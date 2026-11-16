const { Plugin, Notice, PluginSettingTab, Setting, TFile } = require("obsidian");
const yaml = require("js-yaml");
const { convert, PRESERVE_ON_UPDATE } = require("./converter");

const DEFAULTS = { template: "current", linkSpells: true, preparedTracker: false, classic: false, short: 0, hitDiceKey: "", outputFolder: "" };
const FM = /^---\n([\s\S]*?)\n---\n?/;
const BLOCK = /```([\w-]+)\n([\s\S]*?)\n```/g;

class VaultIndex {
  constructor(app) { this.app = app; this.index = new Map(); this.cache = new Map(); this.byname = new Map(); }
  async build() {
    for (const f of this.app.vault.getMarkdownFiles()) {
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter;
      if (fm && fm.archivist === true && fm.slug) if (!this.index.has(String(fm.slug))) {
        this.index.set(String(fm.slug), f);
        for (const key of new Set([String(f.basename || String(f.path).split("/").pop().replace(/\.md$/, "")).toLowerCase(), String(fm.name || "").toLowerCase()])) if (key) { if (!this.byname.has(key)) this.byname.set(key, []); this.byname.get(key).push([fm.entity_type || "", String(fm.slug)]); }
      }
    }
  }
  async get(ref, wantKind) {
    if (!ref) return {};
    const slug = String(ref).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
    if (this.cache.has(slug)) return this.cache.get(slug);
    let f = this.index.get(slug);
    if (!f) { // a plain note name / path ([[Crafter]]): match by file name or note name
      const c = this.byname.get(slug.split("/").pop().replace(/\.md$/, "").trim().toLowerCase()) || [];
      const pick = c.filter((x) => !wantKind || x[0] === wantKind); const chosen = pick[0] || (wantKind ? null : c[0]);
      if (chosen) f = this.index.get(chosen[1]);
    }
    if (!f && !slug.includes("_")) for (const [k, v] of this.index) if (k.endsWith("_spell_" + slug)) { f = v; break; }
    let out = {};
    if (f) {
      const text = await this.app.vault.cachedRead(f);
      const kind = ((this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}).entity_type;
      let found = null, first = null;
      for (const m of text.matchAll(BLOCK)) { try { const d = yaml.load(m[2]) || {}; if (!first) first = d; if (m[1] === kind) found = d; } catch (e) {} }
      out = { ...(found || first || {}) }; out.slug = out.slug || slug; out._type = kind; out._file = f.basename || String(f.path).split("/").pop().replace(/\.md$/, "");
    }
    this.cache.set(slug, out); return out;
  }
}

