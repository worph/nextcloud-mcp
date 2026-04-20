/**
 * Per-room long-poll watcher. Used for every type of conversation the bot
 * cares about — 1-on-1 DMs (type=1) and group / public chats (type=2, 3).
 *
 * Dispatch rule by room type:
 *   - DM (type=1)   → any non-self `comment` message from another user.
 *   - Group (type=2/3) → only messages that contain a `{mention-USER}`
 *                        placeholder in `messageParameters` with id==self
 *                        (direct @Mael, not @all / @here / @group).
 *
 * Holds a single outbound HTTP connection open for up to
 * `dmLongPollTimeoutSec` seconds against Nextcloud Talk's chat endpoint
 * (`lookIntoFuture=1`). Works regardless of the user's presence/read state
 * — unlike notification-feed polling, which Nextcloud silently suppresses
 * for conversations the user is actively viewing.
 */

import { record as recordActivity } from "./activity-log.js";
import { loadConfig } from "./config.js";
import { handle as handleMessage } from "./message-handler.js";
import { loadPollState, updateDm } from "./poll-state.js";
import {
  isOwnMessageId,
  longPollMessages,
  type TalkMessage,
} from "./talk-client.js";

export interface RoomWatcherOptions {
  /**
   * Starting cursor if no saved state exists for this room. Typically the
   * room's current lastMessage.id so first boot doesn't replay history.
   */
  initialCursor?: number;
}

/**
 * Returns true iff the message carries a `{mention-*}` placeholder whose
 * `type` is "user" and whose `id` matches `selfId`. Locale-independent —
 * uses structured parameters, not subject text.
 *
 * @all / @here use `type=call` and are therefore excluded.
 */
function isDirectMentionOfSelf(msg: TalkMessage, selfId: string): boolean {
  const params = (msg as unknown as { messageParameters?: Record<string, unknown> })
    .messageParameters;
  if (!params || typeof params !== "object") return false;
  for (const key of Object.keys(params)) {
    if (!key.startsWith("mention-")) continue;
    const p = params[key] as { type?: string; id?: string };
    if (p?.type === "user" && p?.id === selfId) return true;
  }
  return false;
}

export class RoomWatcher {
  readonly token: string;
  readonly displayName: string;
  /** 1 = one-to-one, 2 = group, 3 = public, etc. */
  readonly roomType: number;

  private readonly ctrl = new AbortController();
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private readonly initialCursor: number;
  // When a human posts from another client (same userId but not our own id),
  // we suppress auto-response for `watcher.suppressAfterHumanSendSec` seconds.
  private suppressUntil = 0;

  constructor(
    token: string,
    displayName: string,
    roomType: number,
    options: RoomWatcherOptions = {},
  ) {
    this.token = token;
    this.displayName = displayName;
    this.roomType = roomType;
    this.initialCursor = options.initialCursor ?? 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.loop().catch((err) => {
      console.warn(
        `RoomWatcher[${this.token}] loop exited with error:`,
        err instanceof Error ? err.message : String(err),
      );
    });
    recordActivity({
      kind: "poll_started",
      conversationToken: this.token,
      conversationName: this.displayName,
      detail: this.isDirect() ? "dm" : "group",
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.ctrl.abort();
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch {
        /* already logged */
      }
    }
    recordActivity({
      kind: "poll_stopped",
      conversationToken: this.token,
      conversationName: this.displayName,
      detail: this.isDirect() ? "dm" : "group",
    });
  }

  private isDirect(): boolean {
    return this.roomType === 1;
  }

  private loadCursor(): number {
    const state = loadPollState();
    const dm = state.dms[this.token];
    const saved = dm?.lastKnownMessageId ?? 0;
    return saved > 0 ? saved : this.initialCursor;
  }

  private async loop(): Promise<void> {
    let cursor = this.loadCursor();
    updateDm(this.token, {
      lastKnownMessageId: cursor,
      displayName: this.displayName,
      lastPollAt: Date.now(),
    });

    while (this.running) {
      const cfg = loadConfig();
      const timeoutSec = cfg.watcher.longPollTimeoutSec;
      try {
        const result = await longPollMessages(
          this.token,
          cursor,
          timeoutSec,
          this.ctrl.signal,
        );
        updateDm(this.token, {
          lastKnownMessageId: result.nextCursor,
          lastPollAt: Date.now(),
        });
        cursor = result.nextCursor;

        if (!result.idle) {
          for (const msg of result.messages) await this.handleMessage(msg);
        }
      } catch (err) {
        if (this.ctrl.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`RoomWatcher[${this.token}] poll error:`, msg);
        await this.sleep(3000);
      }
    }
  }

  private async handleMessage(msg: TalkMessage): Promise<void> {
    const cfg = loadConfig();
    const selfId = cfg.nextcloud.username;

    // Skip system messages (edits, deletes, joins). Only regular chat.
    if (msg.messageType !== "comment") return;

    // Self-actor: if the id is in our ownMessageIds set, we posted it —
    // skip silently. Otherwise it's the user from another client; skip AND
    // open a suppression window so we don't butt in while they're typing.
    if (msg.actorType === "users" && msg.actorId === selfId) {
      const ours = isOwnMessageId(msg.id);
      if (!ours) {
        this.suppressUntil =
          Date.now() + cfg.watcher.suppressAfterHumanSendSec * 1000;
      }
      recordActivity({
        kind: "message_skipped",
        conversationToken: this.token,
        conversationName: this.displayName,
        actorId: msg.actorId,
        detail: ours ? "own_bot_message" : "self_message_suppress",
      });
      return;
    }

    // Filter out anything posted as a Talk bot actor.
    if (msg.actorType === "bots") return;

    if (Date.now() < this.suppressUntil) {
      recordActivity({
        kind: "message_skipped",
        conversationToken: this.token,
        conversationName: this.displayName,
        actorId: msg.actorId,
        detail: `suppressed_after_human_send (${Math.round((this.suppressUntil - Date.now()) / 1000)}s left)`,
      });
      return;
    }

    // Group rooms: only respond if we were directly @mentioned. @all/@here
    // (type=call) and messages without a mention at all are skipped. DMs
    // are always "for us" so we don't require a mention.
    if (!this.isDirect() && !isDirectMentionOfSelf(msg, selfId)) {
      recordActivity({
        kind: "message_skipped",
        conversationToken: this.token,
        conversationName: this.displayName,
        actorId: msg.actorId,
        detail: "not_direct_mention_of_self",
      });
      return;
    }

    await handleMessage({
      kind: this.isDirect() ? "dm_accepted" : "mention_accepted",
      ctx: {
        message: msg.message,
        actorId: msg.actorId,
        actorDisplayName: msg.actorDisplayName,
        conversationToken: this.token,
        conversationName: this.displayName,
        messageId: msg.id,
        rawPayload: msg,
      },
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.ctrl.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(t);
        this.ctrl.signal.removeEventListener("abort", onAbort);
        resolve();
      };
      this.ctrl.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
