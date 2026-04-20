import express, { type Request, type Response, Router } from "express";
import * as path from "path";
import { fileURLToPath } from "url";
import { recent as recentActivity, record as recordActivity } from "./activity-log.js";
import { discoverServers } from "./beacon-discover.js";
import {
  getMaskedConfig,
  loadConfig,
  normalizeNextcloudUrl,
  saveConfig,
  unmaskIncoming,
} from "./config.js";
import { detectLlmServer } from "./llm-detect.js";
import { createMcpProxy } from "./mcp-proxy.js";
import { createTalkMcpHandler } from "./talk-mcp.js";
import { testNextcloudConnection } from "./nextcloud-test.js";
import * as upstream from "./upstream.js";
import {
  Config,
  ConfigSchema,
  type StatusResponse,
  type TargetConfig,
  type WatcherConfig,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface WatcherStatus {
  running: boolean;
  watchedRooms: {
    token: string;
    displayName: string;
    roomType: number;
    lastKnownMessageId: number;
    lastPollAt?: number;
  }[];
}

export interface ApiDependencies {
  getConfig: () => Config;
  onConfigUpdated: (cfg: Config) => Promise<void>;
  getWatcherStatus: () => WatcherStatus;
  rescanWatchers: () => Promise<void>;
}

export function createApi(deps: ApiDependencies): express.Application {
  const app = express();

  // Mount /mcp proxy BEFORE json body parser — proxy needs the raw stream.
  app.use("/mcp", createMcpProxy(deps.getConfig));

  app.use(express.json({ limit: "2mb" }));

  // Talk MCP lives at /talk-mcp — expects a parsed JSON body.
  app.all("/talk-mcp", createTalkMcpHandler());

  app.use(express.static(path.join(__dirname, "../web")));
  app.use("/api", createApiRouter(deps));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(__dirname, "../web/index.html"));
  });

  return app;
}

