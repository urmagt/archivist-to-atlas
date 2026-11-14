const Module = require('module'), fs = require('fs'), path = require('path'), yaml = require('js-yaml');
class TFile { constructor(p, root) { this.path = p; this.root = root; this.extension = 'md'; this.parent = { path: path.dirname(p) === '.' ? '/' : path.dirname(p) }; } }
const notices = [];
const obs = { Plugin: class { async loadData() { return {}; } addSettingTab() {} addCommand() {} registerEvent() {} async saveData() {} },
  Notice: class { constructor(m) { notices.push(m); } }, PluginSettingTab: class {}, Setting: class {}, TFile };
const orig = Module._load; Module._load = function (r, ...a) { return r === 'obsidian' ? obs : orig.call(this, r, ...a); };
const root = process.argv[2], notePath = process.argv[3];
const files = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.md')) files.push(path.relative(root, p)); } })(root);
const objs = new Map(files.map((p) => [p, new TFile(p, root)]));
const fmOf = (f) => { const t = fs.readFileSync(path.join(root, f.path), 'utf8'); const m = /^---\n([\s\S]*?)\n---/.exec(t); try { return m ? yaml.load(m[1]) : {}; } catch (e) { return {}; } };
const app = { vault: { getMarkdownFiles: () => [...objs.values()], cachedRead: async (f) => fs.readFileSync(path.join(root, f.path), 'utf8'), read: async (f) => fs.readFileSync(path.join(root, f.path), 'utf8'),
  getAbstractFileByPath: (p) => objs.get(p) || null, create: async (p, c) => { fs.writeFileSync(path.join(root, p), c); const o = new TFile(p, root); objs.set(p, o); return o; }, modify: async (f, c) => fs.writeFileSync(path.join(root, f.path), c) },
  metadataCache: { getFileCache: (f) => ({ frontmatter: fmOf(f) }) }, workspace: { on() {} } };
const Plugin = require('./dist/main.js');
(async () => { const p = new Plugin(); p.app = app; await p.onload(); await p.run(objs.get(notePath)); console.log(notices.join('\n---\n').slice(0, 600)); })();
