/**
 * Persistent cursor state for the polling watchers. Written on every
 * successful poll turn (debounced to ~1 write/sec) so the wrapper can resume
 * without gaps after a restart or crash.
 *
 * File layout (data/poll-state.json):
 *   {
 *     "dms": {
 *       "<conversation-token>": {
 *         "lastKnownMessageId": 21787,
 *         "displayName": "Pierre Henri",
 *         "lastPollAt": 1776712000
 *       }
 *     },
 *     "lastSeenNotificationId": 12345,
 *     "mentionLoopLastPollAt": 1776711980,
 *     "updatedAt": 1776712000
 *   }
 */

import * as fs from "fs";
import * as path from "path";

export interface DmState {
  lastKnownMessageId: number;
  displayName: string;
  lastPollAt: number;
}

export interface PollState {
  /**
   * Cursor state per watched room token. Name kept as `dms` for backwards
   * compat with existing poll-state.json files, but now holds state for
   * every room type we watch (DMs + groups + public).
   */
  dms: Record<string, DmState>;
  updatedAt: number;
}

function statePath(): string {
  const dir =
    process.env.POLL_STATE_DIR ||
    path.dirname(process.env.CONFIG_PATH || path.join(process.cwd(), "data/config.json"));
  return path.join(dir, "poll-state.json");
}

function empty(): PollState {
  return {
    dms: {},
    updatedAt: 0,
  };
}

let cache: PollState | null = null;
let pendingWrite: NodeJS.Timeout | null = null;

export function loadPollState(): PollState {
  if (cache) return cache;
  const p = statePath();
  try {
    if (!fs.existsSync(p)) {
      cache = empty();
      return cache;
    }
    const raw = fs.readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as Partial<PollState>;
    cache = {
      dms: parsed.dms ?? {},
      updatedAt: parsed.updatedAt ?? 0,
    };
    return cache;
  } catch (err) {
    console.warn("Failed to read poll-state.json, starting fresh:", (err as Error).message);
    cache = empty();
    return cache;
  }
}

/** Schedule a debounced write. Multiple update() calls within 1s coalesce. */
export function savePollState(): void {
  if (!cache) return;
  if (pendingWrite) return;
  pendingWrite = setTimeout(() => {
    pendingWrite = null;
    if (!cache) return;
    cache.updatedAt = Date.now();
    try {
      fs.writeFileSync(statePath(), JSON.stringify(cache, null, 2), { encoding: "utf-8" });
    } catch (err) {
      console.warn("Failed to write poll-state.json:", (err as Error).message);
    }
  }, 1000);
}

export function updateDm(token: string, patch: Partial<DmState>): void {
  const state = loadPollState();
  const existing = state.dms[token] ?? {
    lastKnownMessageId: 0,
    displayName: "",
    lastPollAt: 0,
  };
  state.dms[token] = { ...existing, ...patch };
  savePollState();
}

export function removeDm(token: string): void {
  const state = loadPollState();
  if (state.dms[token]) {
    delete state.dms[token];
    savePollState();
  }
}

export function reset(): void {
  cache = empty();
  savePollState();
}
