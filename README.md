# Locus Communis Sync

Obsidian plugin that syncs excerpts from your [Locus Communis](https://locuscommunis.com) commonplace book into a folder in your vault. Each excerpt becomes its own Markdown file with YAML frontmatter (id, attribution, author, book, source, date), so it slots cleanly into Dataview queries, graph view, and your existing note structure.

## Status

v0.4: a one-way export of your library, restructured around works. Locus Communis is the source of truth: every sync rewrites these files, so write your own thoughts elsewhere in the vault and link to them. Each work gets a note (metadata, your work note, and a live table of its passages) with its passages in a folder beside it. Every passage carries the margin log you kept on it: notes, stamps, and strikes, dated so you can search or sort by when you marked something.

## Disclosures

- **Account required.** The plugin is useless without a Locus Communis account and a sync token generated from your Account page there.
- **Network use.** The plugin talks to exactly one remote service: your Locus Communis deployment (`locuscommunis.com` by default, configurable). It only reads: your excerpts, book pages, and work notes. The plugin sends no vault content anywhere.
- **No telemetry.** The plugin collects no analytics and phones home to nothing besides the sync API described above.

## How it works

The plugin authenticates against `locuscommunis.com/api/sync/*` with a personal access token you generate from the Locus Communis website. It never sees your Supabase credentials, your password, or any details about the backend. Tokens are hashed server-side and revocable per-device, so losing a laptop doesn't mean rotating everything.

Sync is incremental by default: the plugin tracks the timestamp of the last successful sync and only fetches excerpts created since then. A "Full resync" command bypasses the watermark and re-pulls everything (useful if you wipe the synced folder or want to repair drift).

## Install

### From the community directory

Once accepted into the Obsidian community plugins directory: Settings → Community plugins → Browse → search "Locus Communis Sync" → Install → Enable. Then generate a sync token from locuscommunis.com → Settings → **Connected apps**, paste it into the plugin's settings tab, click **Verify**, then **Sync now**.

### Via BRAT (before community-directory acceptance)

Until the plugin is accepted into the official directory, the cleanest way to install it (and get auto-updates) is through [BRAT — Beta Reviewers Auto-update Tool](https://github.com/TfTHacker/obsidian42-brat):

1. In Obsidian: Settings → Community plugins → Browse → install **BRAT** by TfTHacker → Enable
2. Open BRAT's settings tab → click **Add Beta plugin**
3. Paste this repository URL: `https://github.com/portdecker/locus-communis-sync`
4. Leave version as "Latest version" → click **Add Plugin**
5. BRAT downloads `main.js` + `manifest.json` from the latest GitHub release and installs the plugin into your vault
6. In Obsidian: Settings → Community plugins → enable **Locus Communis Sync**
7. Generate a sync token at locuscommunis.com → Settings → **Connected apps**, paste it into the plugin's settings tab, click **Verify**, then **Sync now**

BRAT polls for new GitHub releases automatically, so subsequent `npm version` + `git push --follow-tags` cycles deliver updates to BRAT users without any manual steps.

### From source (development)

1. Clone this repo into `<your-vault>/.obsidian/plugins/locus-communis-sync`
2. `npm install`
3. `npm run dev` (watches and rebuilds `main.js`)
4. In Obsidian: Settings → Community plugins → enable "Locus Communis Sync"
5. Generate a sync token at locuscommunis.com → Settings → **Connected apps**
6. In Obsidian: open the plugin's settings tab and paste the token, then click **Verify**
7. Click **Sync now**, run the command "Sync excerpts from Locus Communis", or click the ribbon icon

## Commands

- **Sync now** (command palette, or the ribbon icon): rebuilds the whole library from Locus Communis. There is no separate full resync; every sync is a full rebuild, so one command is the whole surface.

## Roadmap

- [x] Incremental sync using `since=<timestamp>` (Full resync command available for clean re-pulls)
- [x] Margin log on each passage (notes, stamps, strikes), searchable by date
- [x] Per-work folders with an embedded base in the work note
- [ ] Push direction: DROPPED 2026-08-01: the export is one-way by design
- [ ] Server-side delete propagation (currently orphan files linger until Full resync)
- [ ] Tag mapping from `excerpt_tags`

## Releasing a new version

Releases are cut by tag-pushing. The GitHub Actions workflow at `.github/workflows/release.yml` builds `main.js` and attaches it (plus `manifest.json` and `versions.json`) as release assets.

```bash
# Bump version (also updates manifest.json + versions.json)
npm version patch    # or minor / major / 0.2.0

# Push the tag, Actions takes over
git push --follow-tags
```

Within a minute or two, a new release appears on GitHub with the three required files attached. Obsidian's community directory polls the latest release for these files when users install or update the plugin.

## Submitting to the Obsidian community directory

Not done yet. When ready:

1. Confirm `manifest.json` is filled in correctly (`id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly`)
2. Make sure there's at least one tagged release with `main.js`, `manifest.json`, and `versions.json` as assets
3. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) and add an entry to `community-plugins.json` for `locus-communis-sync` pointing to this repo
4. Open a PR. Review usually takes a few days, sometimes longer
5. Address any feedback (common asks: don't use `innerHTML`, use `requestUrl` instead of `fetch`, no `console.log` in shipping builds, no `var`, etc.)
