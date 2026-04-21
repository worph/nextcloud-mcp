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
  addParticipant,
  addReaction,
  createConversation,
  createOneToOne,
  deleteConversation,
  deleteMessage,
  getMessages,
  leaveConversation,
  listConversations,
  listParticipants,
  markUnread,
  removeAttendee,
  removeReaction,
  renameConversation,
  searchUsers,
  sendMessage,
  setConversationDescription,
  setFavorite,
  setReadMarker,
  type TalkConversation,
  type TalkParticipant,
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
  {
    name: "talk_create_group",
    description:
      "Create a Nextcloud Talk group conversation (private, type=2) or public link conversation (type=3). Use this to start a multi-participant room. Returns the new conversation token, which you can use with `talk_add_participant` to invite people and `talk_send_message` to post. If you want a simple 1-on-1 DM instead, use `talk_create_one_to_one`.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Display name of the new conversation (visible to all participants).",
        },
        public: {
          type: "boolean",
          description:
            "If true, create a public (link-shareable) conversation (roomType=3). Defaults to false — a private group conversation (roomType=2).",
          default: false,
        },
        invite: {
          type: "string",
          description:
            "Optional initial participant. By default treated as a Nextcloud userId; change with `source`. Leave empty to create a room with just yourself and add people later via `talk_add_participant`.",
        },
        source: {
          type: "string",
          enum: ["users", "groups", "circles", "emails"],
          description:
            "How to interpret `invite`. `users` = Nextcloud userId (default), `groups` = add every member of a Nextcloud group, `circles` = a Nextcloud Circle / Team, `emails` = invite an email guest.",
          default: "users",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_list_participants",
    description:
      "List participants of a Nextcloud Talk conversation. Returns actor type, actorId, displayName, participantType and attendeeId (use attendeeId with `talk_remove_participant`).",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        includeStatus: {
          type: "boolean",
          description: "If true, also include online status for each user.",
          default: false,
        },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_add_participant",
    description:
      "Add a participant to a group or public Talk conversation. Requires moderator rights in the room. Use `source` to control what `participant` means (default: Nextcloud userId).",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        participant: {
          type: "string",
          description:
            "Identifier to add. Its meaning depends on `source`: userId (default), Nextcloud groupId, circleId, or email address.",
        },
        source: {
          type: "string",
          enum: ["users", "groups", "circles", "emails", "federated_users"],
          description: "How to interpret `participant`. Defaults to `users`.",
          default: "users",
        },
      },
      required: ["token", "participant"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_remove_participant",
    description:
      "Remove a participant from a Talk conversation by their `attendeeId` (get it from `talk_list_participants`). Requires moderator rights. To leave a room yourself, use `talk_leave_conversation`.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        attendeeId: {
          type: "integer",
          description: "Attendee ID from `talk_list_participants`.",
        },
      },
      required: ["token", "attendeeId"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_rename_conversation",
    description:
      "Rename a Talk conversation (group or public). Requires moderator rights; cannot rename 1-on-1 rooms.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        name: { type: "string", description: "New display name." },
      },
      required: ["token", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_set_description",
    description:
      "Set or clear the description/topic of a Talk conversation (pass an empty string to clear). Requires moderator rights.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        description: { type: "string", description: "New description (markdown allowed). Empty string clears it." },
      },
      required: ["token", "description"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_delete_conversation",
    description:
      "Delete a Talk conversation for all participants. Requires moderator/owner rights on the room. For 1-on-1 rooms this hides the chat for the current user only. To leave a room without deleting it, use `talk_leave_conversation`.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_leave_conversation",
    description:
      "Leave a Talk conversation without deleting it. The other participants keep their chat; you are removed from the room.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_set_favorite",
    description: "Pin or unpin a Talk conversation in the user's room list.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        favorite: {
          type: "boolean",
          description: "true to favorite, false to remove favorite.",
        },
      },
      required: ["token", "favorite"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_mark_read",
    description:
      "Mark a Talk conversation as read (clears the unread counter). If `lastReadMessage` is omitted, the latest message is used.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        lastReadMessage: {
          type: "integer",
          description: "Message ID up to (and including) which the chat should be marked read.",
        },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_mark_unread",
    description: "Mark a Talk conversation as unread (restores the unread indicator).",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
      },
      required: ["token"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_delete_message",
    description:
      "Retract / delete a chat message. The sender or a moderator may delete. Nextcloud leaves a small system placeholder where the message was.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        messageId: { type: "integer", description: "ID of the message to delete." },
      },
      required: ["token", "messageId"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_add_reaction",
    description: "Add an emoji reaction to a chat message.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        messageId: { type: "integer", description: "Target message ID." },
        reaction: {
          type: "string",
          description: "Single emoji, e.g. \"👍\" or \"🎉\".",
        },
      },
      required: ["token", "messageId", "reaction"],
      additionalProperties: false,
    },
  },
  {
    name: "talk_remove_reaction",
    description: "Remove a reaction you previously added to a chat message.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", description: "Conversation token." },
        messageId: { type: "integer", description: "Target message ID." },
        reaction: { type: "string", description: "Emoji to remove." },
      },
      required: ["token", "messageId", "reaction"],
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
        case "talk_create_group": {
          const name = String(a.name ?? "").trim();
          if (!name) throw new Error("name is required");
          const isPublic = Boolean(a.public);
          const invite = a.invite ? String(a.invite) : undefined;
          const source = (a.source ? String(a.source) : "users") as
            | "users"
            | "groups"
            | "circles"
            | "emails";
          const room = await createConversation({
            roomType: isPublic ? 3 : 2,
            roomName: name,
            invite,
            source,
          });
          return textResult(summarizeConversation(room));
        }
        case "talk_list_participants": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          const includeStatus = Boolean(a.includeStatus);
          const participants = await listParticipants(token, includeStatus);
          return textResult(
            participants.map((p: TalkParticipant) => ({
              actorType: p.actorType,
              actorId: p.actorId,
              displayName: p.displayName,
              participantType: p.participantType,
              attendeeId: p.attendeeId,
            })),
          );
        }
        case "talk_add_participant": {
          const token = String(a.token ?? "");
          const participant = String(a.participant ?? "");
          if (!token || !participant)
            throw new Error("token and participant are required");
          const source = (a.source ? String(a.source) : "users") as
            | "users"
            | "groups"
            | "circles"
            | "emails"
            | "federated_users";
          await addParticipant(token, participant, source);
          return textResult({ success: true, token, participant, source });
        }
        case "talk_remove_participant": {
          const token = String(a.token ?? "");
          const attendeeId = Number(a.attendeeId);
          if (!token) throw new Error("token is required");
          if (!Number.isFinite(attendeeId))
            throw new Error("attendeeId must be a number");
          await removeAttendee(token, attendeeId);
          return textResult({ success: true, token, attendeeId });
        }
        case "talk_rename_conversation": {
          const token = String(a.token ?? "");
          const name = String(a.name ?? "").trim();
          if (!token || !name) throw new Error("token and name are required");
          const room = await renameConversation(token, name);
          return textResult(summarizeConversation(room));
        }
        case "talk_set_description": {
          const token = String(a.token ?? "");
          const description = String(a.description ?? "");
          if (!token) throw new Error("token is required");
          const room = await setConversationDescription(token, description);
          return textResult(summarizeConversation(room));
        }
        case "talk_delete_conversation": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          await deleteConversation(token);
          return textResult({ success: true, token });
        }
        case "talk_leave_conversation": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          await leaveConversation(token);
          return textResult({ success: true, token });
        }
        case "talk_set_favorite": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          const favorite = Boolean(a.favorite);
          await setFavorite(token, favorite);
          return textResult({ success: true, token, favorite });
        }
        case "talk_mark_read": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          const lastReadMessage =
            a.lastReadMessage !== undefined ? Number(a.lastReadMessage) : undefined;
          await setReadMarker(token, lastReadMessage);
          return textResult({ success: true, token, lastReadMessage });
        }
        case "talk_mark_unread": {
          const token = String(a.token ?? "");
          if (!token) throw new Error("token is required");
          await markUnread(token);
          return textResult({ success: true, token });
        }
        case "talk_delete_message": {
          const token = String(a.token ?? "");
          const messageId = Number(a.messageId);
          if (!token) throw new Error("token is required");
          if (!Number.isFinite(messageId))
            throw new Error("messageId must be a number");
          await deleteMessage(token, messageId);
          return textResult({ success: true, token, messageId });
        }
        case "talk_add_reaction": {
          const token = String(a.token ?? "");
          const messageId = Number(a.messageId);
          const reaction = String(a.reaction ?? "");
          if (!token || !reaction)
            throw new Error("token and reaction are required");
          if (!Number.isFinite(messageId))
            throw new Error("messageId must be a number");
          await addReaction(token, messageId, reaction);
          return textResult({ success: true, token, messageId, reaction });
        }
        case "talk_remove_reaction": {
          const token = String(a.token ?? "");
          const messageId = Number(a.messageId);
          const reaction = String(a.reaction ?? "");
          if (!token || !reaction)
            throw new Error("token and reaction are required");
          if (!Number.isFinite(messageId))
            throw new Error("messageId must be a number");
          await removeReaction(token, messageId, reaction);
          return textResult({ success: true, token, messageId, reaction });
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
