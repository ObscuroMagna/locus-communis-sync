import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  normalizePath,
  requestUrl,
} from "obsidian";

interface LocusCommunisSettings {
  /** Base URL of the Locus Communis deployment, e.g. https://locuscommunis.com */
  apiBaseUrl: string;
  /** Personal access token issued from the LC settings page. */
  token: string;
  /** Folder inside the vault where excerpts are written. */
  vaultFolder: string;
  /** If true, also pull the user's own submissions to the public book. */
  includePublicBook: boolean;
  /** If true, also pull the user's per-work notes into the Notes subfolder. */
  syncNotes: boolean;
  /** ISO timestamp of the most recent successful excerpt sync. */
  lastSyncedAt: string | null;
  /** Display name of the connected LC user, populated by /api/sync/me. */
  connectedAs: string | null;
}

const DEFAULT_SETTINGS: LocusCommunisSettings = {
  apiBaseUrl: "https://locuscommunis.com",
  token: "",
  vaultFolder: "Locus Communis",
  includePublicBook: false,
  syncNotes: true,
  lastSyncedAt: null,
  connectedAs: null,
};

/** One margin entry: a note you wrote, or a stamp you pressed. */
interface LogEntry {
  kind: "note" | "stamp";
  body: string;
  created_at: string;
}

interface Excerpt {
  id: string;
  quote: string;
  source: string | null;
  attribution: string | null;
  author: string | null;
  book_title: string | null;
  work_id: string | null;
  is_public: boolean;
  dated_at: string | null;
  created_at: string;
  /** Strike count (mark stamps), summed server-side. Absent on v1. */
  strikes?: number;
  /** Notes and stamps, oldest first. Absent on v1 payloads. */
  log?: LogEntry[];
}

interface ExcerptsResponse {
  version: number;
  count: number;
  excerpts: Excerpt[];
}

interface Note {
  work_id: string;
  note: string;
  updated_at: string;
  created_at: string;
  work_title: string | null;
  work_creator: string | null;
  work_media_type: string | null;
  work_year: number | null;
}

interface NotesResponse {
  version: number;
  count: number;
  notes: Note[];
}