module.exports = class ArchivistToAtlas extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addSettingTab(new Tab(this.app, this));
    this.addCommand({ id: "convert-character", name: "Convert this Archivist character to an Atlas statblock",
      checkCallback: (checking) => { const f = this.app.workspace.getActiveFile(); if (!f || f.extension !== "md") return false; if (!checking) this.run(f); return true; } });
    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
      if (fm["archivist-type"] !== "pc") return;
      menu.addItem((i) => i.setTitle("Convert to Atlas statblock").setIcon("swords").onClick(() => this.run(file)));
    }));
  }
  async run(file) {
    try {
      const text = await this.app.vault.read(file);
      let pc = null; for (const m of text.matchAll(BLOCK)) if (m[1] === "pc") { pc = yaml.load(m[2]); break; }
      if (!pc) return new Notice("No Archivist character (pc block) found in this note.");
      { const fmx = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {}; if (fmx["archivist-portrait"]) pc._portrait = fmx["archivist-portrait"]; let fmb = { ...fmx }; for (const m of text.matchAll(BLOCK)) if (m[1] === "atlas" || m[1] === "atlas-bio") { try { Object.assign(fmb, yaml.load(m[2]) || {}); } catch (e) {} }
        pc._bio = {}; for (const k of ["height", "weight", "eyes", "hair", "skin", "appearance", "personality", "ideals", "bonds", "flaws", "allies", "notes", "notes_2", "backstory", "description", "alignment", "age"]) if (fmb[k]) pc._bio[k] = fmb[k]; if (pc.notes && !pc._bio.notes_2) pc._bio.notes_2 = String(pc.notes).trim(); }
      const idx = new VaultIndex(this.app); await idx.build();
      const { out, warn } = await convert(pc, idx, { short: this.settings.short, classic: this.settings.classic, template: this.settings.classic ? "classic" : (this.settings.template || "current"), hitDiceKey: this.settings.hitDiceKey, linkSpells: this.settings.linkSpells, preparedTracker: this.settings.preparedTracker });
      const folder = this.settings.outputFolder ? this.settings.outputFolder.replace(/\/$/, "") : (file.parent && file.parent.path !== "/" ? file.parent.path : "");
      const path = (folder ? folder + "/" : "") + `${pc.name} (Atlas).md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      const explicit = new Set(out._explicit || []); delete out._explicit;
      let body = "\n", merged = out, verb = "Created";
      if (existing instanceof TFile) {
        const old = await this.app.vault.read(existing);
        await this.app.vault.create(path.replace(/\.md$/, ` (backup ${Date.now()}).md`), old);
        const m = FM.exec(old); const ofm = m ? (yaml.load(m[1]) || {}) : {};
        body = m ? old.slice(m[0].length) : old; merged = { ...ofm };
        for (const [k, v] of Object.entries(out)) { if (PRESERVE_ON_UPDATE.has(k) && k in ofm && !explicit.has(k)) continue; merged[k] = v; }
        verb = "Updated";
      }
      const content = "---\n" + yaml.dump(merged, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: true }) + "---\n" + body;
      if (existing instanceof TFile) await this.app.vault.modify(existing, content); else await this.app.vault.create(path, content);
      new Notice(`${verb} ${path}` + (warn.length ? `\n${warn.length} thing(s) to check: ` + warn.join(" | ").slice(0, 400) : ""), 12000);
      if (warn.length) console.log("Archivist→Atlas warnings:", warn);
    } catch (e) { console.error(e); new Notice("Conversion failed: " + e.message); }
  }
  async saveSettings() { await this.saveData(this.settings); }
};

class Tab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl; c.empty();
    new Setting(c).setName("Atlas template").setDesc("Latest = 5e-2024-character-sheet-4r8tqz; Previous pips = 5e-2024-character-sheet-pips-4r8tqz; Tabbed = the earlier tabbed sheet; Classic = the original single-page sheet.")
      .addDropdown((d) => d.addOptions({ current: "5E (2024) Character Sheet (latest)", pips: "Previous pips sheet", tabbed: "Tabbed sheet", classic: "Original single-page sheet" }).setValue(this.plugin.settings.classic ? "classic" : (this.plugin.settings.template || "current")).onChange(async (v) => { this.plugin.settings.template = v; this.plugin.settings.classic = v === "classic"; await this.plugin.saveSettings(); }));
    new Setting(c).setName("Link spells instead of copying their text").setDesc("On = each spell on the sheet is a [[link]] to its note (hover to read) plus its save / attack / damage; off = copy the full text.")
      .addToggle((t) => t.setValue(this.plugin.settings.linkSpells !== false).onChange(async (v) => { this.plugin.settings.linkSpells = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName("Write the Prepared checkbox list").setDesc("Off (default) = leave it out; the Spells tab already shows what is prepared.")
      .addToggle((t) => t.setValue(!!this.plugin.settings.preparedTracker).onChange(async (v) => { this.plugin.settings.preparedTracker = v; await this.plugin.saveSettings(); }));
    new Setting(c).setName("Shorten feature texts to about N characters").setDesc("0 = full text.")
      .addText((t) => t.setValue(String(this.plugin.settings.short)).onChange(async (v) => { this.plugin.settings.short = Number(v) || 0; await this.plugin.saveSettings(); }));
    new Setting(c).setName("Hit dice property name").setDesc("Leave empty to choose automatically (hit_dice_pool for the tabbed sheet, hit_dice_2 for the classic one).")
      .addText((t) => t.setValue(this.plugin.settings.hitDiceKey).onChange(async (v) => { this.plugin.settings.hitDiceKey = v || ""; await this.plugin.saveSettings(); }));
    new Setting(c).setName("Output folder").setDesc("Empty = next to the character note.")
      .addText((t) => t.setValue(this.plugin.settings.outputFolder).onChange(async (v) => { this.plugin.settings.outputFolder = v; await this.plugin.saveSettings(); }));
  }
}
