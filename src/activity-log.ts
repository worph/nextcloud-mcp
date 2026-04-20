/**
 * In-memory ring buffer of recent bot activity events — powers the UI's
 * activity panel and helps debug live traffic without tailing container logs.
 *
 * Intentionally unpersisted: restarts clear it. If history survives restarts,
 * a dedicated file or DB is a better fit than this module.
 */

export type ActivityKind =
  // Watcher lifecycle
  | "poll_started"
  | "poll_stopped"
  // Message intake
  | "mention_accepted"
  | "dm_accepted"
  | "message_skipped"
  // LLM call pipeline
  | "llm_call_start"
  | "llm_call_ok"
  | "llm_call_error"
  // Reply delivery
  | "reply_posted"
  | "reply_failed"
  // Beacon scan
  | "scan";

export interface ActivityEvent {
  timestamp: number;
  kind: ActivityKind;
  conversationToken?: string;
  conversationName?: string;
  actorId?: string;
  actorDisplayName?: string;
  excerpt?: string;
  detail?: string;
  durationMs?: number;
}

const MAX_EVENTS = 50;
const buffer: ActivityEvent[] = [];

export function record(evt: Omit<ActivityEvent, "timestamp">): void {
  const full: ActivityEvent = { ...evt, timestamp: Date.now() };
  buffer.push(full);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);
}

export function recent(limit = MAX_EVENTS): ActivityEvent[] {
  return buffer.slice(-limit).reverse();
}

export function clear(): void {
  buffer.length = 0;
}
