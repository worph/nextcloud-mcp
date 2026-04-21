/**
 * Minimal client for Nextcloud Talk's OCS API.
 *
 * Docs:
 *   - Conversations: https://nextcloud-talk.readthedocs.io/en/latest/conversation/
 *   - Chat:          https://nextcloud-talk.readthedocs.io/en/latest/chat/
 *
 * Authenticates with the Nextcloud app-password via HTTP Basic auth.
 */

import { loadConfig } from "./config.js";

interface OcsEnvelope<T> {
  ocs: {
    meta: { status: string; statuscode: number; message: string };
    data: T;
  };
}

export interface TalkConversation {
  id: number;
  token: string;
  type: number; // 1=one-to-one, 2=group, 3=public, 4=changelog, 5=one-to-one-former, 6=note
  name: string;
  displayName: string;
  description?: string;
  participantType: number;
  unreadMessages: number;
  unreadMention: boolean;
  unreadMentionDirect: boolean;
  lastActivity: number;
  lastMessage?: unknown;
  objectType?: string;
  objectId?: string;
}

export interface TalkMessage {
  id: number;
  token: string;
  actorType: string;
  actorId: string;
  actorDisplayName: string;
  timestamp: number;
  message: string;
  messageType: string;
  systemMessage?: string;
  isReplyable?: boolean;
  referenceId?: string;
  reactions?: Record<string, number>;
}

/**
 * Bounded set of message ids the wrapper itself has posted or edited via
 * this client. DmWatcher consults this when a self-actor message appears in
 * the long-poll: if the id is ours we skip and do NOT trigger the
 * "suppress after human send" window. Without this, every one of our own
 * replies would be mistaken for the user typing from another client and
 * would silence the bot for 60 s.
 *
 * Capped so long-running wrappers don't leak memory; oldest entries evict.
 */
const OWN_IDS_CAP = 500;
const ownMessageIds = new Set<number>();
function trackOwnId(id: number): void {
  ownMessageIds.add(id);
  if (ownMessageIds.size > OWN_IDS_CAP) {
    const first = ownMessageIds.values().next().value as number | undefined;
    if (first !== undefined) ownMessageIds.delete(first);
  }
}
export function isOwnMessageId(id: number): boolean {
  return ownMessageIds.has(id);
}

function authHeader(): { Authorization: string } {
  const cfg = loadConfig();
  const token = Buffer.from(
    `${cfg.nextcloud.username}:${cfg.nextcloud.appPassword}`,
  ).toString("base64");
  return { Authorization: `Basic ${token}` };
}

function baseUrl(): string {
  return loadConfig().nextcloud.url.replace(/\/+$/, "");
}

async function ocsRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url = `${baseUrl()}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        ...authHeader(),
        "OCS-APIRequest": "true",
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      signal: ctrl.signal,
      redirect: "follow",
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await fetch(url, init);
    const text = await res.text();
    let envelope: OcsEnvelope<T> | null = null;
    try {
      envelope = JSON.parse(text) as OcsEnvelope<T>;
    } catch {
      throw new Error(`Talk ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!envelope.ocs?.meta || envelope.ocs.meta.status !== "ok") {
      const meta = envelope?.ocs?.meta;
      throw new Error(
        `Talk ${method} ${path}: ${meta?.statuscode ?? res.status} ${meta?.message ?? "unknown"}`,
      );
    }
    return envelope.ocs.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function listConversations(): Promise<TalkConversation[]> {
  return ocsRequest<TalkConversation[]>(
    "GET",
    "/ocs/v2.php/apps/spreed/api/v4/room",
  );
}

export async function createOneToOne(
  targetUsername: string,
): Promise<TalkConversation> {
  // roomType=1 (one-to-one), invite = username to DM
  return ocsRequest<TalkConversation>("POST", "/ocs/v2.php/apps/spreed/api/v4/room", {
    roomType: 1,
    invite: targetUsername,
  });
}

/**
 * Create a group (roomType=2) or public (roomType=3) conversation.
 *
 * - `roomName` is required for non-1-to-1 rooms.
 * - `source` selects the invite backend: "users" (default), "groups", "circles",
 *   or "emails". When set to "users" you may omit `invite` to create an empty
 *   room and add participants later with `addParticipant`.
 * - `objectType` / `objectId` let you scope a room to a resource (Deck card,
 *   file, etc.). Leave undefined for a plain chat room.
 */
