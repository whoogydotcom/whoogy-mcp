import { randomUUID } from "node:crypto";

import { PluginAuthSession } from "./models/plugin-auth-session.js";

// How long the user has to complete sign-in in their browser after
// /authorize sends them to the Whoogy consent page.
const AUTH_SESSION_TTL_MS = 10 * 60 * 1000;

function frontendBaseUrl(): string {
  return process.env.FRONTEND_URL ?? "http://localhost:3000";
}

/**
 * Creates a pending device-code sign-in session and returns the code plus
 * the browser URL where the user completes it. The main Whoogy API's own
 * plugin-auth route creates the same kind of session for the Figma plugin;
 * this server points `verificationPath` at its own OAuth consent page
 * instead (see oauth-provider.ts).
 */
export async function startPluginAuthSession(
  verificationPath = "/plugin-login",
): Promise<{ code: string; verificationUrl: string }> {
  const code = randomUUID().replace(/-/g, "");
  await PluginAuthSession.create({
    code,
    status: "pending",
    expiresAt: new Date(Date.now() + AUTH_SESSION_TTL_MS),
  });
  return {
    code,
    verificationUrl: `${frontendBaseUrl()}${verificationPath}?code=${code}`,
  };
}
