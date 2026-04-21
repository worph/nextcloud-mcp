import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { Config, ConfigSchema } from "./types.js";

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(process.cwd(), "data/config.json");

export function generateAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function defaultConfig(): Config {
  const defaultTemplate: Record<string, string> = {
    prompt: "[Nextcloud Talk — {{conversationName}}] {{actorDisplayName}}: {{message}}",
  };
  return {
    nextcloud: {
      url: process.env.NEXTCLOUD_HOST ?? "",
      username: process.env.NEXTCLOUD_USERNAME ?? "",
      appPassword: process.env.NEXTCLOUD_PASSWORD ?? "",
    },
    target: {
      mode: ((process.env.TARGET_MODE ?? "auto") as "auto" | "direct" | "off"),
      beaconUrl: process.env.BEACON_URL ?? "http://beacon:9300/mcp/",
      toolName: process.env.TARGET_TOOL ?? "",
      directUrl: process.env.TARGET_DIRECT_URL ?? "",
      directAuthToken: process.env.TARGET_DIRECT_AUTH_TOKEN ?? "",
      paramTemplate: defaultTemplate,
      llmToolNames: ["query_claude", "chat", "ask", "send_prompt", "llm_chat"],
    },
    watcher: {
      enabled: (process.env.WATCHER_ENABLED ?? "true").toLowerCase() === "true",
      replyPrefix: process.env.WATCHER_REPLY_PREFIX ?? "🤖 ",
      longPollTimeoutSec: Number(process.env.WATCHER_LONG_POLL_TIMEOUT_SEC ?? 30),
      suppressAfterHumanSendSec: Number(
        process.env.WATCHER_SUPPRESS_AFTER_HUMAN_SEND_SEC ?? 60,
      ),
      contextMessages: Number(process.env.WATCHER_CONTEXT_MESSAGES ?? 20),
    },
    server: {
      port: Number(process.env.PORT ?? 9650),
      discoveryPort: Number(process.env.DISCOVERY_PORT ?? 9099),
      upstreamPort: Number(process.env.UPSTREAM_PORT ?? 8000),
      upstreamAuthToken: generateAuthToken(),
    },
  };
}

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(`Config file not found at ${CONFIG_PATH}, creating default...`);
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cfg = defaultConfig();
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf-8");
    return cfg;
  }

  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      "Invalid config:\n" +
        result.error.errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n"),
    );
  }
  if (!result.data.server.upstreamAuthToken) {
    result.data.server.upstreamAuthToken = generateAuthToken();
    saveConfig(result.data);
  }
  return result.data;
}

export function saveConfig(config: Config): void {
  const result = ConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      "Invalid config:\n" +
        result.error.errors.map((e) => `  - ${e.path.join(".")}: ${e.message}`).join("\n"),
    );
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(result.data, null, 2), "utf-8");
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length < 10) return "***";
  return `${secret.substring(0, 4)}${"*".repeat(12)}${secret.substring(secret.length - 4)}`;
}

export function getMaskedConfig(config: Config): Config {
  const masked: Config = JSON.parse(JSON.stringify(config));
  masked.nextcloud.appPassword = maskSecret(masked.nextcloud.appPassword);
  masked.server.upstreamAuthToken = maskSecret(masked.server.upstreamAuthToken);
  masked.target.directAuthToken = maskSecret(masked.target.directAuthToken);
  return masked;
}

export function unmaskIncoming(incoming: Config, current: Config): Config {
  const merged: Config = JSON.parse(JSON.stringify(incoming));
  if (!merged.nextcloud.appPassword || merged.nextcloud.appPassword.includes("*")) {
    merged.nextcloud.appPassword = current.nextcloud.appPassword;
  }

  merged.target = merged.target ?? current.target;
  if (!merged.target.directAuthToken || merged.target.directAuthToken.includes("*")) {
    merged.target.directAuthToken = current.target.directAuthToken;
  }

  merged.watcher = merged.watcher ?? current.watcher;

  merged.server = merged.server ?? current.server;
  merged.server.upstreamAuthToken = current.server.upstreamAuthToken;
  merged.server.port = current.server.port;
  merged.server.discoveryPort = current.server.discoveryPort;
  merged.server.upstreamPort = current.server.upstreamPort;
  return merged;
}

export function normalizeNextcloudUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