export default class LocusCommunisPlugin extends Plugin {
  settings!: LocusCommunisSettings;


  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("book-open", "Sync Locus Communis", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      // Obsidian prefixes commands with the plugin name, so naming this
      // "Sync Locus Communis" would read "Locus Communis Sync: Sync
      // Locus Communis" in the palette.
      name: "Sync now",
      callback: () => void this.syncNow(),
    });

    this.addSettingTab(new LocusCommunisSettingTab(this.app, this));
  }

  onunload() {
    // Nothing to tear down: the export is one-way, so there are no
    // watchers or pending pushes (2026-08-01 ruling).
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<LocusCommunisSettings> | null);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Build a URL against the configured API base, normalizing trailing slashes. */
  apiUrl(path: string): string {
    const base = this.settings.apiBaseUrl.replace(/\/+$/, "");
    return `${base}${path}`;
  }

  /**
   * Authenticated GET against the LC sync API. Throws on non-2xx with the
   * server's error message when available.
   */
  async apiGet<T>(path: string): Promise<T> {
    if (!this.settings.token) {
      throw new Error("No sync token configured");
    }
    const res = await requestUrl({
      url: this.apiUrl(path),
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
      },
      throw: false,
    });
    if (res.status < 200 || res.status >= 300) {
      const body = res.json as { error?: string; message?: string } | undefined;
      const detail = body?.message || body?.error || `HTTP ${res.status}`;
      throw new Error(detail);
    }
    return res.json as T;
  }

  /** Verify the current token by calling /api/sync/me; persists the display name. */
  async verifyToken(): Promise<{ user_id: string; display_name: string | null }> {
    const me = await this.apiGet<{ user_id: string; display_name: string | null }>(
      "/api/sync/me"
    );
    this.settings.connectedAs = me.display_name;
    await this.saveSettings();
    return me;
  }

  /**
   * Pull excerpts and notes and rebuild the vault library.
   *
   * Layout:
   *   <vaultFolder>/
   *     Library.base            — Bases table of every work
   *     Works/<Title>.md        — the work: metadata, note, and an
   *                               embedded base of its own passages
   *     Works/<Title>/          — that work's passages, one file each,
   *                               carrying their margin log
   *     Unlinked Excerpts.md    — excerpts without a work_id
   *
   * Incremental sync is intentionally dropped for this layout: rewriting a
   * book page accurately requires knowing *all* of that book's excerpts, so
   * we full-fetch both endpoints every run. For a personal commonplace, the
   * payload is small.
   *
   * `{ full }` is accepted for compatibility but no longer meaningful — every
   * sync is a full rebuild. The `lastSyncedAt` timestamp is still updated for
   * display.
   */
  async syncNow() {
    try {
      if (!this.settings.token) {
        new Notice("Locus Communis: paste a sync token in settings first.");
        return;
      }

      const requestStartedAt = new Date().toISOString();
      new Notice("Locus Communis: syncing…");

      const excerptParams = new URLSearchParams();
      if (this.settings.includePublicBook) excerptParams.set("include_public", "1");
      const excerptQs = excerptParams.toString();

      const [excerptData, notesData] = await Promise.all([
        this.apiGet<ExcerptsResponse>(
          `/api/sync/excerpts${excerptQs ? `?${excerptQs}` : ""}`
        ),
        this.settings.syncNotes
          ? this.apiGet<NotesResponse>(`/api/sync/notes`)
          : Promise.resolve({ version: 1, count: 0, notes: [] } as NotesResponse),
      ]);

      const { bookCount, unlinkedCount } = await this.writeLibrary(
        excerptData.excerpts,
        notesData.notes
      );

      this.settings.lastSyncedAt = requestStartedAt;
        await this.saveSettings();

      const parts: string[] = [];
      parts.push(`${bookCount} book${bookCount === 1 ? "" : "s"}`);
      parts.push(`${excerptData.count} excerpt${excerptData.count === 1 ? "" : "s"}`);
      if (this.settings.syncNotes) {
        parts.push(`${notesData.count} note${notesData.count === 1 ? "" : "s"}`);
      }
      if (unlinkedCount > 0) parts.push(`${unlinkedCount} unlinked`);
      new Notice(`Locus Communis: synced ${parts.join(", ")}.`);
    } catch (err) {
      console.error("[locus-communis] sync failed", err);
      new Notice(`Locus Communis sync failed: ${(err as Error).message}`);
    }
  }

  async ensureFolder(path: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) {
      await this.app.vault.createFolder(path);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`${path} exists and is not a folder`);
    }
  }

  async writeFile(path: string, body: string) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, body);
    } else {
      await this.app.vault.create(path, body);
    }
  }

  /**
   * Rewrite the library:
   *   Works/<title>.md       — the work: metadata, your note, and an
   *                            embedded base listing its passages.
   *   Works/<title>/…md      — one page per passage, with its margin log.
   *   Library.base           — Bases table across every work.
   *
   * Server is the source of truth — existing book/excerpt pages are
   * overwritten in place. Old files from previous layouts are left alone;
   * the user can delete them manually.
   */
  async writeLibrary(excerpts: Excerpt[], notes: Note[]): Promise<{
    bookCount: number;
    unlinkedCount: number;
  }> {
    const rootPath = normalizePath(this.settings.vaultFolder);
    const worksPath = normalizePath(`${this.settings.vaultFolder}/Works`);
    await this.ensureFolder(rootPath);
    await this.ensureFolder(worksPath);

    // Group by work_id. Build book records seeded from notes (which carry
    // authoritative work metadata via the /sync/notes embed) and filled in
    // from excerpts (for work-less excerpt metadata fallbacks).
    const byWork = new Map<string, BookGroup>();

    for (const note of notes) {
      byWork.set(note.work_id, {
        work_id: note.work_id,
        title: note.work_title,
        creator: note.work_creator,
        media_type: note.work_media_type,
        year: note.work_year,
        note,
        excerpts: [],
      });
    }

    const unlinked: Excerpt[] = [];
    for (const e of excerpts) {
      if (!e.work_id) {
        unlinked.push(e);
        continue;
      }
      let group = byWork.get(e.work_id);
      if (!group) {
        group = {
          work_id: e.work_id,
          title: e.book_title,
          creator: e.author,
          media_type: null,
          year: null,
          note: null,
          excerpts: [],
        };
        byWork.set(e.work_id, group);
      } else {
        // Fill in any metadata the note didn't have.
        if (!group.title && e.book_title) group.title = e.book_title;
        if (!group.creator && e.author) group.creator = e.author;
      }
      group.excerpts.push(e);
    }

    // One file per work, then its passages beneath it.
    for (const group of byWork.values()) {
      group.excerpts.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const filename = bookFilename(group);
      const path = normalizePath(`${worksPath}/${filename}`);
      // The work's excerpts live in a sibling folder of the same name, so
      // the work note can embed a base scoped to exactly its own passages.
      const workFolder = filename.replace(/\.md$/, "");
      const workFolderPath = normalizePath(`${worksPath}/${workFolder}`);
      await this.ensureFolder(workFolderPath);
      await this.writeFile(path, bookToMarkdown(group, workFolder));

      // Per-excerpt files, each wikilinked back to the book file. The
      // book wikilink is derived from the book's filename (without .md)
      // so Obsidian resolves it without needing aliases.
      const bookWikilink = workFolder;
      for (const e of group.excerpts) {
        const exFilename = excerptFilename(e);
        const exPath = normalizePath(`${workFolderPath}/${exFilename}`);
        await this.writeFile(exPath, excerptToMarkdownFile(e, group, bookWikilink));
      }
    }

    // Unlinked excerpts — single catch-all file so they still sync.
    const unlinkedPath = normalizePath(`${rootPath}/Unlinked Excerpts.md`);
    if (unlinked.length > 0) {
      await this.writeFile(unlinkedPath, unlinkedToMarkdown(unlinked));
    } else {
      const existing = this.app.vault.getAbstractFileByPath(unlinkedPath);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, unlinkedToMarkdown([]));
      }
    }

    // Bases index.
    const basePath = normalizePath(`${rootPath}/Library.base`);
    await this.writeFile(basePath, renderBase());

    // Readme — documents how to add notes so users know to create a ## Note
    // heading themselves (we no longer emit an empty placeholder).
    const readmePath = normalizePath(`${rootPath}/README.md`);
    await this.writeFile(readmePath, renderReadme());

    return { bookCount: byWork.size, unlinkedCount: unlinked.length };
  }
}

