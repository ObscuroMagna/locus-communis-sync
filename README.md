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

## Roadmap

- [x] Incremental sync using `since=<timestamp>` (Full resync command available for clean re-pulls)
- [ ] Push direction (Obsidian → LC) for notes added in a designated folder
- [ ] Conflict detection on local edits
- [ ] Server-side delete propagation (currently orphan files linger until Full resync)
- [ ] Tag mapping from `excerpt_tags`

## Releasing a new version

Releases are cut by tag-pushing — the GitHub Actions workflow at `.github/workflows/release.yml` builds `main.js` and attaches it (plus `manifest.json` and `versions.json`) as release assets.

```bash
# Bump version (also updates manifest.json + versions.json)
npm version patch    # or minor / major / 0.2.0

# Push the tag — Actions takes over
git push --follow-tags
```

Within a minute or two, a new release appears on GitHub with the three required files attached. Obsidian's community directory polls the latest release for these files when users install or update the plugin.

## Submitting to the Obsidian community directory

Not done yet. When ready:

1. Confirm `manifest.json` is filled in correctly (`id`, `name`, `version`, `minAppVersion`, `description`, `author`, `authorUrl`, `isDesktopOnly`)
2. Make sure there's at least one tagged release with `main.js`, `manifest.json`, and `versions.json` as assets
3. Fork [obsidianmd/obsidian-releases](https://github.com/obsidianmd/obsidian-releases) and add an entry to `community-plugins.json` for `locus-communis-sync` pointing to this repo
4. Open a PR — review usually takes a few days, sometimes longer
5. Address any feedback (common asks: don't use `innerHTML`, use `requestUrl` instead of `fetch`, no `console.log` in shipping builds, no `var`, etc.)
