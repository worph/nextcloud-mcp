/**
 * Owns the full set of Talk watchers. One `RoomWatcher` per conversation
 * the bot cares about (DMs + groups + public rooms).
 *
 * We long-poll every eligible room directly instead of relying on Nextcloud's
 * notifications feed, because the notifications API suppresses events for
 * conversations the user is actively viewing — which is the exact case where
 * an AI assistant *should* still respond. See `docs/design-decisions.md`
 * ADR-001 for the full rationale.
 *
 * Rescans conversation list every 5 minutes to pick up newly-created rooms
 * and drop rooms the user has left.
 */

import { record as recordActivity } from "./activity-log.js";
import { loadConfig } from "./config.js";
import { loadPollState } from "./poll-state.js";
import { listConversations } from "./talk-client.js";
import { RoomWatcher } from "./watcher-room.js";

const RESCAN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Nextcloud Talk room types we long-poll:
 *   1 = one-to-one DM
 *   2 = group conversation
 *   3 = public conversation
 * Skipped:
 *   4 = changelog / system (read-only)
 *   5 = former one-to-one
 *   6 = note-to-self (the user's own reminders — don't auto-respond)
 */
const WATCHED_ROOM_TYPES = new Set([1, 2, 3]);

interface ManagerState {
  running: boolean;
  rescanTimer: NodeJS.Timeout | null;
}

class WatcherManager {
  private rooms = new Map<string, RoomWatcher>();
  private state: ManagerState = { running: false, rescanTimer: null };

  async start(): Promise<void> {
    if (this.state.running) return;
    const cfg = loadConfig();
    if (!cfg.watcher.enabled) {
      console.log("WatcherManager: watcher.enabled=false, staying dormant");
      return;
    }
    if (!cfg.nextcloud.url || !cfg.nextcloud.username || !cfg.nextcloud.appPassword) {
      console.log("WatcherManager: Nextcloud creds missing, can't start");
      return;
    }
    this.state.running = true;
    console.log("WatcherManager: starting");
    await this.rescan();
    this.state.rescanTimer = setInterval(
      () => void this.rescan().catch((err) => console.warn("rescan failed:", err)),
      RESCAN_INTERVAL_MS,
    );
  }

  async stop(): Promise<void> {
    if (!this.state.running) return;
    this.state.running = false;
    console.log("WatcherManager: stopping");
    if (this.state.rescanTimer) {
      clearInterval(this.state.rescanTimer);
      this.state.rescanTimer = null;
    }
    const stops: Promise<void>[] = [];
    for (const w of this.rooms.values()) stops.push(w.stop());
    await Promise.all(stops);
    this.rooms.clear();
  }

  /**
   * Reconcile the watcher set against the user's current room list. Starts
   * watchers for new rooms, stops watchers for rooms the user has left.
   * Idempotent; safe to call any time.
   */
  async rescan(): Promise<void> {
    if (!this.state.running) return;
    let rooms;
    try {
      rooms = await listConversations();
    } catch (err) {
      console.warn(
        "WatcherManager: listConversations failed, keeping existing watchers:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }

    // Target set: every room whose type we watch, keyed by token.
    interface Desired {
      displayName: string;
      type: number;
      lastMessageId: number;
    }
    const desired = new Map<string, Desired>();
    for (const r of rooms) {
      if (!WATCHED_ROOM_TYPES.has(r.type)) continue;
      const lastMessageId =
        (r as unknown as { lastMessage?: { id?: number } }).lastMessage?.id ?? 0;
      desired.set(r.token, {
        displayName: r.displayName || r.name,
        type: r.type,
        lastMessageId,
      });
    }

    // Drop gone rooms.
    for (const [token, watcher] of this.rooms) {
      if (!desired.has(token)) {
        console.log(`WatcherManager: stopping RoomWatcher for gone room ${token}`);
        await watcher.stop();
        this.rooms.delete(token);
      }
    }

    // Start new rooms.
    for (const [token, meta] of desired) {
      if (!this.rooms.has(token)) {
        const typeLabel =
          meta.type === 1 ? "DM" : meta.type === 2 ? "group" : `type=${meta.type}`;
        console.log(
          `WatcherManager: starting RoomWatcher for ${meta.displayName} (${typeLabel}, token=${token}) — initial cursor ${meta.lastMessageId}`,
        );
        const w = new RoomWatcher(token, meta.displayName, meta.type, {
          initialCursor: meta.lastMessageId,
        });
        this.rooms.set(token, w);
        w.start();
      }
    }

    recordActivity({
      kind: "poll_started",
      detail: `rescan complete — watching ${this.rooms.size} room(s)`,
    });
  }

  /** Snapshot for the Web UI and `/api/status`. */
  status(): {
    running: boolean;
    watchedRooms: {
      token: string;
      displayName: string;
      roomType: number;
      lastKnownMessageId: number;
      lastPollAt?: number;
    }[];
  } {
    const state = loadPollState();
    const watchedRooms = [...this.rooms.entries()].map(([token, w]) => {
      const dm = state.dms[token];
      return {
        token,
        displayName: w.displayName,
        roomType: w.roomType,
        lastKnownMessageId: dm?.lastKnownMessageId ?? 0,
        lastPollAt: dm?.lastPollAt,
      };
    });
    return {
      running: this.state.running,
      watchedRooms,
    };
  }
}

export const manager = new WatcherManager();