interface BookGroup {
  work_id: string;
  title: string | null;
  creator: string | null;
  media_type: string | null;
  year: number | null;
  note: Note | null;
  excerpts: Excerpt[];
}
/* ─────────────── Markdown formatting ─────────────── */

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function bookFilename(g: BookGroup): string {
  const base = g.title || g.creator || g.work_id;
  const safe = sanitizeFilename(base);
  // Include a short id suffix so two works with the same title don't collide.
  return `${safe} — ${g.work_id.slice(0, 8)}.md`;
}

/**
 * Render a single book page. YAML frontmatter carries structured fields so the
 * root `Locus Communis.base` can index across books; the body has the work's
 * private note (if any). Excerpts live in their own files under Excerpts/ and
 * link back here via wikilink.
 */
function bookToMarkdown(g: BookGroup, workFolder: string): string {
  const lines = ["---"];
  lines.push(`work_id: ${g.work_id}`);
  if (g.title) lines.push(`title: "${escapeYaml(g.title)}"`);
  if (g.creator) lines.push(`creator: "${escapeYaml(g.creator)}"`);
  if (g.media_type) lines.push(`media_type: ${g.media_type}`);
  if (g.year) lines.push(`year: ${g.year}`);
  lines.push(`excerpt_count: ${g.excerpts.length}`);
  lines.push(`has_note: ${g.note ? "true" : "false"}`);
  if (g.note) lines.push(`note_updated: ${g.note.updated_at}`);
  lines.push("tags:");
  lines.push("  - locus-communis");
  lines.push("  - locus-communis/book");
  lines.push("---");
  lines.push("");
  lines.push(`# ${g.title || g.creator || g.work_id}`);
  if (g.creator) lines.push(`*${g.creator}${g.year ? `, ${g.year}` : ""}*`);
  lines.push("");

  // Only emit the Note section when a note already exists on the server.
  // Otherwise a keystroke in an empty placeholder would create a note row
  // the user never intended. Users who want a note can add `## Note`
  // manually, but this file is rewritten whole every sync, so anything
  // typed here is lost. Notes belong in the web app.
  if (g.note) {
    lines.push("## Note");
    lines.push("");
    lines.push(g.note.note.trim());
    lines.push("");
  }

  // The work's passages live in a sibling folder of the same name. An
  // embedded base scoped to that folder means the note shows a live,
  // sortable table of its own excerpts without duplicating their text.
  lines.push("## Passages");
  lines.push("");
  lines.push("```base");
  lines.push("filters:");
  lines.push("  and:");
  lines.push(`    - file.inFolder("${workFolder}")`);
  lines.push('    - file.hasTag("locus-communis/excerpt")');
  lines.push("views:");
  lines.push("  - type: table");
  lines.push("    name: Passages");
  lines.push("    order:");
  lines.push("      - file.name");
  lines.push("      - date");
  lines.push("      - strikes");
  lines.push("      - log_count");
  lines.push("      - log_last");
  lines.push("    sort:");
  lines.push("      - property: date");
  lines.push("        direction: DESC");
  lines.push("```");
  lines.push("");

  return lines.join("\n");
}

