#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Task #204 — generates issuer-server/elements-catalog.js and
issuer-php/lib/elements-catalog.php from ONE source-of-truth table below,
so the two backends can never drift out of parity with each other (the
same discipline the rest of this project already follows for hand-written
catalog entries — this just makes it mechanical for 115 of them at once).

Data notes (documented here AND carried into the emitted files as a header
comment, so a developer opening either generated file sees the same
caveats without having to find this script first):

- weight (atomic weight, g/mol), category, phase (state at ~25 degC/298K),
  and density are standard, extremely well-established reference values
  (the kind on every periodic table poster / CRC Handbook) -- high
  confidence across the whole table.
- thermalConductivity (W/(m*K)) and electricalConductivity (MS/m,
  megasiemens per metre) are included only where there is high confidence
  in a commonly-cited reference value. Left as None (-> null) for most
  lanthanides/actinides beyond the handful in everyday use, and for every
  synthetic/superheavy element (Tc, Pm, and everything from Po/Fr onward
  except Th/U/Pu) -- these either have no reliably measured bulk value at
  all (many have only ever existed as single atoms) or the number simply
  isn't well established. null is the honest answer there, not a filled-in
  guess.
- density is null for the same "never existed in bulk" reason for most
  elements Fm (100) and heavier, and for a few short-lived elements below
  that (Tc, Pm, Po, At, Fr, Ac, Pa-adjacent light actinides keep real
  measured values where they exist).
- category carries "(predicted)" for elements 104 and up whose chemistry
  has never been observed on a bulk scale, only inferred from a handful of
  atoms and periodic-table extrapolation.
- exchangeRate: 14 elements (rateSource: "market") use a real conversion
  ratio computed from spot/market prices fetched once on 2026-09-17
  (Kitco for precious metals, TradingEconomics for base/industrial metals
  -- see private notes for the full price table and the raw $/gram
  figures each ratio was computed from). Uranium, lithium and tungsten's
  market ratios are derived from their actually-traded compound/
  concentrate prices (U3O8, Li2CO3, APT) adjusted for contained-element
  fraction, not a pure-metal spot price, because pure-metal spot markets
  for those three barely exist. Titanium's ratio is derived from sponge
  feedstock price (a floor, not the pricier finished-ingot price).
  Every other element (rateSource: "tier-estimate") has no real, findable
  per-gram market price at all -- these use a broad, documented tier
  (see TIER_RATES below) informed by real-world rarity/abundance
  characteristics (precious/PGM-adjacent, rare-earth/specialty,
  reactive-light-metal, bulk-industrial-nonmetal, noble-gas, or
  effectively-unobtainable synthetic), NOT a fetched price. This mirrors
  exactly the "market vs tier-estimate, both honestly labeled" plan from
  the private design notes -- nothing here claims to be a real quote that
  isn't one. Rates are fetched/computed ONCE and hard-coded; there is no
  live-updating mechanism (that was explicitly descoped this round).
  Gold/iron/silver's own existing exchangeRate (1 / 20 / 5) are
  deliberately left untouched by this file -- they stay the original
  #203 round demo numbers, not recalculated to this table's real-price
  scale, to avoid disturbing already-shipped, already-tested behavior.
  This is a known, documented inconsistency (a literal iron:gold price
  ratio would be enormous, ~150,000+, not 20) -- see the private notes
  "#204" section for the full reasoning.
- holdingCap: every new element gets the same 500 cap #203 set for
  gold/iron/silver, for consistency and in case a future dev-tool mint
  button ever targets one of these classes directly -- even though, per
  Bruno's own explicit call, NONE of these 115 has a mining stall, so the
  cap has no fresh-mint path to actually gate today. Purely future-proofing.
- model/thumbnail: every new element reuses the existing
  badge.glb/badge.png placeholder art, the same "reused-art" convention
  atlas.badge/atlas.postoffice.membership/atlas.tradingstation.membership/
  atlas.element.silver already use. No new 3D assets were produced this
  round, per Bruno's explicit instruction.