export async function createConversation(opts: {
  roomType: 2 | 3;
  roomName: string;
  invite?: string;
  source?: "users" | "groups" | "circles" | "emails";
  objectType?: string;
  objectId?: string;
}): Promise<TalkConversation> {
  const body: Record<string, unknown> = {
    roomType: opts.roomType,
    roomName: opts.roomName,
  };
  if (opts.invite) body.invite = opts.invite;
  if (opts.source) body.source = opts.source;
  if (opts.objectType) body.objectType = opts.objectType;
  if (opts.objectId) body.objectId = opts.objectId;
  return ocsRequest<TalkConversation>(
    "POST",
    "/ocs/v2.php/apps/spreed/api/v4/room",
    body,
  );
}

export interface TalkParticipant {
  actorType: string; // "users", "groups", "emails", "circles", "guests", "federated_users"
  actorId: string;
  displayName: string;
  participantType: number;
  lastPing?: number;
  inCall?: number;
  attendeeId?: number;
}

export async function listParticipants(
  token: string,
  includeStatus = false,
): Promise<TalkParticipant[]> {
  const qs = includeStatus ? "?includeStatus=true" : "";
  return ocsRequest<TalkParticipant[]>(
    "GET",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants${qs}`,
  );
}

/**
 * Add a participant. `source` defaults to "users" (by Nextcloud userId). Use
 * "groups" to pull in every member of a Nextcloud group, "emails" for email
 * guests, "circles" for Circles/Teams, etc.
 */
export async function addParticipant(
  token: string,
  newParticipant: string,
  source: "users" | "groups" | "circles" | "emails" | "federated_users" = "users",
): Promise<unknown> {
  return ocsRequest<unknown>(
    "POST",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants`,
    { newParticipant, source },
  );
}

/**
 * Remove a participant by `attendeeId` (from `listParticipants`). The endpoint
 * also supports removal by actor, but attendeeId is the modern path and avoids
 * ambiguity across backends.
 */
export async function removeAttendee(
  token: string,
  attendeeId: number,
): Promise<unknown> {
  const qs = new URLSearchParams({ attendeeId: String(attendeeId) });
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/attendees?${qs}`,
  );
}

export async function renameConversation(
  token: string,
  roomName: string,
): Promise<TalkConversation> {
  return ocsRequest<TalkConversation>(
    "PUT",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}`,
    { roomName },
  );
}

export async function setConversationDescription(
  token: string,
  description: string,
): Promise<TalkConversation> {
  return ocsRequest<TalkConversation>(
    "PUT",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/description`,
    { description },
  );
}

/**
 * Delete a conversation. Only moderators/owners can delete group or public
 * rooms. For 1-to-1 rooms this just hides it for the current user.
 */
export async function deleteConversation(token: string): Promise<unknown> {
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}`,
  );
}

/** Leave a conversation you are a participant in (does not delete for others). */
export async function leaveConversation(token: string): Promise<unknown> {
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/participants/self`,
  );
}

export async function setFavorite(
  token: string,
  favorite: boolean,
): Promise<unknown> {
  return ocsRequest<unknown>(
    favorite ? "POST" : "DELETE",
    `/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(token)}/favorite`,
  );
}

export async function setReadMarker(
  token: string,
  lastReadMessage?: number,
): Promise<unknown> {
  const body =
    typeof lastReadMessage === "number" ? { lastReadMessage } : undefined;
  return ocsRequest<unknown>(
    "POST",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/read`,
    body,
  );
}

export async function markUnread(token: string): Promise<unknown> {
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/read`,
  );
}

/**
 * Delete (retract) a chat message. Leaves a system placeholder in the chat.
 * Only the sender or a moderator can delete; older messages may be rejected
 * by the server.
 */
export async function deleteMessage(
  token: string,
  messageId: number,
): Promise<unknown> {
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/${messageId}`,
  );
}

export async function addReaction(
  token: string,
  messageId: number,
  reaction: string,
): Promise<unknown> {
  return ocsRequest<unknown>(
    "POST",
    `/ocs/v2.php/apps/spreed/api/v1/reaction/${encodeURIComponent(token)}/${messageId}`,
    { reaction },
  );
}

export async function removeReaction(
  token: string,
  messageId: number,
  reaction: string,
): Promise<unknown> {
  const qs = new URLSearchParams({ reaction });
  return ocsRequest<unknown>(
    "DELETE",
    `/ocs/v2.php/apps/spreed/api/v1/reaction/${encodeURIComponent(token)}/${messageId}?${qs}`,
  );
}

