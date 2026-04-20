/**
 * Client-side Beacon discovery — sends a UDP probe to the multicast group
 * and collects `announce` replies.
 *
 * Uses a randomly-bound UDP socket (NOT 9099 — that's held by our own
 * discovery responder) so the kernel can deliver responses only to us.
 */
import * as dgram from "dgram";

export interface DiscoveredServer {
  name: string;
  description: string;
  url: string;
  path: string;
  tools: { name: string; description?: string }[];
  port: number;
  /** Source IP of the announce — useful for debugging. */
  remote: string;
  auth?: { type: string; token?: string };
}

export async function discoverServers(
  opts: { timeoutMs?: number; probePort?: number } = {},
): Promise<DiscoveredServer[]> {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const probePort = opts.probePort ?? 9099;

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const seen = new Map<string, DiscoveredServer>();
    let closed = false;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      resolve([...seen.values()]);
    };

    socket.on("message", (data, rinfo) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        if (msg.type !== "announce" || typeof msg.name !== "string") return;
        const name = msg.name;
        const path = (typeof msg.path === "string" ? msg.path : "/mcp") || "/mcp";
        const port = typeof msg.port === "number" ? msg.port : 9099;
        const url = `http://${rinfo.address}:${port}${path}`;
        const tools = Array.isArray(msg.tools)
          ? (msg.tools as unknown[])
              .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
              .map((t) => ({
                name: String(t.name ?? ""),
                description: typeof t.description === "string" ? t.description : undefined,
              }))
              .filter((t) => t.name)
          : [];
        // Key by (remote, name) so multiple servers on the same host don't
        // overwrite each other, and the same server announced twice dedupes.
        seen.set(`${rinfo.address}|${name}`, {
          name,
          description: typeof msg.description === "string" ? msg.description : "",
          url,
          path,
          port,
          tools,
          remote: rinfo.address,
          auth: (msg.auth as DiscoveredServer["auth"]) ?? undefined,
        });
      } catch {
        /* ignore malformed */
      }
    });

    socket.on("error", (err) => {
      console.warn("Beacon scan socket error:", err.message);
      finish();
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(1);
      } catch {
        /* ignore */
      }
      const probe = Buffer.from(JSON.stringify({ type: "discovery" }));
      // Send to multicast group AND broadcast — covers networks where one
      // delivery path is blocked.
      try {
        socket.send(probe, probePort, "239.255.99.1");
      } catch {
        /* ignore */
      }
      try {
        socket.send(probe, probePort, "255.255.255.255");
      } catch {
        /* ignore */
      }
      setTimeout(finish, timeoutMs);
    });
  });
}
