# Nextcloud MCP

An MCP (Model Context Protocol) server that exposes the [Nextcloud](https://nextcloud.com) API — Notes, Calendar, Contacts, Files, Deck, Cookbook, Tables, Sharing, News, Collectives — so an LLM can read and edit your Nextcloud from a chat UI. Packaged as a single Docker image — CasaOS / Yundera compatible — with a small Web UI for setup and [Beacon](../beacon) auto-discovery.

Under the hood it wraps the upstream [`ghcr.io/cbcoutinho/nextcloud-mcp-server`](https://github.com/cbcoutinho/nextcloud-mcp-server) image and adds:

- **Web UI** for entering the Nextcloud URL, username, and app-password (no hand-editing config).
- **Beacon responder** so the server auto-registers on the shared `mcp-net` / `pcs` network.
- **CasaOS-style compose** (`/DATA/AppData/$AppID/...` volume, `pcs` network, Caddy labels).

## Overview

```
┌───────────────┐       ┌────────────────────────────────────────────────┐
│  Nextcloud    │◄─────►│             nextcloudmcp container             │
│  (WebDAV +    │ Basic │  ┌────────────────────┐  ┌─────────────────┐   │
│   REST APIs)  │  auth │  │ Upstream MCP       │  │  Web UI + API   │   │
│               │ (app  │  │ (cbcoutinho/       │  │  :9650          │   │
└───────────────┘  pwd) │  │  nextcloud-mcp,    │◄─┤  • setup guide  │   │
                        │  │  FastAPI HTTP)     │  │  • creds form   │   │
                        │  │  :8000 internal    │  │  • /mcp proxy   │   │
                        │  └──────────┬─────────┘  │  • Beacon UDP   │   │
                        │             │            │    :9099        │   │
                        │             └─ /mcp ────►│                 │   │
                        │                          └─────────────────┘   │
                        └────────────────────────────────────────────────┘
```

LLM clients (Claude Code, Claude Desktop, Cursor, …) connect to `http://<host>:9650/mcp` directly, or let Beacon aggregate it at `http://<host>:9300/mcp/`.

## Features

- **Full Nextcloud surface** via the upstream MCP tools (**118 total** as of upstream v1.27.0) across:
  - Notes, Calendar & Todos, Contacts, Files (WebDAV), Deck (Kanban),
  - Cookbook, Tables, Sharing, News, Collectives.
- **One-shot setup** — paste Nextcloud URL + username + app-password once, hit **Save**, server hot-reloads.
- **CasaOS / Yundera ready** — drop the compose file into `YunderaAppStore/Apps/nextcloudmcp/` and go.
- **Beacon-discoverable** — shows up automatically in any Beacon aggregator on the same network.
- **Single container** — the upstream Python MCP and the Node wrapper are supervised together; config persists on a mounted volume.
- **Optional semantic search** — toggle `ENABLE_SEMANTIC_SEARCH` to enable the upstream's vector search over Notes.

## Quick Start

### Prerequisites

- A running Nextcloud instance (local or remote) reachable from the container.
- A Nextcloud **app-password**: in Nextcloud, **Settings → Personal → Security → Devices & sessions → Create new app password**. Use a descriptive device name (e.g. `nextcloudmcp`). Regular login passwords are *not* recommended and may fail if 2FA is enabled.
- Docker + Docker Compose.

### Run (standalone)

```bash
docker network create mcp-net   # shared with Beacon + other MCPs (once)
docker compose up -d
open http://localhost:9650
```

### Auto-respond to your Talk messages

Optional: flip one toggle and Claude (via Beacon) auto-replies to your
Nextcloud Talk DMs and `@<username>` mentions.

Setup in the Web UI's **Auto-respond** panel:

1. Make sure **Nextcloud Connection** is green (`/api/status` shows
   `upstreamHealthy: true`).
2. In **LLM Target**, click **Rescan Beacon** — if an LLM MCP is on the
   network, it auto-saves (e.g. `claude-code__query_claude`).
3. Check **Enable — watch my DMs and @me mentions**. Optionally tweak the
   reply prefix (defaults to `🤖 `).
4. Click **Save**.

That's it. No `occ` command, no public URL, no HMAC — just the app-password
you already pasted. See
[`docs/design-decisions.md`](./docs/design-decisions.md) (ADR-001) for why
we chose polling over the Talk bot webhook.

In the Web UI:

1. Paste the **Nextcloud URL** (e.g. `http://nextcloud:80` on the same network, or `https://cloud.example.com`).
2. Paste the **Username**.
3. Paste the **App Password**.
4. Click **Test connection** → **Save**.

Add to Claude Code:

```bash
claude mcp add-json nextcloud-mcp '{"type":"url","url":"http://localhost:9650/mcp"}'
```

Or via Beacon (recommended — one entry, every MCP):

```bash
claude mcp add beacon --transport http http://localhost:9300/mcp/
```

### Run on CasaOS / Yundera

Copy `casaos/docker-compose.yml` into `YunderaAppStore/Apps/nextcloudmcp/docker-compose.yml`. It follows the same conventions as the sibling `Nextcloud` app:

- Uses the shared external `pcs` network.
- Mounts `/DATA/AppData/$AppID/data/` for config persistence.
- Caddy labels expose the Web UI at `nextcloudmcp-${APP_DOMAIN}`.
- The MCP endpoint lives at the same hostname under `/mcp`.

Install it from the Yundera store, open the app tile, and finish setup in the UI.

## MCP Tools Exposed

The exact tool list comes from the upstream `cbcoutinho/nextcloud-mcp-server` image — this project forwards them unchanged. As of upstream `v1.27.0` it ships **118 tools** across these categories:

| Category | Prefix | Representative tools |
|---|---|---|
| **Notes** | `nc_notes_*` | `nc_notes_create_note`, `nc_notes_get_note`, `nc_notes_update_note`, `nc_notes_delete_note`, `nc_notes_search_notes`, `nc_notes_append_content`, `nc_notes_get_attachment` |
| **Calendar & Todos** | `nc_calendar_*` | `nc_calendar_create_event`, `nc_calendar_get_event`, `nc_calendar_delete_event`, `nc_calendar_create_todo`, `nc_calendar_delete_todo`, `nc_calendar_create_meeting`, `nc_calendar_find_availability`, `nc_calendar_bulk_operations` |
| **Contacts** | `nc_contacts_*` | `nc_contacts_list_addressbooks`, `nc_contacts_create_addressbook`, `nc_contacts_delete_addressbook`, `nc_contacts_list_contacts`, `nc_contacts_create_contact`, `nc_contacts_update_contact`, `nc_contacts_delete_contact` |
| **Files (WebDAV)** | `nc_webdav_*` | `nc_webdav_list_directory`, `nc_webdav_create_directory`, `nc_webdav_copy_resource`, `nc_webdav_move_resource`, `nc_webdav_delete_resource`, `nc_webdav_find_by_name`, `nc_webdav_find_by_type`, `nc_webdav_list_favorites` |
| **Deck** (Kanban) | `deck_*` | `deck_create_board`, `deck_create_stack`, `deck_create_card`, `deck_delete_card`, `deck_archive_card`, `deck_assign_user_to_card`, `deck_assign_label_to_card`, `deck_create_label` |
| **Cookbook** | `nc_cookbook_*` | `nc_cookbook_list_categories`, `nc_cookbook_list_keywords`, `nc_cookbook_get_recipe`, `nc_cookbook_create_recipe`, `nc_cookbook_delete_recipe`, `nc_cookbook_import_recipe`, `nc_cookbook_get_recipes_in_category`, `nc_cookbook_get_recipes_with_keywords` |
| **Tables** | `nc_tables_*` | `nc_tables_list_tables`, `nc_tables_get_schema`, `nc_tables_read_table`, `nc_tables_insert_row`, `nc_tables_update_row`, `nc_tables_delete_row` |
| **Sharing** | `nc_share_*` | `nc_share_list`, `nc_share_get`, `nc_share_create`, `nc_share_update`, `nc_share_delete` |
| **News** | `nc_news_*` | `nc_news_list_folders`, `nc_news_list_feeds`, `nc_news_list_items`, `nc_news_get_item`, `nc_news_get_starred_items`, `nc_news_get_unread_items`, `nc_news_get_feed_health`, `nc_news_get_status` |
| **Collectives** | `collectives_*` | `collectives_get_collectives`, `collectives_create_collective`, `collectives_delete_collective`, `collectives_restore_collective`, `collectives_get_pages`, `collectives_create_page`, `collectives_move_page`, `collectives_set_page_emoji`, `collectives_assign_tag`, `collectives_get_tags` |

All of these run against the Nextcloud REST/WebDAV APIs using the credentials you saved in the Web UI.

Per-app filtering is available at the upstream level via the `--enable-app` CLI flag (future enhancement: expose this as UI toggles).

## Configuration

The Web UI writes `data/config.json`:

```json
{
  "nextcloud": {
    "url": "https://cloud.example.com",
    "username": "alice",
    "appPassword": "***redacted***"
  },
  "features": {
    "semanticSearch": false
  },
  "server": {
    "port": 9650,
    "discoveryPort": 9099
  }
}
```

The app-password is **never** returned by `GET /api/config` — it's masked as `***redacted***`. Saving with the masked value preserves the existing password.

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Web UI / API / MCP port | `9650` |
| `DISCOVERY_PORT` | Beacon UDP discovery port | `9099` |
| `UPSTREAM_PORT` | Port where the wrapped upstream MCP listens inside the container | `8000` |
| `CONFIG_PATH` | Config file path | `/app/data/config.json` |
| `NEXTCLOUD_HOST` | Optional — pre-seeds `nextcloud.url` if config is empty | — |
| `NEXTCLOUD_USERNAME` | Optional — pre-seeds `nextcloud.username` | — |
| `NEXTCLOUD_PASSWORD` | Optional — pre-seeds `nextcloud.appPassword` (use app-password, not login pw) | — |
| `ENABLE_SEMANTIC_SEARCH` | Toggle upstream semantic search over Notes | `false` |

Setting `NEXTCLOUD_HOST` + `NEXTCLOUD_USERNAME` + `NEXTCLOUD_PASSWORD` lets the stack come up fully configured with no UI click-through — useful for CasaOS install-tips that pass values from the parent Nextcloud app.

## How It Relates to the Existing `Nextcloud` CasaOS App

This project is a *companion* to the sibling `YunderaAppStore/Apps/Nextcloud` app — it does not replace it. Install Nextcloud first, create an app-password there, then install `nextcloudmcp` and paste the credentials. Both apps share the `pcs` network, so the MCP can reach Nextcloud at `http://nextcloud:80` (or whatever hostname the sibling app exposes).

## Security

- The app-password lives in `data/config.json` (volume-mounted) and is never logged or returned via any API.
- The Web UI has no built-in auth by default — front it with the Caddy/Yundera reverse proxy for external access, or enable the optional `nginx-hash-lock` sidecar (see `casaos/docker-compose.yml`).
- Outbound traffic is limited to the configured Nextcloud URL.
- App-passwords can be individually revoked in Nextcloud → **Settings → Security** — use this rather than rotating your main password.

## Project Layout

```
nextcloudmcp/
├── src/                # Node wrapper: Web UI, API, proxy, Beacon announce
├── web/                # Static UI (index.html, app.js)
├── casaos/             # CasaOS-flavored docker-compose.yml
├── Dockerfile
├── docker-compose.yml  # Standalone dev/testing variant
├── supervisord.conf    # Runs upstream MCP + wrapper together
├── package.json
├── IMPLEMENTATION.md
└── README.md
```

## License

MIT