export async function sendMessage(
  token: string,
  message: string,
  replyTo?: number,
): Promise<TalkMessage> {
  const body: Record<string, unknown> = { message };
  if (typeof replyTo === "number") body.replyTo = replyTo;
  const msg = await ocsRequest<TalkMessage>(
    "POST",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}`,
    body,
  );
  trackOwnId(msg.id);
  return msg;
}

/**
 * Edit an existing chat message in place. Nextcloud renders this as a small
 * "(edited)" tag next to the message; the original id/timestamp are preserved.
 *
 * Used by the Talk bot to swap a "⏳ Thinking…" placeholder into the real LLM
 * reply without double-posting.
 */
export async function editMessage(
  token: string,
  messageId: number,
  newMessage: string,
): Promise<TalkMessage> {
  const msg = await ocsRequest<TalkMessage>(
    "PUT",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}/${messageId}`,
    { message: newMessage },
  );
  // The edit emits a system message with a fresh id — track both the
  // original and the system id, in case either surfaces in a long-poll.
  trackOwnId(messageId);
  trackOwnId(msg.id);
  return msg;
}

export async function getMessages(
  token: string,
  opts: { limit?: number; lookIntoFuture?: boolean; lastKnownMessageId?: number } = {},
): Promise<TalkMessage[]> {
  const qs = new URLSearchParams();
  qs.set("limit", String(opts.limit ?? 50));
  qs.set("lookIntoFuture", opts.lookIntoFuture ? "1" : "0");
  if (opts.lastKnownMessageId !== undefined) {
    qs.set("lastKnownMessageId", String(opts.lastKnownMessageId));
  }
  return ocsRequest<TalkMessage[]>(
    "GET",
    `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}?${qs}`,
  );
}

export interface LongPollResult {
  messages: TalkMessage[];
  /** Pass this back as `lastKnownMessageId` on the next call. */
  nextCursor: number;
  /** True when the server returned 304 — no new messages within the timeout. */
  idle: boolean;
}

/**
 * Long-poll the chat endpoint for new messages since `lastKnownMessageId`.
 * The server blocks for up to `timeoutSec` seconds and returns as soon as a
 * message arrives. Uses fetch directly (not `ocsRequest`) because we need
 * response headers (`X-Chat-Last-Given`) and the 304-no-content path.
 *
 * Returns `{ messages, nextCursor, idle }`. `nextCursor` is the value to hand
 * back on the next call — it comes from the `X-Chat-Last-Given` header when
 * present, otherwise we fall back to the max id we saw.
 */
export async function longPollMessages(
  token: string,
  lastKnownMessageId: number,
  timeoutSec: number,
  signal?: AbortSignal,
): Promise<LongPollResult> {
  const qs = new URLSearchParams({
    lookIntoFuture: "1",
    lastKnownMessageId: String(lastKnownMessageId),
    timeout: String(timeoutSec),
    includeLastKnown: "0",
    limit: "100",
  });
  const url = `${baseUrl()}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(token)}?${qs}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeader(),
      "OCS-APIRequest": "true",
      Accept: "application/json",
    },
    signal,
  });

  const cursorHeader = res.headers.get("x-chat-last-given");
  const nextCursorHeader = cursorHeader ? Number(cursorHeader) : NaN;

  if (res.status === 304) {
    return {
      messages: [],
      nextCursor: Number.isFinite(nextCursorHeader) ? nextCursorHeader : lastKnownMessageId,
      idle: true,
    };
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`long-poll ${res.status}: ${text.slice(0, 200)}`);
  }
  const envelope = JSON.parse(text) as { ocs: { data: TalkMessage[] } };
  const messages = envelope.ocs?.data ?? [];
  const fallbackCursor = messages.reduce(
    (acc, m) => (m.id > acc ? m.id : acc),
    lastKnownMessageId,
  );
  return {
    messages,
    nextCursor: Number.isFinite(nextCursorHeader) ? nextCursorHeader : fallbackCursor,
    idle: messages.length === 0,
  };
}

export interface ShareeUser {
  label: string; // display name
  value: { shareType: number; shareWith: string }; // shareWith = userId
}

/**
 * Search Nextcloud users via the "sharees" endpoint (the same one the sharing
 * dialog in the web UI uses). Returns `{label, value.shareWith}` where
 * `shareWith` is the canonical Nextcloud userId.
 */
export async function searchUsers(
  query: string,
  limit = 10,
): Promise<{ userId: string; displayName: string }[]> {
  const qs = new URLSearchParams({
    search: query,
    itemType: "file",
    perPage: String(limit),
    lookup: "false",
  });
  const data = await ocsRequest<{
    exact?: { users?: ShareeUser[] };
    users?: ShareeUser[];
  }>(
    "GET",
    `/ocs/v2.php/apps/files_sharing/api/v1/sharees?${qs}`,
  );
  const all = [...(data.exact?.users ?? []), ...(data.users ?? [])];
  const seen = new Set<string>();
  const out: { userId: string; displayName: string }[] = [];
  for (const u of all) {
    const userId = u.value?.shareWith;
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    out.push({ userId, displayName: u.label });
  }
  return out;
}
