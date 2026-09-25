import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { parseFigmaLink } from "./figma.js";
import { apiBase, apiFetch, McpApiError } from "./api-client.js";

const PLUGIN_URL =
  "https://www.figma.com/community/plugin/1653822145911399092/whoogy-plugin";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}
function json(value: unknown, note?: string): CallToolResult {
  const blob = "```json\n" + JSON.stringify(value, null, 2) + "\n```";
  return text(note ? `${note}\n\n${blob}` : blob);
}
function errorResult(err: unknown): CallToolResult {
  const message =
    err instanceof McpApiError || err instanceof Error
      ? err.message
      : String(err);
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** figmaUrl → fileKey, with a readable error instead of a raw throw. */
function fileKeyOf(figmaUrl: string): string {
  try {
    const { fileKey } = parseFigmaLink(figmaUrl);
    if (!fileKey) throw new Error("no fileKey");
    return fileKey;
  } catch {
    throw new McpApiError(
      "That doesn't look like a Figma file URL. Expected something like https://www.figma.com/design/<key>/...",
      400,
    );
  }
}

function newSessionCode(): string {
  // 8 uppercase hex chars — matches the website's generateSessionId(), and the
  // Figma plugin upper-cases whatever the user types before sending it.
  return randomBytes(4).toString("hex").toUpperCase();
}

type DiscoverPollResult = {
  state: "queued" | "running" | "done" | "error" | "plugin_required";
  frames?: unknown[];
  unmatchedLiveRoutes?: unknown[];
  error?: string;
};

/** Polls a discover/compare job for up to ~`budgetMs`, returning the latest state. */
async function pollJob(
  auth: AuthInfo | undefined,
  jobId: string,
  path: string,
  budgetMs = 27_000,
): Promise<DiscoverPollResult> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const data = await apiFetch<{
      status: string;
      stage?: string;
      error?: string;
      result?: { frames?: unknown[]; unmatchedLiveRoutes?: unknown[] };
    }>(auth, "GET", `${path}/${encodeURIComponent(jobId)}`);

    if (data.status === "plugin_required" || data.stage === "plugin_required") {
      return { state: "plugin_required" };
    }
    if (data.status === "done" || data.status === "completed") {
      return {
        state: "done",
        frames: data.result?.frames,
        unmatchedLiveRoutes: data.result?.unmatchedLiveRoutes,
      };
    }
    if (data.status === "error" || data.status === "failed" || data.status === "cancelled") {
      return { state: "error", error: data.error ?? "The job failed." };
    }
    if (Date.now() >= deadline) {
      return { state: data.status === "queued" ? "queued" : "running" };
    }
    await sleep(3000);
  }
}

// ── Virtual batches for ingest-sourced comparisons ──────────────────────────
// /api/compare/specific-batch always re-reads Figma's live REST API per page
// (compareFigmaToLive → inspectFigmaLink) — fine for pages discovered via
// start_scan, but WRONG for pages discovered via run_scan_from_ingest: their
// data was already pushed into Mongo by the Figma plugin specifically to
// avoid touching Figma's (rate-limited) API again. Those pages must go
// through /api/compare/live-from-ingest instead, which reads the stored
// FigmaFrame doc and never calls Figma. That endpoint is single-frame only,
// so a multi-page "batch" of ingest-sourced pages becomes N real jobs — this
// map lets get_scan_status/get_report/get_visual_diff address them together
// under one synthetic jobId, same as a normal batch. In-memory only (this
// MCP server process's lifetime) — acceptable because each underlying real
// job is itself durably tracked in Mongo; losing the index on a restart just
// means re-running run_selected_pages, not losing any comparison data.
const VIRTUAL_PREFIX = "ingest-batch:";
type VirtualBatch = { pages: { liveUrl: string; figmaFrameUrl: string; realJobId: string }[] };
const virtualBatches = new Map<string, VirtualBatch>();
const isVirtualJobId = (jobId: string) => jobId.startsWith(VIRTUAL_PREFIX);

/** Fetches one live-from-ingest job's raw FigmaCompareResult (not wrapped in
 *  a {results: [...]} array the way specific-batch/batch-from-ingest are). */
async function fetchSingleCompareResult(
  auth: AuthInfo | undefined,
  realJobId: string,
): Promise<{ status: string; error?: string; result?: Record<string, unknown> }> {
  return apiFetch(auth, "GET", "/api/compare/jobs/" + encodeURIComponent(realJobId));
}

