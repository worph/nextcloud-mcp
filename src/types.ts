import { z } from "zod";

const DEFAULT_PARAM_TEMPLATE: Record<string, string> = {
  // Most LLM MCPs (claude-code-container, OpenAI-style wrappers, telegram-mcp's
  // echo helpers) accept `prompt`. If your downstream expects a different arg
  // name, edit this in the Web UI or POST /api/target with your own template.
  prompt: "[Nextcloud Talk — {{conversationName}}] {{actorDisplayName}}: {{message}}",
};

const DEFAULT_LLM_TOOL_NAMES = [
  "query_claude",
  "chat",
  "ask",
  "send_prompt",
  "llm_chat",
];

const TargetSchema = z
  .object({
    /**
     * - "auto"   → route LLM calls through the Beacon aggregator using `call`
     *              on `beaconUrl`; `toolName` is the namespaced name (e.g.
     *              "claude-code-container__query_claude"). Selected at scan time.
     * - "direct" → call `directUrl` directly. Escape hatch for non-Beacon setups
     *              or specific pinning.
     * - "off"    → disable LLM forwarding entirely.
     */
    mode: z.enum(["auto", "direct", "off"]).default("auto"),
    beaconUrl: z.string().default("http://beacon:9300/mcp/"),
    toolName: z.string().default(""),
    directUrl: z.string().default(""),
    directAuthToken: z.string().default(""),
    paramTemplate: z.record(z.string()).default(DEFAULT_PARAM_TEMPLATE),
    llmToolNames: z.array(z.string()).default(DEFAULT_LLM_TOOL_NAMES),
  })
  .default({
    mode: "auto",
    beaconUrl: "http://beacon:9300/mcp/",
    toolName: "",
    directUrl: "",
    directAuthToken: "",
    paramTemplate: DEFAULT_PARAM_TEMPLATE,
    llmToolNames: DEFAULT_LLM_TOOL_NAMES,
  });

/**
 * Polling-based "respond as me" auto-responder. When enabled, the wrapper
 * watches each one-to-one Talk conversation via long-poll and listens for
 * direct @Mael mentions through the notifications feed. See
 * docs/design-decisions.md ADR-001 for why we chose polling over webhooks.
 */
const WatcherSchema = z
  .object({
    enabled: z.boolean().default(false),
    /**
     * Prepended to every auto-reply so humans can tell AI answers from real
     * ones. Empty string to disable.
     */
    replyPrefix: z.string().default("🤖 "),
    /**
     * How long each long-poll call blocks on the server. Applies to DMs and
     * groups alike. Keep ≤60 — that's Nextcloud's server-side cap.
     */
    longPollTimeoutSec: z.number().int().min(5).max(60).default(30),
    /**
     * If the human user posts in a conversation from another client (phone,
     * browser, desktop), skip auto-responding in that conversation for this
     * many seconds — keeps the bot out of the way when the user is actively
     * chatting.
     */
    suppressAfterHumanSendSec: z.number().int().min(0).max(3600).default(60),
  })
  .default({
    enabled: false,
    replyPrefix: "🤖 ",
    longPollTimeoutSec: 30,
    suppressAfterHumanSendSec: 60,
  });

export const ConfigSchema = z.object({
  nextcloud: z.object({
    url: z.string(),
    username: z.string(),
    appPassword: z.string(),
  }),
  features: z
    .object({
      semanticSearch: z.boolean().default(false),
    })
    .default({ semanticSearch: false }),
  target: TargetSchema,
  watcher: WatcherSchema,
  server: z
    .object({
      port: z.number().default(9650),
      discoveryPort: z.number().default(9099),
      upstreamPort: z.number().default(8000),
      upstreamAuthToken: z.string(),
    })
    .default({
      port: 9650,
      discoveryPort: 9099,
      upstreamPort: 8000,
      upstreamAuthToken: "",
    }),
});

export type Config = z.infer<typeof ConfigSchema>;
export type TargetConfig = z.infer<typeof TargetSchema>;
export type WatcherConfig = z.infer<typeof WatcherSchema>;

export interface StatusResponse {
  configured: boolean;
  upstreamHealthy: boolean;
  nextcloudUrl: string;
  username: string;
  watcher: {
    enabled: boolean;
    running: boolean;
    watchedRoomCount: number;
  };
  target: {
    mode: string;
    beaconUrl: string;
    directUrl: string;
    toolName: string;
    configured: boolean;
  };
  lastError?: string;
}
