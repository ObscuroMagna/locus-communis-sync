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
  /** ISO timestamp of the most recent successful notes sync. */
  lastNotesSyncedAt: string | null;
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
  lastNotesSyncedAt: null,
  connectedAs: null,
};

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

  // In-memory mirror of the last-known server note for each work_id. Used
  // to (a) detect real local edits vs. our own writes and (b) supply the
  // `client_updated_at` watermark in PUTs for LWW conflict detection.
  private lastSyncedNotes = new Map<
    string,
    { note: string; updated_at: string; path: string }
  >();

  private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private inflightPushes = new Set<string>();
  private readonly pushDebounceMs = 1500;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("book-open", "Sync Locus Communis", () => {
      this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync Locus Communis",
      callback: () => this.syncNow(),
    });

    this.addCommand({
      id: "full-resync",
      name: "Full resync (rebuild book pages)",
      callback: () => this.syncNow({ full: true }),
    });

    // Two-way notes sync: watch Books/ pages for edits and push the Note
    // section back to the server. Excerpts and frontmatter are ignored.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile) this.onFileModified(file);
      })
    );

    this.addSettingTab(new LocusCommunisSettingTab(this.app, this));
  }

  onunload() {
    for (const timer of this.pushTimers.values()) clearTimeout(timer);
    this.pushTimers.clear();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
   *     Locus Communis.base     — Bases index of all books
   *     Books/<Title>.md        — one page per work (excerpts + note inline)
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
  async syncNow(_opts: { full?: boolean } = {}) {
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
      this.settings.lastNotesSyncedAt = requestStartedAt;
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

  /**
   * Fired on every vault modify. Filters to Books/ pages, extracts the note
   * section, and schedules a debounced PUT if the note differs from the
   * last-synced content. Compares against the in-memory map, not a
   * suppression flag, so our own `writeFile` calls don't echo back as edits.
   */
  private onFileModified(file: TFile) {
    const booksPrefix = normalizePath(`${this.settings.vaultFolder}/Books/`);
    if (!file.path.startsWith(booksPrefix)) return;
    if (!this.settings.syncNotes || !this.settings.token) return;

    const existing = this.pushTimers.get(file.path);
    if (existing) clearTimeout(existing);
    this.pushTimers.set(
      file.path,
      setTimeout(() => {
        this.pushTimers.delete(file.path);
        this.maybePushNote(file).catch((err) => {
          console.error("[locus-communis] note push failed", err);
        });
      }, this.pushDebounceMs)
    );
  }

  private async maybePushNote(file: TFile) {
    if (this.inflightPushes.has(file.path)) {
      // Reschedule behind the in-flight one so the latest edit wins.
      this.onFileModified(file);
      return;
    }

    const content = await this.app.vault.read(file);
    const parsed = parseBookFile(content);
    if (!parsed.work_id) return;

    const known = this.lastSyncedNotes.get(parsed.work_id);
    if (!known) return; // Not yet hydrated by a sync — nothing to diff against.
    if (parsed.note === known.note) return; // Our own write, or no real change.

    this.inflightPushes.add(file.path);
    try {
      const res = await this.putNote(
        parsed.work_id,
        parsed.note,
        known.updated_at || null
      );
      if (res.kind === "ok") {
        this.lastSyncedNotes.set(parsed.work_id, {
          note: res.note.trim(),
          updated_at: res.updated_at,
          path: file.path,
        });
      } else if (res.kind === "conflict") {
        // Server has a newer edit. Pull remote into the file so the user can
        // merge by hand, and update the in-memory map to match.
        new Notice(
          "Locus Communis: note conflict — server version kept. Your edit was saved as a duplicate heading."
        );
        await this.writeConflictMarker(file, parsed, res.server);
        this.lastSyncedNotes.set(parsed.work_id, {
          note: res.server.note.trim(),
          updated_at: res.server.updated_at,
          path: file.path,
        });
      }
    } finally {
      this.inflightPushes.delete(file.path);
    }
  }

  private async putNote(
    workId: string,
    note: string,
    clientUpdatedAt: string | null
  ): Promise<
    | { kind: "ok"; note: string; updated_at: string }
    | { kind: "conflict"; server: { note: string; updated_at: string } }
  > {
    const res = await requestUrl({
      url: this.apiUrl("/api/sync/notes"),
      method: "PUT",
      headers: {
        Authorization: `Bearer ${this.settings.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        work_id: workId,
        note,
        client_updated_at: clientUpdatedAt,
      }),
      throw: false,
    });
    if (res.status === 200) {
      const body = res.json as { note: string; updated_at: string };
      return { kind: "ok", note: body.note, updated_at: body.updated_at };
    }
    if (res.status === 409) {
      const body = res.json as { server: { note: string; updated_at: string } };
      return { kind: "conflict", server: body.server };
    }
    const err = res.json as { error?: string } | undefined;
    throw new Error(err?.error || `HTTP ${res.status}`);
  }

  /**
   * On 409, rewrite the book page with the server note and tuck the local
   * unsynced edit under an "## Unsynced local edit" subsection so it isn't
   * lost. User picks a side and re-saves.
   */
  private async writeConflictMarker(
    file: TFile,
    parsed: ParsedBookFile,
    server: { note: string; updated_at: string }
  ) {
    const current = await this.app.vault.read(file);
    const { before, after } = splitAtNoteSection(current);
    const merged =
      before +
      "## Note\n\n" +
      server.note +
      "\n\n" +
      "## Unsynced local edit\n\n" +
      parsed.note +
      "\n\n" +
      after;
    await this.app.vault.modify(file, merged);
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
   * Rewrite the library: book pages under Books/, a Base index at the root,
   * and an Unlinked Excerpts.md catch-all for excerpts with no work_id.
   *
   * Server is the source of truth — existing book pages are overwritten in
   * place. Old files from the previous per-excerpt layout (v0.1.x) are left
   * alone; the user can delete them manually.
   */
  async writeLibrary(excerpts: Excerpt[], notes: Note[]): Promise<{
    bookCount: number;
    unlinkedCount: number;
  }> {
    const rootPath = normalizePath(this.settings.vaultFolder);
    const booksPath = normalizePath(`${this.settings.vaultFolder}/Books`);
    await this.ensureFolder(rootPath);
    await this.ensureFolder(booksPath);

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

    // Write one file per book and remember the authoritative note content /
    // timestamp so the modify handler can distinguish local edits from our
    // own writes and supply the LWW watermark on PUT.
    const freshLastSynced = new Map<string, { note: string; updated_at: string; path: string }>();
    for (const group of byWork.values()) {
      group.excerpts.sort((a, b) => a.created_at.localeCompare(b.created_at));
      const filename = bookFilename(group);
      const path = normalizePath(`${booksPath}/${filename}`);
      await this.writeFile(path, bookToMarkdown(group));
      freshLastSynced.set(group.work_id, {
        note: (group.note?.note || "").trim(),
        updated_at: group.note?.updated_at || "",
        path,
      });
    }
    this.lastSyncedNotes = freshLastSynced;

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
    const basePath = normalizePath(`${rootPath}/Locus Communis.base`);
    await this.writeFile(basePath, renderBase());

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

/* ─────────────── Markdown parsing (two-way sync) ─────────────── */

interface ParsedBookFile {
  work_id: string | null;
  note: string;
}

/**
 * Extract the `work_id` from YAML frontmatter and the body of the `## Note`
 * section from a book page. Deliberately tolerant: if the file has no Note
 * heading (user deleted it, or hand-wrote the page) we treat the note as
 * empty. The section runs from `## Note` to the next `##` heading or EOF.
 */
function parseBookFile(content: string): ParsedBookFile {
  let work_id: string | null = null;

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fmMatch) {
    const idLine = fmMatch[1].match(/^work_id:\s*(\S+)\s*$/m);
    if (idLine) work_id = idLine[1].replace(/^["']|["']$/g, "");
  }

  const noteMatch = content.match(/\n## Note\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  const note = noteMatch ? noteMatch[1].trim() : "";

  return { work_id, note };
}

/**
 * Split a book page into the chunks around the Note section so a conflict
 * marker can be inserted without clobbering frontmatter or excerpts.
 */
function splitAtNoteSection(content: string): { before: string; after: string } {
  const m = content.match(/\n## Note\s*\n([\s\S]*?)(?=\n## |\s*$)/);
  if (!m) return { before: content + "\n\n", after: "" };
  const start = m.index ?? 0;
  const end = start + m[0].length;
  return {
    before: content.slice(0, start + 1), // keep the leading newline
    after: content.slice(end),
  };
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
 * root `Locus Communis.base` can index across books; the body lists the note
 * (if any) followed by excerpts in chronological order.
 */
function bookToMarkdown(g: BookGroup): string {
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

  // Always emit the Note section so two-way sync has a target to type into.
  // Empty string is fine — the section stays, just without a body.
  lines.push("## Note");
  lines.push("");
  lines.push((g.note?.note || "").trim());
  lines.push("");

  if (g.excerpts.length > 0) {
    lines.push("## Excerpts");
    lines.push("");
    for (const e of g.excerpts) {
      lines.push(renderExcerpt(e));
      lines.push("");
    }
  }

  return lines.join("\n");
}

function renderExcerpt(e: Excerpt): string {
  const parts: string[] = [];
  parts.push(`> ${e.quote.replace(/\n/g, "\n> ")}`);
  parts.push("");
  const attrBits: string[] = [];
  if (e.attribution) {
    attrBits.push(e.source ? `[${e.attribution}](${e.source})` : e.attribution);
  }
  const date = (e.dated_at ?? e.created_at)?.split("T")[0];
  if (date) attrBits.push(date);
  if (attrBits.length > 0) parts.push(`— ${attrBits.join(" · ")}`);
  parts.push(`<!-- excerpt:${e.id} -->`);
  return parts.join("\n");
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
    lines.push(renderExcerpt(e));
    lines.push("");
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
    '    - \'file.folder.startsWith("Locus Communis/Books")\'',
    "views:",
    "  - type: table",
    "    name: Books",
    "    order:",
    "      - file.name",
    "      - creator",
    "      - year",
    "      - media_type",
    "      - excerpt_count",
    "      - has_note",
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
    containerEl.createEl("h2", { text: "Locus Communis Sync" });

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
        "Include your per-work notes on each book page. Notes are strictly private — they never leave your account."
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
      )
      .addButton((b) =>
        b
          .setButtonText("Full resync")
          .setTooltip("Re-pull everything and rebuild book pages.")
          .onClick(() => this.plugin.syncNow({ full: true }))
      );

    if (this.plugin.settings.lastSyncedAt) {
      containerEl.createEl("p", {
        text: `Last sync: ${new Date(this.plugin.settings.lastSyncedAt).toLocaleString()}`,
      });
    }
  }
}
