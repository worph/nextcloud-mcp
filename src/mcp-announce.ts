/**
 * UDP discovery responder — lets MCP servers announce themselves to the Beacon aggregator.
 * Ported from ../beacon/sdk/node/mcp-announce.js to ESM.
 */
import * as dgram from "dgram";

// Ack mode: when a discovery request carries `ack`, reply with 8 bytes —
// "BCNA" + the FNV-1a 32-bit hash of the manifest, big-endian — and send the
// manifest itself only when Beacon asks for it 1:1 with
// {"type":"manifest","rev":"<the hash, 8 hex>"} — one ack per hosted server,
// so the hash is what tells Beacon which manifest to ask for.
// Full manifests answered to a broadcast all land on Beacon at once and
// overflow its socket buffer; an ack never can. Requests without `ack` (an
// older Beacon) still get the full manifest. See beacon/sdk/node/mcp-announce.js.
const ACK_MAGIC = Buffer.from("BCNA");

function fnv1a32(buf: Buffer): number {
  let h = 0x811c9dc5;
  for (const b of buf) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

function ackFor(manifest: string): Buffer {
  const ack = Buffer.alloc(8);
  ACK_MAGIC.copy(ack, 0);
  ack.writeUInt32BE(fnv1a32(Buffer.from(manifest)), 4);
  return ack;
}

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
      const manifests = announcements.map(manifestFor);
      if (msg.type === "manifest") {
        for (const manifest of manifests) {
          const rev = ackFor(manifest).readUInt32BE(4).toString(16).padStart(8, "0");
          if (!msg.rev || msg.rev === rev) socket.send(manifest, rinfo.port, rinfo.address);
        }
      } else if (msg.type === "discovery") {
        console.log(
          `Discovery request from ${rinfo.address}:${rinfo.port}, ${msg.ack ? "acking" : "announcing"} ${announcements.length} server(s)`,
        );
        for (const manifest of manifests) {
          socket.send(msg.ack ? ackFor(manifest) : manifest, rinfo.port, rinfo.address);
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
