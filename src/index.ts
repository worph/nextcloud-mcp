import { createApi } from "./api.js";
import { discoverServers } from "./beacon-discover.js";
import { loadConfig, saveConfig } from "./config.js";
import { detectLlmServer } from "./llm-detect.js";
import { createMultiDiscoveryResponder } from "./mcp-announce.js";
import { getTalkTools } from "./talk-mcp.js";
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

async function refreshToolCache(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await upstream.health()) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const full = await fetchUpstreamTools();
    // Slim the announce payload to {name, description} — full inputSchema for
    // 118 Nextcloud tools exceeds the 64 KB UDP datagram ceiling. Beacon
    // fetches full schemas over HTTP when callers need them.
    cachedTools = full.map((t) => {
      const tool = t as { name?: string; description?: string };
      return { name: tool.name, description: tool.description };
    });
    console.log(`Cached ${cachedTools.length} upstream tools for Beacon announcements`);
  } catch (err) {
    console.warn("Failed to fetch upstream tools for Beacon:", (err as Error).message);
    cachedTools = [];
  }
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
    void refreshToolCache();
  } else {
    console.log("Nextcloud credentials not set yet — open the Web UI to configure.");
  }

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
      void refreshToolCache();
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
    console.log(`Talk MCP:     http://localhost:${port}/talk-mcp`);

    void maybeAutoConfigureTarget(getConfig, onConfigUpdated);

    createMultiDiscoveryResponder(
      [
        {
          name: "nextcloud-mcp",
          description:
            "Nextcloud (Notes, Calendar, Contacts, Files, Deck, Cookbook, Tables, Sharing, News, Collectives) exposed as MCP (wraps cbcoutinho/nextcloud-mcp-server)",
          tools: () => cachedTools,
          port,
          path: "/mcp",
        },
        {
          name: "nextcloud-talk-mcp",
          description:
            "Nextcloud Talk (chat) exposed as MCP — send/receive messages in Nextcloud conversations",
          tools: () => getTalkTools().map((t) => ({ name: t.name, description: t.description })),
          port,
          path: "/talk-mcp",
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
