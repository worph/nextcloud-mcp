import { createProxyMiddleware, type Options } from "http-proxy-middleware";
import type { RequestHandler } from "express";
import type { Config } from "./types.js";

export function createMcpProxy(getConfig: () => Config): RequestHandler {
  const opts: Options = {
    target: "http://127.0.0.1:8000",
    changeOrigin: true,
    ws: true,
    xfwd: false,
    pathRewrite: () => "/mcp",
    router: (_req) => {
      const cfg = getConfig();
      return `http://127.0.0.1:${cfg.server.upstreamPort}`;
    },
    on: {
      error: (err, _req, res) => {
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
      },
    },
  };

  return createProxyMiddleware(opts);
}
