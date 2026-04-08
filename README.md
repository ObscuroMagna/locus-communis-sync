# Locus Communis Sync

Obsidian plugin that syncs excerpts from your [Locus Communis](https://locuscommunis.com) commonplace book into a folder in your vault.

## Status

v0.1 — one-way pull (Locus Communis → vault). Server is source of truth; local edits in the synced folder will be overwritten on next sync.

## Install (development)

This plugin isn't in the community directory yet. To run it locally:

1. Clone this repo into `<your-vault>/.obsidian/plugins/locus-communis-sync`
2. `npm install`
3. `npm run dev` (watches and rebuilds `main.js`)
4. In Obsidian: Settings → Community plugins → enable "Locus Communis Sync"
5. Generate a sync token at locuscommunis.com → Settings → **Connected apps**
6. In Obsidian: open the plugin's settings tab and paste the token, then click **Verify**
7. Click **Sync now**, run the command "Sync excerpts from Locus Communis", or click the ribbon icon

## How auth works

The plugin never talks to Supabase directly. It calls `/api/sync/excerpts` and `/api/sync/me` on the Locus Communis server with a personal access token in the `Authorization` header. The server hashes the token, looks it up in `sync_tokens`, and uses the service role to query the requesting user's data.

This means:

- No credentials in the plugin (no email, no password, no Supabase keys)
- Tokens are revocable per-device from the LC settings page
- The plugin works regardless of how you originally signed in (Google or email)
- The API is a stable JSON contract, so plugin versions keep working across schema changes
- The plugin bundle is tiny — no `@supabase/supabase-js` dependency

## Roadmap

- [ ] Push direction (Obsidian → LC) for notes added in a designated folder
- [ ] Incremental sync using `since=<timestamp>` (the API supports it; the plugin doesn't pass it yet)
- [ ] Conflict detection on local edits
- [ ] Tag mapping from `excerpt_tags`