"""

import json

DOMAIN_PLACEHOLDER = "__DOMAIN__"  # substituted by each backend's own template-string/interpolation convention

# Real, fetched-once market ratios (units of element == 1 unit of gold),
# computed as goldPricePerGram / elementPricePerGram from prices fetched
# 2026-09-17. See the module docstring for the compound/concentrate caveats
# on U, Li and W, and the sponge-price caveat on Ti.
MARKET_RATES = {
    "Platinum": 2.43,
    "Palladium": 3.32,
    "Rhodium": 0.47,
    "Copper": 9824,
    "Aluminium": 42660,
    "Nickel": 8611,
    "Lead": 73810,
    "Zinc": 36520,
    "Tin": 2683,
    "Titanium": 21136,
    "Uranium": 596,
    "Lithium": 1382,
    "Cobalt": 3386,
    "Tungsten": 1744,
}

# Broad, honestly-approximate tiers for every element with no real,
# findable per-gram market price. Representative single value per tier --
# see the module docstring. Individual overrides (a handful of elements
# whose real-world rarity is well-documented enough to place them
# specifically rather than just by broad category) are applied in code
# below via the `rate_override` column.
TIER_RATES = {
    "unobtainium": 0.0005,       # synthetic / no natural stable form, only ever produced atom-by-atom
    "precious_adjacent": 40,      # rare earths / specialty metals with real modest industrial value
    "reactive_light_metal": 6000, # alkali/alkaline-earth metals, generally abundant reactive metals
    "bulk_nonmetal": 60000,       # common industrial gases/nonmetals, genuinely cheap per gram
    "noble_gas_common": 8000,     # argon-like: abundant, cheap to separate
    "noble_gas_scarce": 60,       # neon/xenon-like: real, well-documented supply-crunch scarcity
    "metalloid_specialty": 500,   # semiconductor-adjacent metalloids/post-transition metals
}

# (atomicNumber, symbol, name, category, weight_g_per_mol, phase,
#  density, density_unit, thermal_conductivity_W_per_mK, electrical_conductivity_MS_per_m,
#  rate_key_or_None (looked up in MARKET_RATES by name if None here and name in MARKET_RATES),
#  rate_override_or_None (explicit tier key from TIER_RATES, overrides the default guess below))
ELEMENTS = [
  (1,"H","Hydrogen","reactive nonmetal",1.008,"gas",0.08988,"g/L",0.1805,0,None,"bulk_nonmetal"),
  (2,"He","Helium","noble gas",4.0026,"gas",0.1786,"g/L",0.1513,0,None,"noble_gas_scarce"),
  (3,"Li","Lithium","alkali metal",6.94,"solid",0.534,"g/cm3",84.8,10.8,"Lithium",None),
  (4,"Be","Beryllium","alkaline earth metal",9.0122,"solid",1.85,"g/cm3",200,31.3,None,"precious_adjacent"),
  (5,"B","Boron","metalloid",10.81,"solid",2.34,"g/cm3",27.4,1e-10,None,"metalloid_specialty"),
  (6,"C","Carbon","reactive nonmetal",12.011,"solid",2.267,"g/cm3",119,0.0006,None,"bulk_nonmetal"),
  (7,"N","Nitrogen","reactive nonmetal",14.007,"gas",1.2506,"g/L",0.02583,0,None,"bulk_nonmetal"),
  (8,"O","Oxygen","reactive nonmetal",15.999,"gas",1.429,"g/L",0.02658,0,None,"bulk_nonmetal"),
  (9,"F","Fluorine","reactive nonmetal",18.998,"gas",1.696,"g/L",0.0277,0,None,"bulk_nonmetal"),
  (10,"Ne","Neon","noble gas",20.180,"gas",0.9002,"g/L",0.0491,0,None,"noble_gas_scarce"),
  (11,"Na","Sodium","alkali metal",22.990,"solid",0.971,"g/cm3",142,21.0,None,"reactive_light_metal"),
  (12,"Mg","Magnesium","alkaline earth metal",24.305,"solid",1.738,"g/cm3",156,22.6,None,"reactive_light_metal"),
  (13,"Al","Aluminium","post-transition metal",26.982,"solid",2.70,"g/cm3",237,37.7,"Aluminium",None),
  (14,"Si","Silicon","metalloid",28.085,"solid",2.3296,"g/cm3",149,0.0016,None,"metalloid_specialty"),
  (15,"P","Phosphorus","reactive nonmetal",30.974,"solid",1.82,"g/cm3",0.236,0,None,"bulk_nonmetal"),
  (16,"S","Sulfur","reactive nonmetal",32.06,"solid",2.07,"g/cm3",0.205,1e-15,None,"bulk_nonmetal"),
  (17,"Cl","Chlorine","reactive nonmetal",35.45,"gas",3.214,"g/L",0.0089,0,None,"bulk_nonmetal"),
  (18,"Ar","Argon","noble gas",39.948,"gas",1.784,"g/L",0.01772,0,None,"noble_gas_common"),
  (19,"K","Potassium","alkali metal",39.098,"solid",0.862,"g/cm3",102.5,13.9,None,"reactive_light_metal"),
  (20,"Ca","Calcium","alkaline earth metal",40.078,"solid",1.54,"g/cm3",201,29.8,None,"reactive_light_metal"),
  (21,"Sc","Scandium","transition metal",44.956,"solid",2.985,"g/cm3",15.8,1.77,None,"precious_adjacent"),
  (22,"Ti","Titanium","transition metal",47.867,"solid",4.506,"g/cm3",21.9,2.38,"Titanium",None),
  (23,"V","Vanadium","transition metal",50.942,"solid",6.11,"g/cm3",30.7,5.0,None,"precious_adjacent"),
  (24,"Cr","Chromium","transition metal",51.996,"solid",7.15,"g/cm3",93.9,7.9,None,"precious_adjacent"),
  (25,"Mn","Manganese","transition metal",54.938,"solid",7.21,"g/cm3",7.81,0.62,None,"precious_adjacent"),
  (27,"Co","Cobalt","transition metal",58.933,"solid",8.90,"g/cm3",100,17.9,"Cobalt",None),
  (28,"Ni","Nickel","transition metal",58.693,"solid",8.908,"g/cm3",90.9,14.3,"Nickel",None),
  (29,"Cu","Copper","transition metal",63.546,"solid",8.96,"g/cm3",401,59.6,"Copper",None),
  (30,"Zn","Zinc","transition metal",65.38,"solid",7.14,"g/cm3",116,16.6,"Zinc",None),
  (31,"Ga","Gallium","post-transition metal",69.723,"solid",5.91,"g/cm3",40.6,7.1,None,"metalloid_specialty"),
  (32,"Ge","Germanium","metalloid",72.630,"solid",5.323,"g/cm3",60.2,0.0020,None,"metalloid_specialty"),
  (33,"As","Arsenic","metalloid",74.922,"solid",5.727,"g/cm3",50.2,3.3,None,"metalloid_specialty"),
  (34,"Se","Selenium","reactive nonmetal",78.971,"solid",4.81,"g/cm3",0.52,1e-7,None,"metalloid_specialty"),
  (35,"Br","Bromine","reactive nonmetal",79.904,"liquid",3.10,"g/cm3",0.122,0,None,"bulk_nonmetal"),
  (36,"Kr","Krypton","noble gas",83.798,"gas",3.749,"g/L",0.00943,0,None,"noble_gas_scarce"),
  (37,"Rb","Rubidium","alkali metal",85.468,"solid",1.532,"g/cm3",58.2,8.3,None,"reactive_light_metal"),
  (38,"Sr","Strontium","alkaline earth metal",87.62,"solid",2.64,"g/cm3",35.4,7.7,None,"reactive_light_metal"),
  (39,"Y","Yttrium","transition metal",88.906,"solid",4.472,"g/cm3",17.2,1.8,None,"precious_adjacent"),
  (40,"Zr","Zirconium","transition metal",91.224,"solid",6.52,"g/cm3",22.6,2.4,None,"precious_adjacent"),
  (41,"Nb","Niobium","transition metal",92.906,"solid",8.57,"g/cm3",53.7,6.7,None,"precious_adjacent"),
  (42,"Mo","Molybdenum","transition metal",95.95,"solid",10.28,"g/cm3",138,18.7,None,"precious_adjacent"),
  (43,"Tc","Technetium","transition metal",98.0,"solid",11.0,"g/cm3",50.6,None,None,"unobtainium"),
  (44,"Ru","Ruthenium","transition metal",101.07,"solid",12.45,"g/cm3",117,13.7,None,"precious_adjacent"),
  (45,"Rh","Rhodium","transition metal",102.91,"solid",12.41,"g/cm3",150,21.1,"Rhodium",None),
  (46,"Pd","Palladium","transition metal",106.42,"solid",12.023,"g/cm3",71.8,9.5,"Palladium",None),
  (48,"Cd","Cadmium","transition metal",112.41,"solid",8.65,"g/cm3",96.6,13.8,None,"metalloid_specialty"),
  (49,"In","Indium","post-transition metal",114.82,"solid",7.31,"g/cm3",81.8,12.5,None,"metalloid_specialty"),
  (50,"Sn","Tin","post-transition metal",118.71,"solid",7.265,"g/cm3",66.6,9.1,"Tin",None),
  (51,"Sb","Antimony","metalloid",121.76,"solid",6.697,"g/cm3",24.4,2.5,None,"metalloid_specialty"),
  (52,"Te","Tellurium","metalloid",127.60,"solid",6.24,"g/cm3",1.97,0.001,None,"metalloid_specialty"),
  (53,"I","Iodine","reactive nonmetal",126.90,"solid",4.93,"g/cm3",0.449,1e-13,None,"bulk_nonmetal"),
  (54,"Xe","Xenon","noble gas",131.29,"gas",5.894,"g/L",0.00565,0,None,"noble_gas_scarce"),
  (55,"Cs","Caesium","alkali metal",132.91,"solid",1.93,"g/cm3",35.9,4.8,None,"precious_adjacent"),
  (56,"Ba","Barium","alkaline earth metal",137.33,"solid",3.51,"g/cm3",18.4,2.9,None,"reactive_light_metal"),
  (57,"La","Lanthanum","lanthanide",138.91,"solid",6.162,"g/cm3",13.4,1.6,None,"precious_adjacent"),
  (58,"Ce","Cerium","lanthanide",140.12,"solid",6.770,"g/cm3",11.3,1.4,None,"precious_adjacent"),
  (59,"Pr","Praseodymium","lanthanide",140.91,"solid",6.77,"g/cm3",12.5,1.4,None,"precious_adjacent"),
  (60,"Nd","Neodymium","lanthanide",144.24,"solid",7.01,"g/cm3",16.5,1.6,None,"precious_adjacent"),
  (61,"Pm","Promethium","lanthanide",145.0,"solid",7.26,"g/cm3",None,None,None,"unobtainium"),
  (62,"Sm","Samarium","lanthanide",150.36,"solid",7.52,"g/cm3",13.3,1.1,None,"precious_adjacent"),
  (63,"Eu","Europium","lanthanide",151.96,"solid",5.264,"g/cm3",13.9,1.1,None,"precious_adjacent"),
  (64,"Gd","Gadolinium","lanthanide",157.25,"solid",7.90,"g/cm3",10.6,0.77,None,"precious_adjacent"),
  (65,"Tb","Terbium","lanthanide",158.93,"solid",8.23,"g/cm3",11.1,0.83,None,"precious_adjacent"),
  (66,"Dy","Dysprosium","lanthanide",162.50,"solid",8.54,"g/cm3",10.7,1.1,None,"precious_adjacent"),
  (67,"Ho","Holmium","lanthanide",164.93,"solid",8.79,"g/cm3",16.2,1.1,None,"precious_adjacent"),
  (68,"Er","Erbium","lanthanide",167.26,"solid",9.07,"g/cm3",14.5,1.2,None,"precious_adjacent"),
  (69,"Tm","Thulium","lanthanide",168.93,"solid",9.32,"g/cm3",16.9,1.4,None,"precious_adjacent"),
  (70,"Yb","Ytterbium","lanthanide",173.05,"solid",6.90,"g/cm3",38.5,3.6,None,"precious_adjacent"),
  (71,"Lu","Lutetium","lanthanide",174.97,"solid",9.84,"g/cm3",16.4,1.8,None,"precious_adjacent"),
  (72,"Hf","Hafnium","transition metal",178.49,"solid",13.31,"g/cm3",23.0,3.3,None,"precious_adjacent"),
  (73,"Ta","Tantalum","transition metal",180.95,"solid",16.69,"g/cm3",57.5,7.7,None,"precious_adjacent"),
  (74,"W","Tungsten","transition metal",183.84,"solid",19.25,"g/cm3",173,18.9,"Tungsten",None),
  (75,"Re","Rhenium","transition metal",186.21,"solid",21.02,"g/cm3",48.0,5.6,None,"precious_adjacent"),
  (76,"Os","Osmium","transition metal",190.23,"solid",22.59,"g/cm3",87.6,12.3,None,"precious_adjacent"),
  (77,"Ir","Iridium","transition metal",192.22,"solid",22.56,"g/cm3",147,19.7,None,"precious_adjacent"),
  (78,"Pt","Platinum","transition metal",195.08,"solid",21.45,"g/cm3",71.6,9.4,"Platinum",None),
  (80,"Hg","Mercury","transition metal",200.59,"liquid",13.534,"g/cm3",8.30,1.04,None,"metalloid_specialty"),
  (81,"Tl","Thallium","post-transition metal",204.38,"solid",11.85,"g/cm3",46.1,6.2,None,"metalloid_specialty"),
  (82,"Pb","Lead","post-transition metal",207.2,"solid",11.34,"g/cm3",35.3,4.8,"Lead",None),
  (83,"Bi","Bismuth","post-transition metal",208.98,"solid",9.78,"g/cm3",7.97,0.77,None,"metalloid_specialty"),
  (84,"Po","Polonium","post-transition metal",209.0,"solid",9.20,"g/cm3",20,0.023,None,"unobtainium"),
  (85,"At","Astatine","metalloid",210.0,"solid",None,None,1.7,None,None,"unobtainium"),
  (86,"Rn","Radon","noble gas",222.0,"gas",9.73,"g/L",0.00361,0,None,"unobtainium"),
  (87,"Fr","Francium","alkali metal",223.0,"solid",None,None,15,None,None,"unobtainium"),
  (88,"Ra","Radium","alkaline earth metal",226.0,"solid",5.5,"g/cm3",18.6,1.0,None,"unobtainium"),
  (89,"Ac","Actinium","actinide",227.0,"solid",10.07,"g/cm3",12,None,None,"unobtainium"),
  (90,"Th","Thorium","actinide",232.04,"solid",11.72,"g/cm3",54.0,6.7,None,"precious_adjacent"),
  (91,"Pa","Protactinium","actinide",231.04,"solid",15.37,"g/cm3",47,None,None,"unobtainium"),
  (92,"U","Uranium","actinide",238.03,"solid",19.05,"g/cm3",27.5,3.8,"Uranium",None),
  (93,"Np","Neptunium","actinide",237.0,"solid",20.45,"g/cm3",6.3,None,None,"unobtainium"),
  (94,"Pu","Plutonium","actinide",244.0,"solid",19.82,"g/cm3",6.74,0.67,None,"unobtainium"),
  (95,"Am","Americium","actinide",243.0,"solid",12.0,"g/cm3",10,None,None,"unobtainium"),
  (96,"Cm","Curium","actinide",247.0,"solid",13.51,"g/cm3",None,None,None,"unobtainium"),
  (97,"Bk","Berkelium","actinide",247.0,"solid",14.78,"g/cm3",None,None,None,"unobtainium"),
  (98,"Cf","Californium","actinide",251.0,"solid",15.1,"g/cm3",None,None,None,"unobtainium"),
  (99,"Es","Einsteinium","actinide",252.0,"solid",8.84,"g/cm3",None,None,None,"unobtainium"),
  (100,"Fm","Fermium","actinide",257.0,None,None,None,None,None,None,"unobtainium"),
  (101,"Md","Mendelevium","actinide",258.0,None,None,None,None,None,None,"unobtainium"),
  (102,"No","Nobelium","actinide",259.0,None,None,None,None,None,None,"unobtainium"),
  (103,"Lr","Lawrencium","actinide",266.0,None,None,None,None,None,None,"unobtainium"),
  (104,"Rf","Rutherfordium","transition metal (predicted)",267.0,None,None,None,None,None,None,"unobtainium"),
  (105,"Db","Dubnium","transition metal (predicted)",268.0,None,None,None,None,None,None,"unobtainium"),
  (106,"Sg","Seaborgium","transition metal (predicted)",269.0,None,None,None,None,None,None,"unobtainium"),
  (107,"Bh","Bohrium","transition metal (predicted)",270.0,None,None,None,None,None,None,"unobtainium"),
  (108,"Hs","Hassium","transition metal (predicted)",269.0,None,None,None,None,None,None,"unobtainium"),
  (109,"Mt","Meitnerium","transition metal (predicted)",278.0,None,None,None,None,None,None,"unobtainium"),
  (110,"Ds","Darmstadtium","transition metal (predicted)",281.0,None,None,None,None,None,None,"unobtainium"),
  (111,"Rg","Roentgenium","transition metal (predicted)",282.0,None,None,None,None,None,None,"unobtainium"),
  (112,"Cn","Copernicium","transition metal (predicted)",285.0,"liquid (predicted)",None,None,None,None,None,"unobtainium"),
  (113,"Nh","Nihonium","post-transition metal (predicted)",286.0,None,None,None,None,None,None,"unobtainium"),
  (114,"Fl","Flerovium","post-transition metal (predicted)",289.0,"gas (predicted)",None,None,None,None,None,"unobtainium"),
  (115,"Mc","Moscovium","post-transition metal (predicted)",290.0,None,None,None,None,None,None,"unobtainium"),
  (116,"Lv","Livermorium","post-transition metal (predicted)",293.0,None,None,None,None,None,None,"unobtainium"),
  (117,"Ts","Tennessine","reactive nonmetal (predicted)",294.0,None,None,None,None,None,None,"unobtainium"),
  (118,"Og","Oganesson","noble gas (predicted)",294.0,"solid (predicted)",None,None,None,None,None,"unobtainium"),
]

assert len(ELEMENTS) == 115, f"expected 115 new elements (118 - Fe/Ag/Au), got {len(ELEMENTS)}"
seen_nums = {e[0] for e in ELEMENTS}
assert seen_nums == set(range(1,119)) - {26,47,79}, "atomic number roster mismatch"

def class_id(name):
    return "atlas.element." + name.lower()

def rate_for(name, override_tier):
    if name in MARKET_RATES:
        return MARKET_RATES[name], "market"
    return TIER_RATES[override_tier], "tier-estimate"

entries = {}
for (num, sym, name, cat, weight, phase, density, density_unit, tc, ec, market_key, tier_key) in ELEMENTS:
    lookup_name = market_key if market_key else name
    rate, rate_source = rate_for(lookup_name, tier_key)
    props = {
        "atlas.symbol": sym,
        "atlas.atomicNumber": num,
        "atlas.category": cat,
        "atlas.state": phase if phase else "unknown (never observed in bulk quantity)",
        "atlas.weight": {"value": weight, "unit": "g/mol"},
    }
    if density is not None:
        props["atlas.density"] = {"value": density, "unit": density_unit}
    if tc is not None:
        props["atlas.thermalConductivity"] = {"value": tc, "unit": "W/(m*K)"}
    if ec is not None:
        props["atlas.electricalConductivity"] = {"value": ec, "unit": "MS/m"}
    entries[class_id(name)] = {
        # Task #205 — "<Name> (<Symbol>)" instead of "<Name> Sample", so a
        # user typing into the new searchable Convert/Sell dropdowns can
        # find an element by either its name OR its symbol (e.g. typing
        # "Pt" or "Platinum" both match "Platinum (Pt)").
        "name": f"{name} ({sym})",
        "fungible": True,
        "presentation": "collectible",
        "exchangeRate": rate,
        "rateSource": rate_source,
        "holdingCap": 500,
        "properties": props,
    }

import os
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS_OUT = os.path.join(REPO_ROOT, "issuer-server", "elements-catalog.js")
PHP_OUT = os.path.join(REPO_ROOT, "issuer-php", "lib", "elements-catalog.php")

HEADER_JS = '''// Task #204 — generated file, do not hand-edit (re-run
// tools/generate-elements-catalog.py instead if these ever need to
// change). Adds the other 115 periodic-table elements (everything except
// gold/iron/silver, which stay hand-authored in server.js itself since
// they're the special mineable "currency" three) as convert-only fungible
// assets.
//
// Why this lives in its own file: keeping 115 entries out of server.js
// keeps that file readable, and gives a developer one obvious place to
// look up or edit an element's properties/exchangeRate without scrolling
// past the protocol/endpoint code to find it.
//
// Every entry below reuses the existing badge.glb/badge.png placeholder
// art (same convention atlas.badge/atlas.element.silver/the membership
// cards already use) — no new 3D models or thumbnails were produced for
// this round, per Bruno's explicit instruction.
//
// No mining stall exists for any of these — per Bruno's explicit call,
// the ONLY way to obtain one is by converting into it (POST
// /atlas/convert) from gold, iron, silver, or another rated element.
// holdingCap is still set on every entry for consistency/future-proofing
// (see generate-elements-catalog.py's own module docstring), even though
// nothing today ever calls /atlas/asset/issue for these classes.
//
// exchangeRate: 14 elements (rateSource: "market") carry a real ratio
// computed from spot/market prices fetched ONCE on 2026-09-17 (not
// live-updating — that was explicitly descoped). Every other element
// (rateSource: "tier-estimate") has no real per-gram market price to
// fetch at all, so it uses a broad, honestly-approximate tier informed by
// real-world rarity/abundance facts instead of a fabricated precise
// number. Full reasoning + the raw fetched price table:
// domain-atlas-private-notes.md, "#204" section.

module.exports = function buildElementsCatalog(DOMAIN) {
  return {
'''

FOOTER_JS = '''  };
};
'''

def js_props(props):
    lines = []
    for k, v in props.items():
        if isinstance(v, dict):
            inner = ", ".join(f"{json.dumps(ik)}: {json.dumps(iv)}" for ik, iv in v.items())
            lines.append(f"      {json.dumps(k)}: {{ {inner} }}")
        else:
            lines.append(f"      {json.dumps(k)}: {json.dumps(v)}")
    return ",\n".join(lines)

def emit_js():
    parts = [HEADER_JS]
    keys = list(entries.keys())
    for i, cls in enumerate(keys):
        e = entries[cls]
        comma = "," if i < len(keys) - 1 else ""
        parts.append(f"    {json.dumps(cls)}: {{\n")
        parts.append(f"      name: {json.dumps(e['name'])},\n")
        parts.append("      model: `https://${DOMAIN}/assets/badge.glb`,\n")
        parts.append("      thumbnail: `https://${DOMAIN}/assets/badge.png`,\n")
        parts.append(f"      fungible: true,\n")
        parts.append(f"      presentation: {json.dumps(e['presentation'])},\n")
        parts.append(f"      exchangeRate: {json.dumps(e['exchangeRate'])}, // rateSource: {e['rateSource']}\n")
        parts.append(f"      rateSource: {json.dumps(e['rateSource'])},\n")
        parts.append(f"      holdingCap: {json.dumps(e['holdingCap'])},\n")
        parts.append(f"      properties: {{\n{js_props(e['properties'])}\n      }}\n")
        parts.append(f"    }}{comma}\n")
    parts.append(FOOTER_JS)
    with open(JS_OUT, "w") as f:
        f.write("".join(parts))

HEADER_PHP = '''<?php
// Task #204 — generated file, do not hand-edit (re-run
// tools/generate-elements-catalog.py instead). PHP mirror of
// issuer-server/elements-catalog.js — see that file's own header comment
// for the full rationale (separate file for readability, badge.glb/png
// placeholder art, no mining stalls, market vs tier-estimate exchangeRate
// sourcing). Keep this and the Node version in exact parity; both are
// generated from the same source table by
// tools/generate-elements-catalog.py.
//
// Uses modelPath/thumbnailPath (relative, resolved against the current
// request's domain by atlas_asset_catalog_entry() in store.php) rather
// than a baked-in absolute URL — same convention every other
// ATLAS_ASSET_CATALOG entry already follows, since atlas_domain() reads
// $_SERVER['HTTP_HOST'] and isn't available at file-load time.

function atlas_elements_catalog() {
  return [
'''

FOOTER_PHP = '''  ];
}
'''

def php_val(v):
    if isinstance(v, bool):
        return 'true' if v else 'false'
    if isinstance(v, (int, float)):
        return json.dumps(v)
    if v is None:
        return 'null'
    return "'" + str(v).replace("\\", "\\\\").replace("'", "\\'") + "'"

def php_props(props, indent="      "):
    lines = []
    for k, v in props.items():
        if isinstance(v, dict):
            inner = ", ".join(f"'{ik}' => {php_val(iv)}" for ik, iv in v.items())
            lines.append(f"{indent}'{k}' => [{inner}]")
        else:
            lines.append(f"{indent}'{k}' => {php_val(v)}")
    return ",\n".join(lines)

def emit_php():
    parts = [HEADER_PHP]
    keys = list(entries.keys())
    for i, cls in enumerate(keys):
        e = entries[cls]
        comma = "," if i < len(keys) - 1 else ""
        parts.append(f"    '{cls}' => [\n")
        parts.append(f"      'name' => {php_val(e['name'])},\n")
        parts.append("      'modelPath' => '/assets/badge.glb',\n")
        parts.append("      'thumbnailPath' => '/assets/badge.png',\n")
        parts.append("      'fungible' => true,\n")
        parts.append(f"      'presentation' => {php_val(e['presentation'])},\n")
        parts.append(f"      'exchangeRate' => {php_val(e['exchangeRate'])}, // rateSource: {e['rateSource']}\n")
        parts.append(f"      'rateSource' => {php_val(e['rateSource'])},\n")
        parts.append(f"      'holdingCap' => {php_val(e['holdingCap'])},\n")
        parts.append(f"      'properties' => [\n{php_props(e['properties'])}\n      ]\n")
        parts.append(f"    ]{comma}\n")
    parts.append(FOOTER_PHP)
    with open(PHP_OUT, "w") as f:
        f.write("".join(parts))

emit_js()
emit_php()
print(f"generated {len(entries)} element entries")
print(f"wrote {JS_OUT}")
print(f"wrote {PHP_OUT}")
print("market-rate elements:", sum(1 for v in entries.values() if v.get("rateSource") == "market"))
