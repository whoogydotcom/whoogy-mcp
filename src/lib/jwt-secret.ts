/**
 * Resolves the JWT signing/verification secret at call time (not at module
 * load time) so it always reflects whatever loadEnvFile() has actually put
 * into process.env, however early or late this module gets imported.
 *
 * Must match the JWT_SECRET the main Whoogy API signs plugin-auth tokens
 * with — the MCP access token IS that same JWT, verified here verbatim.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set.");
  }
  return secret;
}
