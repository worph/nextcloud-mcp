# Design Decisions

Architecture decision records (ADRs) for the Nextcloud MCP wrapper. Each
entry captures *why* we made a choice, what we rejected, and when future
maintainers should revisit it.

Format is light — not the full Nygard template. Keep entries short; long
justifications belong in commit messages or dedicated docs.

---

## ADR-001 — Use polling instead of the Nextcloud Talk bot webhook

**Status:** accepted (revised 2026-04-20) · **Date:** 2026-04-20

### Revision notes (2026-04-20)

Two corrections to the original design below were discovered during live
testing and folded back in:

1. **`suppressAfterHumanSendSec` mistook bot replies for human activity.**
   The watcher originally treated every self-actor message it saw in the
   long-poll as "the human is typing from another client" and silenced the
   bot for 60 s. But in "respond as me" mode, the wrapper IS posting as the
   user, so every bot reply hit this path and muted the next incoming
   message. Fixed by tracking message ids the wrapper itself has
   posted/edited (`talk-client.ts::ownMessageIds`) and only opening the
   suppression window when a self-actor message is NOT one we posted.

2. **The notifications feed is suppressed when the user is present.**
   The original `MentionWatcher` polled
   `GET /ocs/v2.php/apps/notifications/api/v2/notifications` for
   `app=spreed, object_type=chat` notifications. Nextcloud doesn't emit
   those for conversations the user is actively viewing (web/desktop tab
   open). For an AI assistant that's the exact scenario where the bot
   *should* still respond. **Fix: dropped the notifications feed entirely
   and extended the long-poll watcher to every group/public room
   (type=2, 3) alongside DMs (type=1).** Direct `@Mael` detection still
   happens via `messageParameters.type="user" && .id===self` — now on the
   message objects returned from the chat long-poll, which are NOT affected
   by presence/read state.

   The corresponding deletions — `src/watcher-mentions.ts` and
   `src/notifications-client.ts` — are gone from the tree. `DmWatcher`
   was renamed to `RoomWatcher` to reflect the widened scope.

   Scale concern on long-polling many rooms: a personal user in 5–20 active
   conversations is well within Nextcloud's per-user connection headroom.
   Large tenants (50+ rooms) would need adaptive polling (long-poll recent
   rooms, periodic list-conversations for idle ones); not built today.

The original ADR below documents the initial design for historical context.
The policy and rationale still stand; only the mention-detection mechanism
was swapped.

---



### Context

The wrapper needs to react to incoming Talk messages:
- any message in a direct (1-on-1) conversation
- `@<username>` mentions in group conversations

Nextcloud Talk 17.1+ ships a bot webhook mechanism. Registration requires
running `occ talk:bot:install <name> <secret> <webhook-url>` on the Nextcloud
host (SSH + admin), and the webhook URL must be reachable from that host
(public URL, reverse-proxy route). Early Phase 2/3 of this project built
the full webhook pipeline: HMAC-verified endpoint, `cloudflared` dev tunnel,
Web UI bot panel with `occ` snippet generator. It worked end-to-end.

The UX cost, however, was steep: two shell-side setup steps (`occ` + expose)
before any message could be delivered. For a personal assistant used by a
single Nextcloud user, that's the biggest blocker — much worse than the few
seconds of latency polling would introduce.

### Decision

Drop the webhook path entirely. Watch Talk traffic instead via two polling
loops, both authenticated with the user's existing **app-password** (already
required for every other wrapper feature):

1. **DM watcher** — one long-poll loop per type-1 conversation against
   `GET /ocs/v2.php/apps/spreed/api/v1/chat/{token}?lookIntoFuture=1`. Server
   blocks up to `dmLongPollTimeoutSec` seconds (default 30), returns the
   moment a new message arrives. Cursor advanced via `X-Chat-Last-Given`
   response header.
2. **Mention watcher** — periodic (`notificationPollSec`, default 20 s) scan
   of `GET /ocs/v2.php/apps/notifications/api/v2/notifications`. Filters for
   `app=spreed`, `object_type=chat`, then fetches the referenced message and
   checks its `messageParameters` for a placeholder of type `user` with id
   matching the authenticated user. Direct-mention only — `@all` / `@here`
   use `type=call` and are ignored. Locale-independent.

Both feed the same reply pipeline (`src/message-handler.ts`) that already
existed: post `⏳ _Thinking…_` placeholder, call the LLM via Beacon, edit the
placeholder in place with the response.

Identity collapses to the authenticated user — **replies appear as the user
themselves, not a separate bot actor**. We prepend `🤖 ` (configurable via
`watcher.replyPrefix`) so humans can tell AI responses from typed ones.

### Consequences

**Good:**
- Zero server-side CLI. Install → paste app-password → flip toggle.
- No public URL required. No HMAC, no webhook handler, no `cloudflared`.
- Gapless restarts — Talk's `lastKnownMessageId` cursor replays any messages
  sent while the wrapper was down (persisted in `data/poll-state.json`).
- Works on any Talk version (not just 17.1+).

**Cost:**
- Group-chat mentions see up to `notificationPollSec` of latency (~20 s).
  DMs stay near-instant via long-poll.
- AI replies use the user's own identity. For shared chats this may surprise
  other participants who don't know about the bot. Mitigated by the
  `replyPrefix` banner on every reply.
- If the human user is actively chatting from another client, the wrapper
  may reply to a message they were about to answer themselves. Mitigated by
  `watcher.suppressAfterHumanSendSec` — once the human posts, auto-response
  is suppressed in that conversation for 60 seconds by default.
