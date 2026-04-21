/* global document, window, fetch, location */

const $ = (sel) => document.querySelector(sel);

let currentConfig = null;
let currentStatus = null;
let statusTimer = null;
let activityTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

document.addEventListener("DOMContentLoaded", async () => {
  bindUi();
  await loadConfig();
  await refreshStatus();
  await refreshWatcher();
  await refreshActivity();
  renderSnippets();
  statusTimer = setInterval(() => {
    refreshStatus();
    refreshWatcher();
  }, 3000);
  activityTimer = setInterval(refreshActivity, 3000);
});

function bindUi() {
  $("#btn-test").addEventListener("click", onTest);
  $("#btn-save").addEventListener("click", onSave);
  $("#btn-rescan").addEventListener("click", onRescanBeacon);
  $("#btn-pin-direct").addEventListener("click", onPinDirect);
  $("#btn-save-watcher").addEventListener("click", onSaveWatcher);
  $("#btn-rescan-watcher").addEventListener("click", onRescanWatcher);
  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = document.getElementById(btn.dataset.copy);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent || "").then(() => toast("Copied"));
    });
  });
}

async function loadConfig() {
  try {
    currentConfig = await api("/api/config");
    $("#nc-url").value = currentConfig.nextcloud?.url || "";
    $("#nc-username").value = currentConfig.nextcloud?.username || "";
    const pw = currentConfig.nextcloud?.appPassword || "";
    $("#nc-app-password").value = pw;
    $("#nc-app-password").placeholder = pw
      ? "app password saved — leave blank to keep"
      : "paste app password here";

    // Target
    const t = currentConfig.target || {};
    $("#target-mode").textContent = t.mode || "—";
    $("#target-beacon").textContent = t.beaconUrl || "—";
    $("#target-tool").textContent = t.toolName || "(none — rescan to detect)";
    $("#direct-url").value = t.directUrl || "";
    $("#direct-tool").value = t.mode === "direct" ? t.toolName || "" : "";
    $("#direct-token").value = t.directAuthToken || "";
    $("#direct-token").placeholder = t.directAuthToken
      ? "token saved — leave blank to keep"
      : "bearer token (optional)";

    // Watcher
    const w = currentConfig.watcher || {};
    $("#watcher-enabled").checked = Boolean(w.enabled);
    $("#watcher-prefix").value = w.replyPrefix ?? "🤖 ";
    $("#watcher-context").value =
      typeof w.contextMessages === "number" ? w.contextMessages : 20;

    // Self label on the auto-respond header
    const self = currentConfig.nextcloud?.username || "me";
    $("#watcher-self").textContent = self;
    $("#watcher-self-inline").textContent = self;
  } catch (e) {
    toast("Failed to load config: " + e.message, true);
  }
}

async function refreshStatus() {
  try {
    const s = await api("/api/status");
    currentStatus = s;
    const pill = $("#status-pill");
    if (!s.configured) {
      pill.textContent = "not configured";
      pill.className =
        "px-3 py-1 rounded-full text-xs font-semibold bg-amber-200 text-amber-900";
    } else if (s.upstreamHealthy) {
      pill.textContent = "connected";
      pill.className =
        "px-3 py-1 rounded-full text-xs font-semibold bg-emerald-200 text-emerald-900";
    } else {
      pill.textContent = "upstream down";
      pill.className = "px-3 py-1 rounded-full text-xs font-semibold bg-red-200 text-red-900";
    }
    if (s.target) {
      $("#target-mode").textContent = s.target.mode;
      $("#target-beacon").textContent = s.target.beaconUrl || "—";
      $("#target-tool").textContent = s.target.toolName || "(none — rescan to detect)";
    }

    // Watcher summary pill
    const wp = $("#watcher-status-pill");
    if (!s.watcher) {
      wp.textContent = "—";
      wp.className = "text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700";
    } else if (s.watcher.enabled && s.watcher.running) {
      const n = s.watcher.watchedRoomCount;
      wp.textContent = `running · ${n} room${n === 1 ? "" : "s"}`;
      wp.className = "text-xs px-2 py-0.5 rounded bg-emerald-200 text-emerald-900";
    } else if (s.watcher.enabled) {
      wp.textContent = "starting…";
      wp.className = "text-xs px-2 py-0.5 rounded bg-amber-200 text-amber-900";
    } else {
      wp.textContent = "off";
      wp.className = "text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700";
    }
  } catch (e) {
    console.warn("status failed", e);
  }
}

