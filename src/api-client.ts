import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

/**
 * Thin HTTP client the MCP tools use to call the Whoogy API as the signed-in
 * user. This server carries the user's Whoogy JWT (the MCP access token,
 * see oauth-provider.ts) as a Bearer token, exactly like the website does.
 */

export function apiBase(): string {
  return process.env.MCP_API_BASE ?? "http://localhost:4000";
}

/** The Whoogy JWT for the current MCP request — it IS the access token. */
export function tokenFrom(auth: AuthInfo | undefined): string {
  const token = auth?.token;
  if (!token) {
    throw new McpApiError("You're not connected. Reconnect the Whoogy connector in Claude settings.", 401);
  }
  return token;
}

export class McpApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "McpApiError";
    this.status = status;
    this.code = code;
  }
}

type Json = Record<string, unknown>;

/**
 * Calls the Whoogy API and returns parsed JSON, or throws McpApiError with a
 * message that's already safe to show the user. Known backend error `code`s
 * (no_credits, insufficient_credits, jobs_in_flight, …) are rewritten into
 * plain guidance rather than surfaced raw.
 */
export async function apiFetch<T = Json>(
  auth: AuthInfo | undefined,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: Json,
): Promise<T> {
  const token = tokenFrom(auth);
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new McpApiError(
      `Couldn't reach the Whoogy API (${apiBase()}). ${err instanceof Error ? err.message : String(err)}`,
      502,
    );
  }

  const text = await res.text();
  let data: Json = {};
  try {
    data = text ? (JSON.parse(text) as Json) : {};
  } catch {
    if (!res.ok) {
      throw new McpApiError(`Whoogy API error ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
  }

  if (!res.ok) {
    throw new McpApiError(friendlyApiError(data, res.status), res.status, String(data.code ?? ""));
  }
  return data as T;
}

function friendlyApiError(data: Json, status: number): string {
  const code = typeof data.code === "string" ? data.code : "";
  const raw = typeof data.error === "string" ? data.error : "";

  switch (code) {
    case "no_credits":
      return "This account is out of Whoogy credits. Add a credit pack at whoogy.com/pricing, then try again.";
    case "insufficient_credits":
      return `Not enough credits for this run${
        typeof data.creditsNeeded === "number"
          ? ` (needs ${data.creditsNeeded}, has ${data.creditsAvailable ?? 0})`
          : ""
      }. Add a pack at whoogy.com/pricing.`;
    case "jobs_in_flight":
      return "There are already Whoogy scans running on this account. Wait for them to finish (or add more credits) before starting another.";
  }
  if (status === 401) {
    return "Whoogy sign-in expired. Reconnect the Whoogy connector in Claude settings.";
  }
  return raw || `Whoogy API request failed (${status}).`;
}
