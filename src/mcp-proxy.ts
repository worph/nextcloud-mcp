import { createProxyMiddleware, fixRequestBody, responseInterceptor, type Options } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { IncomingMessage } from "http";
import { callTalkTool, getTalkTools, TALK_TOOL_NAMES } from "./talk-mcp.js";
import type { Config } from "./types.js";

/**
 * /mcp — one MCP server combining the upstream Nextcloud tools with our Talk
 * tools. Everything streams to the upstream untouched (sessions, resources,
 * prompts, the GET notification stream) except two JSON-RPC methods:
 *
 *   - tools/list: the upstream reply is rewritten to append the Talk tools.
 *   - tools/call for a Talk tool: answered here, never forwarded.
 *
 * Talk tools win name clashes: newer upstream releases ship their own `talk_*`
 * tools, and those are hidden so each name has exactly one implementation.
 * Batched JSON-RPC (dropped from the spec in 2025-06) is forwarded as-is.
 */
export function createMcpProxy(getConfig: () => Config): RequestHandler {
  const baseOptions: Options = {
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    xfwd: false,
    pathRewrite: () => "/mcp",
    router: (_req) => {
      const cfg = getConfig();
      return `http://127.0.0.1:${cfg.server.upstreamPort}`;
    },
  };

  const onError: NonNullable<Options["on"]>["error"] = (err, _req, res) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("MCP proxy error:", msg);
    if (res && "writeHead" in res && !res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: "upstream_unreachable",
          message:
            "The wrapped nextcloud-mcp-server process is not reachable. Check the config — did you save the Nextcloud URL, username, and app password?",
        }),
      );
    }
  };

  // Streaming pass-through: the default for every request.
  const passThrough = createProxyMiddleware({
    ...baseOptions,
    ws: true,
    on: { proxyReq: fixRequestBody, error: onError },
  });

  // Buffered variant, used only for tools/list so the reply can be rewritten.
  // A tools/list reply is a single JSON body or a short SSE stream that ends
  // with the response, so buffering it is safe.
  const listProxy = createProxyMiddleware({
    ...baseOptions,
    selfHandleResponse: true,
    on: {
      proxyReq: fixRequestBody,
      error: onError,
      proxyRes: responseInterceptor(async (buffer, proxyRes) => {
        if (proxyRes.statusCode !== 200) return buffer;
        return mergeToolsListReply(buffer.toString("utf8"), contentType(proxyRes));
      }),
    },
  });

  return (req, res, next) => {
    const msg = (req as { body?: unknown }).body as JsonRpcRequest | undefined;
    if (req.method === "POST" && msg && !Array.isArray(msg) && typeof msg === "object") {
      if (msg.method === "tools/list") return listProxy(req, res, next);
      const toolName = msg.method === "tools/call" ? msg.params?.name : undefined;
      if (typeof toolName === "string" && TALK_TOOL_NAMES.has(toolName)) {
        void callTalkTool(toolName, (msg.params?.arguments as Record<string, unknown>) ?? {}).then(
          (result) => res.json({ jsonrpc: "2.0", id: msg.id ?? null, result }),
          (err) => {
            const message = err instanceof Error ? err.message : String(err);
            res.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32603, message } });
          },
        );
        return;
      }
    }
    return passThrough(req, res, next);
  };
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; [key: string]: unknown };
}

interface ToolsListResult {
  tools?: { name?: string }[];
  nextCursor?: string;
}

function contentType(res: IncomingMessage): string {
  return String(res.headers["content-type"] ?? "").toLowerCase();
}

/**
 * Drop upstream tools shadowed by a Talk tool, and append the Talk tools to
 * the last page (the one without nextCursor) so pagination stays coherent.
 */
export function mergeTools(result: ToolsListResult): ToolsListResult {
  if (!Array.isArray(result.tools)) return result;
  const tools = result.tools.filter((t) => !TALK_TOOL_NAMES.has(String(t.name)));
  if (!result.nextCursor) tools.push(...getTalkTools());
  return { ...result, tools };
}

function mergeMessage(message: unknown): unknown {
  const m = message as { result?: ToolsListResult } | null;
  if (!m || typeof m !== "object" || !m.result || !Array.isArray(m.result.tools)) return message;
  return { ...m, result: mergeTools(m.result) };
}

/** Rewrite a tools/list reply, whether it came back as plain JSON or SSE. */
export function mergeToolsListReply(body: string, type: string): string {
  if (type.includes("application/json")) {
    try {
      return JSON.stringify(mergeMessage(JSON.parse(body)));
    } catch {
      return body;
    }
  }
  if (!type.includes("text/event-stream")) return body;
  // SSE: rewrite each event's data. An event's data may span several `data:`
  // lines; they are re-emitted as one, which is equivalent.
  return body
    .split(/\r?\n\r?\n/)
    .map((event) => {
      const lines = event.split(/\r?\n/);
      const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
      if (data.length === 0) return event;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.join("\n"));
      } catch {
        return event;
      }
      const other = lines.filter((l) => !l.startsWith("data:"));
      return [...other, `data: ${JSON.stringify(mergeMessage(parsed))}`].join("\n");
    })
    .join("\n\n");
}
