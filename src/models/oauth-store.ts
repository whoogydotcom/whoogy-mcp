import mongoose, { Document, Schema } from "mongoose";

/**
 * OAuth 2.1 storage for the Whoogy MCP connector.
 *
 * Claude (claude.ai / Claude Desktop) talks to this server as a standard
 * remote MCP client: it dynamically registers itself (RFC 7591), runs an
 * authorization-code + PKCE flow, and calls /mcp with a Bearer token.
 *
 * This is not a general-purpose OAuth server — the actual "who is this
 * user" step reuses the Whoogy web app's existing sign-in: /authorize
 * redirects the user's browser to Whoogy's consent page, they approve with
 * their normal signed-in session, and the long-lived Whoogy JWT that flow
 * already mints becomes the MCP access token verbatim (see oauth-provider.ts).
 *
 * Two short-lived collections, both TTL-swept by MongoDB like
 * PluginAuthSession:
 *  - OAuthClient: one row per Claude client that has registered (public
 *    client, no secret — PKCE is the protection).
 *  - OAuthGrant: one row per in-progress authorization, linking the PKCE
 *    challenge + Claude's redirect_uri/state to the plugin-auth code and,
 *    once approved, to the minted Whoogy JWT.
 */

export interface IOAuthClient extends Document {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  raw: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const oauthClientSchema = new Schema<IOAuthClient>(
  {
    clientId: { type: String, required: true, unique: true },
    clientName: { type: String },
    redirectUris: { type: [String], default: [] },
    raw: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

export const OAuthClient = mongoose.model<IOAuthClient>("OAuthClient", oauthClientSchema);

export interface IOAuthGrant extends Document {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource?: string;
  state?: string;
  pluginAuthCode: string;
  whoogyJwt?: string;
  status: "pending" | "ready";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const oauthGrantSchema = new Schema<IOAuthGrant>(
  {
    code: { type: String, required: true, unique: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    resource: { type: String },
    state: { type: String },
    pluginAuthCode: { type: String, required: true },
    whoogyJwt: { type: String },
    status: { type: String, enum: ["pending", "ready"], default: "pending" },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

oauthGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const OAuthGrant = mongoose.model<IOAuthGrant>("OAuthGrant", oauthGrantSchema);