- One outbound long-poll connection per DM. Fine for a personal account
  (5–10 DMs at most). A user in 50+ active DMs would need an adaptive
  strategy (only long-poll recently active DMs, fall back to the
  notifications loop for stale ones). Not built today.

### Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep bot webhook** | `occ` + public-URL friction killed the "it just works" UX goal. |
| **Invoke `occ` from the wrapper** | Requires SSH or Docker-socket access to the Nextcloud container. Huge security surface; couples our deployment to theirs. |
| **Direct DB insert into `talk_bots_server`** | Brittle across Nextcloud upgrades; bypasses validation; multi-DB support burden. |
| **Talk high-performance-backend signaling (WebSocket)** | Fast and real-time but HPB is an optional component many small Nextcloud installs don't have. Hard dependency we can't assume. |
| **Notifications-only polling (drop DM long-poll)** | DMs wouldn't be notifications for direct 1-on-1 depending on config; latency ceiling ≥ poll interval. Long-poll for DMs is a clean win. |

### When to revisit

- **Multi-tenant deployment.** One wrapper instance serving many Nextcloud
  users can't use a single app-password. At that point the webhook-registered
  bot identity becomes the right model again and the old code can be resurrected
  from git history (commit range of Phases 2 & 3).
- **"Needs separate bot avatar" product requirement.** A support-bot
  scenario where users must see a distinct actor. Today's "respond as the
  user" model fails that on purpose.
- **Sub-second mention latency mandated.** Today's 20 s mention ceiling is a
  conscious choice. If real-time is needed, either HPB (if present) or the
  webhook path (if admin CLI access is acceptable).

---

## ADR-002 — Route LLM calls through the Beacon aggregator

**Status:** accepted · **Date:** 2026-04-20 (captures a Phase 3 decision)

### Context

The auto-respond watchers forward user messages to a "target LLM" — typically
a container like `claude-code-container` that exposes `query_claude` over MCP.
Early iterations had the wrapper hold the LLM's URL + bearer token directly
(`target.url` + `target.authToken`). That coupled us to:
- the downstream's URL changing on container recreates
- the downstream's auth scheme (bearer? basic? none?)
- a secret token stored in our config that the user had to know about

All of these were UX tax, and all were already solved by Beacon — the
MCP aggregator running on the shared Docker network. Beacon discovers every
MCP server announced on the `mcp-net` UDP channel and exposes their tools as
namespaced aliases (`claude-code-container__query_claude`). It owns URL
routing, reachability, and auth.

### Decision

In `target.mode = "auto"` (the default), the wrapper calls **Beacon's `call`
tool** at `target.beaconUrl` (default `http://beacon:9300/mcp/`) with:

```json
{
  "tool_name": "<namespace>__<tool>",
  "arguments": { ...resolved-paramTemplate }
}
```

The auto-detection flow (`POST /api/beacon/scan?autoSave=1`) saves the
namespaced tool name into `target.toolName` — no URL, no token. `target.mode
= "direct"` remains as an escape hatch that pins a specific `directUrl`
+ optional `directAuthToken`; used when no aggregator is available.

### Consequences

- **No secrets in our config** for the common case. `target.authToken` is
  gone from the default path.
- **Invisible downstream churn.** Beacon handles the routing when the
  downstream restarts, moves, or changes auth.
- **Hard dependency on Beacon** when `mode=auto`. The `direct` escape hatch
  preserves decoupling for setups without an aggregator.
- **Extra hop** for every LLM call. Beacon's overhead is negligible (tens of
  ms) compared to the LLM call itself (seconds).

### Alternatives considered

- **Hold URL + auth in wrapper config** (what we had). Worked but re-
  introduced the UX tax every time a container changed.
- **Autodetect URL + auth without Beacon (direct UDP scan + HTTP probe).**
  Would require us to re-implement a subset of Beacon inside the wrapper. No
  reason to.

### When to revisit

- Beacon becomes unavailable or unsuitable for a deployment (e.g. host-
  network constraints where multicast doesn't work). Today the `direct`
  mode already covers that case.

---

## ADR-003 — Slim Beacon announce payload to `{name, description}` per tool

**Status:** accepted · **Date:** 2026-04-20 (retroactive)

### Context

The wrapper re-announces the upstream Nextcloud MCP's full tool catalog
(≈118 tools) so Beacon lists them under `nextcloud-mcp__*`. Announces ride
UDP; our initial implementation included each tool's full `inputSchema`.
The serialized manifest came to ~208 KB. Linux UDP datagram ceiling is
~64 KB, and `dgram.send` on payloads over that limit fails silently
(packets just never reach the aggregator).

### Decision

Strip tool schemas from the announce payload. Include only `name` and
`description`. Callers who need the full schema fetch it over HTTP via the
announced `/mcp` endpoint — Beacon's `server_doc` / `tool_doc` already do
this on demand.

### Consequences

- Announce payload drops from ~208 KB to ~38 KB (well under the UDP ceiling).
- Beacon's server overview renders correctly; callers that need full
  schemas pay a one-time HTTP round-trip.
- Works transparently as long as the announced `/mcp` endpoint is reachable
  from whoever's fetching — which is always the case inside `mcp-net`.

### When to revisit

If Beacon's discovery protocol evolves to use chunked UDP or a reliable
transport (TCP control plane) for announces, sending full schemas again
becomes feasible. Not worth it today.
