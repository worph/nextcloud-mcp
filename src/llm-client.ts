/**
 * Downstream MCP client. Supports two routing modes:
 *
 *   - "auto"   : route the call through the Beacon aggregator. Invokes
 *                Beacon's `call` tool with {tool_name, arguments}. Beacon
 *                resolves the namespaced tool back to the underlying MCP.
 *                This is the default — one fixed endpoint, zero auth config,
 *                transparent failover when downstream LLMs move.
 *
 *   - "direct" : bypass Beacon and hit a pinned URL directly. Used when no
 *                aggregator is available or the operator wants to fence off
 *                a specific target.
 *
 * Intentionally stateless: a new transport per call. Each @mention is its own
 * conversation turn — persistent sessions would require per-sender pools.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TargetConfig } from "./types.js";

export interface MessageContext {
  message: string;
  actorId: string;
  actorDisplayName: string;
  conversationToken: string;
  conversationName: string;
  messageId: string | number;
  rawPayload?: unknown;
}

function resolveTemplateValue(value: string, ctx: MessageContext): string {
  return value.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const v = (ctx as unknown as Record<string, unknown>)[key];
    if (v === undefined || v === null) return "";
    return typeof v === "string" ? v : String(v);
  });
}

export function resolveTemplate(
  tpl: Record<string, string>,
  ctx: MessageContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tpl)) out[k] = resolveTemplateValue(v, ctx);
  return out;
}

export interface CallLlmResult {
  text: string;
  isError: boolean;
  raw: unknown;
}

interface ResolvedCall {
  url: URL;
  toolName: string;
  toolArgs: Record<string, unknown>;
  headers: Record<string, string>;
}

function resolveCall(target: TargetConfig, ctx: MessageContext): ResolvedCall {
  const params = resolveTemplate(target.paramTemplate, ctx);

  if (target.mode === "auto") {
    if (!target.beaconUrl) throw new Error("target.beaconUrl is required (mode=auto)");
    if (!target.toolName) {
      throw new Error(
        "target.toolName is required (mode=auto) — run POST /api/beacon/scan?autoSave=1 to set it",
      );
    }
    return {
      url: new URL(target.beaconUrl),
      toolName: "call",
      toolArgs: { tool_name: target.toolName, arguments: params },
      headers: {},
    };
  }

  // mode === "direct"
  if (!target.directUrl) throw new Error("target.directUrl is required (mode=direct)");
  if (!target.toolName) throw new Error("target.toolName is required (mode=direct)");
  const headers: Record<string, string> = {};
  if (target.directAuthToken) headers["Authorization"] = `Bearer ${target.directAuthToken}`;
  return {
    url: new URL(target.directUrl),
    toolName: target.toolName,
    toolArgs: params,
    headers,
  };
}

export async function callTargetLlm(
  target: TargetConfig,
  ctx: MessageContext,
  timeoutMs = 180_000,
): Promise<CallLlmResult> {
  if (target.mode === "off") {
    throw new Error("target.mode is 'off' — LLM forwarding disabled");
  }

  const call = resolveCall(target, ctx);
  const transport = new StreamableHTTPClientTransport(call.url, {
    requestInit: { headers: call.headers },
  });
  const client = new Client(
    { name: "nextcloudmcp-talk-bot", version: "0.1.0" },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: call.toolName, arguments: call.toolArgs },
      undefined,
      { timeout: timeoutMs },
    );

    const content = (result as { content?: unknown[] }).content ?? [];
    const text = Array.isArray(content)
      ? content
          .map((c) => (c as { type?: string; text?: string }))
          .filter((c) => c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n")
          .trim()
      : "";
    return {
      text,
      isError: Boolean((result as { isError?: boolean }).isError),
      raw: result,
    };
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    try {
      await transport.close();
    } catch {
      /* ignore */
    }
  }
}