function excerptFilename(e: Excerpt): string {
  // Build a readable preview from the first ~50 chars of the quote, then
  // append a short id suffix to prevent collisions. Same naming pattern
  // as bookFilename — readable left, stable right.
  const preview = sanitizeFilename(e.quote || "").slice(0, 50).trim() || "excerpt";
  return `${preview} — ${e.id.slice(0, 8)}.md`;
}

/**
 * Render a single excerpt as its own .md file. Frontmatter carries the
 * structured fields so Bases can index across Excerpts/; the body has the
 * quote, attribution, and a wikilink back to the book page.
 */
function excerptToMarkdownFile(e: Excerpt, g: BookGroup, bookWikilink: string): string {
  const lines = ["---"];
  lines.push(`excerpt_id: ${e.id}`);
  if (e.work_id) lines.push(`work_id: ${e.work_id}`);
  if (g.title) lines.push(`work_title: "${escapeYaml(g.title)}"`);
  if (g.creator) lines.push(`work_creator: "${escapeYaml(g.creator)}"`);
  if (e.attribution) lines.push(`attribution: "${escapeYaml(e.attribution)}"`);
  if (e.source) lines.push(`source: "${escapeYaml(e.source)}"`);
  const date = (e.dated_at ?? e.created_at)?.split("T")[0];
  if (date) lines.push(`date: ${date}`);
  // The margin log, summarised in frontmatter so a base can sort and
  // filter on it. Body lines below carry the readable thread; these are
  // what make "everything I marked in July" a query rather than a grep.
  const log = e.log ?? [];
  const strikes = e.strikes ?? 0;
  if (strikes > 0) lines.push(`strikes: ${strikes}`);
  if (log.length > 0) {
    lines.push(`log_count: ${log.length}`);
    lines.push(`log_first: ${logDate(log[0].created_at)}`);
    lines.push(`log_last: ${logDate(log[log.length - 1].created_at)}`);
  }
  lines.push("tags:");
  lines.push("  - locus-communis");
  lines.push("  - locus-communis/excerpt");
  lines.push("---");
  lines.push("");
  lines.push(...quoteBlock(e));
  lines.push("");
  lines.push(`From [[${bookWikilink}]]`);
  lines.push("");

  lines.push(...logLines(e));
  return lines.join("\n");
}

