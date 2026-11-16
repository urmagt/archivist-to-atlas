#!/usr/bin/env python3
"""
Archivist character note  ->  Atlas VTT statblock note (5E 2024 character sheet template).

Run it from anywhere; it reads your vault's compendium notes to work things out.

    pip install pyyaml
    python archivist_to_atlas.py "Characters/Kankri.md" --vault "C:/path/to/MyVault"

Output: "<name> (Atlas).md" next to the input. Re-running with --update <existing atlas note> keeps what you
typed there (portrait, backstory, notes, XP, ...) and only refreshes the numbers and lists this script fills in.
A backup of the note you update is saved as <name>.bak.md first.

Private use: the output can contain text copied from your compendium notes.
"""
import argparse, math, re, shutil, sys
from pathlib import Path
import yaml

TEMPLATE_ID = "5e-2024-rules-character-sheet-tabbed-q4m8xe"   # the tabbed template; use --classic for the original sheet
CLASSIC_TEMPLATE_ID = "5e-2024-rules-character-sheet-p7k2nd"
NEW_TEMPLATE_ID = "5e-2024-character-sheet-4r8tqz"            # latest official sheet (pips layout, "as comprehensive as possible")
PIPS_TEMPLATE_ID = "5e-2024-character-sheet-pips-4r8tqz"      # the newer sheet with use pips (Atlas "Pips 5e (2024) Character Sheet")
PROF_SYMBOL = {"0": "◇", "half": "⬖", "1": "◆", "2": "❖"}   # the pips sheet writes proficiency as a symbol
HIT_DICE_KEYS = {False: "hit_dice_pool", True: "hit_dice_2"}   # tabbed template uses hit_dice_pool; the classic sheet uses hit_dice_2
ABILS = ["str", "dex", "con", "int", "wis", "cha"]
ABIL_FULL = dict(str="strength", dex="dexterity", con="constitution", int="intelligence", wis="wisdom", cha="charisma")
SKILLS = {  # key -> ability
    "acrobatics": "dex", "animal_handling": "wis", "arcana": "int", "athletics": "str", "deception": "cha",
    "history": "int", "insight": "wis", "intimidation": "cha", "investigation": "int", "medicine": "wis",
    "nature": "int", "perception": "wis", "performance": "cha", "persuasion": "cha", "religion": "int",
    "sleight_of_hand": "dex", "stealth": "dex", "survival": "wis"}
SCHOOL = dict(abjuration="Abjur", conjuration="Conj", divination="Div", enchantment="Ench", evocation="Evoc",
              illusion="Illus", necromancy="Necro", transmutation="Trans")
FULL_SLOTS = {1: [2], 2: [3], 3: [4, 2], 4: [4, 3], 5: [4, 3, 2], 6: [4, 3, 3], 7: [4, 3, 3, 1], 8: [4, 3, 3, 2],
              9: [4, 3, 3, 3, 1], 10: [4, 3, 3, 3, 2], 11: [4, 3, 3, 3, 2, 1], 12: [4, 3, 3, 3, 2, 1],
              13: [4, 3, 3, 3, 2, 1, 1], 14: [4, 3, 3, 3, 2, 1, 1], 15: [4, 3, 3, 3, 2, 1, 1, 1],
              16: [4, 3, 3, 3, 2, 1, 1, 1], 17: [4, 3, 3, 3, 2, 1, 1, 1, 1], 18: [4, 3, 3, 3, 3, 1, 1, 1, 1],
              19: [4, 3, 3, 3, 3, 2, 1, 1, 1], 20: [4, 3, 3, 3, 3, 2, 2, 1, 1]}
# used only if the vault has no note for the item
ARMOR_FALLBACK = {"padded": (11, True, None), "leather": (11, True, None), "studded-leather": (12, True, None),
    "hide": (12, True, 2), "chain-shirt": (13, True, 2), "scale-mail": (14, True, 2), "breastplate": (14, True, 2),
    "half-plate": (15, True, 2), "ring-mail": (14, False, 0), "chain-mail": (16, False, 0),
    "splint": (17, False, 0), "plate": (18, False, 0)}

# ------------------------------------------------------------------ vault index
FM = re.compile(r"\A---\n(.*?)\n---", re.S)
BLOCK = re.compile(r"```([\w-]+)\n(.*?)\n```", re.S)

def parse_note(path):
    text = Path(path).read_text(encoding="utf-8")
    fm = {}
    m = FM.match(text)
    if m:
        try: fm = yaml.safe_load(m.group(1)) or {}
        except Exception: fm = {}
    blocks = {}
    for b in BLOCK.finditer(text):
        try: blocks[b.group(1)] = yaml.safe_load(b.group(2)) or {}
        except Exception: pass
    return fm, blocks, text

class Vault:
    def __init__(self, root):
        self.root = Path(root); self.index = {}; self.cache = {}; self.byname = {}
        for p in self.root.rglob("*.md"):
            if ".obsidian" in p.parts: continue
            try:
                head = p.read_text(encoding="utf-8", errors="ignore")[:600]
            except Exception: continue
            m = re.search(r"^slug:\s*['\"]?([^'\"\n]+)['\"]?\s*$", head, re.M)
            if m and "archivist: true" in head:
                self.index.setdefault(m.group(1).strip(), p)
                nm = re.search(r"^name:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", head, re.M); et = re.search(r"^entity_type:\s*(\S+)", head, re.M)
                for key in {p.stem.lower(), (nm.group(1).strip().lower() if nm else p.stem.lower())}:
                    self.byname.setdefault(key, []).append((et.group(1) if et else "", m.group(1).strip()))
    def get(self, ref, kind=None):
        """ref: '[[slug]]' or 'slug' (or a note name such as '[[Crafter]]') -> the entity block (dict) or {}"""
        if not ref: return {}
        slug = re.sub(r"^\[\[|\]\]$", "", str(ref)).split("|")[0].strip()
        if slug in self.cache: return self.cache[slug]
        p = self.index.get(slug); out = {}
        if not p:   # a plain note name / path ([[Crafter]], [[SRD 5e/Feats/Crafter]]): match by file name or note name
            cands = self.byname.get(slug.split("/")[-1].removesuffix(".md").strip().lower(), [])
            pick = [c for c in cands if not kind or c[0] == kind] or ([] if kind else cands)
            if pick: p = self.index.get(pick[0][1])
        if not p and "_" not in slug:   # a bare name such as 'wind-wall': find any '<compendium>_spell_wind-wall'
            for k, v in self.index.items():
                if k.endswith("_spell_" + slug): p = v; break
        if p:
            fm, blocks, _ = parse_note(p)
            kind = fm.get("entity_type")
            out = next(iter(blocks.values()), {}) if not kind else (blocks.get(kind) or next(iter(blocks.values()), {}))
            out = dict(out); out.setdefault("slug", slug); out["_type"] = kind; out["_file"] = Path(p).stem
        self.cache[slug] = out
        return out

def slug_of(ref): return re.sub(r"^\[\[|\]\]$", "", str(ref)).split("|")[0].strip()
def mod(score): return (score - 10) // 2
def signed(n): return f"+{n}" if n >= 0 else str(n)
def name_from_slug(slug): return re.sub(r"^.*?_(?:spell|item|armor|weapon|feat)_", "", slug).replace("-", " ").title()
def first_text(d):
    t = d.get("description") or "\n".join(str(x) for x in d.get("entries", []) if isinstance(x, str)) or ""
    return str(t).strip()
