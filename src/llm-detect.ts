/**
 * Heuristic to pick an "LLM-capable" MCP server out of a list of discovered
 * announces. The rule is intentionally simple: a server qualifies if it
 * exposes at least one tool whose name matches the configured allowlist.
 *
 * Self-references (our own nextcloud-* servers) are always excluded.
 */

import type { DiscoveredServer } from "./beacon-discover.js";

const SELF_PREFIXES = ["nextcloud-mcp", "nextcloud-talk-mcp"];

export interface LlmCandidate {
  server: DiscoveredServer;
  matchedTool: { name: string; description?: string };
}

export interface DetectResult {
  candidates: LlmCandidate[];
  bestMatch: LlmCandidate | null;
  reason: "ok" | "none" | "ambiguous";
}

/**
 * Given discovered servers and a list of LLM tool-name hints, return:
 *   - candidates  : every server that exposes at least one hint-matching tool
 *   - bestMatch   : the unique candidate if there's exactly one, else null
 *   - reason      : "ok" (1 match), "ambiguous" (>1), "none" (0)
 */
export function detectLlmServer(
  servers: DiscoveredServer[],
  llmToolNames: string[],
): DetectResult {
  const hints = new Set(llmToolNames.map((n) => n.toLowerCase()));

  const candidates: LlmCandidate[] = [];
  for (const s of servers) {
    if (SELF_PREFIXES.some((p) => s.name === p)) continue;
    const hit = s.tools.find((t) => hints.has(t.name.toLowerCase()));
    if (hit) candidates.push({ server: s, matchedTool: hit });
  }

  let reason: DetectResult["reason"];
  let bestMatch: LlmCandidate | null;
  if (candidates.length === 0) {
    reason = "none";
    bestMatch = null;
  } else if (candidates.length === 1) {
    reason = "ok";
    bestMatch = candidates[0];
  } else {
    reason = "ambiguous";
    bestMatch = null;
  }

  return { candidates, bestMatch, reason };
}
