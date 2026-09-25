import { randomUUID } from "node:crypto";

import type { Response } from "express";
import jwt from "jsonwebtoken";

import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

import { getJwtSecret } from "./lib/jwt-secret.js";
import { startPluginAuthSession } from "./plugin-auth-session.js";
import { PluginAuthSession } from "./models/plugin-auth-session.js";
import { OAuthClient, OAuthGrant } from "./models/oauth-store.js";

// The browser page where the user reviews + approves the connection. Lives
// in the Whoogy web app, alongside the Figma plugin's /plugin-login.
const CONSENT_PATH = "/connect/claude";

// How long the user has to finish the browser sign-in before the pending
// authorization is swept. Matches PluginAuthSession's own 10-minute window.
const GRANT_TTL_MS = 10 * 60 * 1000;

async function getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const doc = await OAuthClient.findOne({ clientId }).lean();
  if (!doc) return undefined;
  return doc.raw as unknown as OAuthClientInformationFull;
}

// The SDK's registration handler has already generated client_id /
// client_id_issued_at by the time it calls this. We store the document
// verbatim and hand it straight back — public client, no secret (PKCE is
// the protection), so nothing to enforce.
async function registerClient(
  input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
): Promise<OAuthClientInformationFull> {
  const client = input as OAuthClientInformationFull;
  await OAuthClient.findOneAndUpdate(
    { clientId: client.client_id },
    {
      $set: {
        clientId: client.client_id,
        clientName: client.client_name,
        redirectUris: client.redirect_uris ?? [],
        raw: client as unknown as Record<string, unknown>,
      },
    },
    { upsert: true },
  );
  return client;
}

const clientsStore = {
  getClient,
  registerClient,
} as unknown as OAuthRegisteredClientsStore;

async function loadGrant(code: string) {
  const grant = await OAuthGrant.findOne({ code });
  if (!grant || grant.expiresAt.getTime() <= Date.now()) {
    throw new InvalidGrantError("Authorization code is invalid or expired.");
  }
  return grant;
}

export const whoogyOAuthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /**
   * Start of the browser flow. We mint a pending grant + a plugin-auth
   * device-code session, then send the user to the Whoogy consent page. The
   * final redirect back to Claude (with `code` + `state`) happens later, in
   * GET /oauth/continue (server.ts), once the user has approved.
   */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const { code: pluginAuthCode } = await startPluginAuthSession(CONSENT_PATH);
    const grantCode = randomUUID().replace(/-/g, "");

    await OAuthGrant.create({
      code: grantCode,
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
      state: params.state,
      pluginAuthCode,
      status: "pending",
      expiresAt: new Date(Date.now() + GRANT_TTL_MS),
    });

    const frontendBase = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const publicUrl = (
      process.env.MCP_PUBLIC_URL ?? `http://localhost:${process.env.MCP_PORT ?? 5000}`
    ).replace(/\/$/, "");

    const consent = new URL(`${frontendBase}${CONSENT_PATH}`);
    consent.searchParams.set("code", pluginAuthCode);
    consent.searchParams.set("grant", grantCode);
    // Where the consent page sends the browser once the user clicks "Allow"
    // — this server finishes the OAuth redirect back to Claude from there.
    consent.searchParams.set("return_to", `${publicUrl}/oauth/continue?grant=${grantCode}`);
    if (client.client_name) {
      consent.searchParams.set("client", client.client_name);
    }
    res.redirect(302, consent.href);
  },

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const grant = await loadGrant(authorizationCode);
    return grant.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<OAuthTokens> {
    const grant = await loadGrant(authorizationCode);
    if (grant.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code was issued to another client.");
    }
    if (grant.status !== "ready" || !grant.whoogyJwt) {
      throw new InvalidGrantError("Authorization has not been approved yet.");
    }

    const token = grant.whoogyJwt;
    // One-time: the code is spent now.
    await OAuthGrant.deleteOne({ _id: grant._id });

    let expiresIn = 60 * 24 * 60 * 60; // 60d fallback — mirrors the plugin token TTL
    try {
      const decoded = jwt.decode(token) as { exp?: number } | null;
      if (decoded?.exp) {
        expiresIn = Math.max(60, decoded.exp - Math.floor(Date.now() / 1000));
      }
    } catch {
      /* keep fallback */
    }

    return {
      access_token: token,
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "whoogy",
    };
  },

  async exchangeRefreshToken(): Promise<OAuthTokens> {
    // No refresh tokens in v1 — the access token is a 60-day Whoogy JWT.
    // When it expires Claude re-runs the (fast) authorization flow.
    throw new ServerError("Refresh tokens are not supported.");
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const payload = jwt.verify(token, getJwtSecret()) as {
        userId: string;
        email: string;
        name?: string;
        exp?: number;
      };
      return {
        token,
        clientId: "whoogy-mcp",
        scopes: ["whoogy"],
        expiresAt: payload.exp,
        extra: {
          userId: payload.userId,
          email: payload.email,
          name: payload.name,
        },
      };
    } catch {
      throw new InvalidTokenError("Access token is invalid or expired.");
    }
  },
};

/**
 * Called by GET /oauth/continue once the user has approved in the browser.
 * Pulls the freshly-minted Whoogy JWT off the PluginAuthSession, stamps it
 * on the grant, and returns the redirect URL back to Claude. Retries
 * briefly so a race between the consent page's approve call and this
 * handler resolves cleanly.
 */
export async function finalizeGrant(
  grantCode: string,
): Promise<{ redirectUrl: string } | { error: string }> {
  const grant = await OAuthGrant.findOne({ code: grantCode });
  if (!grant || grant.expiresAt.getTime() <= Date.now()) {
    return { error: "This authorization link has expired. Reconnect from Claude to try again." };
  }

  if (grant.status !== "ready") {
    let session = await PluginAuthSession.findOne({ code: grant.pluginAuthCode });
    for (let attempt = 0; attempt < 4 && session?.status !== "approved"; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      session = await PluginAuthSession.findOne({ code: grant.pluginAuthCode });
    }
    if (!session || session.status !== "approved" || !session.token) {
      return { error: "Sign-in wasn't completed. Reconnect from Claude to try again." };
    }
    grant.whoogyJwt = session.token;
    grant.status = "ready";
    await grant.save();
    // One-time semantics for the device code, same as the main API's own
    // GET /api/plugin-auth/status/:code.
    await PluginAuthSession.deleteOne({ _id: session._id });
  }

  const redirect = new URL(grant.redirectUri);
  redirect.searchParams.set("code", grant.code);
  if (grant.state) redirect.searchParams.set("state", grant.state);
  return { redirectUrl: redirect.href };
}
