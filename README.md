# Whoogy MCP Server — Figma to Website Design QA for Claude

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![MCP Server](https://img.shields.io/badge/MCP-Server-blue)](https://modelcontextprotocol.io)
[![Works with Claude](https://img.shields.io/badge/Works%20with-Claude-6b46c1)](https://claude.ai)

**Fastest Figma-to-website design QA, powered by AI.** This MCP server connects Claude to Whoogy to auto-detect pages, run automated visual regression and UI comparison scans, and deliver a full design QA report in minutes — catching spacing, typography, color, and layout drift before launch, without leaving your conversation.

## What is Whoogy MCP?

Whoogy compares a **Figma design against its live website** and reports exactly where the build has drifted from the design — pixel-level spacing errors, wrong fonts, mismatched colors, missing sections, broken layouts. This repository is the **Model Context Protocol (MCP) server** that exposes that Figma vs. live-site comparison as tools Claude can call directly, so a full design QA scan runs and reports back inside your AI chat instead of a separate app or browser plugin.

If you're searching for **Figma to code QA**, **design QA automation**, **visual regression testing for Figma**, or a **Claude MCP server for design review**, this is it.

## Why an MCP server instead of a Figma plugin?

Most Figma-to-live-site QA tools are overlay plugins — you open Figma, open the live site, and eyeball the difference manually, page by page. Whoogy MCP flips that:

- **Automatic page discovery** — give it a Figma file and a live root URL; it matches Figma frames to live routes on its own.
- **No context switching** — ask Claude to run the scan, review the report, and re-run it, all in the same conversation.
- **Structured findings, not just screenshots** — every issue is categorized by severity (critical → low) and type (spacing, typography, color, layout, missing element), not just a visual diff image.
- **Minutes, not hours** — a full multi-page comparison report comes back in minutes, so design QA can run on every deploy, not just before a big launch.

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

## Frequently asked questions

**What does this MCP server actually compare?**
A Figma file (or specific frames) against a live website's rendered pages — layout, spacing, typography, color, and content, page by page.

**How is this different from a pixel-overlay Figma plugin?**
An overlay plugin needs a human to look at each page and spot differences. This server discovers pages automatically and returns a structured, severity-ranked report Claude can read, summarize, and act on.

**How long does a scan take?**
Discovery and comparison run as background jobs; a typical multi-page report comes back within minutes of confirming which pages to run.

**Is my data shared with other users?**
No. Every tool call runs as your signed-in Whoogy account via OAuth — reports, credits, and projects are scoped to your account only.

**Which AI assistants can use this?**
Any MCP client that supports remote, OAuth-authenticated HTTP servers — Claude.ai, Claude Desktop, and other MCP-compatible tools (Cursor, VS Code Copilot, etc.).

**Does it cost anything to run a scan?**
Comparisons spend Whoogy credits (one per page compared). `check_credits` reports your balance before you commit to a run.

## Self-hosting

This server is stateless per request (a fresh `McpServer` + transport per HTTP call) and talks to the main Whoogy REST API over HTTP as the signed-in user — it holds no product data of its own. It shares its OAuth-grant and device-code collections with the main Whoogy API's MongoDB, so it isn't meant to be pointed at a different backend; self-hosting only makes sense if you're running the rest of Whoogy yourself too.

```bash
npm install
cp .env.example .env   # fill in MONGODB_URI, JWT_SECRET, MCP_API_BASE, FRONTEND_URL
npm run dev
```

See `.env.example` for what each variable does. `MCP_PUBLIC_URL` must be a publicly reachable HTTPS URL for any remote client (claude.ai, etc.) to connect — plain HTTP only works for purely local testing.

## Learn more

- Whoogy: [https://whoogy.com](https://whoogy.com)
- Model Context Protocol: [https://modelcontextprotocol.io](https://modelcontextprotocol.io)

## License

MIT