type Page = {
  figmaFrameUrl: string;
  figmaFrameName: string;
  figmaPageName: string;
  suggestedPath: string;
  matchedPath: string | null;
  liveUrl: string;
  frameType: string;
  /** The Figma node-id for this frame — needed by run_selected_pages to
   *  dispatch an ingest-sourced page correctly (see ingestFileKey). */
  nodeId: string;
  /** Set only when this page came from the plugin-ingest discovery path
   *  (run_scan_from_ingest). Tells run_selected_pages this page's data
   *  already lives in Mongo (FigmaFrame) and must be compared via
   *  /api/compare/live-from-ingest — NOT /api/compare/specific-batch, which
   *  always re-reads the live (and, for a free-team file, rate-limited)
   *  Figma REST API regardless of how the page was discovered. */
  ingestFileKey?: string;
};

function pickPages(frames: unknown[] | undefined): Page[] {
  return ((frames ?? []) as Record<string, unknown>[])
    .filter((f) => f.frameType === "page")
    .map((f) => ({
      figmaFrameUrl: String(f.figmaFrameUrl ?? ""),
      figmaFrameName: String(f.figmaFrameName ?? ""),
      figmaPageName: String(f.figmaPageName ?? ""),
      suggestedPath: String(f.suggestedPath ?? ""),
      matchedPath: (f.matchedPath as string | null) ?? null,
      liveUrl: String(f.liveUrl ?? ""),
      frameType: String(f.frameType ?? "page"),
      nodeId: String(f.nodeId ?? ""),
      ingestFileKey: typeof f.ingestFileKey === "string" ? f.ingestFileKey : undefined,
    }));
}

function mdEscape(s: string): string {
  return s.replace(/\|/g, "\\|");
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const;
const SEVERITY_EMOJI: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "⚪" };

type ReportPage = {
  liveUrl: string;
  figmaFrame: string;
  similarityScore: number | null;
  error: string | null;
  findings: { severity: string; category: string; section: string; summary: string; expected: string; actual: string }[];
};

