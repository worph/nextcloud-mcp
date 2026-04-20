/**
 * UDP discovery responder — lets MCP servers announce themselves to the Beacon aggregator.
 * Ported from ../beacon/sdk/node/mcp-announce.js to ESM.
 */
import * as dgram from "dgram";

export interface Announcement {
  name: string;
  description: string;
  /**
   * Tool list exposed to Beacon. Pass an array for a static list, or a callback
   * to evaluate lazily on each discovery probe — useful when tools come from a
   * wrapped upstream that can be reconfigured at runtime.
   */
  tools: unknown[] | (() => unknown[]);
  port: number;
  path?: string;
  auth?: { type: string; token: string };
}

export interface DiscoveryResponderOptions extends Announcement {
  listenPort?: number;
}

function manifestFor(a: Announcement): string {
  const payload: Record<string, unknown> = {
    type: "announce",
    name: a.name,
    description: a.description,
    tools: typeof a.tools === "function" ? a.tools() : a.tools,
    port: a.port,
  };
  if (a.path) payload.path = a.path;
  if (a.auth) payload.auth = a.auth;
  return JSON.stringify(payload);
}

/**
 * Create a UDP responder that answers discovery probes with one or more
 * announce payloads. Multiple MCP servers hosted in the same process should
 * share a single responder — only one socket can own UDP 9099.
 */
export function createMultiDiscoveryResponder(
  announcements: Announcement[],
  opts: { listenPort?: number } = {},
): dgram.Socket {
  const listenPort = opts.listenPort ?? 9099;
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });

  socket.on("message", (data, rinfo) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "discovery") {
        console.log(
          `Discovery request from ${rinfo.address}:${rinfo.port}, announcing ${announcements.length} server(s)`,
        );
        for (const a of announcements) {
          socket.send(manifestFor(a), rinfo.port, rinfo.address);
        }
      }
    } catch {
      /* ignore malformed */
    }
  });

  socket.on("error", (err) => {
    console.error("Announce socket error:", err.message);
  });

  socket.bind(listenPort, "0.0.0.0", () => {
    try {
      socket.addMembership("239.255.99.1");
    } catch (err) {
      console.warn("Failed to join multicast group (continuing):", err);
    }
    const names = announcements.map((a) => a.name).join(", ");
    console.log(
      `Discovery responder listening on UDP :${listenPort} (multicast 239.255.99.1) for: ${names}`,
    );
  });

  return socket;
}

/**
 * Back-compat single-server helper — delegates to the multi responder.
 */
export function createDiscoveryResponder(opts: DiscoveryResponderOptions): dgram.Socket {
  const { listenPort, ...rest } = opts;
  return createMultiDiscoveryResponder([rest], { listenPort });
}
