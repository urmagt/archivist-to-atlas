// Archivist character (pc block) -> Atlas VTT statblock properties. Pure logic, no Obsidian imports.
const yaml = require("js-yaml");
const ABILS = ["str", "dex", "con", "int", "wis", "cha"];
const ABIL_FULL = { str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" };
const SKILLS = ["acrobatics", "animal_handling", "arcana", "athletics", "deception", "history", "insight", "intimidation",
  "investigation", "medicine", "nature", "perception", "performance", "persuasion", "religion", "sleight_of_hand", "stealth", "survival"];
const SCHOOL = { abjuration: "Abjur", conjuration: "Conj", divination: "Div", enchantment: "Ench", evocation: "Evoc", illusion: "Illus", necromancy: "Necro", transmutation: "Trans" };
const FULL_SLOTS = { 1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2], 9: [4, 3, 3, 3, 1],
  10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1], 12: [4, 3, 3, 3, 2, 1], 13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1],
  15: [4, 3, 3, 3, 2, 1, 1, 1], 16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1], 18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
  19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1] };
const ARMOR_FALLBACK = { padded: [11, true, null], leather: [11, true, null], "leather-armor": [11, true, null], "studded-leather": [12, true, null],
  hide: [12, true, 2], "chain-shirt": [13, true, 2], "scale-mail": [14, true, 2], breastplate: [14, true, 2], "half-plate": [15, true, 2],
  "ring-mail": [14, false, 0], "chain-mail": [16, false, 0], splint: [17, false, 0], plate: [18, false, 0] };
const TEMPLATE_TABBED = "5e-2024-rules-character-sheet-tabbed-q4m8xe";
const TEMPLATE_CLASSIC = "5e-2024-rules-character-sheet-p7k2nd";
const TEMPLATE_CURRENT = "5e-2024-character-sheet-4r8tqz"; // latest official sheet
const TEMPLATE_PIPS = "5e-2024-character-sheet-pips-4r8tqz"; // the newer sheet with use pips
const PROF_SYMBOL = { half: "⬖", 1: "◆", 2: "❖" }; // the pips sheet writes proficiency as a symbol

