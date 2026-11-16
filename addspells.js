// Add every spell on a class's list to an Archivist character (for classes that prepare from their whole list).
const bare = (x) => String(x == null ? "" : x).replace(/^\[\[|\]\]$/g, "").split("|")[0].trim();
const clsName = (x) => bare(x).split("/").pop().replace(/_/g, " ").toLowerCase().trim();
const ORD = ["1st", "2nd", "3rd", "4th", "5th", "6th", "7th", "8th", "9th"];

// the highest spell level the class has slots for at this level: from its table, else from its caster type
function maxSpellLevel(classDoc, level) {
  const cols = (((classDoc || {}).table || {})[String(level)] || {}).columns || {};
  let hi = 0; ORD.forEach((o, i) => { if (Number(String(cols[o] == null ? 0 : cols[o]).match(/\d+/) || 0) > 0) hi = i + 1; });
  if (hi) return hi;
  const t = ((classDoc || {}).spellcasting || {}).caster_type;
  if (t === "full") return Math.min(9, Math.ceil(level / 2));
  if (t === "half" || t === "half-up") return Math.min(5, Math.floor((level + 3) / 4));
  if (t === "pact") return Math.min(5, Math.ceil(level / 2));
  return Math.min(9, Math.ceil(level / 2));
}

// spells: [{ slug, name, level, classes, edition, compendium }]
function plan(pc, classDoc, spells, opts) {
  const cname = String(classDoc.name || "").toLowerCase();
  const have = new Set(((pc.spells || {}).known || []).map((e) => bare(typeof e === "string" ? e : e && e.spell)));
  const max = opts.maxLevel != null ? opts.maxLevel : 9;
  const ed = opts.editions && opts.editions.size ? opts.editions : null, comp = opts.compendiums && opts.compendiums.size ? opts.compendiums : null;
  const add = [];
  for (const s of spells) {
    if (!(s.classes || []).some((c) => clsName(c) === cname)) continue;
    const lv = Number(s.level || 0);
    if (lv === 0 ? !opts.cantrips : lv > max) continue;
    if (ed && !ed.has(String(s.edition || ""))) continue;
    if (comp && !comp.has(String(s.compendium || ""))) continue;
    if (have.has(s.slug)) continue;
    add.push(s);
  }
  add.sort((a, b) => Number(a.level || 0) - Number(b.level || 0) || String(a.name).localeCompare(String(b.name)));
  return add;
}

function apply(pc, classRef, additions, multi) {
  pc.spells = pc.spells || { known: [], overrides: [] };
  if (!Array.isArray(pc.spells.known)) pc.spells.known = [];
  for (const s of additions) pc.spells.known.push(multi ? { spell: s.slug, class: bare(classRef) } : s.slug);
  return pc;
}
module.exports = { plan, apply, maxSpellLevel, clsName, bare };