async function refreshWatcher() {
  try {
    const r = await api("/api/watcher");
    const status = r.status || {};
    const list = $("#watched-list");
    if (!status.watchedRooms || status.watchedRooms.length === 0) {
      list.innerHTML = r.config?.enabled
        ? '<span class="text-slate-400">no rooms yet — click "Re-scan conversations"</span>'
        : '<span class="text-slate-400">disabled</span>';
    } else {
      list.innerHTML = status.watchedRooms
        .map((d) => {
          const ts = d.lastPollAt ? new Date(d.lastPollAt).toLocaleTimeString() : "—";
          const tag =
            d.roomType === 1
              ? '<span class="text-xs bg-slate-200 text-slate-700 px-1 rounded">DM</span>'
              : d.roomType === 2
                ? '<span class="text-xs bg-indigo-100 text-indigo-700 px-1 rounded">group</span>'
                : `<span class="text-xs bg-slate-100 text-slate-600 px-1 rounded">type=${d.roomType}</span>`;
          return `<div>${tag} <span class="font-medium text-slate-700">${escapeHtml(d.displayName)}</span> <span class="text-slate-400">(${escapeHtml(d.token)})</span> — last poll ${ts}, cursor ${d.lastKnownMessageId}</div>`;
        })
        .join("");
    }
  } catch (e) {
    /* ignore */
  }
}

async function refreshActivity() {
  try {
    const r = await api("/api/activity?limit=25");
    const root = $("#activity");
    if (!r.events || r.events.length === 0) {
      root.innerHTML = '<div class="text-slate-400">no activity yet — events appear here when a message arrives</div>';
      return;
    }
    root.innerHTML = r.events
      .map((e) => {
        const ts = new Date(e.timestamp).toLocaleTimeString();
        const kindCls =
          {
            poll_started: "text-indigo-700",
            poll_stopped: "text-slate-500",
            mention_accepted: "text-emerald-700",
            dm_accepted: "text-emerald-700",
            message_skipped: "text-slate-500",
            llm_call_start: "text-blue-700",
            llm_call_ok: "text-emerald-700",
            llm_call_error: "text-red-700",
            reply_posted: "text-emerald-700",
            reply_failed: "text-red-700",
            scan: "text-indigo-700",
          }[e.kind] || "text-slate-700";
        const detail = e.detail ? ` — ${escapeHtml(e.detail)}` : "";
        const excerpt = e.excerpt ? ` — ${escapeHtml(e.excerpt)}` : "";
        const dur = e.durationMs !== undefined ? ` (${e.durationMs}ms)` : "";
        const from = e.actorDisplayName ? ` from ${escapeHtml(e.actorDisplayName)}` : "";
        const room = e.conversationName ? ` in ${escapeHtml(e.conversationName)}` : "";
        return `<div><span class="text-slate-400">${ts}</span> <span class="${kindCls}">${e.kind}</span>${dur}${from}${room}${excerpt}${detail}</div>`;
      })
      .join("");
  } catch (e) {
    /* ignore */
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderSnippets() {
  const origin = location.origin;
  $("#mcp-url").textContent = `${origin}/mcp`;
  $("#talk-mcp-url").textContent = `${origin}/talk-mcp`;
  $("#snippet-claude").textContent =
    `claude mcp add-json nextcloud-mcp '{"type":"url","url":"${origin}/mcp"}'`;
}

async function onTest() {
  const url = $("#nc-url").value.trim();
  const username = $("#nc-username").value.trim();
  const appPassword = $("#nc-app-password").value;
  const out = $("#test-result");
  out.textContent = "testing…";
  out.className = "text-sm text-slate-500";
  try {
    const r = await api("/api/test", {
      method: "POST",
      body: JSON.stringify({ url, username, appPassword }),
    });
    if (r.ok) {
      out.textContent = r.serverVersion ? `✓ connected (${r.serverVersion})` : `✓ connected`;
      out.className = "text-sm text-emerald-700 font-medium";
    } else {
      out.textContent = `✗ ${r.error || "failed"}`;
      out.className = "text-sm text-red-700 font-medium";
    }
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.className = "text-sm text-red-700 font-medium";
  }
}

async function onSave() {
  const url = $("#nc-url").value.trim();
  const username = $("#nc-username").value.trim();
  const appPassword = $("#nc-app-password").value;
  if (!url) return toast("Nextcloud URL is required", true);
  if (!username) return toast("Username is required", true);
  try {
    await api("/api/config", {
      method: "POST",
      body: JSON.stringify({
        nextcloud: { url, username, appPassword },
      }),
    });
    toast("Saved — upstream restarting");
    await loadConfig();
  } catch (e) {
    toast("Save failed: " + e.message, true);
  }
}

async function onRescanBeacon() {
  const result = $("#scan-result");
  result.textContent = "scanning Beacon…";
  try {
    const r = await api("/api/beacon/scan?autoSave=1", { method: "POST" });
    result.textContent = `Found ${r.servers.length} server(s), ${r.candidates.length} LLM candidate(s). ${r.saved ? "Auto-saved best match." : r.reason === "ambiguous" ? "Multiple candidates — pick one below." : r.reason === "none" ? "No LLM found." : ""}`;
    renderCandidates(r.candidates);
    await loadConfig();
  } catch (e) {
    result.textContent = `scan failed: ${e.message}`;
  }
}

function renderCandidates(candidates) {
  const root = $("#candidate-list");
  if (!candidates || candidates.length === 0) {
    root.innerHTML = "";
    return;
  }
  root.innerHTML = candidates
    .map(
      (c, i) => `
      <div class="flex items-center justify-between text-xs bg-slate-50 border border-slate-200 p-2 rounded">
        <div>
          <div class="font-mono">${escapeHtml(c.namespacedToolName)}</div>
          <div class="text-slate-500">${escapeHtml(c.server.description || "")}</div>
        </div>
        <button class="text-xs px-2 py-1 bg-slate-800 text-white rounded hover:bg-slate-700" data-pick="${i}">Pick</button>
      </div>`,
    )
    .join("");
  root.querySelectorAll("[data-pick]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const idx = Number(btn.dataset.pick);
      const pick = candidates[idx];
      try {
        await api("/api/target", {
          method: "POST",
          body: JSON.stringify({ mode: "auto", toolName: pick.namespacedToolName }),
        });
        toast(`Pinned ${pick.namespacedToolName}`);
        await loadConfig();
      } catch (e) {
        toast("Pin failed: " + e.message, true);
      }
    });
  });
}