const slugOf = (ref) => String(ref).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
const mod = (s) => Math.floor((s - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : String(n));
const titleCase = (s) => String(s).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
const nameFromSlug = (slug) => titleCase(slug.replace(/^.*?_(?:spell|item|armor|weapon|feat)_/, "").replace(/-/g, " "));
const abPoints = (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0 && Object.entries(v).every(([a, n]) => ["str","dex","con","int","wis","cha"].includes(a) && Number.isInteger(n));
const arr = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const firstText = (d) => String(d.description || arr(d.entries).filter((x) => typeof x === "string").join("\n") || "").trim();
function clean(t, limit) {
  t = String(t).replace(/\r/g, "").replace(/([.!?]),\s*(?=\**[A-ZÁÉÍÓÚ¿¡])/g, "$1\n\n").replace(/^\s*[*\u2022]\s+/gm, "- ").replace(/[`*_]{1,2}/g, "");
  if (!limit) {   // full text: keep paragraphs, list items and table rows on their own lines
    const out = [], para = [];
    const flush = () => { if (para.length) { out.push(para.join(" ")); para.length = 0; } };
    for (const ln of t.split("\n").map((l) => l.trim())) {
      if (!ln) { flush(); out.push(""); }
      else if (ln.startsWith("- ") || ln.startsWith("|") || /^\d+[.)] /.test(ln)) { flush(); out.push(ln); }
      else para.push(ln);
    }
    flush();
    return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  t = t.replace(/\s*\n\s*/g, " ").trim();
  if (t.length > limit) {
    const cut = t.slice(0, limit); const k = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
    t = k > limit / 2 ? cut.slice(0, k + 1) : cut.trimEnd() + "…";
  }
  return t;
}


const SAVE_ES = { fuerza: "Strength", destreza: "Dexterity", "constitución": "Constitution", constitucion: "Constitution", inteligencia: "Intelligence", "sabiduría": "Wisdom", sabiduria: "Wisdom", carisma: "Charisma" };
const SAVE_EN = { str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" };
function spellLabel(d, nm, opts) {
  const f = d._file; if (opts.linkSpells === false || !f) return nm;
  return f === nm ? `[[${f}]]` : `[[${f}|${nm}]]`;
}
function itemLabel(d, nm, opts) {   // an item's name as a link to its note, like spells
  const f = d._file; if (opts.linkSpells === false || !f) return nm;
  return f === nm ? `[[${f}]]` : `[[${f}|${nm}]]`;
}
function spellMechanics(d) {   // short English-keyword line: the Atlas sheet reads saves / attacks from it
  const txt = String(d.description || ""); const parts = [];
  let ab = d.saving_throw && d.saving_throw.ability ? String(d.saving_throw.ability).toLowerCase() : null;
  if (ab) ab = SAVE_EN[ab.slice(0, 3)] || ab[0].toUpperCase() + ab.slice(1);
  else { const m = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/i.exec(txt) || /salvaci[oó]n de (Fuerza|Destreza|Constituci[oó]n|Inteligencia|Sabidur[ií]a|Carisma)/i.exec(txt); if (m) ab = SAVE_ES[m[1].toLowerCase()] || (m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()); }
  if (ab) parts.push(`${ab} saving throw`);
  let kind = typeof d.spell_attack === "string" ? d.spell_attack : "";
  if (!kind) kind = /ranged spell attack|ataque de conjuro a distancia/i.test(txt) ? "ranged" : (/melee spell attack|ataque de conjuro cuerpo a cuerpo/i.test(txt) ? "melee" : "");
  if (d.spell_attack === true && !kind) kind = "ranged";
  if (kind) parts.push(`${kind[0].toUpperCase() + kind.slice(1)} spell attack`);
  const types = (d.damage || {}).types || [];
  if (d.damage_roll) parts.push(`${d.damage_roll} ${types[0] ? types[0] + " damage" : ""}`.trim());
  return parts.join(" · ");
}

async function convert(pc, vault, opts = {}) {
  const tmpl = opts.template || (opts.classic ? "classic" : "tabbed"), pips = tmpl === "pips" || tmpl === "current";
  const short = opts.short || 0, classic = tmpl === "classic", hitKey = opts.hitDiceKey || (classic ? "hit_dice_2" : "hit_dice_pool");
  const warn = [];
  const classesPc = pc.class || [];
  const levelTotal = classesPc.reduce((a, c) => a + Number(c.level || 1), 0);
  const pb = 2 + Math.floor((levelTotal - 1) / 4);
  const race = await vault.get(pc.race), bg = await vault.get(pc.background);
  const classes = [];
  for (const c of classesPc) classes.push([await vault.get(c.name), c]);
  const firstCls = classes[0] ? classes[0][0] : {};
  if (!race.slug) warn.push(`species ${pc.race} not found in the vault`);
  if (!firstCls.slug) warn.push(`class ${classesPc[0] && classesPc[0].name} not found`);
  const oc = pc.origin_choices || {};

  // ability scores
  const sc = { ...pc.abilities };
  const keep = !!pc.keep_species_ability_increases;
  const bgGives = !!bg.ability_score_increases || arr(bg.choices).some((c) => c.kind === "ability-points");
  const applySpecies = String(race.edition) === "2024" || !bgGives || keep;
  if (applySpecies) {
    for (const rs of [race, await vault.get(pc.subrace || "")]) // species and subrace (Hill Dwarf, High Elf...) fixed increases
      for (const inc of arr(rs && rs.ability_score_increases)) if (inc && inc.ability in sc && "amount" in inc && !("choose" in inc)) sc[inc.ability] += inc.amount;
    for (const [k, v] of Object.entries(oc)) if (k.startsWith("race:") && abPoints(v)) for (const [a, n] of Object.entries(v)) sc[a] += n;
  }
  for (const [k, v] of Object.entries(oc)) if (bgGives && k.startsWith("background:") && abPoints(v)) for (const [a, n] of Object.entries(v)) sc[a] += n;
  for (const c of classesPc) for (const [lv, ch] of Object.entries(c.choices || {})) {
    if (Number(lv) > c.level || !ch || typeof ch !== "object") continue;
    for (const [k, v] of Object.entries(ch)) if (k.startsWith("feat:") && abPoints(v)) for (const [a, n] of Object.entries(v)) sc[a] = Math.min(20, sc[a] + n);
    if (typeof ch.feat === "string" && ch.feat) { // a feat with one fixed ability (grants_asi) and no ability-points choice
      const fd = await vault.get(ch.feat), ga = fd && fd.grants_asi;
      if (ga && Array.isArray(ga.pool) && ga.pool.length === 1 && ga.pool[0] in sc && !arr(fd.choices).some((x) => x && x.kind === "ability-points")) sc[ga.pool[0]] = Math.min(20, sc[ga.pool[0]] + Number(ga.amount || 1));
    }
  }
  for (const [a, v] of Object.entries(((pc.overrides || {}).abilities) || {})) if (typeof v === "number") sc[a] = v;
  const m = {}; for (const a of ABILS) m[a] = mod(sc[a]);

  const out = { statblock: true, "atlas-template": classic ? TEMPLATE_CLASSIC : tmpl === "current" ? TEMPLATE_CURRENT : pips ? TEMPLATE_PIPS : TEMPLATE_TABBED, name: pc.name, level: levelTotal };
  out.species = race.name || nameFromSlug(slugOf(pc.race || ""));
  out.background = bg.name || "";
  out.class = classes.map(([c, p]) => c.name || nameFromSlug(slugOf(p.name))).join(" / ");
  const subs = []; for (const [, p] of classes) if (p.subclass) subs.push((await vault.get(p.subclass)).name);
  out.subclass = subs.filter(Boolean).join(" / ");
  out.size = titleCase(race.size || "medium");
  out.pb = pb;
  { // bio fields: Archivist has no place for most of them, so read them from the character note's own properties
    const bio = {}; for (const k of ["alignment", "age"]) if (pc[k]) bio[k] = pc[k];
    Object.assign(bio, pc._bio || {});
    if (bio.backstory && !bio.description) { bio.description = bio.backstory; delete bio.backstory; }
    const extraP = [["ideals", "Ideals"], ["bonds", "Bonds"], ["flaws", "Flaws"]].filter(([k]) => bio[k]).map(([k, l]) => { const t = `${l}: ${bio[k]}`; delete bio[k]; return t; });
    if (extraP.length) bio.personality = [...(bio.personality ? [String(bio.personality)] : []), ...extraP].join("\n\n");
    for (const [k, v] of Object.entries(bio)) if (BIO_KEYS.has(k)) out[k] = k === "description" ? String(v).trimEnd() : String(v).trim();
    out._explicit = Object.keys(bio).filter((k) => BIO_KEYS.has(k));
  }
  if (pc._portrait) out.image = String(pc._portrait).replace(/^!?\[\[|\]\]$/g, "").split("|")[0];
  out.stats = ABILS.map((a) => sc[a]);

  // hit points
  const hpb = (o) => { let n = 0; if (Array.isArray(o)) for (const v of o) n += hpb(v); else if (o && typeof o === "object") { if (o.kind === "hp-per-level-bonus") n += Number(o.value || 0); for (const v of Object.values(o)) n += hpb(v); } return n; };
  let bonus = hpb(race.traits) + hpb(bg.feature);
  for (const [k, v] of Object.entries(oc)) if (typeof v === "string" && k.includes("feat") && v) { try { bonus += hpb((await vault.get(v)).effects); } catch (e) {} }
  for (const [, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) if (ch && ch.feat && Number(lv) <= p.level) { try { bonus += hpb((await vault.get(ch.feat)).effects); } catch (e) {} }
  const ho = (pc.overrides || {}).hp || {};
  let hp = 0;
  if (ho.rolled) hp = Number(ho.rolled) + m.con * levelTotal;
  else classes.forEach(([c, p], i) => { const die = parseInt(String(c.hit_die || "d8").replace(/^d/, ""), 10); for (let lv = 1; lv <= p.level; lv++) hp += (i === 0 && lv === 1 ? die : Math.floor(die / 2) + 1) + m.con; });
  hp += bonus * levelTotal;
  const stMax = ((pc.state || {}).hp || {}).max;
  if (stMax && Number(stMax) !== hp) warn.push(`HP computed as ${hp} (the note's stored max was ${stMax}, possibly stale); check against the Archivist sheet`);
  out.hp = Number(hp);
  const dice = {};
  for (const [c, p] of classes) { const d = c.hit_die || "d8"; dice[d] = (dice[d] || 0) + p.level; }
  out.hit_dice = Object.entries(dice).map(([d, n]) => `${n}${d}`).join(" + ");
  const usedHd = (pc.state || {}).hit_dice || {};
  if (pips) out.heroic_inspiration = [{ name: "Inspiration", max: 1, used: (pc.state || {}).inspiration ? 0 : 1 }];
  out[hitKey] = Object.entries(dice).map(([d, n]) => ({ name: d, max: n, used: Number(((usedHd[d] || {}).used) || 0) }));

  // species choices (select-inline options) and their effects
  const chosen = [];
  for (const t of arr(race.traits)) for (const ch of arr(t.choices)) {
    if (ch.kind !== "select-inline") continue;
    const val = oc[`race:${ch.id}`];
    for (const o of arr(ch.options)) if (val != null && o.value === val) {
      const mm = /\((\d+)(?:st|nd|rd|th) level\)/.exec(t.name || "");
      if (!mm || levelTotal >= Number(mm[1])) chosen.push([t, o]);
    }
  }
  const effects = [];
  for (const [, o] of chosen) effects.push(...arr(o.effects));
  for (const t of arr(race.traits)) effects.push(...arr(t.effects));

  // speed
  let walk = (race.speed || {}).walk || 30;
  const modes = {};
  for (const [k, v] of Object.entries(race.speed || {})) if (k !== "walk" && k !== "hover" && v) modes[k] = v;
  for (const [, o] of chosen) { // a lineage option that only says "Your Speed increases to 35 feet" in its text (Wood Elf)
    if (arr(o.effects).some((e) => e.kind === "speed-bonus")) continue;
    const mm = String(o.description || "").match(/\bspeed increases to (\d+) feet/i); if (mm) walk = Math.max(walk, Number(mm[1]));
  }
  for (const e of effects) {
    if (e.kind === "speed-bonus" && ["fly", "swim", "climb", "burrow"].includes(e.mode)) modes[e.mode] = e.equal_to === "walk" ? walk : (e.value != null ? e.value : modes[e.mode] || 0);
    else if (e.kind === "speed-bonus" && e.mode === "walk" && !e.condition) walk = e.set ? Math.max(walk, e.value || 0) : walk + (e.value || 0);
  }
  if (pips) { // the pips sheet's speed is a plain number (walking); other modes go to the Other actions list
    out.speed = Number(walk);
    if (Object.keys(modes).length) out.otheractions = [{ name: "Movement", desc: Object.entries(modes).map(([k, v]) => `${titleCase(k)} ${v} ft`).join(", ") }];
  } else out.speed = [`${walk} ft`, ...Object.entries(modes).map(([k, v]) => `${k} ${v} ft`)].join(", ");

  // skills and saves
  const prof = new Set(), expert = new Set();
  const norm = (s) => String(s).replace(/[- ]/g, "_").toLowerCase();
  const sk = pc.skills || {};
  arr(sk.proficient).forEach((s) => prof.add(norm(s))); arr(sk.expertise).forEach((s) => expert.add(norm(s)));
  arr(bg.skill_proficiencies).forEach((s) => prof.add(norm(s)));
  for (const [, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) {
    if (Number(lv) > p.level || !ch || typeof ch !== "object") continue;
    for (const [key, v] of Object.entries(ch)) {
      if (/expertise/i.test(key) && (typeof v === "string" || Array.isArray(v))) arr(v).forEach((x) => { if (typeof x === "string" && !x.startsWith("[[")) expert.add(norm(x)); }); // Rogue/Bard/Ranger expertise picks
      if (key === "skills" && Array.isArray(v)) v.forEach((s) => prof.add(norm(s)));
      else if (key.endsWith("skill") && (typeof v === "string" || Array.isArray(v))) arr(v).forEach((s) => prof.add(norm(s)));
    }
  }
  for (const [k, v] of Object.entries(oc)) if (/expertise/i.test(k) && (typeof v === "string" || Array.isArray(v))) arr(v).forEach((x) => { if (typeof x === "string") expert.add(norm(x)); });
  for (const [k, v] of Object.entries(oc)) if (/^(race|background):/.test(k) && k.endsWith("skill") && (typeof v === "string" || Array.isArray(v))) arr(v).forEach((x) => prof.add(norm(x)));
  for (const e of effects) if (e.kind === "proficiency" && e.proficiency_type === "skill") { prof.add(norm(e.value)); if (e.expertise) expert.add(norm(e.value)); }
  expert.forEach((x) => prof.add(x)); // expertise implies proficiency
  let half = effects.some((e) => e.kind === "half-proficiency");
  for (const k of SKILLS) {
    const lvl = expert.has(k) ? "2" : prof.has(k) ? "1" : (half && pips ? "half" : null);
    if (lvl) out[`${k}_prof`] = pips ? PROF_SYMBOL[lvl] : lvl;
  }
  const saves = arr(firstCls.saving_throws).map((a) => ({ [ABIL_FULL[a]]: m[a] + pb }));
  if (saves.length) out.saves = saves;
  const pp = 10 + m.wis + (prof.has("perception") || expert.has("perception") ? pb * (expert.has("perception") ? 2 : 1) : 0);

  // armor class
  const eq = pc.equipment || [];
  const body = eq.find((i) => i.equipped && i.slot === "armor"), shield = eq.find((i) => i.equipped && i.slot === "shield");
  let ac = 10 + m.dex;
  const armorNote = async (it) => { // magic armor = item note with base_item -> follow one hop to the real armor
    const n = await vault.get(it.item);
    if (!n.ac && n.base_item) { const bn = await vault.get(n.base_item); if (bn.ac) return [bn, n]; }
    return [n, n];
  };
  const needsAttune = (n) => (n.attunement && typeof n.attunement === "object") ? !!n.attunement.required : !!n.attunement;
  if (body) {
    const [a, magic] = await armorNote(body); const sl = slugOf(magic.base_item || body.item).split("armor_").pop();
    let base, add, cap;
    if (a.ac) { base = (a.ac.base || 10) + (a.ac.flat || 0); add = !!a.ac.add_dex; cap = a.ac.dex_max; }
    else if (ARMOR_FALLBACK[sl]) [base, add, cap] = ARMOR_FALLBACK[sl];
    else { base = 10; add = true; cap = null; warn.push(`armor ${sl} not found; AC may be wrong`); }
    ac = base + (add ? (cap != null ? Math.min(m.dex, cap) : m.dex) : 0);
  }
  if (!body) {
    for (const [c] of classes) {
      const cn = String(c.name || "").toLowerCase(), alt = { barbarian: "con", monk: "wis" }[cn];
      if (alt && (cn === "barbarian" || !shield)) ac = Math.max(ac, 10 + m.dex + m[alt]);
    }
    for (const e of effects) if (e.kind === "unarmored-ac")
      ac = Math.max(ac, (e.base != null ? e.base : 10) + arr(e.abilities).reduce((t, x) => t + (m[x] || 0), 0));
  }
  if (shield) { const [s] = await armorNote(shield); ac += (s.ac || {}).base || 2; }
  for (const it of [body, shield]) if (it) ac += Number((it.overrides || {}).ac_bonus || 0);
  for (const it of eq) {
    if (!it.equipped) continue;
    const n = await vault.get(it.item);
    if (!n || (needsAttune(n) && !it.attuned)) continue;
    let bn = (n.bonuses || {}).ac;
    if (bn && typeof bn === "object") {
      let ok = true;
      for (const w of arr(bn.when)) {
        if (w.kind === "no_armor" && body) ok = false;
        else if (w.kind === "no_shield" && shield) ok = false;
        else if (w.kind !== "no_armor" && w.kind !== "no_shield") ok = false;
      }
      bn = ok ? (bn.value || 0) : 0;
    }
    ac += Number(bn || 0);
    for (const e of arr(n.effects)) if (e.kind === "ac-bonus" && (!e.requires_armor || body)) ac += e.value || 0;
  }
  for (const e of effects) if (e.kind === "ac-bonus" && (!e.requires_armor || body)) ac += e.value || 0;
  out.ac = ac; out.initiative = m.dex;
  let protector = false;
  for (const [, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) if (ch && String(ch["divine-order"] || "").toLowerCase() === "protector" && Number(lv) <= p.level) protector = true;

  // senses, languages, defenses, proficiencies
  const passive = (skill, ab) => 10 + m[ab] + (prof.has(skill) || expert.has(skill) ? pb * (expert.has(skill) ? 2 : 1) : 0);
  const sens = pips ? [] : [`Passive Perception ${pp}`];
  if (pips) { out.passive_perception = pp; out.passive_investigation = passive("investigation", "int"); out.passive_insight = passive("insight", "wis"); }
  let dv = (race.vision || {}).darkvision;
  for (const [, o] of chosen) { const mm = String(o.description || "").match(/darkvision increases to (\d+) feet/i); if (mm && (!dv || Number(mm[1]) > Number(dv))) dv = Number(mm[1]); } // Drow
  const sensPre = [...sens];
  const sensesU = dv ? { darkvision: Number(dv) } : {};
  for (const e of effects) if (e.kind === "sense") { const t = String(e.type || e.sense || "").toLowerCase(), r = Number(e.range || 0); if (t && r > (sensesU[t] || 0)) sensesU[t] = r; } // largest range per sense
  for (const [t, r] of Object.entries(sensesU)) sens.push(`${titleCase(t)} ${r} ft`);
  if (sens.length) out.senses = sens.join(", ");
  let langs = arr((race.languages || {}).fixed).map(titleCase);
  for (const [k, v] of Object.entries(oc)) if (k.startsWith("background:languages") || (k.startsWith("race:") && k.includes("language"))) langs.push(...arr(v).map(titleCase));
  langs.push(...arr((((pc.overrides || {}).languages) || {}).add).map((x) => titleCase(String(x).replace(/-/g, " "))));
  out.languages = [...new Set(langs)].join(", ");
  const res = effects.filter((e) => e.kind === "resistance").map((e) => titleCase(e.damage_type));
  if (res.length) out.damage_resistances = res.join(", ");
  const pr = firstCls.proficiencies || {};
  let arm = arr(pr.armor).map(titleCase);
  for (const e of effects) if (e.kind === "proficiency" && e.proficiency_type === "armor") arm.push(titleCase(e.value));
  let wp = arr((pr.weapons || {}).categories);
  if (protector) { arm.push("Heavy"); wp = [...wp, "martial"]; }
  if (arm.length) out.armor_training = [...new Set(arm)].join(", ");
  const wprof = new Set(wp.map((x) => String(x).toLowerCase()));
  const wrules = []; // property rules such as the Rogue's "Martial weapons that have the Finesse or Light property"
  const wfixed = arr((pr.weapons || {}).fixed).filter((x) => typeof x === "string");
  for (const ph of wfixed) {
    const mm = ph.match(/\b(simple|martial)\b.*?\b(?:have|has|with)\b.*?\bthe\s+(.+?)\s+propert/i);
    if (mm) wrules.push([mm[1].toLowerCase(), new Set(mm[2].split(/\s+or\s+|,|\s+and\s+/i).map((x) => x.trim().toLowerCase()).filter(Boolean))]);
    else if (/^\s*(simple|martial)( weapons?)?\s*$/i.test(ph)) wprof.add(ph.trim().split(/\s+/)[0].toLowerCase());
    else { wprof.add(ph.trim().toLowerCase()); wprof.add(ph.trim().toLowerCase().replace(/s$/, "")); }
  }
  if (wp.length || wfixed.length) out.weapon_proficiencies = [...wp.map(titleCase), ...wfixed].join(", ");
  const tools = []; for (const t of arr(bg.tool_proficiencies)) if (t && typeof t === "object") tools.push(...arr(t.items).map(String));
  const toolName = (x) => String(x).replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/'S\b/g, "'s");
  for (const [k, v] of Object.entries(oc)) if (/^background:tool/.test(k) || (k.startsWith("race:") && k.includes("tool"))) for (const x of arr(v)) tools.push(String(x).includes("_") ? nameFromSlug(slugOf(String(x))) : toolName(x));
  for (const [c, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) if (Number(lv) <= p.level && ch && typeof ch === "object")
    for (const [key, v] of Object.entries(ch)) if (/(^|-)tools?($|-)/.test(key) && (typeof v === "string" || Array.isArray(v))) tools.push(...arr(v).map(toolName));
  const toolsU = [...new Set(tools.map((t) => /^[a-z' -]+$/.test(t) ? t.replace(/-/g, " ").replace(/\b([a-z])/g, (x) => x.toUpperCase()).replace(/'S/g, "'s") : t))];
  if (toolsU.length) out.tool_proficiencies = toolsU.join(", ");

  // features, traits, feats
  const featEntries = (fbl, upto) => {
    const got = new Map();
    for (const lv of Object.keys(fbl || {}).sort((a, b) => a - b)) {
      if (Number(lv) > upto) continue;
      for (const f of arr(fbl[lv])) { if (!f.name) continue; const d = clean(firstText(f), short); got.set(f.id || f.name, d ? { name: f.name, desc: d, _act: f.action || f.action_cost } : null); }
    }
    return [...got.values()].filter(Boolean);
  };
  let cf = []; const poolDocs = [];
  for (const [c, p] of classes) {
    const start = cf.length;
    cf.push(...featEntries(c.features_by_level, p.level));
    if (p.subclass) cf.push(...featEntries((await vault.get(p.subclass)).features_by_level, p.level));
    // features that scale by a class table column ("as shown in the Sneak Attack column..."): print today's value
    const cols = (((c.table || {})[String(p.level)] || {}).columns) || {};
    for (const f of cf.slice(start)) {
      const seen = [];
      for (const mm of f.desc.matchAll(/(?:in|of) the ([A-Z][A-Za-z' ]+?) column/g)) {
        const cn = mm[1].trim();
        if (seen.includes(cn) || ["Cantrips", "Prepared Spells", "Spells Known", "Invocations", "Spell Slots", "Slot Level"].includes(cn) || !(cn in cols)) continue;
        seen.push(cn);
      }
      if (seen.length) f.desc = f.desc.replace(/\s+$/, "") + `\n\nAt level ${p.level}: ` + seen.map((cn) => `${cn} ${cols[cn]}`).join("; ");
    }
  }
  cf = cf.filter((f) => !/^(ability score improvement|subclass.*|epic boon)$/i.test(f.name));
  // class selection-pool picks (infusions, invocations, metamagic...): list the chosen optional features
  for (const [c, p] of classes) {
    const pools = {}; for (const pl of arr(c.selection_pools)) if (pl && pl.id) pools[pl.id] = pl;
    for (const [lv, ch] of Object.entries(p.choices || {})) {
      if (!ch || typeof ch !== "object" || Number(lv) > p.level) continue;
      for (const [pid, picks] of Object.entries(ch)) {
        if (!pools[pid] || !Array.isArray(picks)) continue;
        for (const pk of picks) {
          let od = {}; try { od = await vault.get(`[[${pk}]]`, "optional-feature"); } catch (e) {}
          if (!od || !od.name) continue;
          poolDocs.push(od);
          cf.push({ name: `${pools[pid].label || pid}: ${od.name}`.replace("Artificer Infusions: ", "Infusion: "), desc: clean(firstText(od), short) });
        }
      }
    }
  }
  out.class_features = cf;
  const ba = [], rx = [];
  for (const f of out.class_features) {
    const head = (f.full || f.desc).slice(0, 300); const act = f._act; delete f._act;
    if (act === "bonus-action" || (!act && /\b(as|use|take|with|spend) (a|your) Bonus Action\b|\b(como|usa|usar|con|gasta|gastar|mediante) (una|tu) acci[oó]n adicional\b/i.test(head))) ba.push({ name: f.name, desc: f.desc });
    else if (act === "reaction" || (!act && /\b(as|use|take|with|spend) (a|your) Reaction\b|\bwhen .{0,80}you can use your Reaction|\b(como|usa|usar|con|gasta|gastar|mediante) (una|tu) reacci[oó]n\b/i.test(head))) rx.push({ name: f.name, desc: f.desc });
  }
  if (ba.length) out.bonus_actions = ba;
  if (rx.length) out.reactions = rx;
  const st = [];
  for (const t of arr(race.traits)) {
    if (["Size", "Speed", "Darkvision"].includes(t.name)) continue;
    const picked = chosen.filter(([tt]) => tt === t).map(([, o]) => o);
    if (picked.length) for (const o of picked) st.push({ name: `${t.name.split(" (")[0]}: ${o.label}`, desc: clean(o.description || "", short) });
    else if (!arr(t.choices).length) { const d = firstText(t); if (d) st.push({ name: t.name, desc: clean(d, short) }); }
  }
  out.species_traits = st;
  const feats = [];
  const featText = (f) => { // intro line plus the feat's `benefits` bullets
    const t = firstText(f); const ben = arr(f.benefits).map((b) => typeof b === "string" ? b.trim() : b && typeof b === "object" ? ((b.name ? `**${String(b.name).trim()}.** ` : "") + String(b.description || b.desc || "").trim()) : "").filter(Boolean);
    return (t + (t && ben.length ? "\n\n" : "") + ben.map((b) => "- " + b).join("\n")).trim();
  };
  const featDocs = [];
  const featEntry = async (ref, extra) => { const f = await vault.get(ref, "feat"); featDocs.push(f); return { name: (f.name || nameFromSlug(slugOf(ref))) + (extra ? ` (${extra})` : ""), desc: clean(featText(f), short) }; };
  if (bg.origin_feat) {
    let extra = "";
    if (oc["background:feat:spell-list"]) {
      const sp = arr(oc["background:feat:mi-cantrips"]).map((x) => nameFromSlug(slugOf(x)));
      const l1 = oc["background:feat:mi-level1"];
      extra = `${titleCase(oc["background:feat:spell-list"])}: ` + [...sp, ...(l1 ? [nameFromSlug(slugOf(l1))] : [])].join(", ");
    }
    feats.push(await featEntry(bg.origin_feat, extra));
  }
  for (const [, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {}).sort((a, b) => a[0] - b[0])) {
    if (Number(lv) <= p.level && ch && ch.feat) {
      let extra = ""; if (ch["feat:asi"] && typeof ch["feat:asi"] === "object") extra = Object.entries(ch["feat:asi"]).map(([a, n]) => `+${n} ${titleCase(a)}`).join(", ");
      feats.push(await featEntry(ch.feat, extra));
    }
  }
  for (const [k, v] of Object.entries(oc)) if (k.startsWith("race:") && k.includes("feat") && typeof v === "string" && v) feats.push(await featEntry(v, ""));
  out.feats = feats;
  // initiative = Dex modifier + every initiative-bonus effect (Alert: your Proficiency Bonus, ...)
  const amt = (e) => {
    if (e.value !== undefined && e.value !== null) return parseInt(e.value, 10) || 0;
    let a = String(e.amount || "").trim().toLowerCase(); if (!a) return 0;
    a = a.replace(/\{prof\}|\byour proficiency bonus\b|\bproficiency bonus\b/g, String(pb)).replace(/\{(str|dex|con|int|wis|cha)_mod\}/g, (_, x) => String(m[x]));
    for (const [ab, full] of Object.entries(ABIL_FULL)) a = a.replace(new RegExp(`\\byour ${full} modifier\\b`, "g"), String(m[ab]));
    a = a.replace(/\bhalf (\d+)\b/g, (_, n) => String(Math.floor(Number(n) / 2)));
    return /^[\d\s+\-*/().]+$/.test(a) ? Math.trunc(Function(`"use strict";return (${a})`)()) : 0;
  };
  const initEffs = [...effects, ...featDocs.flatMap((f) => arr(f.effects))];
  for (const [c, p] of classes) for (const src of [c, p.subclass ? await vault.get(p.subclass) : null]) {
    for (const [lv, fl] of Object.entries((src && src.features_by_level) || {})) if (/^\d+$/.test(lv) && Number(lv) <= p.level) for (const ft of arr(fl)) if (ft && !ft.activatable) initEffs.push(...arr(ft.effects));
  }
  for (const it of eq) { if (!it.equipped) continue; const n = await vault.get(it.item); if (n && (!needsAttune(n) || it.attuned)) initEffs.push(...arr(n.effects)); }
  let initBonus = 0;
  for (const e of initEffs) if (e && e.kind === "initiative-bonus" && String(e.subject || "self") === "self") { try { initBonus += amt(e); } catch (x) {} }
  out.initiative = m.dex + initBonus;
  // senses from feats (Skulker: Blindsight), invocations (Devil's Sight), class features and worn items
  for (const e of [...initEffs, ...poolDocs.flatMap((d) => arr(d.effects))]) if (e && e.kind === "sense" && String(e.subject || "self") === "self") { const t = String(e.type || e.sense || "").toLowerCase(), r = Number(e.range || 0); if (t && r > (sensesU[t] || 0)) sensesU[t] = r; }
  for (const d of [...featDocs, ...poolDocs]) { // a feat that only states its sense in text ("You have Blindsight with a range of 10 feet")
    if (arr(d.effects).some((e) => e && e.kind === "sense")) continue;
    for (const mm of featText(d).matchAll(/\b(blindsight|darkvision|tremorsense|truesight)\b[^.]{0,40}?\brange of (\d+) feet/gi)) { const t = mm[1].toLowerCase(), r = Number(mm[2]); if (r > (sensesU[t] || 0)) sensesU[t] = r; }
  }
  const allS = [...sensPre, ...Object.entries(sensesU).map(([t, r]) => `${titleCase(t)} ${r} ft`)]; if (allS.length) out.senses = allS.join(", ");

  // spells
  const spells = new Map();
  const add = (ref, prepared, always, name) => { let sl = slugOf(ref); if (!sl.includes("_spell_")) for (const k of spells.keys()) if (k.endsWith("_spell_" + sl) || k.endsWith("_spell_" + sl + "-es")) { sl = k; break; } const cur = spells.get(sl) || { prepared: false, always: false }; if (prepared) cur.prepared = true; if (always) cur.always = true; if (name) cur.name = name; spells.set(sl, cur); };
  for (const s of arr((pc.spells || {}).known)) add(s.spell, s.prepared);
  for (const [k, v] of Object.entries(oc)) if (/mi-cantrips|mi-level1|spell/.test(k) && !k.includes("list") && !k.includes("ability")) for (const x of arr(v)) add(x, true);
  for (const [c, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) // spells picked through a feat taken in a class slot
    if (ch && typeof ch === "object" && Number(lv) <= p.level) for (const [k, v] of Object.entries(ch))
      if ((k.startsWith("feat:") || arr(c.selection_pools).some((pl) => pl && k.startsWith(`${pl.id}:`))) && /cantrip|spell|level\d/.test(k) && !k.includes("list") && !k.includes("ability")) for (const x of arr(v)) if (typeof x === "string") add(x, true);
  for (const [c, p] of classes) for (const src of [c, p.subclass ? await vault.get(p.subclass) : {}]) {
    if (!Array.isArray(src.additional_spells)) continue;
    for (const entry of src.additional_spells) for (const key of ["known", "prepared", "innate"]) { // Ranger's Hunter's Mark and domain/oath spells sit under `prepared`
      const blk = entry && entry[key]; if (!blk || typeof blk !== "object" || Array.isArray(blk)) continue;
      for (const [lv, names] of Object.entries(blk)) {
        if (lv !== "_" && !/^\d+$/.test(lv)) continue; if (/^\d+$/.test(lv) && Number(lv) > p.level) continue;
        for (const n of (Array.isArray(names) ? names : [names])) if (typeof n === "string") add(n.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), true, true, n);
      }
    }
  }
  const fixedNames = (x) => (typeof x === "string" ? (x.includes("=") ? [] : [x]) : Array.isArray(x) ? x.flatMap(fixedNames) : x && typeof x === "object" && !("choose" in x) ? Object.values(x).flatMap(fixedNames) : []);
  for (const fd of featDocs) for (const entry of Array.isArray(fd && fd.additional_spells) ? fd.additional_spells : []) for (const key of ["known", "prepared", "innate"]) { // Fey-Touched's Misty Step, Shadow-Touched's Invisibility; {choose} rows are Builder picks
    const blk = entry && entry[key]; if (!blk || typeof blk !== "object" || Array.isArray(blk)) continue;
    for (const [lv, names] of Object.entries(blk)) { if (lv !== "_" && (!/^\d+$/.test(lv) || Number(lv) > levelTotal)) continue;
      for (const n0 of fixedNames(names)) { const n = n0.replace(/\b\w/g, (c) => c.toUpperCase()); add(n.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), true, true, n); } }
  }
  // species (and subspecies) additional_spells: the entry named like the chosen lineage, else the only/unnamed one
  const flat = (x) => (typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" ? Object.values(x).flatMap(flat) : []);
  const picks = new Set(Object.entries(oc).filter(([k, v]) => k.startsWith("race:") && typeof v === "string").map(([, v]) => v.toLowerCase().replace(/ /g, "-")));
  for (const rsrc of [race, pc.subrace ? await vault.get(pc.subrace) : {}]) {
    let ents = rsrc && rsrc.additional_spells; ents = !ents ? [] : Array.isArray(ents) ? ents : [ents];
    const norm = (n) => String(n || "").toLowerCase().replace(/ /g, "-");
    let use = ents.filter((e) => picks.has(norm(e.name)));
    if (!use.length) use = ents.filter((e) => !e.name);
    if (!use.length && ents.length === 1) use = ents;
    for (const entry of use) for (const key of ["known", "prepared", "innate"]) {
      const sec = entry[key]; if (!sec || typeof sec !== "object" || Array.isArray(sec)) continue;
      for (const [lv, names] of Object.entries(sec)) {
        if (lv !== "_" && (!/^\d+$/.test(lv) || Number(lv) > levelTotal)) continue;
        for (const n of flat(names)) add(n.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), true, true, n);
      }
    }
  }
  const info = new Map();
  for (const sl of spells.keys()) info.set(sl, await vault.get(sl));
  const SCHOOL_ABBR = (s) => SCHOOL[String(s || "").toLowerCase()] || "";
  const spellEntry = (sl) => {
    const d = info.get(sl) || {}; const e = { name: spellLabel(d, d.name || (spells.get(sl) || {}).name || nameFromSlug(sl), opts) };
    if (d.range) e.range = String(d.range).replace(/feet/g, "ft").replace(/ ft\./g, " ft").replace(/^S:(.*)$/, "Self ($1)");
    const ct = String(d.casting_time || "").toLowerCase();
    if (ct) { const c2 = ct.replace(/(\d+)\s*minutes?/, "$1 min").replace(/(\d+)\s*hours?/, "$1 h"); e.cost = { "1 action": "1 a", "1 bonus action": "1 ba", "1 reaction": "1 r", "action": "1 a", "act": "1 a", "bonus-action": "1 ba", "reaction": "1 r", "react": "1 r" }[c2] || c2; }
    let dur = String(d.duration || "");
    if (dur) { dur = dur.replace(/^instantaneous$/i, "Inst").replace(/minutes?/g, "min").replace(/hours?/g, "h"); e.duration = d.concentration ? "C, " + dur : dur; }
    if (d.damage_roll) e.damage = String(d.damage_roll);
    const types = (d.damage || {}).types || [];
    e.type = types.length ? titleCase(types[0]) : SCHOOL_ABBR(d.school);
    e.desc = clean(firstText(d), short || 0);
    if (opts.linkSpells !== false && d._file) {
      e.desc = spellMechanics(d);
      const ah = Array.isArray(d.at_higher_levels) ? d.at_higher_levels.join(" ") : (d.at_higher_levels ? String(d.at_higher_levels) : "");
      if (ah) e.upcast = clean(ah, 0).replace(/\s+/g, " ").slice(0, 300);
      for (const k of Object.keys(e)) if (e[k] === "" || e[k] == null) delete e[k];
      return e;
    }
    if (!short && d.at_higher_levels) { const ah = Array.isArray(d.at_higher_levels) ? d.at_higher_levels.join(" ") : String(d.at_higher_levels); const ahc = clean(ah, 0), mm = /\n\n(?:Fuente|Source): [^\n]*$/.exec(e.desc); e.desc = mm ? e.desc.slice(0, mm.index) + "\n\n" + ahc + e.desc.slice(mm.index) : (e.desc + "\n\n" + ahc).trim(); }
    for (const k of Object.keys(e)) if (e[k] === "" || e[k] == null) delete e[k];
    return e;
  };
  const cant = [], tabs = {}, book = {}, prepCounters = [], unresolved = [];
  for (const [sl, s] of spells) {
    const d = info.get(sl) || {};
    if (d.level == null) { unresolved.push(d.name || s.name || nameFromSlug(sl).replace(/^Srd 20\d\d /, "")); continue; }
    const lv = Number(d.level);
    (book[lv] = book[lv] || []).push(spellEntry(sl));
    if (lv === 0) cant.push(spellEntry(sl));
    else {
      const on = s.prepared || s.always;
      prepCounters.push({ name: spellLabel(d, d.name || nameFromSlug(sl), opts) + (d.ritual ? " (R)" : ""), max: 1, used: on ? 0 : 1 });
      if (on) (tabs[lv] = tabs[lv] || []).push(spellEntry(sl));
    }
  }
  if (classes.some(([, p]) => Object.values(p.choices || {}).some((ch) => ch && typeof ch === "object" && Object.values(ch).some((v) => Array.isArray(v) && v.some((pk) => String(pk).includes("agonizing-blast"))))))
    for (const e of cant) if (String(e.name || "").includes("eldritch-blast") && e.damage && !String(e.damage).includes("@cha.mod")) e.damage = `${e.damage}+@cha.mod`; // Agonizing Blast
  if (cant.length) out.spellcasting = cant;
  for (const lv of Object.keys(tabs).sort((a, b) => a - b)) out[`tab_${Number(lv) + 1}`] = tabs[lv];
  if (!classic && !pips) for (const lv of Object.keys(book).sort((a, b) => a - b)) out[`spellbook_${lv}`] = book[lv].sort((a, b) => a.name.localeCompare(b.name));
  if (prepCounters.length && opts.preparedTracker) out.prepared_spells = prepCounters;
  let scAb = null;
  for (const [c, p] of classes) { const sp = c.spellcasting || (p.subclass ? (await vault.get(p.subclass)).spellcasting : null); if (sp && sp.ability) { scAb = sp.ability; break; } }
  if (!scAb) scAb = oc["background:feat:spellcasting-ability"];
  if (!scAb) { // a non-caster with species/feat spells (Wood Elf Rogue): use the ability picked for them
    const cands = [...Object.entries(oc), ...classes.flatMap(([, p]) => Object.values(p.choices || {}).filter((ch) => ch && typeof ch === "object").flatMap((ch) => Object.entries(ch)))];
    for (const [k, v] of cands) if (String(k).endsWith("spellcasting-ability") && ABILS.includes(v)) { scAb = v; break; }
  }
  // spells a feat grants cast with the ability that feat raised (Fey-Touched, Shadow-Touched...), which can differ from the class's
  const featAb = new Map();
  for (const [c, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) {
    if (!(ch && typeof ch === "object" && Number(lv) <= p.level && typeof ch.feat === "string")) continue;
    const fd = await vault.get(ch.feat), ents = fd && fd.additional_spells; if (!Array.isArray(ents) || !ents.length) continue;
    let ab = null; for (const [k, v] of Object.entries(ch)) if (String(k).endsWith("spellcasting-ability") && ABILS.includes(v)) { ab = v; break; }
    if (!ab) { const pts = ch["feat:asi"]; if (abPoints(pts)) ab = Object.keys(pts).reduce((a, b) => (pts[b] > pts[a] ? b : a)); else if (ents[0] && ABILS.includes(ents[0].ability)) ab = ents[0].ability; }
    if (!ab) continue;
    for (const [k, v] of Object.entries(ch)) if (k.startsWith("feat:") && /cantrip|spell|level\d/.test(k) && !k.includes("list") && !k.includes("ability")) for (const x of arr(v)) if (typeof x === "string") featAb.set(slugOf(x), ab);
    for (const e of ents) for (const key of ["known", "prepared", "innate"]) for (const nm of fixedNames((e && e[key]) || {})) { const s2 = nm.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); for (const sk of spells.keys()) if (sk === s2 || sk.endsWith("_spell_" + s2)) featAb.set(sk, ab); }
  }
  if (!scAb && featAb.size) scAb = [...featAb.values()][0];
  if (featAb.size) {
    const lab = new Map(); for (const [sl, a] of featAb) if (info.has(sl)) { const d = info.get(sl) || {}; lab.set(spellLabel(d, d.name || nameFromSlug(sl), opts), a); }
    const tag = (e) => { const a = lab.get(e.name); if (a && a !== scAb) e.desc = `${e.desc || ""}\n\nCast with ${titleCase(ABIL_FULL[a])}: save DC ${8 + pb + m[a]}, spell attack ${signed(pb + m[a])}`.trim(); };
    for (const e of cant) tag(e); for (const l of [...Object.values(tabs), ...Object.values(book)]) for (const e of l) tag(e);
  }
  if (scAb && (cant.length || Object.keys(tabs).length || prepCounters.length)) {
    out.spellcasting_ability = pips ? titleCase(ABIL_FULL[scAb]).slice(0, 3) : titleCase(ABIL_FULL[scAb]); out.spell_save_dc = `8+@${scAb}.mod+@pb`; out.spell_attack_bonus = `@${scAb}.mod+@pb`;
  }
  let clevel = 0, casters = 0, slots = null, pact = null;
  const suU = (pc.state || {}).spell_slots || {};
  const PACT = { 1: [1, 1], 2: [2, 1], 3: [2, 2], 4: [2, 2], 5: [2, 3], 6: [2, 3], 7: [2, 4], 8: [2, 4], 9: [2, 5], 10: [2, 5], 11: [3, 5], 12: [3, 5], 13: [3, 5], 14: [3, 5], 15: [3, 5], 16: [3, 5], 17: [4, 5], 18: [4, 5], 19: [4, 5], 20: [4, 5] };
  const num = (x) => { const mm = String(x).match(/^\d+/); return mm ? Number(mm[0]) : 0; };
  for (const [c, p] of classes) {
    const ct = (c.spellcasting || {}).caster_type, lv = p.level, cols = (((c.table || {})[String(lv)] || {}).columns) || {};
    if (ct === "pact") { let n = num(cols["Spell Slots"]), l = num(cols["Slot Level"]); if (!(n && l)) [n, l] = PACT[Math.min(20, lv)]; pact = [n, l]; }
    else if (["full", "half", "half-up", "third"].includes(ct)) {
      casters++;
      const own = {}; for (const [k, v] of Object.entries(cols)) if (/^\d+(st|nd|rd|th)$/.test(k)) own[num(k)] = num(v);
      const top = Math.max(0, ...Object.entries(own).filter(([, v]) => v > 0).map(([k]) => Number(k)));
      if (top) slots = Array.from({ length: top }, (_, i) => own[i + 1] || 0);
      if (ct === "full") clevel += lv; else if (ct === "half") clevel += Math.floor(lv / 2); else if (ct === "half-up") clevel += Math.ceil(lv / 2); else clevel += Math.floor(lv / 3);
    }
  }
  if (casters > 1 || !slots) slots = clevel ? FULL_SLOTS[Math.min(20, clevel)] : null; // multiclass: the combined table
  if (slots) out.slots = slots.map((n, i) => { const u = suU[String(i + 1)] || suU[i + 1]; return { name: `Level ${i + 1}`, max: n, used: u && typeof u === "object" ? Number(u.used || 0) : 0 }; }).filter((x) => x.max);
  if (pact) out.slots = [...arr(out.slots), { name: `Pact Magic (Level ${pact[1]})`, max: pact[0], used: Number((suU.pact || {}).used || 0) }];

  // attacks and equipment
  const acts = [], eqs = [], attunedItems = [];
  const wm = [];
  for (const [c, p] of classes) for (const [lv, ch] of Object.entries(p.choices || {})) if (Number(lv) <= p.level && ch && Array.isArray(ch["weapon-mastery"]))
    for (const ref of ch["weapon-mastery"]) { const wd = await vault.get(ref); const mk = arr(wd.mastery)[0]; wm.push({ name: (wd.name || nameFromSlug(slugOf(ref))) + (mk ? ` (${titleCase(String(mk))})` : "") }); }
  if (wm.length && !out.weapon_mastery) out.weapon_mastery = wm;
  const resmap = {}; // resource id -> display name (Lay On Hands, Paladin's Smite, Channel Divinity...)
  for (const src of [...classes.map(([c]) => c), ...(await Promise.all(classes.filter(([, p]) => p.subclass).map(([, p]) => vault.get(p.subclass)))), race])
    for (const fl of Object.values((src && src.features_by_level) || {})) for (const ft of arr(fl)) for (const r of arr(ft && ft.resources)) if (r && r.id && r.name) { resmap[r.id] = r.name; for (const q of arr(r.equivalent_ids)) if (!(q in resmap)) resmap[q] = r.name; }
  const fuRaw = (pc.state || {}).feature_uses || {}, cfn = {};
  // drop leftovers of things the character no longer has (a Dragonborn's Breath Weapon after switching species)
  const slg = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const refs = [pc.race, pc.subrace, pc.background, ...classesPc.map((c) => c.name), ...classesPc.map((c) => c.subclass)];
  for (const c of classesPc) for (const ch of Object.values(c.choices || {})) if (ch && typeof ch === "object") refs.push(...Object.values(ch).filter((v) => typeof v === "string" && v.includes("_")));
  refs.push(...Object.values(oc).filter((v) => typeof v === "string" && v.includes("_")));
  const liveP = new Set(); for (const r of refs) { const sl = r ? slugOf(r) : ""; if (sl) { liveP.add(sl); liveP.add(sl.split("_").pop()); } }
  const liveN = new Set(["species_traits", "class_features", "feats", "bonus_actions", "reactions"].flatMap((sec) => arr(out[sec]).map((e) => slg(e && e.name))));
  const live = (k) => { if (k in resmap || !k.includes(":")) return true; const i = k.lastIndexOf(":"), pref = k.slice(0, i), fid = k.slice(i + 1); return liveP.has(pref) || [...liveP].some((x) => x.length > 2 && (pref.endsWith(x) || x.endsWith(pref))) || liveN.has(fid); };
  const fu = Object.fromEntries(Object.entries(fuRaw).filter(([k]) => live(k)));
  for (const f of cf) cfn[f.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")] = f.name;
  const resC = [];
  for (const [k, v] of Object.entries(fu)) { if (!v || typeof v !== "object" || !v.max) continue; const fid = k.split(":").pop(); resC.push({ name: resmap[k] || cfn[fid] || titleCase(fid.replace(/-/g, " ")), max: Number(v.max), used: Number(v.used || 0) }); }
  if (pips) { // use pips live in the section they belong to: species traits, feats, class features
    const slug = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const spkey = slug(race.name), featkeys = new Set(arr(out.feats).map((f) => slug(f.name))), spk = new Set(arr(out.species_traits).map((t) => slug(t.name)));
    const buckets = { class_feature_uses: [], species_trait_uses: [], feat_uses: [] };
    for (const [k, v] of Object.entries(fu)) {
      if (!v || typeof v !== "object" || !v.max) continue;
      const i = k.lastIndexOf(":"), pref = i >= 0 ? k.slice(0, i) : "", fid = i >= 0 ? k.slice(i + 1) : k;
      const row = { name: resmap[k] || cfn[fid] || titleCase(fid.replace(/-/g, " ")), max: Number(v.max), used: Number(v.used || 0) };
      if (pref && (pref === spkey || spkey.includes(pref) || spk.has(fid))) buckets.species_trait_uses.push(row);
      else if (featkeys.has(fid)) buckets.feat_uses.push(row);
      else buckets.class_feature_uses.push(row);
    }
    for (const [bk, rows] of Object.entries(buckets)) if (rows.length) out[bk] = rows;
  } else if (resC.length) out.class_resources = resC;
  for (const it of eq) {
    const d = await vault.get(it.item); const ov = it.overrides || {}; const nm = ov.name || d.name || nameFromSlug(slugOf(it.item)); const cat = String(d.category || "");
    if (d._type === "weapon" || (d.damage && cat.includes("-"))) {
      const props = arr(d.properties).map((p) => (typeof p === "string" ? p.toLowerCase().replace(/_/g, " ") : ""));
      const ranged = cat.includes("ranged"), fin = props.includes("finesse");
      const ab = ranged || (fin && m.dex > m.str) ? "dex" : "str";
      const proficient = wprof.has(cat.split("-")[0]) || wprof.has(nm.toLowerCase()) || wrules.some(([c, set]) => cat.split("-")[0] === c && props.some((x) => set.has(x)));
      const atk = m[ab] + (proficient ? pb : 0), dmg = d.damage || {};
      const e = { name: itemLabel(d, nm, opts), attack: signed(atk), damage: `${dmg.dice || "1"}${m[ab] >= 0 ? "+" : ""}@${ab}.mod`.replace("+-", "-"), type: titleCase(dmg.type || ""), cost: { free: "free", special: "special", bonus: "1 ba", reaction: "1 r" }[String(ov.action || "").toLowerCase()] || "1 a" };
      if ((it.qty || 1) > 1) e.name = itemLabel(d, `${nm} x${it.qty}`, opts);
      const rg = d.range || {};
      e.range = rg.long ? `${rg.normal}/${rg.long} ft` : rg.normal ? `${rg.normal} ft` : ranged ? "" : "Melee";
      if (props.includes("thrown") && rg.normal) e.range = "Melee, " + e.range;
      e.desc = [props.filter(Boolean).map(titleCase).join(", "), arr(d.mastery).length ? titleCase(String(d.mastery[0])) : "", it.notes || ""].filter(Boolean).join("; ");
      for (const k of Object.keys(e)) if (!e[k]) delete e[k];
      acts.push(e);
    } else {
      const q = it.qty || 1; const e = { name: itemLabel(d, nm + (q > 1 ? ` x${q}` : ""), opts) };
      const needAtt = needsAttune(d);
      let desc = it.equipped ? "equipped" : it.in ? `in ${it.in}` : "";
      if (needAtt) desc = (desc ? desc + ", " : "") + (it.attuned ? "attuned" : "requires attunement (not attuned)");
      if (desc) e.desc = desc; eqs.push(e);
      if (needAtt && it.attuned) {
        let txt = clean(firstText(d), 0).replace(/\s+/g, " ").trim(); if (txt.length > 260) txt = txt.slice(0, 260).replace(/\s+\S*$/, "") + "…";
        attunedItems.push({ name: e.name, desc: txt || "Attuned" });
      }
    }
  }
  // conditional damage riders (Sneak Attack...): a clickable damage roll of its own
  for (const [c, p] of classes) {
    const cols = (((c.table || {})[String(p.level)] || {}).columns) || {};
    for (const src of [c, p.subclass ? await vault.get(p.subclass) : null]) {
      for (const [lv, fl] of Object.entries((src && src.features_by_level) || {})) {
        if (!(/^\d+$/.test(lv) && Number(lv) <= p.level)) continue;
        for (const ft of arr(fl)) {
          if (!ft || ft.activatable) continue;
          for (const e of arr(ft.effects)) {
            if (!e || e.kind !== "damage-bonus" || !e.condition || e.applies_to === "spell") continue;
            let amount = String(e.amount || "").trim(); const mm = amount.match(/^column\('(.+?)'\)$/); if (mm) amount = String(cols[mm[1]] ?? "");
            if (!/^\d+d\d+(\s*[+-]\s*\d+)?$/.test(amount)) continue;
            const at = Array.isArray(e.applies_to) ? e.applies_to.join(", ") : (e.applies_to ? String(e.applies_to) : "weapon"); const dt = String(e.damage_type || "");
            acts.push({ name: ft.name, damage: amount, type: dt.toLowerCase() === "weapon" ? "Weapon" : titleCase(dt), cost: "free", desc: `Once per turn (applies to ${at} attacks); ${e.condition}` });
          }
        }
      }
    }
  }
  if (acts.length) out.actions = acts;
  if (eqs.length) out.equipment = eqs;
  if (attunedItems.length && pips) out.otheractions = [...arr(out.otheractions), { name: `Attunement (${attunedItems.length}/3)`, desc: "Attuned magic items; they are listed below." }, ...attunedItems];
  const cur = pc.currency || {};
  out.currency = ["cp", "sp", "ep", "gp", "pp"].map((k) => cur[k] || null);
  if (unresolved.length) warn.push("spells without a note in the vault were skipped: " + unresolved.join(", "));
  // Obsidian stops reading a note's properties when the frontmatter passes ~32,000 characters: shrink the copies
  const LIMIT = 30000;
  const size = () => yaml.dump(out, { lineWidth: -1, noRefs: true }).length;
  const brief = (t, n = 220) => { t = String(t).replace(/\s+/g, " ").trim(); if (t.length <= n) return t; const c = t.slice(0, n); const k = Math.max(c.lastIndexOf(". "), c.lastIndexOf("; ")); return k > n / 2 ? c.slice(0, k + 1) : c.trimEnd() + "…"; };
  const shrink = (keys, n) => { for (const k of keys) for (const e of arr(out[k])) if (e && typeof e.desc === "string" && e.desc.length > n) e.desc = brief(e.desc, n); };
  if (size() > LIMIT) {
    shrink(["bonus_actions", "reactions"], 200); let note = "bonus/reaction texts shortened";
    if (size() > LIMIT) { shrink(["spellcasting", ...Object.keys(out).filter((k) => /^tab_\d+$/.test(k))], 220); note += ", spell copies on the Spells/Actions tabs shortened (full text stays in the spellbook lists)"; }
    if (size() > LIMIT) { shrink(["class_features", "species_traits", "feats"], 700); note += ", long feature texts cut"; }
    warn.push(`The sheet was over Obsidian's ~32 KB frontmatter limit (${note}); size now ${size()} characters`);
  }
  return { out, warn };
}

const BIO_KEYS = new Set(["alignment", "age", "height", "weight", "eyes", "hair", "skin", "appearance", "personality", "allies", "notes", "description"]);
const PRESERVE_ON_UPDATE = new Set(["image", "description", "xp", "alignment", "heroic_inspiration", "age", "height", "weight", "eyes", "hair", "skin",
  "appearance", "personality", "ideals", "bonds", "flaws", "allies", "notes", "notes_2", "damage_vulnerabilities", "damage_immunities", "condition_immunities", "weapon_mastery"]);
module.exports = { convert, PRESERVE_ON_UPDATE, slugOf };
