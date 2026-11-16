const { Plugin, Notice, PluginSettingTab, Setting, TFile, Modal } = require("obsidian");
const yaml = require("js-yaml");
const { convert, PRESERVE_ON_UPDATE } = require("./converter");
const addSpells = require("./addspells");

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
    this.addCommand({ id: "add-class-spells", name: "Add all spells of a class to this Archivist character",
      checkCallback: (checking) => { const f = this.app.workspace.getActiveFile(); if (!f || f.extension !== "md") return false; const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}; if (fm["archivist-type"] !== "pc") return false; if (!checking) this.addClassSpells(f); return true; } });
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
  async addClassSpells(file) {
    try {
      const text = await this.app.vault.read(file);
      let m = null; for (const x of text.matchAll(BLOCK)) if (x[1] === "pc") { m = x; break; }
      if (!m) return new Notice("No Archivist character (pc block) found in this note.");
      const pc = yaml.load(m[2]); const idx = new VaultIndex(this.app); await idx.build();
      const classes = [];
      for (const c of pc.class || []) { const d = await idx.get(c.name); if (d && d.spellcasting) classes.push({ ref: c.name, level: Number(c.level || 1), doc: d }); }
      if (!classes.length) return new Notice("None of this character's classes has spellcasting.");
      new Notice("Reading the compendium spells…");
      const spells = [];
      const files = this.app.vault.getMarkdownFiles().filter((f) => { const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}; return fm.archivist === true && fm.entity_type === "spell" && fm.slug; });
      for (let i = 0; i < files.length; i += 50) await Promise.all(files.slice(i, i + 50).map(async (f) => {
        const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}; const t = await this.app.vault.cachedRead(f);
        for (const x of t.matchAll(BLOCK)) if (x[1] === "spell") { try { const d = yaml.load(x[2]) || {}; spells.push({ slug: String(d.slug || fm.slug), name: d.name || fm.name, level: d.level || 0, classes: d.classes || [], edition: String(d.edition || ""), compendium: String(fm.compendium || "") }); } catch (e) {} break; }
      }));
      new AddSpellsModal(this.app, classes, spells, async (ci, opts) => {
        const c = classes[ci], add = addSpells.plan(pc, c.doc, spells, opts);
        if (!add.length) return new Notice("Nothing to add: every matching spell is already on the character.");
        addSpells.apply(pc, c.ref, add, classes.length > 1);
        const dumped = yaml.dump(pc, { lineWidth: -1, noRefs: true, quotingType: '"' }).replace(/\n$/, "");
        const cur = await this.app.vault.read(file);
        await this.app.vault.modify(file, cur.replace(m[0], "```pc\n" + dumped + "\n```"));
        new Notice(`Added ${add.length} ${c.doc.name} spell(s). Reopen the sheet if it does not refresh.`, 10000);
      }).open();
    } catch (e) { console.error(e); new Notice("Could not add spells: " + e.message); }
  }
};

class AddSpellsModal extends Modal {
  constructor(app, classes, spells, onSubmit) { super(app); this.classes = classes; this.spells = spells; this.onSubmit = onSubmit; this.ci = 0; this.cantrips = true; this.editions = new Set(); this.comps = new Set(); this.max = null; }
  onOpen() { this.render(); }
  render() {
    const { contentEl: c } = this; c.empty();
    c.createEl("h3", { text: "Add all spells of a class" });
    const cl = this.classes[this.ci], cname = String(cl.doc.name || "").toLowerCase();
    if (this.classes.length > 1) new Setting(c).setName("Class").addDropdown((d) => { this.classes.forEach((x, i) => d.addOption(String(i), x.doc.name)); d.setValue(String(this.ci)).onChange((v) => { this.ci = Number(v); this.max = null; this.render(); }); });
    if (this.max == null) this.max = addSpells.maxSpellLevel(cl.doc, cl.level);
    new Setting(c).setName("Highest spell level").setDesc("Defaults to the highest level this class has slots for at its level.").addText((t) => t.setValue(String(this.max)).onChange((v) => { this.max = Math.max(0, Math.min(9, Number(v) || 0)); }));
    new Setting(c).setName("Include cantrips").addToggle((t) => t.setValue(this.cantrips).onChange((v) => { this.cantrips = v; }));
    const mine = this.spells.filter((s) => (s.classes || []).some((x) => addSpells.clsName(x) === cname));
    const eds = [...new Set(mine.map((s) => s.edition))].sort(), comps = [...new Set(mine.map((s) => s.compendium))].sort();
    c.createEl("h4", { text: "Editions (none ticked = all)" });
    for (const e of eds) new Setting(c).setName(e || "(no edition)").addToggle((t) => t.setValue(this.editions.has(e)).onChange((v) => { v ? this.editions.add(e) : this.editions.delete(e); }));
    c.createEl("h4", { text: "Compendiums (none ticked = all)" });
    for (const k of comps) new Setting(c).setName(`${k || "(none)"} · ${mine.filter((s) => s.compendium === k).length}`).addToggle((t) => t.setValue(this.comps.has(k)).onChange((v) => { v ? this.comps.add(k) : this.comps.delete(k); }));
    new Setting(c).addButton((b) => b.setButtonText("Add spells").setCta().onClick(async () => { this.close(); await this.onSubmit(this.ci, { maxLevel: this.max, cantrips: this.cantrips, editions: this.editions, compendiums: this.comps }); }));
  }
  onClose() { this.contentEl.empty(); }
}

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