function createApiRouter(deps: ApiDependencies): Router {
  const router = Router();

  router.get("/config", (_req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      res.json(getMaskedConfig(cfg));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/config", async (req: Request, res: Response) => {
    try {
      const current = loadConfig();
      const incoming = req.body as Partial<Config>;

      if (!incoming.nextcloud?.url) {
        res.status(400).json({ error: "nextcloud.url is required" });
        return;
      }
      if (!incoming.nextcloud.username) {
        res.status(400).json({ error: "nextcloud.username is required" });
        return;
      }

      const hydrated: Config = {
        nextcloud: {
          url: normalizeNextcloudUrl(incoming.nextcloud.url),
          username: incoming.nextcloud.username,
          appPassword: incoming.nextcloud.appPassword ?? "",
        },
        features: {
          semanticSearch:
            incoming.features?.semanticSearch ?? current.features.semanticSearch,
        },
        target: (incoming.target ?? current.target) as TargetConfig,
        watcher: (incoming.watcher ?? current.watcher) as WatcherConfig,
        server: current.server,
      };

      const merged = unmaskIncoming(hydrated, current);
      const validation = ConfigSchema.safeParse(merged);
      if (!validation.success) {
        res.status(400).json({
          error: "Invalid config",
          details: validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        });
        return;
      }
      saveConfig(validation.data);
      await deps.onConfigUpdated(validation.data);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/test", async (req: Request, res: Response) => {
    try {
      const current = loadConfig();
      const body = req.body as {
        url?: string;
        username?: string;
        appPassword?: string;
      };
      const url = body.url ?? current.nextcloud.url;
      const username = body.username ?? current.nextcloud.username;
      let appPassword = body.appPassword ?? "";
      if (!appPassword || appPassword.includes("*")) appPassword = current.nextcloud.appPassword;
      const result = await testNextcloudConnection(url, username, appPassword);
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  router.get("/status", async (_req: Request, res: Response) => {
    const cfg = deps.getConfig();
    const configured = Boolean(
      cfg.nextcloud.url && cfg.nextcloud.username && cfg.nextcloud.appPassword,
    );
    const upstreamHealthy = configured ? await upstream.health() : false;
    const targetConfigured =
      cfg.target.mode === "off"
        ? false
        : cfg.target.mode === "direct"
          ? Boolean(cfg.target.directUrl && cfg.target.toolName)
          : Boolean(cfg.target.beaconUrl && cfg.target.toolName);
    const response: StatusResponse = {
      configured,
      upstreamHealthy,
      nextcloudUrl: cfg.nextcloud.url,
      username: cfg.nextcloud.username,
      watcher: {
        enabled: cfg.watcher.enabled,
        running: deps.getWatcherStatus().running,
        watchedRoomCount: deps.getWatcherStatus().watchedRooms.length,
      },
      target: {
        mode: cfg.target.mode,
        beaconUrl: cfg.target.beaconUrl,
        directUrl: cfg.target.directUrl,
        toolName: cfg.target.toolName,
        configured: targetConfigured,
      },
    };
    res.json(response);
  });

  // --- Beacon discovery & LLM target -------------------------------------

  router.post("/beacon/scan", async (req: Request, res: Response) => {
    try {
      const cfg = loadConfig();
      const servers = await discoverServers({ timeoutMs: 2000 });
      const detection = detectLlmServer(servers, cfg.target.llmToolNames);

      let saved = false;
      if (
        req.query.autoSave === "1" &&
        cfg.target.mode === "auto" &&
        detection.reason === "ok" &&
        detection.bestMatch
      ) {
        const toolName = `${detection.bestMatch.server.name}__${detection.bestMatch.matchedTool.name}`;
        const next: Config = {
          ...cfg,
          target: { ...cfg.target, toolName },
        };
        saveConfig(next);
        await deps.onConfigUpdated(next);
        saved = true;
      }

      recordActivity({
        kind: "scan",
        detail: `${servers.length} servers, ${detection.candidates.length} LLM candidates (${detection.reason})${saved ? " — auto-saved" : ""}`,
      });

      const toNamespaced = (c: { server: { name: string }; matchedTool: { name: string } }): string =>
        `${c.server.name}__${c.matchedTool.name}`;

      res.json({
        servers,
        candidates: detection.candidates.map((c) => ({
          server: c.server,
          matchedTool: c.matchedTool,
          namespacedToolName: toNamespaced(c),
        })),
        bestMatch: detection.bestMatch
          ? {
              namespacedToolName: toNamespaced(detection.bestMatch),
              serverName: detection.bestMatch.server.name,
              matchedToolName: detection.bestMatch.matchedTool.name,
              serverUrl: detection.bestMatch.server.url,
            }
          : null,
        reason: detection.reason,
        saved,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/target", (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json(getMaskedConfig(cfg).target);
  });

  router.post("/target", async (req: Request, res: Response) => {
    try {
      const current = loadConfig();
      const incoming = (req.body ?? {}) as Partial<TargetConfig>;
      const merged: TargetConfig = {
        mode: (incoming.mode as TargetConfig["mode"]) ?? current.target.mode,
        beaconUrl: incoming.beaconUrl ?? current.target.beaconUrl,
        toolName: incoming.toolName ?? current.target.toolName,
        directUrl: incoming.directUrl ?? current.target.directUrl,
        directAuthToken:
          incoming.directAuthToken && !incoming.directAuthToken.includes("*")
            ? incoming.directAuthToken
            : current.target.directAuthToken,
        paramTemplate: incoming.paramTemplate ?? current.target.paramTemplate,
        llmToolNames: incoming.llmToolNames ?? current.target.llmToolNames,
      };
      const next: Config = { ...current, target: merged };
      const validation = ConfigSchema.safeParse(next);
      if (!validation.success) {
        res.status(400).json({
          error: "Invalid target",
          details: validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        });
        return;
      }
      saveConfig(validation.data);
      await deps.onConfigUpdated(validation.data);
      res.json({ success: true, target: getMaskedConfig(validation.data).target });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Auto-respond watcher ---------------------------------------------

  router.get("/watcher", (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json({ config: cfg.watcher, status: deps.getWatcherStatus() });
  });

  router.post("/watcher", async (req: Request, res: Response) => {
    try {
      const current = loadConfig();
      const incoming = (req.body ?? {}) as Partial<WatcherConfig>;
      const merged: WatcherConfig = {
        enabled: incoming.enabled ?? current.watcher.enabled,
        replyPrefix: incoming.replyPrefix ?? current.watcher.replyPrefix,
        longPollTimeoutSec:
          incoming.longPollTimeoutSec ?? current.watcher.longPollTimeoutSec,
        suppressAfterHumanSendSec:
          incoming.suppressAfterHumanSendSec ?? current.watcher.suppressAfterHumanSendSec,
      };
      const next: Config = { ...current, watcher: merged };
      const validation = ConfigSchema.safeParse(next);
      if (!validation.success) {
        res.status(400).json({
          error: "Invalid watcher config",
          details: validation.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`),
        });
        return;
      }
      saveConfig(validation.data);
      await deps.onConfigUpdated(validation.data);
      res.json({ success: true, config: validation.data.watcher });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/watcher/rescan", async (_req: Request, res: Response) => {
    try {
      await deps.rescanWatchers();
      res.json({ success: true, status: deps.getWatcherStatus() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // --- Activity feed (used by the UI) -----------------------------------

  router.get("/activity", (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 50);
    res.json({ events: recentActivity(Math.max(1, Math.min(limit, 50))) });
  });

  return router;
}
