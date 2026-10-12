import { createApi } from "./api.js";
import { discoverServers } from "./beacon-discover.js";
import { loadConfig, saveConfig } from "./config.js";
import { detectLlmServer } from "./llm-detect.js";
import { createMultiDiscoveryResponder } from "./mcp-announce.js";
import { getTalkTools, TALK_TOOL_NAMES } from "./talk-mcp.js";
import * as upstream from "./upstream.js";
import { fetchUpstreamTools } from "./upstream-tools.js";
import { manager as watcherManager } from "./watcher-manager.js";
import type { Config } from "./types.js";

let cachedTools: unknown[] = [];

async function maybeAutoConfigureTarget(
  getConfig: () => Config,
  onConfigUpdated: (cfg: Config) => Promise<void>,
): Promise<void> {
  // Give sibling MCPs on the network a moment to start announcing.
  await new Promise((r) => setTimeout(r, 3000));

  const cfg = getConfig();
  if (cfg.target.mode !== "auto") {
    console.log(`target mode=${cfg.target.mode} — skipping auto-detection.`);
    return;
  }
  if (cfg.target.toolName) {
    console.log(
      `target already configured (toolName=${cfg.target.toolName}, beaconUrl=${cfg.target.beaconUrl}) — skipping auto-detection.`,
    );
    return;
  }

  try {
    const servers = await discoverServers({ timeoutMs: 2000 });
    const detection = detectLlmServer(servers, cfg.target.llmToolNames);
    console.log(
      `Beacon scan found ${servers.length} server(s), ${detection.candidates.length} LLM candidate(s) (reason=${detection.reason}).`,
    );

    if (detection.reason === "ok" && detection.bestMatch) {
      const toolName = `${detection.bestMatch.server.name}__${detection.bestMatch.matchedTool.name}`;
      console.log(
        `Auto-configuring target LLM (via Beacon): ${toolName} @ ${cfg.target.beaconUrl}`,
      );
      const next: Config = {
        ...cfg,
        target: { ...cfg.target, toolName },
      };
      saveConfig(next);
      await onConfigUpdated(next);
    } else if (detection.reason === "ambiguous") {
      console.log(
        "Multiple LLM candidates discovered — auto-pick skipped. Use POST /api/beacon/scan to see them and POST /api/target to pin one.",
      );
    } else {
      console.log(
        "No LLM candidates discovered. Start an LLM MCP on the same network, then POST /api/beacon/scan?autoSave=1.",
      );
    }
  } catch (err) {
    console.warn("LLM auto-detection failed:", (err as Error).message);
  }
}

const TOOL_FETCH_INITIAL_DELAY_MS = 1500;
const TOOL_FETCH_MAX_DELAY_MS = 60_000;
const TOOL_REFRESH_INTERVAL_MS = 5 * 60_000;

// Monotonic counter: a newer refresh (credential change, periodic tick)
// invalidates any retry loop still in flight, so a slow old fetch can never
// overwrite a fresh result.
let refreshGeneration = 0;

/**
 * Fetch the upstream catalog for Beacon announcements, retrying with backoff
 * until it succeeds or a newer refresh supersedes it. The Python upstream
 * takes ~40s to boot, so a single attempt at startup always loses the race.
 * On failure the last good list is kept — announcing 0 tools makes Beacon
 * drop the whole catalog until the next success.
 */
function refreshToolCache(): void {
  const generation = ++refreshGeneration;
  void (async () => {
    let delay = TOOL_FETCH_INITIAL_DELAY_MS;
    for (let attempt = 1; generation === refreshGeneration; attempt++) {
      try {
        if (!(await upstream.health())) throw new Error("upstream not ready");
        const full = await fetchUpstreamTools();
        if (generation !== refreshGeneration) return;
        // Slim the announce payload to {name, description} — full inputSchema for
        // 118 Nextcloud tools exceeds the 64 KB UDP datagram ceiling. Beacon
        // fetches full schemas over HTTP.
        cachedTools = full.map((t) => {
          const tool = t as { name?: string; description?: string };
          return { name: tool.name, description: tool.description };
        });
        // Same merge as /mcp's tools/list: Talk tools shadow upstream ones.
        cachedTools = cachedTools.filter((t) => !TALK_TOOL_NAMES.has(String((t as { name?: string }).name)));
        console.log(
          `Cached ${cachedTools.length} upstream tools for Beacon announcements (attempt ${attempt})`,
        );
        return;
      } catch (err) {
        console.warn(
          `Failed to fetch upstream tools for Beacon (attempt ${attempt}): ${(err as Error).message}. Retrying in ${Math.round(delay / 1000)}s.`,
        );
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, TOOL_FETCH_MAX_DELAY_MS);
      }
    }
  })();
}

