import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { registerWhoogyTools } from "./tools.js";

/**
 * Builds a fresh McpServer for one Streamable-HTTP request. The transport
 * runs stateless (no session id), so we create a new server + transport per
 * request and tear both down when the response ends — see server.ts.
 */
export function createWhoogyMcpServer(): McpServer {
  const server = new McpServer(
    { name: "whoogy", version: "0.1.0" },
    {
      instructions:
        "Whoogy compares Figma designs against live websites and reports visual + content differences " +
        "(spacing, typography, color, layout, missing elements). Typical flow: start_scan → poll " +
        "get_scan_status → list_discovered_pages → confirm with the user → run_selected_pages → poll " +
        "get_scan_status → get_report → get_visual_diff. If a Figma file is on a free/rate-limited team, " +
        "start_scan returns a plugin session code and instructions to relay to the user; after they run the " +
        "Whoogy Figma plugin, use check_plugin_ingest then run_scan_from_ingest. Scans spend credits " +
        "(one per compared page) — check_credits shows the balance.",
    },
  );

  registerWhoogyTools(server);
  return server;
}
