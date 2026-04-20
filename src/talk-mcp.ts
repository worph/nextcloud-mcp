/**
 * MCP server exposing Nextcloud Talk (chat) tools.
 *
 * Mounted at /talk-mcp alongside the existing /mcp proxy so Beacon can
 * discover them as a separate server (`nextcloud-talk-mcp`). Uses the
 * streamable-HTTP transport from the official MCP SDK.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import {
  createOneToOne,
  getMessages,
  listConversations,
  searchUsers,
  sendMessage,
  type TalkConversation,
} from "./talk-client.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "talk_list_conversations",
    description:
      "List all Nextcloud Talk conversations the user is a participant in. Returns each room's token, type, display name, and unread count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "talk_find_user",
    description:
      "Search Nextcloud users by name or username. Use this to resolve a human-readable name into the `userId` needed for `talk_create_one_to_one`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name or username fragment to search for." },
        limit: { type: "integer", description: "Max results (default 10).", default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_create_one_to_one",
    description:
      "Open or fetch a 1-on-1 Nextcloud Talk conversation with another user. Returns the conversation token (use with `talk_send_message`). Idempotent — if a 1-on-1 already exists with this user, the same token is returned.",
    inputSchema: {
      type: "object",
      properties: {
        userId: {
          type: "string",
          description: "Nextcloud userId (not display name) of the target user. Look up with `talk_find_user`.",
        },
      },
      required: ["userId"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_send_message",
    description:
      "Send a text message into a Nextcloud Talk conversation. Provide the conversation `token` (from `talk_list_conversations` or `talk_create_one_to_one`). Supports markdown.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        message: { type: "string", description: "Message text (markdown allowed)." },
        replyTo: {
          type: "integer",
          description: "Optional message ID to reply to (must be in the same conversation).",
        },
      },
      required: ["token", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_send_to_user",
    description:
      "Smart-send a chat message to a Nextcloud user in one call. Accepts either an exact userId or a name/handle to look up. If the name matches exactly one user, opens (or reuses) a 1-on-1 conversation and sends the message. If multiple users match, returns the candidates WITHOUT sending so the caller can pick one. This is the preferred tool for quick DMs — prefer it over `talk_find_user` → `talk_create_one_to_one` → `talk_send_message`.",
    inputSchema: {
      type: "object",
      properties: {
        user: {
          type: "string",
          description:
            "Exact Nextcloud userId, or a name/handle fragment. Exact userId/displayName matches are preferred; otherwise a unique fuzzy match is used. If multiple users match, the tool returns the candidate list and does NOT send.",
        },
        message: { type: "string", description: "Message text (markdown allowed)." },
      },
      required: ["user", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_get_messages",
    description:
      "Read recent messages from a Nextcloud Talk conversation. Use `lookIntoFuture=true` to long-poll for new messages.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        limit: { type: "integer", description: "Max messages (default 50).", default: 50 },
        lookIntoFuture: {
          type: "boolean",
          description: "If true, wait for new messages after `lastKnownMessageId`. Default false.",
          default: false,
        },
        lastKnownMessageId: {
          type: "integer",
          description: "Only return messages after this ID (required when `lookIntoFuture` is true).",
        },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
];

function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function summarizeConversation(c: TalkConversation): Record<string, unknown> {
  return {
    token: c.token,
    type: c.type,
    displayName: c.displayName,
    unreadMessages: c.unreadMessages,
    unreadMention: c.unreadMention,
    lastActivity: c.lastActivity,
    objectType: c.objectType,
    objectId: c.objectId,
  };
}

export function getTalkTools(): ToolDef[] {
  return TOOLS;
}

function createTalkServer(): Server {
  const server = new Server(
    { name: "nextcloud-talk-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    const a = args as Record<string, unknown>;
    try {
      switch (name) {
        case "talk_list_conversations": {
          const rooms = await listConversations();
          return textResult(rooms.map(summarizeConversation));
        }
        case "talk_find_user": {
          const query = String(a.query ?? "");
          const limit = Number(a.limit ?? 10);
          if (!query) throw new Error("query is required");
          const users = await searchUsers(query, limit);
          return textResult(users);
        }
        case "talk_create_one_to_one": {
          const userId = String(a.userId ?? "");
          if (!userId) throw new Error("userId is required");
          const room = await createOneToOne(userId);
          return textResult(summarizeConversation(room));
        }
        case "talk_send_message": {
          const token = String(a.token ?? "");
          const message = String(a.message ?? "");
          const replyTo = a.replyTo !== undefined ? Number(a.replyTo) : undefined;
          if (!token || !message) throw new Error("token and message are required");
          const msg = await sendMessage(token, message, replyTo);
          return textResult({ id: msg.id, timestamp: msg.timestamp, token: msg.token });
        }
        case "talk_send_to_user": {
          const userInput = String(a.user ?? "").trim();
          const message = String(a.message ?? "");
          if (!userInput || !message) throw new Error("user and message are required");

          const matches = await searchUsers(userInput, 10);
          // Prefer exact userId, then exact displayName, then a unique fuzzy match.
          let resolved =
            matches.find((m) => m.userId === userInput) ??
            matches.find((m) => m.displayName === userInput);
          if (!resolved) {
            if (matches.length === 1) {
              resolved = matches[0];
            } else if (matches.length === 0) {
              return {
                content: [
                  { type: "text", text: `No Nextcloud user matches "${userInput}".` },
                ],
                isError: true,
              };
            } else {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      `Multiple users match "${userInput}". Re-send with an exact userId from this list:\n` +
                      JSON.stringify(matches, null, 2),
                  },
                ],
                isError: true,
              };
            }
          }

          const room = await createOneToOne(resolved.userId);
          const msg = await sendMessage(room.token, message);
          return textResult({
            resolvedUser: resolved,
            conversation: {
              token: room.token,
              type: room.type,
              displayName: room.displayName,
            },
            message: { id: msg.id, timestamp: msg.timestamp },
          });
        }
        case "talk_get_messages": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          const limit = a.limit !== undefined ? Number(a.limit) : undefined;
          const lookIntoFuture = Boolean(a.lookIntoFuture);
          const lastKnownMessageId =
            a.lastKnownMessageId !== undefined ? Number(a.lastKnownMessageId) : undefined;
          const msgs = await getMessages(token, { limit, lookIntoFuture, lastKnownMessageId });
          return textResult(
            msgs.map((m) => ({
              id: m.id,
              actorDisplayName: m.actorDisplayName,
              actorId: m.actorId,
              timestamp: m.timestamp,
              message: m.message,
              messageType: m.messageType,
            })),
          );
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Error: ${msg}` }],
        isError: true,
      };
    }
  });

  return server;
}

interface SessionEntry {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

const sessions = new Map<string, SessionEntry>();

function isInitializeRequest(body: unknown): boolean {
  if (Array.isArray(body)) return body.some(isInitializeRequest);
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { method?: string }).method === "initialize"
  );
}

/**
 * Return an Express-compatible handler serving the Talk MCP server over
 * streamable HTTP. Keeps a session cache keyed by `mcp-session-id` so the
 * SDK's built-in state-machine (initialize → initialized → tools/*) works.
 */
export function createTalkMcpHandler(): RequestHandler {
  return async (req, res) => {
    try {
      const body = (req as unknown as { body?: unknown }).body;
      const existingSid = req.headers["mcp-session-id"] as string | undefined;

      let entry: SessionEntry | undefined = existingSid
        ? sessions.get(existingSid)
        : undefined;

      if (!entry) {
        if (req.method !== "POST" || !isInitializeRequest(body)) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Missing or unknown mcp-session-id" },
            id: null,
          });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, entry!);
          },
        });
        const server = createTalkServer();
        await server.connect(transport);
        entry = { server, transport };
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) sessions.delete(sid);
        };
      }

      await entry.transport.handleRequest(req, res, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("talk-mcp handler error:", msg);
      if (!res.headersSent) {
        res.status(500).json({ error: "talk_mcp_error", message: msg });
      }
    }
  };
}