/** ISO day for a log line: sortable, searchable, no time noise. */
function logDate(iso: string): string {
  return (iso || "").split("T")[0];
}

/**
 * The quote block both surfaces share: blockquote, then the citation
 * line. Extracted so a passage reads identically whether it lives in its
 * work's folder or the unlinked catch-all.
 */
function quoteBlock(e: Excerpt): string[] {
  const lines = [`> ${e.quote.replace(/\n/g, "\n> ")}`, ""];
  const bits: string[] = [];
  if (e.attribution) {
    bits.push(e.source ? `[${e.attribution}](${e.source})` : e.attribution);
  }
  const date = (e.dated_at ?? e.created_at)?.split("T")[0];
  if (date) bits.push(date);
  if (bits.length > 0) lines.push(`— ${bits.join(" · ")}`);
  return lines;
}

/**
 * The margin log as body lines: ISO date first so a month reads as a
 * plain-text search and the lines sort lexically. Shared by both
 * surfaces, so an unlinked passage keeps the marks made on it.
 */
function logLines(e: Excerpt): string[] {
  const log = e.log ?? [];
  const strikes = e.strikes ?? 0;
  if (log.length === 0 && strikes === 0) return [];
  const lines = ["## Log", ""];
  if (strikes > 0) lines.push(`- ${logDate(e.created_at)} · struck ϟ ×${strikes}`);
  for (const entry of log) {
    if (entry.kind === "note") {
      lines.push(`- ${logDate(entry.created_at)} · note :: ${entry.body.trim().replace(/\n/g, "\n  ")}`);
    } else {
      lines.push(`- ${logDate(entry.created_at)} · stamp ${entry.body}`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * Catch-all file for excerpts that have no work_id. Rewritten in full each
 * sync so deletions propagate. Empty body when all excerpts are linked.
 */
function unlinkedToMarkdown(excerpts: Excerpt[]): string {
  const lines = ["---"];
  lines.push("tags:");
  lines.push("  - locus-communis");
  lines.push("  - locus-communis/unlinked");
  lines.push("---");
  lines.push("");
  lines.push("# Unlinked Excerpts");
  lines.push("");
  if (excerpts.length === 0) {
    lines.push("*No unlinked excerpts. Every excerpt is attached to a book page.*");
    return lines.join("\n");
  }
  lines.push(
    "*Excerpts below have no linked work in Locus Communis. Edit the excerpt " +
      "in the web app and pick a book to move it onto its own book page.*"
  );
  lines.push("");
  const sorted = [...excerpts].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const e of sorted) {
    lines.push(...quoteBlock(e));
    lines.push("");
    lines.push(...logLines(e));
  }
  return lines.join("\n");
}

/**
 * Obsidian Bases file for the library root. Filters to the Books/ subfolder
 * so the table view enumerates every book page with its frontmatter columns.
 * Bases are a YAML-based view spec introduced in Obsidian 1.9+.
 */
function renderBase(): string {
  return [
    "filters:",
    "  and:",
    // Tag, not folder: works sit in Works/ while their passages sit in
    // per-work subfolders BENEATH it, and a folder prefix would sweep
    // every excerpt into the library table too.
    '    - \'file.hasTag("locus-communis/book")\'',
    "views:",
    "  - type: table",
    "    name: Works",
    "    order:",
    "      - file.name",
    "      - creator",
    "      - year",
    "      - media_type",
    "      - excerpt_count",
    "      - has_note",
    "    sort:",
    "      - property: file.name",
    "        direction: ASC",
    "",
  ].join("\n");
}

function renderReadme(): string {
  return [
    "# Locus Communis",
    "",
    "This folder mirrors your [Locus Communis](https://locuscommunis.com) library.",
    "",
    "```",
    "Works/",
    "  <Work>.md        the work: metadata, your note, and a live table",
    "                   of its passages",
    "  <Work>/          that work's passages, one file each, with the",
    "                   margin log you kept on them",
    "Library.base       a table across every work",
    "```",
    "",
    "Each passage carries its log in the body (dated lines you can search,",
    "like `2026-07`) and a summary in frontmatter (`log_count`, `log_first`,",
    "`log_last`, `strikes`) so a base can sort and filter on it.",
    "",
    "The export is one-way: Locus Communis is the source of truth and every",
    "sync rewrites these files. Write freely in your own notes elsewhere in",
    "the vault and link to these; anything you type INSIDE them is replaced",
    "on the next sync.",
    "",
    "## Notes on a work",
    "",
    "A work's `## Note` section mirrors the note you wrote in Locus Communis.",
    "It is private and never leaves your account. Write it in the web app:",
    "anything typed here is replaced on the next sync.",
    "",
    "## Excerpts",
    "",
    "Excerpts are overwritten each sync: the web app is the source of truth.",
    "Edit the quote or attribution in Locus Communis, not here. Excerpts that",
    "aren't attached to a work land in `Unlinked Excerpts.md` at the root.",
    "",
    "## Resync",
    "",
    "Run **Sync now** from the command palette, or click the ribbon icon, any time.",
    "Everything under this folder is safe to rebuild.",
    "",
  ].join("\n");
}

/* ─────────────────────────── Settings tab ─────────────────────────── */

class LocusCommunisSettingTab extends PluginSettingTab {
  plugin: LocusCommunisPlugin;

  constructor(app: App, plugin: LocusCommunisPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("Base URL of your Locus Communis deployment.")
      .addText((t) =>
        t
          .setPlaceholder("https://locuscommunis.com")
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async (v) => {
            this.plugin.settings.apiBaseUrl = v.trim() || DEFAULT_SETTINGS.apiBaseUrl;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync token")
      .setDesc(
        "Paste a personal sync token. Generate one at locuscommunis.com → Settings → Connected apps."
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("lcs_live_…")
          .setValue(this.plugin.settings.token)
          .onChange(async (v) => {
            this.plugin.settings.token = v.trim();
            await this.plugin.saveSettings();
          });
      })
      .addButton((b) =>
        b
          .setButtonText("Verify")
          .onClick(async () => {
            try {
              const me = await this.plugin.verifyToken();
              new Notice(
                `Locus Communis: connected as ${me.display_name || me.user_id.slice(0, 8)}.`
              );
              this.display();
            } catch (err) {
              new Notice(`Verify failed: ${(err as Error).message}`);
            }
          })
      );

    if (this.plugin.settings.connectedAs) {
      containerEl.createEl("p", {
        text: `Connected as: ${this.plugin.settings.connectedAs}`,
      });
    }

    new Setting(containerEl)
      .setName("Vault folder")
      .setDesc("Folder to write excerpts into.")
      .addText((t) =>
        t
          .setPlaceholder("Locus Communis")
          .setValue(this.plugin.settings.vaultFolder)
          .onChange(async (v) => {
            this.plugin.settings.vaultFolder = v.trim() || "Locus Communis";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync work notes")
      .setDesc(
        "Include your per-work notes on each book page. Notes are strictly private: they never leave your account."
      )
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.syncNotes)
          .onChange(async (v) => {
            this.plugin.settings.syncNotes = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Include public book excerpts")
      .setDesc("If on, also pull excerpts you've submitted to the public book.")
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.includePublicBook)
          .onChange(async (v) => {
            this.plugin.settings.includePublicBook = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .addButton((b) =>
        b
          .setButtonText("Sync now")
          .setCta()
          .onClick(() => this.plugin.syncNow())
      );

    if (this.plugin.settings.lastSyncedAt) {
      containerEl.createEl("p", {
        text: `Last sync: ${new Date(this.plugin.settings.lastSyncedAt).toLocaleString()}`,
      });
    }
  }
}