async function onPinDirect() {
  const directUrl = $("#direct-url").value.trim();
  const toolName = $("#direct-tool").value.trim();
  const directAuthToken = $("#direct-token").value;
  if (!directUrl || !toolName) return toast("direct URL and tool name required", true);
  try {
    await api("/api/target", {
      method: "POST",
      body: JSON.stringify({ mode: "direct", directUrl, toolName, directAuthToken }),
    });
    toast("Direct target saved");
    await loadConfig();
  } catch (e) {
    toast("Save failed: " + e.message, true);
  }
}

async function onSaveWatcher() {
  const enabled = $("#watcher-enabled").checked;
  const replyPrefix = $("#watcher-prefix").value;
  const ctxRaw = Number($("#watcher-context").value);
  const contextMessages = Number.isFinite(ctxRaw) ? Math.max(0, Math.min(100, Math.floor(ctxRaw))) : 20;
  const out = $("#watcher-save-result");
  out.textContent = "saving…";
  out.className = "text-xs text-slate-500";
  try {
    await api("/api/watcher", {
      method: "POST",
      body: JSON.stringify({ enabled, replyPrefix, contextMessages }),
    });
    out.textContent = "✓ saved";
    out.className = "text-xs text-emerald-700 font-medium";
    await loadConfig();
    await refreshWatcher();
  } catch (e) {
    out.textContent = `✗ ${e.message}`;
    out.className = "text-xs text-red-700 font-medium";
  }
}

async function onRescanWatcher() {
  try {
    await api("/api/watcher/rescan", { method: "POST" });
    toast("Re-scanned conversations");
    await refreshWatcher();
  } catch (e) {
    toast("Re-scan failed: " + e.message, true);
  }
}

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = `fixed bottom-4 right-4 max-w-sm p-3 rounded shadow-lg text-sm ${
    isError ? "bg-red-600 text-white" : "bg-slate-900 text-white"
  }`;
  setTimeout(() => t.classList.add("hidden"), 2500);
}