/** Markdown summary table — one row per compared page. */
function reportTable(pages: ReportPage[]): string {
  const rows = pages.map((p) => {
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of p.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    const sim = p.error ? "❌ failed" : p.similarityScore != null ? `${p.similarityScore}%` : "—";
    return `| ${mdEscape(p.liveUrl)} | ${sim} | ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} |`;
  });
  return [
    "| Page | Similarity | 🔴 Critical | 🟠 High | 🟡 Medium | ⚪ Low |",
    "|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** Per-page findings, grouped and bulleted, worst severity first. */
function reportPageSection(p: ReportPage): string {
  const header = `### ${p.liveUrl}` + (p.figmaFrame ? ` — vs "${p.figmaFrame}"` : "");
  if (p.error) return `${header}\n❌ ${p.error}`;
  if (p.findings.length === 0) return `${header}\n✅ No differences found.`;
  const lines = p.findings.map((f) => {
    const detail = f.expected || f.actual ? ` — expected "${f.expected}", got "${f.actual}"` : "";
    return `- ${SEVERITY_EMOJI[f.severity] ?? "⚪"} **${f.category}** (${f.section || "page"}): ${f.summary}${detail}`;
  });
  return [header, ...lines].join("\n");
}

function pluginInstructions(sessionCode: string): string {
  return [
    "This Figma file's team is on a free plan, so Figma's API blocks direct reads.",
    "Ask the user to push the frames from the Figma plugin (about a minute):",
    "",
    "1. Open the Figma file, then **Plugins → Whoogy Plugin**",
    `   (install it first if needed: ${PLUGIN_URL})`,
    `2. Paste this code into the plugin: **${sessionCode}**  →  Send`,
    "3. When the plugin finishes uploading frames, tell me \"done\"",
    "",
    `Then I'll call check_plugin_ingest and run_scan_from_ingest with sessionCode "${sessionCode}".`,
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerWhoogyTools(server: McpServer): void {
  const A = (extra: { authInfo?: AuthInfo }) => extra.authInfo;

  server.registerTool(
    "check_credits",
    {
      title: "Check Whoogy credits",
      description:
        "Returns the connected Whoogy account's remaining credit balance. Each compared page costs credits; check this before starting a large scan.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    // NOTE: inputSchema: {} (an empty object, not omitted) still makes the SDK
    // treat this as a schema-bearing tool, so the callback gets (args, extra)
    // — NOT just (extra). A single-parameter (extra) => ... here silently
    // binds `extra` to the empty parsed-args object instead, so `.authInfo`
    // is always undefined regardless of the caller's real token. That's what
    // made check_credits/list_projects fail with "not connected" on every
    // call while every other (parameterized) tool worked fine.
    async (_args, extra) => {
      try {
        const data = await apiFetch<{ credits?: number }>(A(extra), "GET", "/api/subscription");
        return json({ credits: data.credits ?? 0 });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Whoogy projects",
      description: "Lists the connected account's Whoogy projects (a project pairs a live site with a Figma file).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    // See the identical note on check_credits above — inputSchema: {} means
    // the callback signature is (args, extra), not (extra).
    async (_args, extra) => {
      try {
        return json(await apiFetch(A(extra), "GET", "/api/projects"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_recent_scans",
    {
      title: "List recent scans",
      description:
        "Lists the account's recent QA scans (jobId, live URL, Figma file, status, date). Use a jobId here with get_report or get_visual_diff.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }, extra) => {
      try {
        return json(await apiFetch(A(extra), "GET", `/api/jobs?limit=${limit ?? 15}`));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "check_figma_tier",
    {
      title: "Check Figma file tier",
      description:
        "Probes whether a Figma file can be read directly via Figma's API, or whether its team is on a free/rate-limited plan that requires the Whoogy plugin flow. start_scan does this automatically — call this only for a standalone check.",
      inputSchema: { figmaUrl: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ figmaUrl }, extra) => {
      try {
        return json(
          await apiFetch(A(extra), "POST", "/api/figma/tier-check", { url: figmaUrl }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "start_scan",
    {
      title: "Start a design-vs-live scan",
      description:
        "Starts comparing a Figma file against a live website. Returns a jobId — then poll get_scan_status until it reports 'discovered', then call list_discovered_pages, then run_selected_pages. If the Figma file needs the plugin flow, this returns a session code and step-by-step instructions to relay to the user (no jobId yet).",
      inputSchema: {
        figmaUrl: z.string().describe("Figma file or frame URL"),
        liveUrl: z.string().describe("Live site root URL, e.g. https://example.com"),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ figmaUrl, liveUrl }, extra) => {
      try {
        const tier = await apiFetch<{ requiresPlugin?: boolean; planTier?: string }>(
          A(extra),
          "POST",
          "/api/figma/tier-check",
          { url: figmaUrl },
        );

        if (tier.requiresPlugin) {
          const fileKey = fileKeyOf(figmaUrl);
          const sessionCode = newSessionCode();
          await apiFetch(A(extra), "POST", "/api/figma/session", {
            sessionId: sessionCode,
            fileKey,
          });
          return json(
            { status: "plugin_required", sessionCode, planTier: tier.planTier ?? null, figmaUrl, liveUrl },
            pluginInstructions(sessionCode),
          );
        }

        const { jobId } = await apiFetch<{ jobId: string }>(
          A(extra),
          "POST",
          "/api/figma/discover",
          { figmaUrl, liveRootUrl: liveUrl },
        );
        return json(
          { jobId, status: "started" },
          `Scan started. Poll get_scan_status with jobId "${jobId}" until it reports 'discovered'.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_scan_status",
    {
      title: "Check scan status",
      description:
        "Polls a scan/discovery job. Waits up to ~25s internally, then returns queued | running | discovered | error. On 'discovered', call list_discovered_pages next. On 'plugin_required', switch to the plugin flow (create_plugin_session / run_scan_from_ingest).",
      inputSchema: { jobId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId }, extra) => {
      try {
        if (isVirtualJobId(jobId)) {
          const batch = virtualBatches.get(jobId);
          if (!batch) return errorResult(new McpApiError("Job not found.", 404));
          const statuses = await Promise.all(
            batch.pages.map((p) => fetchSingleCompareResult(A(extra), p.realJobId)),
          );
          const allSettled = statuses.every(
            (s) => s.status === "done" || s.status === "completed" || s.status === "error" || s.status === "failed",
          );
          if (!allSettled) {
            return json({ status: "running" }, "Still running. Call get_scan_status again in a moment.");
          }
          return json(
            { status: "discovered", pageCount: batch.pages.length },
            `Comparison finished for ${batch.pages.length} page(s). Call get_report with jobId "${jobId}".`,
          );
        }

        // Discovery jobs and compare jobs use different status endpoints; try
        // discovery first, fall back to compare.
        let result = await pollJob(A(extra), jobId, "/api/discover/jobs").catch(() => null);
        if (!result || result.state === "error") {
          const compare = await pollJob(A(extra), jobId, "/api/compare/jobs", 3000).catch(() => null);
          if (compare && compare.state !== "error") result = compare;
        }
        if (!result) return errorResult(new McpApiError("Job not found.", 404));

        if (result.state === "done") {
          const pages = pickPages(result.frames);
          if (pages.length > 0 || result.frames) {
            return json(
              { status: "discovered", pageCount: pages.length },
              `Discovery done — ${pages.length} page(s) matched. Call list_discovered_pages with jobId "${jobId}".`,
            );
          }
          return json({ status: "done" }, "Job finished. Call get_report.");
        }
        if (result.state === "plugin_required") {
          return json(
            { status: "plugin_required" },
            "This Figma file needs the plugin flow. Call create_plugin_session, relay the steps, then run_scan_from_ingest.",
          );
        }
        if (result.state === "error") return errorResult(new McpApiError(result.error ?? "Job failed.", 500));
        return json({ status: result.state }, `Still ${result.state}. Call get_scan_status again in a moment.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_discovered_pages",
    {
      title: "List discovered pages",
      description:
        "For a completed discovery jobId, returns the matched Figma-frame ↔ live-URL pairs as a table. Show the table to the user, then pass the CHOSEN page objects from the 'Reference data' block through unchanged to run_selected_pages (they carry nodeId/ingestFileKey that run_selected_pages needs).",
      inputSchema: { jobId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId }, extra) => {
      try {
        const data = await apiFetch<{
          status: string;
          result?: { frames?: unknown[]; unmatchedLiveRoutes?: unknown[] };
        }>(A(extra), "GET", `/api/discover/jobs/${encodeURIComponent(jobId)}`);
        if (data.status !== "done" && data.status !== "completed") {
          return json({ status: data.status }, "Discovery isn't finished yet — call get_scan_status first.");
        }
        const pages = pickPages(data.result?.frames);
        const matched = pages.filter((p) => p.matchedPath);
        const unmatched = pages.filter((p) => !p.matchedPath);

        const rows = pages.map(
          (p) =>
            `| ${mdEscape(p.figmaFrameName)} | ${mdEscape(p.liveUrl || p.suggestedPath)} | ${p.matchedPath ? "✅" : "⚠️ no match"} |`,
        );
        const table = ["| Figma Frame | Live URL | Status |", "|---|---|---|", ...rows].join("\n");
        const summary = `## 📄 ${pages.length} page(s) discovered — ${matched.length} matched, ${unmatched.length} unmatched`;
        const referenceBlock = "```json\n" + JSON.stringify({ jobId, pages }, null, 2) + "\n```";
        const markdown = [
          summary,
          "",
          table,
          "",
          "Ask the user which pages to run, then pass their exact page objects (from Reference data below) to run_selected_pages.",
          "",
          "Reference data (pass these objects through unchanged to run_selected_pages):",
          referenceBlock,
        ].join("\n");

        return text(markdown);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "run_selected_pages",
    {
      title: "Run comparison on selected pages",
      description:
        "Runs the actual visual + content comparison for the given pages (as returned by list_discovered_pages — pass the objects back through, don't retype them). Spends credits (one per page). Returns a jobId — poll get_scan_status, then call get_report. Confirm the page list with the user before calling this. All pages in one call must come from the SAME list_discovered_pages result.",
      inputSchema: {
        pages: z
          .array(
            z.object({
              figmaFrameUrl: z.string().describe("figmaFrameUrl from list_discovered_pages"),
              liveUrl: z.string(),
              nodeId: z
                .string()
                .optional()
                .describe("nodeId from list_discovered_pages — required if ingestFileKey is set"),
              ingestFileKey: z
                .string()
                .optional()
                .describe(
                  "Set this to the page's ingestFileKey from list_discovered_pages when it has one — that page came from the Figma plugin and must be compared from its already-pushed data, not a fresh (rate-limited) Figma API read.",
                ),
            }),
          )
          .min(1),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ pages }, extra) => {
      try {
        const ingestPages = pages.filter((p) => p.ingestFileKey);
        const livePages = pages.filter((p) => !p.ingestFileKey);

        if (ingestPages.length > 0 && livePages.length > 0) {
          return errorResult(
            new McpApiError(
              "These pages are a mix of plugin-ingested and directly-discovered pages — run them in two separate run_selected_pages calls (they use different comparison paths).",
              400,
            ),
          );
        }

        if (ingestPages.length > 0) {
          const missingNodeId = ingestPages.find((p) => !p.nodeId);
          if (missingNodeId) {
            return errorResult(
              new McpApiError(
                `Page ${missingNodeId.figmaFrameUrl} is missing nodeId — pass the page objects from list_discovered_pages through unchanged.`,
                400,
              ),
            );
          }
          // live-from-ingest is single-frame only (it reads one FigmaFrame doc
          // and never calls Figma's REST API) — dispatch one real job per page
          // and index them under one synthetic jobId so the rest of the tool
          // set (get_scan_status/get_report/get_visual_diff) can treat this
          // exactly like a normal batch.
          const dispatched = await Promise.all(
            ingestPages.map(async (p) => {
              const { jobId: realJobId } = await apiFetch<{ jobId: string }>(
                A(extra),
                "POST",
                "/api/compare/live-from-ingest",
                { fileKey: p.ingestFileKey, frameId: p.nodeId, liveUrl: p.liveUrl },
              );
              return { liveUrl: p.liveUrl, figmaFrameUrl: p.figmaFrameUrl, realJobId };
            }),
          );
          const virtualJobId = VIRTUAL_PREFIX + randomUUID();
          virtualBatches.set(virtualJobId, { pages: dispatched });
          return json(
            { jobId: virtualJobId, status: "running", pageCount: ingestPages.length },
            `Comparing ${ingestPages.length} plugin-sourced page(s) from their pushed data (no live Figma API calls). Poll get_scan_status with jobId "${virtualJobId}", then call get_report.`,
          );
        }

        const { jobId } = await apiFetch<{ jobId: string }>(
          A(extra),
          "POST",
          "/api/compare/specific-batch",
          {
            pairs: livePages.map((p, index) => ({
              index,
              figmaUrl: p.figmaFrameUrl,
              liveUrl: p.liveUrl,
            })),
          },
        );
        return json(
          { jobId, status: "running", pageCount: livePages.length },
          `Comparing ${livePages.length} page(s). Poll get_scan_status with jobId "${jobId}", then call get_report.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_report",
    {
      title: "Get the comparison report",
      description:
        "Returns the structured findings for a completed comparison jobId: per page, a similarity score and a list of issues (severity, category, section, expected vs actual). Findings are ordered critical → low.",
      inputSchema: { jobId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId }, extra) => {
      try {
        let outcomes: Record<string, unknown>[];

        if (isVirtualJobId(jobId)) {
          const batch = virtualBatches.get(jobId);
          if (!batch) return errorResult(new McpApiError("Job not found.", 404));
          const settled = await Promise.all(
            batch.pages.map(async (p) => {
              const data = await fetchSingleCompareResult(A(extra), p.realJobId);
              return {
                liveUrl: p.liveUrl,
                error: data.status === "error" || data.status === "failed" ? data.error ?? "Comparison failed." : null,
                result: data.status === "done" || data.status === "completed" ? data.result ?? null : null,
              };
            }),
          );
          const stillRunning = settled.some((s) => !s.error && !s.result);
          if (stillRunning) {
            return json({ status: "running" }, "Not finished — poll get_scan_status first.");
          }
          outcomes = settled;
        } else {
          const data = await apiFetch<{
            status: string;
            error?: string;
            result?: { results?: unknown[] };
          }>(A(extra), "GET", `/api/compare/jobs/${encodeURIComponent(jobId)}`);

          if (data.status === "error" || data.status === "failed") {
            return errorResult(new McpApiError(data.error ?? "The scan failed.", 500));
          }
          if (data.status !== "done" && data.status !== "completed") {
            return json({ status: data.status }, "Not finished — poll get_scan_status first.");
          }
          outcomes = (data.result?.results ?? []) as Record<string, unknown>[];
        }

        const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const pages = outcomes.map((o) => {
          const r = (o.result ?? null) as Record<string, unknown> | null;
          const findings = ((r?.findings ?? []) as Record<string, unknown>[])
            .map((f) => ({
              severity: String(f.severity ?? "low"),
              category: String(f.type ?? "issue"),
              section: String(f.section ?? ""),
              summary: String(f.summary ?? ""),
              expected: String(f.expected ?? f.figmaValue ?? ""),
              actual: String(f.actual ?? f.liveValue ?? ""),
            }))
            .sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
          return {
            liveUrl: String(o.liveUrl ?? ""),
            figmaFrame: r ? String(r.figmaFrame ?? "") : "",
            similarityScore: r ? (r.similarityScore as number) ?? null : null,
            error: (o.error as string | null) ?? null,
            summary: (r?.summary as Record<string, number>) ?? null,
            findings,
          };
        });

        const totals = pages.reduce(
          (acc, p) => {
            for (const f of p.findings) acc[f.severity] = (acc[f.severity] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>,
        );

        const summaryLine = `## Report — ${pages.length} page(s) · ${SEVERITY_ORDER.map((s) => `${SEVERITY_EMOJI[s]} ${totals[s] ?? 0}`).join("  ")}`;
        const table = reportTable(pages);
        const sections = pages.map((p) => reportPageSection(p)).join("\n\n");
        const referenceBlock = "```json\n" + JSON.stringify({ jobId, pages }, null, 2) + "\n```";
        const markdown = [summaryLine, "", table, "", sections, "", "Reference data:", referenceBlock].join("\n");

        // Best-effort: embed the worst-affected page's side-by-side image inline
        // (same image /get_visual_diff would fetch) so the report is visual by
        // default, not just a table. Never fails the whole report if this fails.
        let worstIdx = -1;
        let worstWeight = 0;
        pages.forEach((p, i) => {
          if (p.error) return;
          const weight =
            p.findings.filter((f) => f.severity === "critical").length * 3 +
            p.findings.filter((f) => f.severity === "high").length;
          if (weight > worstWeight) {
            worstWeight = weight;
            worstIdx = i;
          }
        });

        const content: CallToolResult["content"] = [{ type: "text", text: markdown }];
        if (worstIdx >= 0) {
          try {
            const raw = (outcomes[worstIdx]?.result ?? null) as Record<string, unknown> | null;
            const imgPath = (raw?.sideBySidePath as string) || (raw?.diffImagePath as string) || "";
            if (imgPath) {
              const url = /^https?:\/\//i.test(imgPath) ? imgPath : `${apiBase()}${imgPath}`;
              const resp = await fetch(url);
              if (resp.ok) {
                const buf = Buffer.from(await resp.arrayBuffer());
                content.push({
                  type: "text",
                  text: `Visual diff for the most-affected page (${pages[worstIdx].liveUrl}) — left: Figma, right: live. Call get_visual_diff for any other page.`,
                });
                content.push({
                  type: "image",
                  data: buf.toString("base64"),
                  mimeType: resp.headers.get("content-type") ?? "image/png",
                });
              }
            }
          } catch {
            /* image is a bonus, never block the report on it */
          }
        }

        return { content };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_visual_diff",
    {
      title: "Get a page's visual diff image",
      description:
        "Returns the side-by-side (Figma vs live) comparison image for one page of a completed report, so it can be shown inline. Identify the page by its live URL or its index in get_report.",
      inputSchema: {
        jobId: z.string(),
        page: z.string().describe("The page's live URL, or its 0-based index from get_report"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ jobId, page }, extra) => {
      try {
        let outcomes: { liveUrl: unknown; result: unknown }[];

        if (isVirtualJobId(jobId)) {
          const batch = virtualBatches.get(jobId);
          if (!batch) return errorResult(new McpApiError("No report for that jobId yet.", 404));
          outcomes = await Promise.all(
            batch.pages.map(async (p) => {
              const data = await fetchSingleCompareResult(A(extra), p.realJobId);
              return { liveUrl: p.liveUrl, result: data.result ?? null };
            }),
          );
        } else {
          const data = await apiFetch<{ status: string; result?: { results?: unknown[] } }>(
            A(extra),
            "GET",
            `/api/compare/jobs/${encodeURIComponent(jobId)}`,
          );
          outcomes = (data.result?.results ?? []) as { liveUrl: unknown; result: unknown }[];
        }
        if (outcomes.length === 0) return errorResult(new McpApiError("No report for that jobId yet.", 404));

        const idx = /^\d+$/.test(page.trim()) ? Number(page.trim()) : -1;
        const match =
          idx >= 0
            ? outcomes[idx]
            : outcomes.find((o) => String(o.liveUrl ?? "").replace(/\/$/, "") === page.replace(/\/$/, ""));
        const r = (match?.result ?? null) as Record<string, unknown> | null;
        const imgPath =
          (r?.sideBySidePath as string) || (r?.diffImagePath as string) || "";
        if (!imgPath) return errorResult(new McpApiError("That page has no diff image.", 404));

        const url = /^https?:\/\//i.test(imgPath) ? imgPath : `${apiBase()}${imgPath}`;
        const resp = await fetch(url);
        if (!resp.ok) return errorResult(new McpApiError(`Couldn't fetch the diff image (${resp.status}).`, 502));
        const buf = Buffer.from(await resp.arrayBuffer());
        return {
          content: [
            { type: "text", text: `Side-by-side for ${String(match?.liveUrl ?? page)} (left: Figma, right: live)` },
            { type: "image", data: buf.toString("base64"), mimeType: resp.headers.get("content-type") ?? "image/png" },
          ],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_plugin_session",
    {
      title: "Create a Figma plugin session",
      description:
        "For a rate-limited (free-team) Figma file: creates a session code the user pastes into the Whoogy Figma plugin to push frames. Returns the code + numbered instructions to relay. Then poll check_plugin_ingest, then run_scan_from_ingest.",
      inputSchema: { figmaUrl: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ figmaUrl }, extra) => {
      try {
        const fileKey = fileKeyOf(figmaUrl);
        const sessionCode = newSessionCode();
        await apiFetch(A(extra), "POST", "/api/figma/session", { sessionId: sessionCode, fileKey });
        return json(
          { sessionCode, pluginUrl: PLUGIN_URL, figmaUrl },
          pluginInstructions(sessionCode),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "check_plugin_ingest",
    {
      title: "Check plugin upload progress",
      description:
        "Checks how many Figma frames the plugin has pushed for a session code. Returns { count, totalFrames, cancelled }. When count reaches totalFrames (or the user says it's done), call run_scan_from_ingest.",
      inputSchema: { figmaUrl: z.string(), sessionCode: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ figmaUrl, sessionCode }, extra) => {
      try {
        const fileKey = fileKeyOf(figmaUrl);
        const data = await apiFetch(
          A(extra),
          "GET",
          `/api/figma/frames/${encodeURIComponent(fileKey)}?sessionId=${encodeURIComponent(
            sessionCode.toUpperCase(),
          )}`,
        );
        return json(data);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "run_scan_from_ingest",
    {
      title: "Start scan from plugin-pushed frames",
      description:
        "After the Whoogy plugin has pushed frames for a session code, starts discovery against the live site. Returns a jobId — then poll get_scan_status, list_discovered_pages, run_selected_pages, get_report (same as start_scan).",
      inputSchema: {
        figmaUrl: z.string(),
        liveUrl: z.string(),
        sessionCode: z.string(),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ figmaUrl, liveUrl, sessionCode }, extra) => {
      try {
        const fileKey = fileKeyOf(figmaUrl);
        const { jobId } = await apiFetch<{ jobId: string }>(
          A(extra),
          "POST",
          "/api/figma/discover-from-ingest",
          { fileKey, liveRootUrl: liveUrl, sessionId: sessionCode.toUpperCase() },
        );
        return json(
          { jobId, status: "started" },
          `Discovery started from the pushed frames. Poll get_scan_status with jobId "${jobId}".`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "duplicate_figma_file",
    {
      title: "Duplicate a Figma file into a paid team",
      description:
        "Alternative to the plugin flow for a rate-limited file: copies it into Whoogy's Dev Pro team and returns a new Figma URL you can scan directly. Note: it's a snapshot — later edits to the original won't sync.",
      inputSchema: { figmaUrl: z.string() },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ figmaUrl }, extra) => {
      try {
        return json(await apiFetch(A(extra), "POST", "/api/figma/duplicate", { figmaUrl }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
