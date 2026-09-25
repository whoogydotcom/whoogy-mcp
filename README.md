# Whoogy MCP Server

Compare a Figma design against its live website from inside Claude — spacing, typography, color, layout, and missing-element differences, reported page by page.

Whoogy is a design-QA tool: point it at a Figma file and a live URL, and it tells you where the build has drifted from the design. This MCP server exposes that as a set of tools Claude can call directly, so you can run a scan and read the report without leaving the chat.

## Connect it to Claude

This is a **remote** MCP server — no install, no API key to copy around. Claude authenticates you through Whoogy's own sign-in (OAuth 2.1 + PKCE), so it only ever acts on the Whoogy account you approve.

**Claude.ai / Claude Desktop** — Settings → Connectors → Add custom connector, then paste:

```
https://mcp.whoogy.com/mcp
```

Claude will open a Whoogy sign-in/consent page; approve it once and you're connected.

**Other MCP clients** (Cursor, VS Code Copilot, etc.) that support remote HTTP + OAuth connectors can point at the same URL.

## What it can do

| Tool | What it does |
|---|---|
| `check_credits` | Remaining Whoogy credit balance on the connected account |
| `list_projects` | Lists the account's Whoogy projects (a live site + Figma file pairing) |
| `list_recent_scans` | Recent QA scans — jobId, live URL, Figma file, status, date |
| `check_figma_tier` | Checks whether a Figma file needs the plugin-ingest flow (free/rate-limited team) |
| `start_scan` | Starts comparing a Figma file against a live site; returns a jobId |
| `get_scan_status` | Polls a scan/discovery job |
| `list_discovered_pages` | Lists matched Figma-frame ↔ live-URL pairs for a discovery job |
| `run_selected_pages` | Runs the actual visual + content comparison on chosen pages (spends credits) |
| `get_report` | Structured findings for a completed comparison: similarity score + issues by severity |
| `get_visual_diff` | Side-by-side (Figma vs. live) image for one page |
| `create_plugin_session` / `check_plugin_ingest` / `run_scan_from_ingest` | Fallback flow for Figma files on a free/rate-limited team, via the Whoogy Figma plugin |
| `duplicate_figma_file` | Copies a rate-limited Figma file into a Whoogy-owned team so it can be scanned directly |

Typical flow: `start_scan` → poll `get_scan_status` → `list_discovered_pages` → confirm with the user → `run_selected_pages` → poll `get_scan_status` → `get_report` → `get_visual_diff`.

## How auth works

Claude registers itself as an OAuth client (RFC 7591) and runs a standard authorization-code + PKCE flow against this server. `/authorize` redirects your browser to Whoogy's own consent page; once you approve with your normal Whoogy sign-in, the long-lived Whoogy JWT that flow mints becomes the MCP access token, verbatim — there's no separate token system to manage. There are no refresh tokens: the access token is a 60-day JWT, and Claude re-runs the (fast) authorization flow once it expires.

## Self-hosting

This server is stateless per request (a fresh `McpServer` + transport per HTTP call) and talks to the main Whoogy REST API over HTTP as the signed-in user — it holds no product data of its own. It shares its OAuth-grant and device-code collections with the main Whoogy API's MongoDB, so it isn't meant to be pointed at a different backend; self-hosting only makes sense if you're running the rest of Whoogy yourself too.

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT_SECRET, MCP_API_BASE, FRONTEND_URL
npm run dev
```

See `.env.example` for what each variable does. `MCP_PUBLIC_URL` must be a publicly reachable HTTPS URL for any remote client (claude.ai, etc.) to connect — plain HTTP only works for purely local testing.

## License

MIT
