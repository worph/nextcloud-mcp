/**
 * Shared reply pipeline for incoming Talk messages. Called from both the
 * DM long-poll watcher and the @mention notifications watcher.
 *
 * Flow: placeholder → LLM via Beacon → edit placeholder in place.
 * Activity events are written so the Web UI surfaces what's happening.
 */

import { record as recordActivity } from "./activity-log.js";
import { loadConfig } from "./config.js";
import { callTargetLlm, type MessageContext } from "./llm-client.js";
import { editMessage as talkEdit, sendMessage as talkSend } from "./talk-client.js";

const THINKING_PLACEHOLDER = "⏳ _Thinking…_";

export type DispatchKind = "dm_accepted" | "mention_accepted";

export interface DispatchInput {
  kind: DispatchKind;
  ctx: MessageContext;
}

export async function handle(input: DispatchInput): Promise<void> {
  const { kind, ctx } = input;
  const cfg = loadConfig();
  const target = cfg.target;

  recordActivity({
    kind,
    conversationToken: ctx.conversationToken,
    conversationName: ctx.conversationName,
    actorId: ctx.actorId,
    actorDisplayName: ctx.actorDisplayName,
    excerpt: ctx.message.slice(0, 160),
  });

  // Verify target is ready before posting the placeholder — don't leave a
  // dangling "⏳ Thinking…" message when we know we can't respond.
  const endpoint = target.mode === "direct" ? target.directUrl : target.beaconUrl;
  if (target.mode === "off" || !endpoint || !target.toolName) {
    console.warn(
      `Talk: ${kind} received but target LLM is not configured (mode=${target.mode}, endpoint=${endpoint || "∅"}, tool=${target.toolName || "∅"})`,
    );
    recordActivity({
      kind: "llm_call_error",
      conversationToken: ctx.conversationToken,
      detail: `target_unconfigured (mode=${target.mode})`,
    });
    return;
  }

  console.log(
    `Talk: ${kind} in ${ctx.conversationName} (${ctx.conversationToken}) from ${ctx.actorDisplayName} — forwarding to ${target.toolName} @ ${endpoint}`,
  );

  // Post a placeholder immediately so the user sees that the bot is working.
  let placeholderId: number | null = null;
  try {
    const pm = await talkSend(ctx.conversationToken, THINKING_PLACEHOLDER);
    placeholderId = pm.id;
  } catch (err) {
    console.warn(
      "Talk: failed to post placeholder (will fall back to single post):",
      err instanceof Error ? err.message : String(err),
    );
  }

  recordActivity({
    kind: "llm_call_start",
    conversationToken: ctx.conversationToken,
    conversationName: ctx.conversationName,
    actorId: ctx.actorId,
    excerpt: `→ ${target.toolName} (mode=${target.mode})`,
  });

  const prefix = cfg.watcher.replyPrefix ?? "";
  let reply = "";
  const t0 = Date.now();
  try {
    const result = await callTargetLlm(target, ctx);
    const dt = Date.now() - t0;
    console.log(
      `Talk: LLM responded in ${dt}ms, isError=${result.isError}, len=${result.text.length}`,
    );
    reply = result.isError
      ? `${prefix}(LLM error) ${result.text || "no response"}`
      : `${prefix}${result.text || "(empty response)"}`;
    recordActivity({
      kind: result.isError ? "llm_call_error" : "llm_call_ok",
      conversationToken: ctx.conversationToken,
      durationMs: dt,
      excerpt: reply.slice(0, 160),
    });
  } catch (err) {
    const dt = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`Talk: LLM call failed after ${dt}ms: ${msg}`);
    reply = `${prefix}(failed to reach LLM: ${msg})`;
    recordActivity({
      kind: "llm_call_error",
      conversationToken: ctx.conversationToken,
      durationMs: dt,
      detail: msg.slice(0, 240),
    });
  }

  // Deliver the reply: prefer editing the placeholder; fall back to a fresh
  // post if placeholder wasn't created or edit fails.
  try {
    if (placeholderId !== null) {
      try {
        await talkEdit(ctx.conversationToken, placeholderId, reply);
        console.log(
          `Talk: edited placeholder #${placeholderId} in ${ctx.conversationToken} (${reply.length} chars)`,
        );
        recordActivity({
          kind: "reply_posted",
          conversationToken: ctx.conversationToken,
          conversationName: ctx.conversationName,
          excerpt: reply.slice(0, 160),
          detail: `edited placeholder #${placeholderId}`,
        });
        return;
      } catch (editErr) {
        console.warn(
          "Talk: edit failed, falling back to new post:",
          editErr instanceof Error ? editErr.message : String(editErr),
        );
      }
    }
    await talkSend(ctx.conversationToken, reply);
    console.log(`Talk: reply posted to ${ctx.conversationToken} (${reply.length} chars)`);
    recordActivity({
      kind: "reply_posted",
      conversationToken: ctx.conversationToken,
      conversationName: ctx.conversationName,
      excerpt: reply.slice(0, 160),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("Talk: failed to post reply:", msg);
    recordActivity({
      kind: "reply_failed",
      conversationToken: ctx.conversationToken,
      detail: msg.slice(0, 240),
    });
  }
}