def clean(t, limit):
    t = str(t).replace("\r", "")
    t = re.sub(r"([.!?]),\s*(?=\**[A-ZÁÉÍÓÚ¿¡])", r"\1\n\n", t)
    t = re.sub(r"(?m)^\s*[*\u2022]\s+", "- ", t)          # bullets stay bullets
    t = re.sub(r"[`*_]{1,2}", "", t)
    if not limit:   # full text: keep paragraphs, list items and table rows on their own lines
        out, para = [], []
        def flush():
            if para: out.append(" ".join(para)); para.clear()
        for ln in (l.strip() for l in t.split("\n")):
            if not ln: flush(); out.append("")
            elif ln.startswith(("- ", "|")) or re.match(r"\d+[.)] ", ln): flush(); out.append(ln)
            else: para.append(ln)
        flush()
        txt = "\n".join(out)
        return re.sub(r"\n{3,}", "\n\n", txt).strip()
    t = re.sub(r"\s*\n\s*", " ", t).strip()
    if len(t) > limit:
        cut = t[:limit]; k = max(cut.rfind(". "), cut.rfind("; "))
        t = (cut[:k + 1] if k > limit // 2 else cut.rstrip()) + ("" if k > limit // 2 else "…")
    return t


LINK_SPELLS = True
PREPARED_TRACKER = False
SAVE_ES = {"fuerza": "Strength", "destreza": "Dexterity", "constitución": "Constitution", "constitucion": "Constitution", "inteligencia": "Intelligence", "sabiduría": "Wisdom", "sabiduria": "Wisdom", "carisma": "Charisma"}
SAVE_EN = {"str": "Strength", "dex": "Dexterity", "con": "Constitution", "int": "Intelligence", "wis": "Wisdom", "cha": "Charisma"}
def spell_label(d, nm):
    """The spell's name as a link to its note: [[file|Name]] (a quoted link in a name field renders as a hoverable link in Atlas)."""
    f = d.get("_file")
    if not (LINK_SPELLS and f): return nm
    return f"[[{f}]]" if f == nm else f"[[{f}|{nm}]]"
def item_label(d, nm):
    """An item's name as a link to its note ([[file|Name]]), like spells; plain text when the vault has no note for it."""
    f = d.get("_file")
    if not (LINK_SPELLS and f): return nm
    return f"[[{f}]]" if f == nm else f"[[{f}|{nm}]]"
def spell_mechanics(d):
    """Short English-keyword line (the Atlas sheet reads saves/attacks from it): save, attack, damage."""
    txt = str(d.get("description") or ""); parts = []
    st = d.get("saving_throw"); ab = None
    if isinstance(st, dict) and st.get("ability"): ab = str(st["ability"]).lower()
    if ab: ab = SAVE_EN.get(ab[:3], ab.title())
    else:
        m = re.search(r"(?i)\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw", txt) or re.search(r"(?i)salvaci[oó]n de (Fuerza|Destreza|Constituci[oó]n|Inteligencia|Sabidur[ií]a|Carisma)", txt)
        if m: ab = SAVE_ES.get(m.group(1).lower(), m.group(1).title())
    if ab: parts.append(f"{ab} saving throw")
    sa = d.get("spell_attack")
    kind = (sa if isinstance(sa, str) else "") or ("ranged" if re.search(r"(?i)ranged spell attack|ataque de conjuro a distancia", txt) else ("melee" if re.search(r"(?i)melee spell attack|ataque de conjuro cuerpo a cuerpo", txt) else ""))
    if sa is True and not kind: kind = "ranged"
    if kind: parts.append(f"{str(kind).title()} spell attack")
    dr = d.get("damage_roll"); types = (d.get("damage") or {}).get("types") or []
    if dr: parts.append(f"{dr} {types[0] if types else ''} {'damage' if types else ''}".replace("  ", " ").strip())
    return " · ".join(parts)

# ------------------------------------------------------------------ conversion
def convert(pc, vault, short, classic=False, template=None):
    warn = []
    level_total = sum(int(c.get("level", 1)) for c in pc["class"])
    pb = 2 + (level_total - 1) // 4
    race = vault.get(pc.get("race")); bg = vault.get(pc.get("background"))
    classes = [(vault.get(c["name"]), c) for c in pc["class"]]
    first_cls = classes[0][0]
    if not race: warn.append(f"species {pc.get('race')} not found in the vault")
    if not first_cls: warn.append(f"class {pc['class'][0]['name']} not found")
    oc = pc.get("origin_choices") or {}

    # ---- ability scores
    def _ab_points(v): return isinstance(v, dict) and v and all(a in ABILS and isinstance(n, int) for a, n in v.items())
    sc = dict(pc["abilities"])
    keep = bool(pc.get("keep_species_ability_increases"))
    bg_gives = bool(bg.get("ability_score_increases")) or any(c.get("kind") == "ability-points" for c in bg.get("choices", []) or [])
    apply_species = (str(race.get("edition")) == "2024") or (not bg_gives) or keep
    if apply_species:
        for rsrc_ in [race, vault.get(pc.get("subrace") or "")]:   # species and subrace (Hill Dwarf, High Elf...) fixed increases
            for inc in (rsrc_.get("ability_score_increases", []) if isinstance(rsrc_, dict) else []) or []:
                if isinstance(inc, dict) and inc.get("ability") in sc and "amount" in inc and "choose" not in inc: sc[inc["ability"]] += inc["amount"]
        for k, v in oc.items():
            if k.startswith("race:") and _ab_points(v):
                for a, n in v.items(): sc[a] += n
    for k, v in oc.items():
        if bg_gives and k.startswith("background:") and _ab_points(v):   # an ability-points choice, whatever its id (…:asi, …:abilities)
            for a, n in v.items(): sc[a] += n
    for c in pc["class"]:
        for lv, ch in (c.get("choices") or {}).items():
            if int(lv) <= c["level"] and isinstance(ch, dict):
                for k_, v_ in ch.items():   # ability-points picks of the ASI feat or any feat taken in a class slot
                    if str(k_).startswith("feat:") and _ab_points(v_):
                        for a, n in v_.items(): sc[a] = min(20, sc[a] + n)
                fref = ch.get("feat")       # a feat with one fixed ability (grants_asi) and no ability-points choice
                if isinstance(fref, str) and fref:
                    fd = vault.get(fref); ga = fd.get("grants_asi") if isinstance(fd, dict) else None
                    if isinstance(ga, dict) and isinstance(ga.get("pool"), list) and len(ga["pool"]) == 1 and ga["pool"][0] in sc \
                       and not any(x.get("kind") == "ability-points" for x in fd.get("choices") or [] if isinstance(x, dict)):
                        sc[ga["pool"][0]] = min(20, sc[ga["pool"][0]] + int(ga.get("amount", 1)))
    # a stored override wins
    for a, v in ((pc.get("overrides") or {}).get("abilities") or {}).items():
        if isinstance(v, (int, float)): sc[a] = int(v)
    m = {a: mod(sc[a]) for a in ABILS}

    tmpl = template or ("classic" if classic else "tabbed"); pips = tmpl in ("pips", "current"); classic = tmpl == "classic"
    out = {"statblock": True, "atlas-template": {"classic": CLASSIC_TEMPLATE_ID, "pips": PIPS_TEMPLATE_ID, "current": NEW_TEMPLATE_ID}.get(tmpl, TEMPLATE_ID), "name": pc["name"], "level": level_total}
    out["species"] = race.get("name", name_from_slug(slug_of(pc.get("race", ""))))
    out["background"] = bg.get("name", "")
    out["class"] = " / ".join(c.get("name") or name_from_slug(slug_of(pcc["name"])) for (c, pcc) in classes)
    subs = [vault.get(pcc.get("subclass")).get("name") for (_, pcc) in classes if pcc.get("subclass")]
    out["subclass"] = " / ".join(s for s in subs if s)
    out["size"] = str(race.get("size", "medium")).title()
    out["pb"] = pb
    # bio fields: Archivist has no place for most of them, so they are read from the character note's own
    # properties (alignment/age also from the sheet); whatever is set there wins over the Atlas note on update
    bio = {k: pc[k] for k in ("alignment", "age") if pc.get(k)}
    bio.update(pc.get("_bio") or {})
    if bio.get("backstory") and not bio.get("description"): bio["description"] = bio.pop("backstory")
    extra_p = [f"{lab}: {bio.pop(k)}" for k, lab in (("ideals", "Ideals"), ("bonds", "Bonds"), ("flaws", "Flaws")) if bio.get(k)]
    if extra_p: bio["personality"] = "\n\n".join(([str(bio["personality"])] if bio.get("personality") else []) + extra_p)
    for k, v in bio.items():
        if k in BIO_KEYS: out[k] = str(v).strip() if k != "description" else str(v).rstrip()
    out["_explicit"] = sorted(k for k in bio if k in BIO_KEYS)
    if pc.get("_portrait"):
        out["image"] = re.sub(r"^!?\[\[|\]\]$", "", str(pc["_portrait"])).split("|")[0]
    out["stats"] = [sc[a] for a in ABILS]

    # ---- hit points
    # computed like the Archivist sheet: average (or rolled) HP + Con per level + per-level bonuses
    def _hpb(o):
        n = 0
        if isinstance(o, dict):
            if o.get("kind") == "hp-per-level-bonus": n += int(o.get("value", 0) or 0)
            for v in o.values(): n += _hpb(v)
        elif isinstance(o, list):
            for v in o: n += _hpb(v)
        return n
    bonus = _hpb(race.get("traits")) + _hpb(bg.get("feature"))
    for k, v in oc.items():
        if isinstance(v, str) and ("feat" in k) and v:
            try: bonus += _hpb(vault.get(v).get("effects"))
            except Exception: pass
    for _c, _p in classes:
        for _lv, _ch in (_p.get("choices") or {}).items():
            if isinstance(_ch, dict) and _ch.get("feat") and int(_lv) <= _p["level"]:
                try: bonus += _hpb(vault.get(_ch["feat"]).get("effects"))
                except Exception: pass
    h = (pc.get("overrides") or {}).get("hp") or {}
    if h.get("rolled"): hp = int(h["rolled"]) + m["con"] * level_total
    else:
        hp = 0
        for i, (cdat, pcc) in enumerate(classes):
            die = int(str(cdat.get("hit_die", "d8")).lstrip("d"))
            for lv in range(1, pcc["level"] + 1):
                hp += (die if (i == 0 and lv == 1) else die // 2 + 1) + m["con"]
    hp += bonus * level_total
    st_max = ((pc.get("state") or {}).get("hp") or {}).get("max")
    if st_max and int(st_max) != hp: warn.append(f"HP computed as {hp} (the note's stored max was {st_max}, possibly stale); check against the Archivist sheet")
    out["hp"] = int(hp)
    dice = {}
    for cdat, pcc in classes: dice[cdat.get("hit_die", "d8")] = dice.get(cdat.get("hit_die", "d8"), 0) + pcc["level"]
    out["hit_dice"] = " + ".join(f"{n}{d}" for d, n in dice.items())
    used = ((pc.get("state") or {}).get("hit_dice") or {})
    if pips: out["heroic_inspiration"] = [{"name": "Inspiration", "max": 1, "used": 0 if (pc.get("state") or {}).get("inspiration") else 1}]
    out[HIT_DICE_KEYS[bool(classic)]] = [{"name": d, "max": n, "used": int((used.get(d) or {}).get("used", 0))} for d, n in dice.items()]

    # ---- effects chosen on species traits (select-inline options)
    chosen = []   # (trait, option)
    for t in race.get("traits", []) or []:
        for ch in t.get("choices", []) or []:
            if ch.get("kind") != "select-inline": continue
            val = oc.get(f"race:{ch['id']}")
            for o in ch.get("options", []) or []:
                if val is not None and o.get("value") == val:
                    mm = re.search(r"\((\d+)(?:st|nd|rd|th) level\)", t.get("name", ""))
                    if not mm or level_total >= int(mm.group(1)): chosen.append((t, o))
    effects = [e for _, o in chosen for e in (o.get("effects") or [])]
    for t in race.get("traits", []) or []: effects += t.get("effects") or []

    # ---- speed
    walk = (race.get("speed") or {}).get("walk", 30)
    modes = {k: v for k, v in (race.get("speed") or {}).items() if k not in ("walk", "hover") and v}
    for _t, o_ in chosen:   # a lineage option that only says "Your Speed increases to 35 feet" in its text (Wood Elf)
        if not any(e_.get("kind") == "speed-bonus" for e_ in (o_.get("effects") or [])):
            mm_ = re.search(r"(?i)\bspeed increases to (\d+) feet", str(o_.get("description") or ""))
            if mm_: walk = max(walk, int(mm_.group(1)))
    for e in effects:
        if e.get("kind") == "speed-bonus" and e.get("mode") in ("fly", "swim", "climb", "burrow"):
            modes[e["mode"]] = walk if e.get("equal_to") == "walk" else e.get("value", modes.get(e["mode"], 0))
        elif e.get("kind") == "speed-bonus" and e.get("mode") == "walk" and not e.get("condition"): walk = max(walk, e.get("value", 0)) if e.get("set") else walk + e.get("value", 0)
    if pips:   # the pips sheet's speed is a plain number (walking); other modes go to the Other actions list
        out["speed"] = int(walk)
        if modes: out["otheractions"] = [{"name": "Movement", "desc": ", ".join(f"{k.title()} {v} ft" for k, v in modes.items())}]
    else:
        out["speed"] = ", ".join([f"{walk} ft"] + [f"{k} {v} ft" for k, v in modes.items()])

    # ---- skills and saves
    prof, expert = set(), set()
    sk = pc.get("skills") or {}
    prof |= {s.replace("-", "_") for s in sk.get("proficient", []) or []}
    expert |= {s.replace("-", "_") for s in sk.get("expertise", []) or []}
    for s in bg.get("skill_proficiencies", []) or []: prof.add(str(s).replace("-", "_").replace(" ", "_").lower())
    for cdat, pcc in classes:
        for lv, ch in (pcc.get("choices") or {}).items():
            if int(lv) <= pcc["level"] and isinstance(ch, dict):
                for key, v in ch.items():
                    if key == "skills" and isinstance(v, list): prof |= {s.replace("-", "_") for s in v}
                    if re.search(r"expertise", str(key), re.I) and isinstance(v, (str, list)):   # Rogue/Bard/Ranger expertise picks (expertise, expertise-2, feat:expertise...)
                        expert |= {str(x).replace("-", "_") for x in ([v] if isinstance(v, str) else v) if isinstance(x, str) and not x.startswith("[[")}
                    if key.endswith("skill") and isinstance(v, (str, list)):
                        prof |= {s.replace("-", "_") for s in ([v] if isinstance(v, str) else v)}
    for k, v in oc.items():
        if re.search(r"expertise", k, re.I) and isinstance(v, (str, list)):
            expert |= {str(x).replace("-", "_") for x in ([v] if isinstance(v, str) else v) if isinstance(x, str)}
        if k.startswith(("race:", "background:")) and k.endswith("skill") and isinstance(v, (str, list)):
            prof |= {str(x).replace("-", "_") for x in ([v] if isinstance(v, str) else v)}
    for e in effects:
        if e.get("kind") == "proficiency" and e.get("proficiency_type") == "skill":
            prof.add(str(e["value"]).replace("-", "_"))
            if e.get("expertise"): expert.add(str(e["value"]).replace("-", "_"))
    prof |= expert   # expertise implies proficiency
    half = any(e.get("kind") == "half-proficiency" for e in effects) or any(
        e.get("kind") == "half-proficiency" for _c, _p in classes for f_ in ((_c.get("features_by_level") or {}).values()) for ft in (f_ if isinstance(f_, list) else []) for e in (ft.get("effects") or []))
    for k in SKILLS:
        lvl = "2" if k in expert else "1" if k in prof else ("half" if (half and pips) else None)
        if lvl: out[f"{k}_prof"] = PROF_SYMBOL[lvl] if pips else lvl
    saves = []
    for a in (first_cls.get("saving_throws") or []):
        saves.append({ABIL_FULL[a]: m[a] + pb})
    if saves: out["saves"] = saves
    pp = 10 + m["wis"] + (pb * (2 if "perception" in expert else 1) if ("perception" in prof or "perception" in expert) else 0)

    # ---- AC
    eq = pc.get("equipment") or []
    body = shield = None
    for it in eq:
        if it.get("equipped") and it.get("slot") == "armor": body = it
        if it.get("equipped") and it.get("slot") == "shield": shield = it
    ac = 10 + m["dex"]; acnote = []
    def _armor_note(it):   # a magic armor is an item note with base_item -> follow one hop to the real armor
        n = vault.get(it["item"])
        if not n.get("ac") and n.get("base_item"):
            bn = vault.get(n["base_item"])
            if bn.get("ac"): return bn, n
        return n, n
    def _needs_attune(n):
        at = n.get("attunement")
        return bool(at.get("required")) if isinstance(at, dict) else bool(at)
    if body:
        a, magic = _armor_note(body); sl = slug_of((magic.get("base_item") or body["item"])).split("armor_")[-1]
        if a.get("ac"):
            base = a["ac"].get("base", 10) + a["ac"].get("flat", 0); add = a["ac"].get("add_dex", False); cap = a["ac"].get("dex_max")
        elif sl in ARMOR_FALLBACK: base, add, cap = ARMOR_FALLBACK[sl]
        else: base, add, cap = 10, True, None; warn.append(f"armor {sl} not found; AC may be wrong")
        ac = base + ((min(m["dex"], cap) if cap is not None else m["dex"]) if add else 0)
    # unarmored formulas: Barbarian/Monk plus any `unarmored-ac` effect (only while no body armor)
    if not body:
        for cdat, pcc in classes:
            cn = str(cdat.get("name", "")).lower()
            alt = {"barbarian": "con", "monk": "wis"}.get(cn)
            if alt and (cn == "barbarian" or not shield):
                ac = max(ac, 10 + m["dex"] + m[alt])
        for e in effects:
            if e.get("kind") == "unarmored-ac":
                ac = max(ac, (e.get("base") if e.get("base") is not None else 10) + sum(m[x] for x in e.get("abilities", []) if x in m))
    if shield:
        s_, _ = _armor_note(shield); ac += (s_.get("ac") or {}).get("base", 2)
    # +N on the worn armor / shield, item bonuses (+1 armor, Ring of Protection...), item effects
    for it in (body, shield):
        if it: ac += int((it.get("overrides") or {}).get("ac_bonus") or 0)
    for it in eq:
        if not it.get("equipped"): continue
        n = vault.get(it["item"])
        if not n or (_needs_attune(n) and not it.get("attuned")): continue
        bn = (n.get("bonuses") or {}).get("ac")
        if isinstance(bn, dict):
            ok = True
            for w in bn.get("when") or []:
                k = w.get("kind")
                if k == "no_armor" and body: ok = False
                elif k == "no_shield" and shield: ok = False
                elif k not in ("no_armor", "no_shield"): ok = False
            bn = bn.get("value", 0) if ok else 0
        ac += int(bn or 0)
        for e in n.get("effects") or []:
            if e.get("kind") == "ac-bonus" and (not e.get("requires_armor") or body): ac += e.get("value", 0)
    for e in effects:
        if e.get("kind") == "ac-bonus" and (not e.get("requires_armor") or body): ac += e.get("value", 0)
    out["ac"] = ac
    out["initiative"] = m["dex"]
    protector = False
    for cdat, pcc in classes:   # 2024 Cleric Divine Order: Protector grants martial weapons and heavy armor
        for lv, ch in (pcc.get("choices") or {}).items():
            if isinstance(ch, dict) and str(ch.get("divine-order", "")).lower() == "protector" and int(lv) <= pcc["level"]:
                protector = True

    # ---- senses, languages, defenses, proficiencies
    def passive(skill, ab):
        return 10 + m[ab] + (pb * (2 if skill in expert else 1) if (skill in prof or skill in expert) else 0)
    sens = [] if pips else [f"Passive Perception {pp}"]
    if pips: out["passive_perception"], out["passive_investigation"], out["passive_insight"] = pp, passive("investigation", "int"), passive("insight", "wis")
    dv = (race.get("vision") or {}).get("darkvision")
    for _t, o_ in chosen:   # Drow: "The range of your Darkvision increases to 120 feet"
        mm_ = re.search(r"(?i)darkvision increases to (\d+) feet", str(o_.get("description") or ""))
        if mm_ and (not dv or int(mm_.group(1)) > int(dv)): dv = int(mm_.group(1))
    sens_pre = list(sens)
    senses_ = {"darkvision": int(dv)} if dv else {}
    for e in effects:   # sense effects: the largest range per sense wins (never a sum)
        if e.get("kind") == "sense":
            t_ = str(e.get("type") or e.get("sense") or "").lower(); r_ = int(e.get("range") or 0)
            if t_ and r_ > senses_.get(t_, 0): senses_[t_] = r_
    sens += [f"{t_.title()} {r_} ft" for t_, r_ in senses_.items()]
    if sens: out["senses"] = ", ".join(sens)
    langs = [str(x).title() for x in (race.get("languages") or {}).get("fixed", []) or []]
    for k, v in oc.items():
        if k.startswith("background:languages") or (k.startswith("race:") and "language" in k):
            langs += [str(x).title() for x in (v if isinstance(v, list) else [v])]
    for _c, pcc_ in classes:   # a language a feat lets you pick (Prodigy)
        for lv_, ch_ in (pcc_.get("choices") or {}).items():
            if isinstance(ch_, dict) and int(lv_) <= pcc_["level"]:
                for k_, v_ in ch_.items():
                    if str(k_).startswith("feat:") and re.search(r"language", k_) and isinstance(v_, (str, list)):
                        langs += [str(x).replace("-", " ").title() for x in ([v_] if isinstance(v_, str) else v_)]
    langs += [str(x).replace("-", " ").title() for x in (((pc.get("overrides") or {}).get("languages") or {}).get("add") or [])]
    out["languages"] = ", ".join(dict.fromkeys(langs))
    res = [e["damage_type"].title() for e in effects if e.get("kind") == "resistance"]
    if res: out["damage_resistances"] = ", ".join(res)
    pr = first_cls.get("proficiencies") or {}
    arm = [str(x).title() for x in pr.get("armor", []) or []]
    for e in effects:
        if e.get("kind") == "proficiency" and e.get("proficiency_type") == "armor": arm.append(str(e["value"]).title())
    wp = (pr.get("weapons") or {}).get("categories", []) or []
    if protector:
        arm.append("Heavy"); wp = list(wp) + ["martial"]
    if arm: out["armor_training"] = ", ".join(dict.fromkeys(arm))
    wprof = {str(x).lower() for x in wp}
    wrules = []   # property rules such as the Rogue's "Martial weapons that have the Finesse or Light property"
    wfixed = [str(x) for x in ((pr.get("weapons") or {}).get("fixed") or []) if isinstance(x, str)]
    for ph in wfixed:
        mm = re.search(r"(?i)\b(simple|martial)\b.*?\b(?:have|has|with)\b.*?\bthe\s+(.+?)\s+propert", ph)
        if mm: wrules.append((mm.group(1).lower(), {x.strip().lower() for x in re.split(r"\s+or\s+|,|\s+and\s+", mm.group(2)) if x.strip()}))
        elif re.fullmatch(r"(?i)\s*(simple|martial)( weapons?)?\s*", ph): wprof.add(ph.split()[0].lower())
        else: wprof.add(ph.strip().lower()); wprof.add(re.sub(r"s$", "", ph.strip().lower()))
    if wp or wfixed: out["weapon_proficiencies"] = ", ".join([str(x).title() for x in wp] + wfixed)
    tools = []
    for t in bg.get("tool_proficiencies", []) or []:
        if isinstance(t, dict): tools += [str(x) for x in t.get("items", []) or []]
    for k, v in oc.items():
        if re.match(r"background:tool", k) or (k.startswith("race:") and "tool" in k):
            tools += [name_from_slug(slug_of(str(x))) if "_" in str(x) else str(x).replace("-", " ").title().replace("'S", "'s") for x in (v if isinstance(v, list) else [v])]
    for cdat, pcc in classes:
        for lv, ch in (pcc.get("choices") or {}).items():
            if int(lv) <= pcc["level"] and isinstance(ch, dict):
                for key, v in ch.items():
                    if re.search(r"(^|-)tools?($|-)", key) and isinstance(v, (str, list)):
                        tools += [str(x).replace("-", " ").title().replace("'S", "'s") for x in ([v] if isinstance(v, str) else v)]
    tools = [re.sub(r"\b([a-z])", lambda mm: mm.group(1).upper(), t.replace("-", " ")) if re.fullmatch(r"[a-z' -]+", t) else t for t in tools]
    tools = [t.replace("'S", "'s") for t in tools]
    tools = list(dict.fromkeys(tools))
    if tools: out["tool_proficiencies"] = ", ".join(tools)

    # ---- features, traits, feats
    lim = short or 0
    def feat_entries(feats_by_level, upto):
        got = {}
        for lv in sorted(feats_by_level, key=lambda x: int(x)):
            if int(lv) > upto: continue
            for f in feats_by_level[lv] or []:
                if not f.get("name"): continue
                d = clean(first_text(f), lim)
                got[f.get("id") or f["name"]] = {"name": f["name"], "desc": d, "_act": f.get("action") or f.get("action_cost")} if d else None
        return [v for v in got.values() if v]
    cf = []; pool_docs = []
    for cdat, pcc in classes:
        _start = len(cf)
        cf += feat_entries(cdat.get("features_by_level") or {}, pcc["level"])
        if pcc.get("subclass"):
            sub = vault.get(pcc["subclass"])
            cf += feat_entries(sub.get("features_by_level") or {}, pcc["level"])
        # features that scale by a class table column ("as shown in the Sneak Attack column..."): print today's value
        cols_ = ((cdat.get("table") or {}).get(str(pcc["level"])) or {}).get("columns") or {}
        for f_ in cf[_start:]:
            seen_ = []
            for cn in re.findall(r"(?:in|of) the ([A-Z][A-Za-z' ]+?) column", f_["desc"]):
                cn = cn.strip()
                if cn in seen_ or cn in ("Cantrips", "Prepared Spells", "Spells Known", "Invocations", "Spell Slots", "Slot Level") or cn not in cols_: continue
                seen_.append(cn)
            if seen_: f_["desc"] = f_["desc"].rstrip() + "\n\nAt level " + str(pcc["level"]) + ": " + "; ".join(f"{c_} {cols_[c_]}" for c_ in seen_)
    cf = [f for f in cf if not re.fullmatch(r"(?i)ability score improvement|subclass.*|epic boon", f["name"]) ]
    # class selection-pool picks (infusions, invocations, metamagic...): list the chosen optional features
    for cdat, pcc in classes:
        pools = {p_.get("id"): p_ for p_ in (cdat.get("selection_pools") or []) if isinstance(p_, dict)}
        for lv, ch in (pcc.get("choices") or {}).items():
            if not isinstance(ch, dict) or int(lv) > pcc["level"]: continue
            for pid, picks in ch.items():
                if pid not in pools or not isinstance(picks, list): continue
                for pk in picks:
                    try: od = vault.get(f"[[{pk}]]", "optional-feature")
                    except Exception: od = None
                    if not od or not od.get("name"): continue
                    pool_docs.append(od)
                    cf.append({"name": f"{pools[pid].get('label', pid)}: {od['name']}".replace("Artificer Infusions: ", "Infusion: "), "desc": clean(first_text(od) or od.get("description", ""), lim)})
    out["class_features"] = cf
    ba, rx = [], []
    for f in cf:
        head = f.get("full", f["desc"])[:300]; act = f.pop("_act", None)
        if act == "bonus-action" or (not act and re.search(r"(?i)\b(as|use|take|with|spend) (a|your) Bonus Action\b|\b(como|usa|usar|con|gasta|gastar|mediante) (una|tu) acci[oó]n adicional\b", head)): ba.append({"name": f["name"], "desc": f["desc"]})
        elif act == "reaction" or (not act and re.search(r"(?i)\b(as|use|take|with|spend) (a|your) Reaction\b|\bwhen .{0,80}you can use your Reaction|\b(como|usa|usar|con|gasta|gastar|mediante) (una|tu) reacci[oó]n\b", head)): rx.append({"name": f["name"], "desc": f["desc"]})
    if ba: out["bonus_actions"] = ba
    if rx: out["reactions"] = rx
    st = []
    for t in race.get("traits", []) or []:
        if t.get("name") in ("Size", "Speed", "Darkvision"): continue
        d = first_text(t); picked = [o for tt, o in chosen if tt is t]
        if picked:
            for o in picked: st.append({"name": f"{t['name'].split(' (')[0]}: {o['label']}", "desc": clean(o.get("description", ""), lim)})
        elif not t.get("choices"):
            if d: st.append({"name": t["name"], "desc": clean(d, lim)})
    out["species_traits"] = st
    feats = []
    bg_feat = bg.get("origin_feat")
    feat_docs = []
    def feat_text(f):   # a feat's intro line plus its `benefits` bullets (Alert: "You gain the following benefits." + the two benefits)
        t = first_text(f); ben = []
        for b in f.get("benefits") or []:
            if isinstance(b, str): ben.append(b.strip())
            elif isinstance(b, dict):
                nm_, ds_ = str(b.get("name") or "").strip(), str(b.get("description") or b.get("desc") or "").strip()
                ben.append((f"**{nm_}.** " if nm_ else "") + ds_)
        ben = [b for b in ben if b]
        return (t + ("\n\n" if t and ben else "") + "\n".join("- " + b for b in ben)).strip()
    def feat_entry(ref, extra=""):
        f = vault.get(ref, "feat"); feat_docs.append(f)
        nm = f.get("name") or name_from_slug(slug_of(ref))
        return {"name": nm + (f" ({extra})" if extra else ""), "desc": clean(feat_text(f), lim)}
    if bg_feat:
        extra = ""
        if oc.get("background:feat:spell-list"):
            sp = [name_from_slug(slug_of(x)) for x in (oc.get("background:feat:mi-cantrips") or [])]
            l1 = oc.get("background:feat:mi-level1")
            extra = f"{str(oc['background:feat:spell-list']).title()}: " + ", ".join(sp + ([name_from_slug(slug_of(l1))] if l1 else []))
        feats.append(feat_entry(bg_feat, extra))
    for cdat, pcc in classes:
        for lv, ch in sorted((pcc.get("choices") or {}).items(), key=lambda kv: int(kv[0])):
            if int(lv) <= pcc["level"] and isinstance(ch, dict) and ch.get("feat"):
                extra = ""
                if isinstance(ch.get("feat:asi"), dict): extra = ", ".join(f"+{n} {a.title()}" for a, n in ch["feat:asi"].items())
                bits_ = [extra] if extra else []
                for k_, v_ in ch.items():   # the feat's other picks (Elemental Adept's damage type, Keen Mind's skill...); spells and abilities are shown elsewhere
                    if str(k_).startswith("feat:") and k_ != "feat:asi" and not re.search(r"cantrip|spell|level\d|ability|list|mode$", k_):
                        bits_ += [str(x).replace("-", " ").title() for x in ([v_] if isinstance(v_, str) else v_ if isinstance(v_, list) else []) if isinstance(x, str) and "_" not in x]
                extra = ", ".join(bits_)
                feats.append(feat_entry(ch["feat"], extra))
    for k, v in oc.items():
        if k.startswith("race:") and "feat" in k and isinstance(v, str) and v: feats.append(feat_entry(v, ""))
    out["feats"] = feats
    # initiative = Dex modifier + every initiative-bonus effect (Alert: your Proficiency Bonus, ...)
    def _amt(e):
        if e.get("value") is not None:
            try: return int(e["value"])
            except Exception: return 0
        a = str(e.get("amount") or "").strip().lower()
        if not a: return 0
        a = re.sub(r"\{prof\}|\byour proficiency bonus\b|\bproficiency bonus\b", str(pb), a)
        a = re.sub(r"\{(str|dex|con|int|wis|cha)_mod\}", lambda mm: str(m[mm.group(1)]), a)
        for ab_, full_ in ABIL_FULL.items(): a = re.sub(rf"\byour {full_.lower()} modifier\b", str(m[ab_]), a)
        a = re.sub(r"\bhalf (\d+)\b", lambda mm: str(int(mm.group(1)) // 2), a)
        return int(eval(a, {"__builtins__": {}}, {})) if re.fullmatch(r"[\d\s+\-*/().]+", a) else 0
    init_effs = [e for e in effects if isinstance(e, dict)]
    for f_ in feat_docs: init_effs += [e for e in (f_.get("effects") or []) if isinstance(e, dict)]
    for cdat, pcc in classes:
        for src_ in [cdat, vault.get(pcc.get("subclass"))]:
            for lv_, fl_ in ((src_.get("features_by_level") or {}).items() if isinstance(src_, dict) else []):
                if str(lv_).isdigit() and int(lv_) <= pcc["level"]:
                    for ft_ in (fl_ or []):
                        if isinstance(ft_, dict) and not ft_.get("activatable"): init_effs += [e for e in (ft_.get("effects") or []) if isinstance(e, dict)]
    for it_ in eq:   # worn magic items (attuned when they need it)
        if not it_.get("equipped"): continue
        n_ = vault.get(it_["item"])
        if n_ and (not _needs_attune(n_) or it_.get("attuned")): init_effs += [e for e in (n_.get("effects") or []) if isinstance(e, dict)]
    init_bonus = 0
    for e in init_effs:
        if e.get("kind") == "initiative-bonus" and str(e.get("subject") or "self") == "self":
            try: init_bonus += _amt(e)
            except Exception: pass
    out["initiative"] = m["dex"] + init_bonus
    # senses from feats (Skulker: Blindsight), invocations (Devil's Sight), class features and worn items
    named_s = {}   # a sense an invocation/option grants keeps its own name: Devil's Sight is not plain Darkvision (it also sees through magical darkness)
    for d_ in pool_docs:
        for e_ in (d_.get("effects") or []):
            if isinstance(e_, dict) and e_.get("kind") == "sense" and str(e_.get("subject") or "self") == "self" and d_.get("name"):
                named_s[d_["name"]] = max(named_s.get(d_["name"], 0), int(e_.get("range") or 0))
    for e in init_effs:
        if isinstance(e, dict) and e.get("kind") == "sense" and str(e.get("subject") or "self") == "self":
            t_ = str(e.get("type") or e.get("sense") or "").lower(); r_ = int(e.get("range") or 0)
            if t_ and r_ > senses_.get(t_, 0): senses_[t_] = r_
    for d_ in feat_docs + pool_docs:   # a feat that only states its sense in text ("You have Blindsight with a range of 10 feet")
        if any(isinstance(e_, dict) and e_.get("kind") == "sense" for e_ in (d_.get("effects") or [])): continue
        for mm_ in re.finditer(r"(?i)\b(blindsight|darkvision|tremorsense|truesight)\b[^.]{0,40}?\brange of (\d+) feet", feat_text(d_) if "benefits" in d_ else first_text(d_)):
            t_, r_ = mm_.group(1).lower(), int(mm_.group(2))
            if r_ > senses_.get(t_, 0): senses_[t_] = r_
    _all_s = sens_pre + [f"{t_.title()} {r_} ft" for t_, r_ in senses_.items()] + [f"{n_} {r_} ft" for n_, r_ in named_s.items() if r_]
    if _all_s: out["senses"] = ", ".join(_all_s)

    # ---- spells
    spells = {}   # slug -> dict(level, prepared)
    def add(ref, prepared=None, always=False):
        sl = slug_of(ref); cur = spells.setdefault(sl, {"prepared": False, "always": False})
        if prepared: cur["prepared"] = True
        if always: cur["always"] = True
    for s in (pc.get("spells") or {}).get("known", []) or []:
        add(s["spell"], prepared=s.get("prepared"))
    for k, v in oc.items():
        if re.search(r"mi-cantrips|mi-level1|spell", k) and "list" not in k and "ability" not in k:
            for x in (v if isinstance(v, list) else [v]): add(x, prepared=True)
    for cdat, pcc in classes:   # spells picked through a feat taken in a class slot (Druidic Warrior, Magic Initiate...)
        for lv, ch in (pcc.get("choices") or {}).items():
            if isinstance(ch, dict) and int(lv) <= pcc["level"]:
                for k, v in ch.items():
                    if (str(k).startswith("feat:") or any(str(k).startswith(str(pl_.get("id")) + ":") for pl_ in (cdat.get("selection_pools") or []) if isinstance(pl_, dict))) and re.search(r"cantrip|spell|level\d", k) and "list" not in k and "ability" not in k:
                        for x in (v if isinstance(v, list) else [v]):
                            if isinstance(x, str): add(x, prepared=True)
    adds = []
    def _fixed_names(x):   # plain spell names of an additional_spells block; {choose} rows are Builder picks
        if isinstance(x, str): return [] if "=" in x else [x.title()]
        if isinstance(x, list): return [n for y in x for n in _fixed_names(y)]
        if isinstance(x, dict) and "choose" not in x: return [n for y in x.values() for n in _fixed_names(y)]
        return []
    for fd_ in feat_docs:   # Fey-Touched's Misty Step, Shadow-Touched's Invisibility...
        for ent_ in (fd_.get("additional_spells") or []) if isinstance(fd_, dict) and isinstance(fd_.get("additional_spells"), list) else []:
            for key_ in ("known", "prepared", "innate"):
                blk_ = ent_.get(key_) if isinstance(ent_, dict) else None
                for lv_, nm_ in (blk_.items() if isinstance(blk_, dict) else []):
                    if lv_ != "_" and (not str(lv_).isdigit() or int(lv_) > level_total): continue
                    adds += _fixed_names(nm_)
    for cdat, pcc in classes:
        for src in [cdat, vault.get(pcc.get("subclass"))]:
            for entry in (src.get("additional_spells") or []) if isinstance(src.get("additional_spells"), list) else []:
                for key in ("known", "prepared", "innate"):   # Ranger's Hunter's Mark and domain/oath spells are under `prepared`
                    blk = entry.get(key)
                    for lv, names in (blk.items() if isinstance(blk, dict) else []):
                        if str(lv) != "_" and not str(lv).isdigit(): continue
                        if str(lv).isdigit() and int(lv) > pcc["level"]: continue
                        adds += [n for n in (names if isinstance(names, list) else [names]) if isinstance(n, str)]
    # species (and subspecies) additional_spells: the entry named like the chosen lineage, else the only/unnamed one
    def _flat(x):
        if isinstance(x, str): return [x]
        if isinstance(x, list): return [n for y in x for n in _flat(y)]
        if isinstance(x, dict): return [n for y in x.values() for n in _flat(y)]
        return []
    picks = {str(v).lower().replace(" ", "-") for k, v in oc.items() if str(k).startswith("race:") and isinstance(v, str)}
    for rsrc in [race, vault.get((pc.get("subrace") or ""))]:
        ents = rsrc.get("additional_spells") if isinstance(rsrc, dict) else None
        ents = [ents] if isinstance(ents, dict) else (ents or [])
        named = [e for e in ents if str(e.get("name", "")).lower().replace(" ", "-") in picks]
        for entry in (named or [e for e in ents if not e.get("name")] or (ents if len(ents) == 1 else [])):
            for key in ("known", "prepared", "innate"):
                for lv, names in (entry.get(key) or {}).items() if isinstance(entry.get(key), dict) else []:
                    if lv != "_" and (not str(lv).isdigit() or int(lv) > level_total): continue
                    adds += _flat(names)
    for n in adds:
        sl_ = re.sub(r"[^a-z0-9]+", "-", re.sub(r"['’]", "", n.lower())).strip("-")
        have_ = next((k for k in spells if k == sl_ or k.endswith("_spell_" + sl_) or k.endswith("_spell_" + sl_ + "-es")), None)   # the same spell already picked under its full slug
        if have_: spells[have_]["prepared"] = True; spells[have_]["always"] = True
        else: spells[sl_] = {"prepared": True, "always": True, "name": n}
    info = {}
    for sl, st_ in spells.items():
        d = vault.get(sl)
        info[sl] = d or {}
    def spell_entry(sl):
        d = info[sl]; e = {"name": spell_label(d, d.get("name") or spells[sl].get("name") or name_from_slug(sl))}
        if d.get("range"): e["range"] = re.sub(r"^S:(.*)$", r"Self (\1)", str(d["range"]).replace("feet", "ft").replace(" ft.", " ft"))
        ct = str(d.get("casting_time", "")).lower()
        if ct:
            ct = re.sub(r"(\d+)\s*minutes?", r"\1 min", ct); ct = re.sub(r"(\d+)\s*hours?", r"\1 h", ct)
            e["cost"] = {"1 action": "1 a", "1 bonus action": "1 ba", "1 reaction": "1 r", "action": "1 a", "act": "1 a", "bonus-action": "1 ba", "reaction": "1 r", "react": "1 r"}.get(ct, ct)
        dur = str(d.get("duration", "")); 
        if dur:
            dur = re.sub(r"(?i)^instantaneous$", "Inst", dur).replace("minutes", "min").replace("minute", "min").replace("hours", "h").replace("hour", "h")
            e["duration"] = ("C, " + dur) if d.get("concentration") else dur
        if d.get("damage_roll"): e["damage"] = str(d["damage_roll"])
        types = (d.get("damage") or {}).get("types") or []
        e["type"] = types[0].title() if types else SCHOOL.get(str(d.get("school", "")).lower(), "")
        e["desc"] = clean(first_text(d), short or 0)
        if LINK_SPELLS and d.get("_file"):
            e["desc"] = spell_mechanics(d)
            ah = d.get("at_higher_levels"); ah = " ".join(map(str, ah)) if isinstance(ah, list) else (str(ah) if ah else "")
            if ah: e["upcast"] = re.sub(r"\s+", " ", clean(ah, 0))[:300]
            return {k: v for k, v in e.items() if v not in ("", None)}
        if not short and d.get("at_higher_levels"):
            ah = d["at_higher_levels"]; ah = " ".join(map(str, ah)) if isinstance(ah, list) else str(ah)
            ahc = clean(ah, 0); mm = re.search(r"\n\n(?:Fuente|Source): [^\n]*$", e["desc"])
            e["desc"] = (e["desc"][:mm.start()] + "\n\n" + ahc + e["desc"][mm.start():]) if mm else (e["desc"] + "\n\n" + ahc).strip()
        return {k: v for k, v in e.items() if v not in ("", None)}
    cant, tabs = [], {}
    prepared_counters = []
    for sl, s_ in spells.items():
        d = info[sl]; lv = d.get("level", None)
        if lv is None: continue
        if int(lv) == 0: cant.append(spell_entry(sl))
        else:
            on = s_["prepared"] or s_["always"]
            prepared_counters.append({"name": spell_label(d, d.get("name") or name_from_slug(sl)) + (" (R)" if d.get("ritual") else ""), "max": 1, "used": 0 if on else 1})
            if on: tabs.setdefault(int(lv), []).append(spell_entry(sl))
    unresolved = [name_from_slug(sl) if "_spell_" in sl else sl.replace("-", " ").title() for sl in spells if info[sl].get("level") is None]
    book = {}
    for sl, s_ in spells.items():
        d = info[sl]
        if d.get("level") is not None: book.setdefault(int(d["level"]), []).append(spell_entry(sl))
    if any("agonizing-blast" in str(pk_) for _c, pcc_ in classes for ch_ in (pcc_.get("choices") or {}).values() if isinstance(ch_, dict) for v_ in ch_.values() if isinstance(v_, list) for pk_ in v_):
        for e_ in cant:   # Agonizing Blast: Eldritch Blast adds the Charisma modifier to its damage
            if "eldritch-blast" in str(e_.get("name", "")) and e_.get("damage") and "@cha.mod" not in str(e_["damage"]): e_["damage"] = f"{e_['damage']}+@cha.mod"
    if cant: out["spellcasting"] = cant
    if not classic and not pips:   # the pips sheet has no all-spells (spellbook) tabs
        for lv, lst in sorted(book.items()):
            out[f"spellbook_{lv}"] = sorted(lst, key=lambda e: e["name"])
    for lv, lst in sorted(tabs.items()): out[f"tab_{lv + 1}"] = lst
    if prepared_counters and PREPARED_TRACKER: out["prepared_spells"] = prepared_counters
    sc_ab = None
    for cdat, pcc in classes:
        sp = cdat.get("spellcasting") or (vault.get(pcc.get("subclass")).get("spellcasting"))
        if sp and sp.get("ability"): sc_ab = sp["ability"]; break
    if not sc_ab:
        sc_ab = (oc.get("background:feat:spellcasting-ability"))
    if not sc_ab:   # a non-caster with species/feat spells (Wood Elf Rogue): use the ability picked for them
        for k_, v_ in list(oc.items()) + [(k2, v2) for _c, pc_ in classes for ch_ in (pc_.get("choices") or {}).values() if isinstance(ch_, dict) for k2, v2 in ch_.items()]:
            if str(k_).endswith("spellcasting-ability") and v_ in ABILS: sc_ab = v_; break
    # spells a feat grants cast with the ability that feat raised (Fey-Touched, Shadow-Touched...), which can differ from the class's
    feat_ab = {}   # spell slug -> ability
    for cdat, pcc in classes:
        for lv_, ch_ in (pcc.get("choices") or {}).items():
            if not (isinstance(ch_, dict) and int(lv_) <= pcc["level"] and isinstance(ch_.get("feat"), str)): continue
            fd_ = vault.get(ch_["feat"]); ents_ = fd_.get("additional_spells") if isinstance(fd_, dict) else None
            if not isinstance(ents_, list) or not ents_: continue
            ab_ = next((v for k, v in ch_.items() if str(k).endswith("spellcasting-ability") and v in ABILS), None)
            if not ab_:
                pts_ = ch_.get("feat:asi")
                if _ab_points(pts_): ab_ = max(pts_, key=lambda a: pts_[a])
                elif isinstance(ents_[0], dict) and ents_[0].get("ability") in ABILS: ab_ = ents_[0]["ability"]
            if not ab_: continue
            for k, v in ch_.items():
                if str(k).startswith("feat:") and re.search(r"cantrip|spell|level\d", k) and "list" not in k and "ability" not in k:
                    for x in (v if isinstance(v, list) else [v]):
                        if isinstance(x, str): feat_ab[slug_of(x)] = ab_
            for e_ in ents_:
                for key_ in ("known", "prepared", "innate"):
                    for nm_ in _fixed_names(e_.get(key_) or {}) if isinstance(e_, dict) else []:
                        sl2 = re.sub(r"[^a-z0-9]+", "-", re.sub(r"['’]", "", nm_.lower())).strip("-")
                        for sk in spells:
                            if sk == sl2 or sk.endswith("_spell_" + sl2): feat_ab[sk] = ab_
    if not sc_ab and feat_ab: sc_ab = next(iter(feat_ab.values()))
    if feat_ab:
        lab_ = {spell_label(info[sl].get("name") and info[sl] or {}, info[sl].get("name") or name_from_slug(sl)): a_ for sl, a_ in feat_ab.items() if sl in info}
        def _tag(e_):
            a_ = lab_.get(e_.get("name"))
            if a_ and a_ != sc_ab:
                e_["desc"] = ((e_.get("desc") or "") + f"\n\nCast with {ABIL_FULL[a_].title()}: save DC {8 + pb + m[a_]}, spell attack {signed(pb + m[a_])}").strip()
        for e_ in cant: _tag(e_)
        for lst_ in list(tabs.values()) + list(book.values()):
            for e_ in lst_: _tag(e_)
    if sc_ab and (cant or tabs or prepared_counters):
        out["spellcasting_ability"] = ABIL_FULL[sc_ab].title()[:3] if pips else ABIL_FULL[sc_ab].title()
        out["spell_save_dc"] = f"8+@{sc_ab}.mod+@pb"
        out["spell_attack_bonus"] = f"@{sc_ab}.mod+@pb"
    # slots
    clevel = 0; casters = 0; slots = None; pact = None
    st_used = (pc.get("state") or {}).get("spell_slots") or {}
    PACT = {1: (1, 1), 2: (2, 1), 3: (2, 2), 4: (2, 2), 5: (2, 3), 6: (2, 3), 7: (2, 4), 8: (2, 4), 9: (2, 5), 10: (2, 5), 11: (3, 5), 12: (3, 5), 13: (3, 5), 14: (3, 5), 15: (3, 5), 16: (3, 5), 17: (4, 5), 18: (4, 5), 19: (4, 5), 20: (4, 5)}
    def _num(x):
        mm_ = re.match(r"\d+", str(x)); return int(mm_.group(0)) if mm_ else 0
    for cdat, pcc in classes:
        ct = (cdat.get("spellcasting") or {}).get("caster_type")
        lv = pcc["level"]
        cols = ((cdat.get("table") or {}).get(str(lv)) or {}).get("columns") or {}
        if ct == "pact":
            n_, lvl_ = _num(cols.get("Spell Slots")), _num(cols.get("Slot Level"))
            if not (n_ and lvl_): n_, lvl_ = PACT[min(20, lv)]
            pact = (n_, lvl_)
        elif ct in ("full", "half", "half-up", "third"):
            casters += 1
            own = {_num(k): _num(v) for k, v in cols.items() if re.fullmatch(r"\d+(st|nd|rd|th)", str(k))}
            if own and max(own.values()) > 0: slots = [own.get(i, 0) for i in range(1, max(k for k, v in own.items() if v) + 1)]
            if ct == "full": clevel += lv
            elif ct == "half": clevel += lv // 2
            elif ct == "half-up": clevel += math.ceil(lv / 2)
            elif ct == "third": clevel += lv // 3
    if casters > 1 or slots is None: slots = FULL_SLOTS[min(20, clevel)] if clevel else None   # multiclass: the combined table
    if slots:
        out["slots"] = [{"name": f"Level {i + 1}", "max": n, "used": int((st_used.get(str(i + 1)) or st_used.get(i + 1) or {}).get("used", 0)) if isinstance(st_used.get(str(i + 1)) or st_used.get(i + 1), dict) else 0} for i, n in enumerate(slots) if n]
    if pact:
        pu = st_used.get("pact") if isinstance(st_used.get("pact"), dict) else {}
        out["slots"] = list(out.get("slots") or []) + [{"name": f"Pact Magic (Level {pact[1]})", "max": pact[0], "used": int(pu.get("used", 0))}]

    # ---- attacks and equipment
    acts, eqs, attuned = [], [], []
    wm = []
    for cdat, pcc in classes:
        for lv, ch in (pcc.get("choices") or {}).items():
            if int(lv) <= pcc["level"] and isinstance(ch, dict) and isinstance(ch.get("weapon-mastery"), list):
                for ref in ch["weapon-mastery"]:
                    wd = vault.get(ref); mk = (wd.get("mastery") or [None])[0]
                    nm_ = wd.get("name") or name_from_slug(slug_of(ref))
                    mname = str(mk).title() if mk else ""
                    ent_ = {"name": nm_ + (f" ({mname})" if mname else "")}
                    wm.append(ent_)
    if wm and "weapon_mastery" not in out: out["weapon_mastery"] = wm
    fu = (pc.get("state") or {}).get("feature_uses") or {}
    cfn = {re.sub(r"[^a-z0-9]+", "-", f["name"].lower()).strip("-"): f["name"] for f in cf}
    resmap = {}   # resource id -> its display name (Lay On Hands, Paladin's Smite, Channel Divinity...)
    for src_ in [c_ for c_, _p in classes] + [vault.get(p_.get("subclass")) for _c, p_ in classes if p_.get("subclass")] + [race]:
        for fl_ in ((src_.get("features_by_level") or {}).values() if isinstance(src_, dict) else []):
            for ft_ in (fl_ or []):
                for r_ in (ft_.get("resources") or []) if isinstance(ft_, dict) else []:
                    if isinstance(r_, dict) and r_.get("id") and r_.get("name"):
                        resmap[r_["id"]] = r_["name"]
                        for eq_ in r_.get("equivalent_ids") or []: resmap.setdefault(eq_, r_["name"])
    # drop leftovers of things the character no longer has (a Dragonborn's Breath Weapon after switching species)
    _sl = lambda x: re.sub(r"[^a-z0-9]+", "-", str(x or "").lower()).strip("-")
    _refs = [pc.get("race"), pc.get("subrace"), pc.get("background")] + [c_.get("name") for c_ in pc["class"]] + [c_.get("subclass") for c_ in pc["class"]]
    for c_ in pc["class"]:
        for ch_ in (c_.get("choices") or {}).values():
            if isinstance(ch_, dict): _refs += [v_ for v_ in ch_.values() if isinstance(v_, str) and "_" in v_]
    _refs += [v_ for v_ in oc.values() if isinstance(v_, str) and "_" in v_]
    _live_p = set()
    for r_ in _refs:
        sl_ = slug_of(r_) if r_ else ""
        if sl_: _live_p |= {sl_, sl_.split("_")[-1]}
    _live_n = {_sl(e_.get("name")) for sec_ in ("species_traits", "class_features", "feats", "bonus_actions", "reactions") for e_ in (out.get(sec_) or []) if isinstance(e_, dict)}
    def _live(k_):
        if k_ in resmap or ":" not in k_: return True
        pref_, _, fid_ = k_.rpartition(":")
        return pref_ in _live_p or any(pref_.endswith(x_) or x_.endswith(pref_) for x_ in _live_p if len(x_) > 2) or fid_ in _live_n
    fu = {k_: v_ for k_, v_ in fu.items() if _live(k_)}
    res_c = []
    for k, v in fu.items():
        if not isinstance(v, dict) or not v.get("max"): continue
        fid = k.split(":")[-1]
        res_c.append({"name": resmap.get(k) or cfn.get(fid) or fid.replace("-", " ").title(), "max": int(v["max"]), "used": int(v.get("used", 0))})
    if pips:   # use pips live in the section they belong to: species traits, feats, class features
        spkey = re.sub(r"[^a-z0-9]+", "-", str(race.get("name", "")).lower()).strip("-")
        featkeys = {re.sub(r"[^a-z0-9]+", "-", str(f.get("name", "")).lower()).strip("-") for f in (out.get("feats") or [])}
        spk = {re.sub(r"[^a-z0-9]+", "-", str(t.get("name", "")).lower()).strip("-") for t in (out.get("species_traits") or [])}
        buckets = {"class_feature_uses": [], "species_trait_uses": [], "feat_uses": []}
        for k, v in fu.items():
            if not isinstance(v, dict) or not v.get("max"): continue
            pref, _, fid = k.rpartition(":"); fid = fid or pref
            row = {"name": resmap.get(k) or cfn.get(fid) or fid.replace("-", " ").title(), "max": int(v["max"]), "used": int(v.get("used", 0))}
            if pref and (pref == spkey or pref in spkey or fid in spk): buckets["species_trait_uses"].append(row)
            elif fid in featkeys: buckets["feat_uses"].append(row)
            else: buckets["class_feature_uses"].append(row)
        for bk, rows in buckets.items():
            if rows: out[bk] = rows
    elif res_c: out["class_resources"] = res_c
    for it in eq:
        d = vault.get(it["item"]); nm = d.get("name") or name_from_slug(slug_of(it["item"]))
        ov = it.get("overrides") or {}
        if ov.get("name"): nm = ov["name"]
        cat = str(d.get("category", ""))
        if d.get("_type") == "weapon" or "damage" in d and d.get("category", "").find("-") > 0:
            props = [str(p).lower().replace("_", " ") if isinstance(p, str) else "" for p in d.get("properties", []) or []]
            ranged = "ranged" in cat
            fin = "finesse" in props
            ab = "dex" if ranged or (fin and m["dex"] > m["str"]) else "str"
            proficient = cat.split("-")[0] in wprof or nm.lower() in wprof or any(cat.split("-")[0] == c_ and (pset_ & set(props)) for c_, pset_ in wrules)
            atk = m[ab] + (pb if proficient else 0)
            dmg = d.get("damage") or {}
            e = {"name": item_label(d, nm), "attack": signed(atk), "damage": f"{dmg.get('dice', '1')}{'+' if m[ab] >= 0 else ''}@{ab}.mod".replace("+-", "-"),
                 "type": str(dmg.get("type", "")).title(), "cost": {"free": "free", "special": "special", "bonus": "1 ba", "reaction": "1 r"}.get(str(ov.get("action", "")).lower(), "1 a")}
            if it.get("qty", 1) and it.get("qty", 1) > 1: e["name"] = item_label(d, nm + f" x{it['qty']}")
            rg = d.get("range") or {}
            e["range"] = f"{rg['normal']}/{rg['long']} ft" if rg.get("long") else (f"{rg['normal']} ft" if rg.get("normal") else ("Melee" if not ranged else ""))
            if "thrown" in props and rg.get("normal"): e["range"] = "Melee, " + e["range"]
            e["desc"] = "; ".join(x for x in [", ".join(p.title() for p in props if p), (str(d['mastery'][0]).title() if d.get("mastery") else ""), it.get("notes", "")] if x)
            acts.append({k: v for k, v in e.items() if v})
        else:
            q = it.get("qty", 1)
            need_att = _needs_attune(d)
            dsc = "equipped" if it.get("equipped") else ("in " + str(it["in"]) if it.get("in") else "")
            if need_att: dsc = (dsc + ", " if dsc else "") + ("attuned" if it.get("attuned") else "requires attunement (not attuned)")
            lab = item_label(d, nm + (f" x{q}" if q and q > 1 else ""))
            eqs.append({k: v for k, v in {"name": lab, "desc": dsc}.items() if v})
            if need_att and it.get("attuned"):
                txt = re.sub(r"\s+", " ", clean(first_text(d), 0)).strip()
                if len(txt) > 260: txt = (txt[:260].rsplit(" ", 1)[0] + "…")
                attuned.append({"name": lab, "desc": txt or "Attuned"})
    # conditional damage riders (Sneak Attack...): a clickable damage roll of its own
    for cdat, pcc in classes:
        cols_ = ((cdat.get("table") or {}).get(str(pcc["level"])) or {}).get("columns") or {}
        for src_ in [cdat, vault.get(pcc.get("subclass"))]:
            for lv_, fl_ in ((src_.get("features_by_level") or {}).items() if isinstance(src_, dict) else []):
                if not (str(lv_).isdigit() and int(lv_) <= pcc["level"]): continue
                for ft_ in (fl_ or []):
                    if not isinstance(ft_, dict) or ft_.get("activatable"): continue
                    for e_ in ft_.get("effects") or []:
                        if not isinstance(e_, dict) or e_.get("kind") != "damage-bonus" or not e_.get("condition") or e_.get("applies_to") in ("spell",): continue
                        amt_ = str(e_.get("amount") or "")
                        mm_ = re.fullmatch(r"column\('(.+?)'\)", amt_.strip())
                        if mm_: amt_ = str(cols_.get(mm_.group(1), ""))
                        if not re.fullmatch(r"\d+d\d+(\s*[+-]\s*\d+)?", amt_.strip()): continue
                        at_ = e_.get("applies_to"); at_ = ", ".join(at_) if isinstance(at_, list) else (str(at_) if at_ else "weapon")
                        dt_ = str(e_.get("damage_type") or "")
                        acts.append({"name": ft_["name"], "damage": amt_.strip(), "type": ("Weapon" if dt_.lower() == "weapon" else dt_.title()),
                                     "cost": "free", "desc": f"Once per turn (applies to {at_} attacks); {e_['condition']}"})
    if acts: out["actions"] = acts
    if eqs: out["equipment"] = [e for e in eqs]
    if attuned and pips:   # attuned magic items: listed under Actions > Other (most give an ability), with the slots used
        hdr = {"name": f"Attunement ({len(attuned)}/3)", "desc": "Attuned magic items; they are listed below."}
        out["otheractions"] = list(out.get("otheractions") or []) + [hdr] + attuned
    cur = pc.get("currency") or {}
    out["currency"] = [cur.get(k) if cur.get(k) else None for k in ("cp", "sp", "ep", "gp", "pp")]
    if unresolved: warn.append("spells without a note in the vault were skipped: " + ", ".join(unresolved))
    # Obsidian stops reading a note's properties when the frontmatter passes ~32,000 characters: shrink the copies
    LIMIT = 30000
    def _size(): return len(yaml.dump(out, Dumper=D, sort_keys=False, allow_unicode=True, width=10**6))
    def _brief(t, n=220):
        t = re.sub(r"\s+", " ", re.sub(r"\n\s*\n.*$", "", str(t), flags=re.S) if False else str(t)).strip()
        if len(t) <= n: return t
        c = t[:n]; k = max(c.rfind(". "), c.rfind("; "))
        return (c[:k + 1] if k > n // 2 else c.rstrip() + "…")
    def _shrink(keys, n):
        for k in keys:
            for e in out.get(k) or []:
                if isinstance(e, dict) and isinstance(e.get("desc"), str) and len(e["desc"]) > n: e["desc"] = _brief(e["desc"], n)
    if _size() > LIMIT:
        _shrink(["bonus_actions", "reactions"], 200); note = "bonus/reaction texts shortened"
        if _size() > LIMIT:
            _shrink(["spellcasting"] + [k for k in out if re.fullmatch(r"tab_\d+", k)], 220); note += ", spell copies on the Spells/Actions tabs shortened (full text stays in the spellbook lists)"
        if _size() > LIMIT:
            _shrink(["class_features", "species_traits", "feats"], 700); note += ", long feature texts cut"
        warn.append(f"The sheet was over Obsidian's ~32 KB frontmatter limit ({note}); size now {_size()} characters")
    return out, warn

# ------------------------------------------------------------------ yaml output
class D(yaml.SafeDumper): pass
def _str(dumper, s):
    if "\n" in s: return dumper.represent_scalar("tag:yaml.org,2002:str", s, style='"')   # escaped, never a block scalar: some Obsidian builds refuse block scalars with tables/colons
    if re.fullmatch(r"[-+]?\d+(\.\d+)?", s) or s in ("true", "false", "null", "") or s.startswith(("@", "[", "{", "#", "&", "*", "!", "|", ">", "%", "`", "'", '"')) or ": " in s or s.endswith(":"):
        return dumper.represent_scalar("tag:yaml.org,2002:str", s, style='"')
    return dumper.represent_scalar("tag:yaml.org,2002:str", s)
D.add_representer(str, _str)

BIO_KEYS = {"alignment", "age", "height", "weight", "eyes", "hair", "skin", "appearance", "personality", "allies", "notes", "notes_2", "description"}
PRESERVE_ON_UPDATE = {"image", "description", "xp", "alignment", "heroic_inspiration", "age", "height", "weight", "eyes",
    "hair", "skin", "appearance", "personality", "ideals", "bonds", "flaws", "allies", "notes", "notes_2", "damage_vulnerabilities",
    "damage_immunities", "condition_immunities", "weapon_mastery"}

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("character", help="the Archivist character note (.md)")
    ap.add_argument("--vault", required=True, help="your Obsidian vault folder (contains the Compendium)")
    ap.add_argument("-o", "--output", help="output file (default: '<name> (Atlas).md' next to the input)")
    ap.add_argument("--update", help="an existing Atlas note to refresh in place (keeps portrait, backstory, notes...)")
    ap.add_argument("--classic", action="store_true", help="write for the original single-page template instead of the tabbed one")
    ap.add_argument("--template", choices=["current", "pips", "tabbed", "classic"], help="which Atlas template to write for (default: current = 5e-2024-character-sheet-4r8tqz; pips = the previous pips sheet)")
    ap.add_argument("--no-link-spells", action="store_true", help="copy each spell's full text into the sheet instead of linking to the spell note")
    ap.add_argument("--prepared-tracker", action="store_true", help="also write the 'Prepared' checkbox list (off by default: the Spells tab already shows what is prepared)")
    ap.add_argument("--short", type=int, default=0, help="shorten feature texts to about N characters (default: full text)")
    a = ap.parse_args()
    fm, blocks, _ = parse_note(a.character)
    pc = blocks.get("pc")
    if not pc: sys.exit("No ```pc block found in that note.")
    if fm.get("archivist-portrait"): pc["_portrait"] = fm["archivist-portrait"]
    for kb in ("atlas", "atlas-bio"):   # or a fenced ```atlas block anywhere in the note body: key: value lines
        if isinstance(blocks.get(kb), dict): fm = {**fm, **blocks[kb]}
    pc["_bio"] = {k: fm[k] for k in ("height", "weight", "eyes", "hair", "skin", "appearance", "personality", "ideals", "bonds", "flaws", "allies", "notes", "notes_2", "backstory", "description", "alignment", "age") if fm.get(k)}
    if pc.get("notes") and not pc["_bio"].get("notes_2"): pc["_bio"]["notes_2"] = str(pc["notes"]).strip()   # the sheet's own Notes tab text
    vault = Vault(a.vault)
    print(f"Indexed {len(vault.index)} compendium notes.")
    global LINK_SPELLS, PREPARED_TRACKER
    PREPARED_TRACKER = a.prepared_tracker
    LINK_SPELLS = not a.no_link_spells
    out, warn = convert(pc, vault, a.short, a.classic, a.template or ("classic" if a.classic else "current"))
    explicit = set(out.pop("_explicit", []))
    body = ""
    if a.update:
        up = Path(a.update); shutil.copy(up, up.with_suffix(".bak.md"))
        ofm, _, text = parse_note(up)
        m = FM.match(text); body = text[m.end():] if m else text
        merged = dict(ofm)
        for k, v in out.items():
            if k in PRESERVE_ON_UPDATE and k in ofm and k not in explicit: continue
            merged[k] = v
        out, target = merged, up
    else:
        target = Path(a.output) if a.output else Path(a.character).with_name(f"{pc['name']} (Atlas).md")
    text = "---\n" + yaml.dump(out, Dumper=D, sort_keys=False, allow_unicode=True, width=10**6) + "---\n" + (body or "\n")
    target.write_text(text, encoding="utf-8")
    print(f"Wrote {target}")
    for w in warn: print("  check:", w)

if __name__ == "__main__":
    main()
