import cors from "cors";
import express from "express";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";

import { connectDb } from "./db.js";
import { loadEnvFile } from "./load-env.js";
import { createWhoogyMcpServer } from "./server-factory.js";
import { whoogyOAuthProvider, finalizeGrant } from "./oauth-provider.js";

loadEnvFile();

connectDb().catch((error) => {
  console.error("[mcp][db] Connection failed:", error instanceof Error ? error.message : error);
});

process.on("unhandledRejection", (reason) => {
  console.error("[mcp] Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[mcp] Uncaught exception:", err);
});

const PORT = Number(process.env.MCP_PORT ?? 5000);

// The externally-reachable base URL of THIS server (ngrok locally,
// https://mcp.whoogy.com in prod). Every OAuth metadata URL is built from it —
// it must never be "localhost" when a remote client (claude.ai) is involved.
const PUBLIC_URL = (process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const MCP_ENDPOINT = `${PUBLIC_URL}/mcp`;

const app = express();
// One proxy hop in front of us (ngrok locally, nginx/CF in prod). NOT `true` —
// express-rate-limit (used by the OAuth router) rejects a permissive setting.
app.set("trust proxy", Number(process.env.MCP_TRUST_PROXY ?? 1));

// MCP + OAuth are called from browsers and web-based clients — allow any origin
// (every protected route is Bearer-authenticated anyway).
app.use(
  cors({
    origin: true,
    exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
  }),
);

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "whoogy-mcp", publicUrl: PUBLIC_URL });
});

// OAuth 2.1 authorization-server + protected-resource metadata, dynamic client
// registration, /authorize, /token. Must be mounted at the app root.
app.use(
  mcpAuthRouter({
    provider: whoogyOAuthProvider,
    issuerUrl: new URL(PUBLIC_URL),
    baseUrl: new URL(PUBLIC_URL),
    resourceServerUrl: new URL(MCP_ENDPOINT),
    resourceName: "Whoogy",
    scopesSupported: ["whoogy"],
  }),
);

// Browser lands here after approving on the Whoogy consent page. Completes the
// authorization by attaching the minted Whoogy JWT to the grant and redirecting
// back to Claude with `code` + `state`.
app.get("/oauth/continue", async (req, res) => {
  const grant = typeof req.query.grant === "string" ? req.query.grant : "";
  if (!grant) {
    res.status(400).send("Missing grant parameter.");
    return;
  }
  try {
    const outcome = await finalizeGrant(grant);
    if ("error" in outcome) {
      res.status(400).send(outcome.error);
      return;
    }
    res.redirect(302, outcome.redirectUrl);
  } catch (err) {
    console.error("[mcp][oauth/continue]", err);
    res.status(500).send("Could not complete the connection. Reconnect from Claude to try again.");
  }
});

const bearer = requireBearerAuth({
  verifier: whoogyOAuthProvider,
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(MCP_ENDPOINT)),
});

// Streamable HTTP, stateless: a fresh server + transport per request.
app.post("/mcp", bearer, express.json({ limit: "4mb" }), async (req, res) => {
  const server = createWhoogyMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no standalone SSE stream.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this server uses stateless Streamable HTTP." },
    id: null,
  });
});

app.listen(PORT, () => {
  console.log(`[mcp] Whoogy MCP server on :${PORT}`);
  console.log(`[mcp] public URL      ${PUBLIC_URL}`);
  console.log(`[mcp] connector URL   ${MCP_ENDPOINT}`);
  console.log(`[mcp] calls API at    ${process.env.MCP_API_BASE ?? "http://localhost:4000"}`);
  if (PUBLIC_URL.startsWith("http://") && !PUBLIC_URL.includes("localhost")) {
    console.warn("[mcp] WARNING: MCP_PUBLIC_URL is not HTTPS — claude.ai will reject the connector.");
  }
});
