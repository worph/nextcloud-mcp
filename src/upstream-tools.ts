/**
 * Fetches the upstream MCP server's `tools/list` via the streamable-HTTP transport
 * so we can publish them in our Beacon announce payload.
 *
 * Performs the standard MCP handshake: initialize → notifications/initialized → tools/list.
 */

const UPSTREAM_PORT = Number(process.env.UPSTREAM_PORT ?? 8000);

function parseSseData(text: string): unknown[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice(6))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

export async function fetchUpstreamTools(timeoutMs = 8000): Promise<unknown[]> {
  const base = `http://127.0.0.1:${UPSTREAM_PORT}/mcp`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    // 1. initialize — captures session id from response header
    const initRes = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "nextcloudmcp-wrapper", version: "0.1.0" },
        },
      }),
      signal: ctrl.signal,
    });
    if (!initRes.ok) throw new Error(`initialize ${initRes.status}`);
    const sid = initRes.headers.get("mcp-session-id");
    if (!sid) throw new Error("upstream did not return mcp-session-id");
    await initRes.text(); // drain

    // 2. notifications/initialized
    await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: ctrl.signal,
    });

    // 3. tools/list
    const listRes = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      signal: ctrl.signal,
    });
    if (!listRes.ok) throw new Error(`tools/list ${listRes.status}`);
    const text = await listRes.text();
    const msgs = parseSseData(text);
    for (const m of msgs) {
      const r = (m as { result?: { tools?: unknown[] } }).result;
      if (r?.tools) return r.tools;
    }
    throw new Error("tools/list response contained no tools");
  } finally {
    clearTimeout(timer);
  }
}
