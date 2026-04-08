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
  /** ISO timestamp of the most recent successful sync. */
  lastSyncedAt: string | null;
  /** Display name of the connected LC user, populated by /api/sync/me. */
  connectedAs: string | null;
}

const DEFAULT_SETTINGS: LocusCommunisSettings = {
  apiBaseUrl: "https://locuscommunis.com",
  token: "",
  vaultFolder: "Locus Communis",
  includePublicBook: false,
  lastSyncedAt: null,
  connectedAs: null,
};

interface Excerpt {
  id: string;
  quote: string;
  source: string | null;
  attribution: string | null;
  author: string | null;
  book_title: string | null;
  is_public: boolean;
  dated_at: string | null;
  created_at: string;
}

interface ExcerptsResponse {
  version: number;
  count: number;
  excerpts: Excerpt[];
}

export default class LocusCommunisPlugin extends Plugin {
  settings!: LocusCommunisSettings;

  async onload() {
    await this.loadSettings();

    this.addRibbonIcon("book-open", "Sync Locus Communis", () => {
      this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync excerpts from Locus Communis",
      callback: () => this.syncNow(),
    });

    this.addSettingTab(new LocusCommunisSettingTab(this.app, this));
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

  async syncNow() {
    try {
      if (!this.settings.token) {
        new Notice("Locus Communis: paste a sync token in settings first.");
        return;
      }

      new Notice("Locus Communis: fetching excerpts…");
      const params = new URLSearchParams();
      if (this.settings.includePublicBook) params.set("include_public", "1");
      const qs = params.toString();
      const data = await this.apiGet<ExcerptsResponse>(
        `/api/sync/excerpts${qs ? `?${qs}` : ""}`
      );

      await this.writeExcerpts(data.excerpts);

      this.settings.lastSyncedAt = new Date().toISOString();
      await this.saveSettings();
      new Notice(`Locus Communis: synced ${data.count} excerpts.`);
    } catch (err) {
      console.error("[locus-communis] sync failed", err);
      new Notice(`Locus Communis sync failed: ${(err as Error).message}`);
    }
  }

  async writeExcerpts(excerpts: Excerpt[]) {
    const folderPath = normalizePath(this.settings.vaultFolder);
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    } else if (!(folder instanceof TFolder)) {
      throw new Error(`${folderPath} exists and is not a folder`);
    }

    for (const excerpt of excerpts) {
      const filename = excerptFilename(excerpt);
      const path = normalizePath(`${folderPath}/${filename}`);
      const body = excerptToMarkdown(excerpt);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        // Server is the source of truth in v0.1 — overwrite local file.
        await this.app.vault.modify(existing, body);
      } else {
        await this.app.vault.create(path, body);
      }
    }
  }
}

/* ─────────────── Markdown formatting (mirrors LC exportUtils.js) ─────────────── */

function excerptToMarkdown(e: Excerpt): string {
  const lines = ["---"];
  lines.push(`id: ${e.id}`);
  if (e.attribution) lines.push(`attribution: "${escapeYaml(e.attribution)}"`);
  if (e.author) lines.push(`author: "${escapeYaml(e.author)}"`);
  if (e.book_title) lines.push(`book: "${escapeYaml(e.book_title)}"`);
  if (e.source) lines.push(`source: "${escapeYaml(e.source)}"`);
  const date = (e.dated_at ?? e.created_at)?.split("T")[0];
  if (date) lines.push(`date: ${date}`);
  lines.push(`public: ${e.is_public}`);
  lines.push("tags: [commonplace]");
  lines.push("---");
  lines.push("");
  lines.push(`> ${e.quote.replace(/\n/g, "\n> ")}`);
  lines.push("");
  if (e.attribution) {
    const attr = e.source ? `[${e.attribution}](${e.source})` : e.attribution;
    lines.push(`— ${attr}`);
    lines.push("");
  }
  return lines.join("\n");
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

function excerptFilename(e: Excerpt): string {
  const base =
    e.attribution ||
    e.book_title ||
    e.author ||
    e.quote.slice(0, 40) ||
    e.id;
  const safe = base
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe} — ${e.id.slice(0, 8)}.md`;
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

    new Setting(containerEl).addButton((b) =>
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