async function main(): Promise<void> {
  console.log("Starting nextcloud-mcp wrapper...");

  let config: Config = loadConfig();
  saveConfig(config);

  if (config.nextcloud.url && config.nextcloud.username && config.nextcloud.appPassword) {
    await upstream.writeEnv({
      url: config.nextcloud.url,
      username: config.nextcloud.username,
      appPassword: config.nextcloud.appPassword,
      authToken: config.server.upstreamAuthToken,
    });
    await upstream.restart();
    refreshToolCache();
  } else {
    console.log("Nextcloud credentials not set yet — open the Web UI to configure.");
  }

  // Periodic re-fetch catches upstream restarts and catalog changes.
  setInterval(() => {
    if (config.nextcloud.url && config.nextcloud.username && config.nextcloud.appPassword) {
      refreshToolCache();
    }
  }, TOOL_REFRESH_INTERVAL_MS).unref();

  const getConfig = (): Config => config;

  const upstreamInputsChanged = (prev: Config, next: Config): boolean =>
    prev.nextcloud.url !== next.nextcloud.url ||
    prev.nextcloud.username !== next.nextcloud.username ||
    prev.nextcloud.appPassword !== next.nextcloud.appPassword;

  const watcherInputsChanged = (prev: Config, next: Config): boolean =>
    prev.watcher.enabled !== next.watcher.enabled ||
    prev.nextcloud.url !== next.nextcloud.url ||
    prev.nextcloud.username !== next.nextcloud.username ||
    prev.nextcloud.appPassword !== next.nextcloud.appPassword;

  const onConfigUpdated = async (next: Config): Promise<void> => {
    const prev = config;
    config = next;

    const hasCreds = Boolean(
      config.nextcloud.url && config.nextcloud.username && config.nextcloud.appPassword,
    );
    if (!hasCreds) {
      await watcherManager.stop();
      return;
    }

    if (upstreamInputsChanged(prev, next)) {
      await upstream.writeEnv({
        url: config.nextcloud.url,
        username: config.nextcloud.username,
        appPassword: config.nextcloud.appPassword,
        authToken: config.server.upstreamAuthToken,
      });
      await upstream.restart();
      refreshToolCache();
    }

    if (watcherInputsChanged(prev, next)) {
      await watcherManager.stop();
      if (config.watcher.enabled) await watcherManager.start();
    }
  };

  const app = createApi({
    getConfig,
    onConfigUpdated,
    getWatcherStatus: () => watcherManager.status(),
    rescanWatchers: async () => {
      await watcherManager.rescan();
    },
  });
  const port = config.server.port;
  const discoveryPort = config.server.discoveryPort;

  const server = app.listen(port, () => {
    console.log(`Web UI:       http://localhost:${port}`);
    console.log(`MCP endpoint: http://localhost:${port}/mcp`);

    void maybeAutoConfigureTarget(getConfig, onConfigUpdated);

    createMultiDiscoveryResponder(
      [
        {
          name: "nextcloud-mcp",
          description:
            "Nextcloud (Notes, Calendar, Contacts, Files, Deck, Talk, Cookbook, Tables, Sharing, News, Collectives) exposed as MCP (wraps cbcoutinho/nextcloud-mcp-server)",
          tools: () => [
            ...cachedTools,
            ...getTalkTools().map((t) => ({ name: t.name, description: t.description })),
          ],
          port,
          path: "/mcp",
        },
      ],
      { listenPort: discoveryPort },
    );

    // Start the polling watchers after the HTTP server is listening, so the
    // UI is reachable even if watcher init hits a transient error.
    if (config.watcher.enabled) {
      void watcherManager.start().catch((err) => {
        console.warn("Watcher startup failed:", (err as Error).message);
      });
    }
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await watcherManager.stop();
    } catch (err) {
      console.warn("Watcher shutdown error:", (err as Error).message);
    }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
