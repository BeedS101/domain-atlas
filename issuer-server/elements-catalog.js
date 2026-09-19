// Task #204 — generated file, do not hand-edit (re-run
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
    "atlas.element.hydrogen": {
      name: "Hydrogen (H)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "H",
      "atlas.atomicNumber": 1,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "gas",
      "atlas.weight": { "value": 1.008, "unit": "g/mol" },
      "atlas.density": { "value": 0.08988, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.1805, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.helium": {
      name: "Helium (He)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "He",
      "atlas.atomicNumber": 2,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 4.0026, "unit": "g/mol" },
      "atlas.density": { "value": 0.1786, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.1513, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.lithium": {
      name: "Lithium (Li)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 1382, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Li",
      "atlas.atomicNumber": 3,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 6.94, "unit": "g/mol" },
      "atlas.density": { "value": 0.534, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 84.8, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 10.8, "unit": "MS/m" }
      }
    },
    "atlas.element.beryllium": {
      name: "Beryllium (Be)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Be",
      "atlas.atomicNumber": 4,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 9.0122, "unit": "g/mol" },
      "atlas.density": { "value": 1.85, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 200, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 31.3, "unit": "MS/m" }
      }
    },
    "atlas.element.boron": {
      name: "Boron (B)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "B",
      "atlas.atomicNumber": 5,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 10.81, "unit": "g/mol" },
      "atlas.density": { "value": 2.34, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 27.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1e-10, "unit": "MS/m" }
      }
    },
    "atlas.element.carbon": {
      name: "Carbon (C)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "C",
      "atlas.atomicNumber": 6,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 12.011, "unit": "g/mol" },
      "atlas.density": { "value": 2.267, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 119, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.0006, "unit": "MS/m" }
      }
    },
    "atlas.element.nitrogen": {
      name: "Nitrogen (N)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "N",
      "atlas.atomicNumber": 7,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "gas",
      "atlas.weight": { "value": 14.007, "unit": "g/mol" },
      "atlas.density": { "value": 1.2506, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.02583, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.oxygen": {
      name: "Oxygen (O)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "O",
      "atlas.atomicNumber": 8,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "gas",
      "atlas.weight": { "value": 15.999, "unit": "g/mol" },
      "atlas.density": { "value": 1.429, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.02658, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.fluorine": {
      name: "Fluorine (F)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "F",
      "atlas.atomicNumber": 9,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "gas",
      "atlas.weight": { "value": 18.998, "unit": "g/mol" },
      "atlas.density": { "value": 1.696, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.0277, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.neon": {
      name: "Neon (Ne)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ne",
      "atlas.atomicNumber": 10,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 20.18, "unit": "g/mol" },
      "atlas.density": { "value": 0.9002, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.0491, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.sodium": {
      name: "Sodium (Na)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Na",
      "atlas.atomicNumber": 11,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 22.99, "unit": "g/mol" },
      "atlas.density": { "value": 0.971, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 142, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 21.0, "unit": "MS/m" }
      }
    },
    "atlas.element.magnesium": {
      name: "Magnesium (Mg)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Mg",
      "atlas.atomicNumber": 12,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 24.305, "unit": "g/mol" },
      "atlas.density": { "value": 1.738, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 156, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 22.6, "unit": "MS/m" }
      }
    },
    "atlas.element.aluminium": {
      name: "Aluminium (Al)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 42660, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Al",
      "atlas.atomicNumber": 13,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 26.982, "unit": "g/mol" },
      "atlas.density": { "value": 2.7, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 237, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 37.7, "unit": "MS/m" }
      }
    },
    "atlas.element.silicon": {
      name: "Silicon (Si)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Si",
      "atlas.atomicNumber": 14,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 28.085, "unit": "g/mol" },
      "atlas.density": { "value": 2.3296, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 149, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.0016, "unit": "MS/m" }
      }
    },
    "atlas.element.phosphorus": {
      name: "Phosphorus (P)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "P",
      "atlas.atomicNumber": 15,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 30.974, "unit": "g/mol" },
      "atlas.density": { "value": 1.82, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 0.236, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.sulfur": {
      name: "Sulfur (S)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "S",
      "atlas.atomicNumber": 16,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 32.06, "unit": "g/mol" },
      "atlas.density": { "value": 2.07, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 0.205, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1e-15, "unit": "MS/m" }
      }
    },
    "atlas.element.chlorine": {
      name: "Chlorine (Cl)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cl",
      "atlas.atomicNumber": 17,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "gas",
      "atlas.weight": { "value": 35.45, "unit": "g/mol" },
      "atlas.density": { "value": 3.214, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.0089, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.argon": {
      name: "Argon (Ar)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 8000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ar",
      "atlas.atomicNumber": 18,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 39.948, "unit": "g/mol" },
      "atlas.density": { "value": 1.784, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.01772, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.potassium": {
      name: "Potassium (K)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "K",
      "atlas.atomicNumber": 19,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 39.098, "unit": "g/mol" },
      "atlas.density": { "value": 0.862, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 102.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 13.9, "unit": "MS/m" }
      }
    },
    "atlas.element.calcium": {
      name: "Calcium (Ca)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ca",
      "atlas.atomicNumber": 20,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 40.078, "unit": "g/mol" },
      "atlas.density": { "value": 1.54, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 201, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 29.8, "unit": "MS/m" }
      }
    },
    "atlas.element.scandium": {
      name: "Scandium (Sc)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sc",
      "atlas.atomicNumber": 21,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 44.956, "unit": "g/mol" },
      "atlas.density": { "value": 2.985, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 15.8, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.77, "unit": "MS/m" }
      }
    },
    "atlas.element.titanium": {
      name: "Titanium (Ti)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 21136, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ti",
      "atlas.atomicNumber": 22,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 47.867, "unit": "g/mol" },
      "atlas.density": { "value": 4.506, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 21.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 2.38, "unit": "MS/m" }
      }
    },
    "atlas.element.vanadium": {
      name: "Vanadium (V)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "V",
      "atlas.atomicNumber": 23,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 50.942, "unit": "g/mol" },
      "atlas.density": { "value": 6.11, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 30.7, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 5.0, "unit": "MS/m" }
      }
    },
    "atlas.element.chromium": {
      name: "Chromium (Cr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cr",
      "atlas.atomicNumber": 24,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 51.996, "unit": "g/mol" },
      "atlas.density": { "value": 7.15, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 93.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 7.9, "unit": "MS/m" }
      }
    },
    "atlas.element.manganese": {
      name: "Manganese (Mn)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Mn",
      "atlas.atomicNumber": 25,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 54.938, "unit": "g/mol" },
      "atlas.density": { "value": 7.21, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 7.81, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.62, "unit": "MS/m" }
      }
    },
    "atlas.element.cobalt": {
      name: "Cobalt (Co)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 3386, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Co",
      "atlas.atomicNumber": 27,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 58.933, "unit": "g/mol" },
      "atlas.density": { "value": 8.9, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 100, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 17.9, "unit": "MS/m" }
      }
    },
    "atlas.element.nickel": {
      name: "Nickel (Ni)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 8611, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ni",
      "atlas.atomicNumber": 28,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 58.693, "unit": "g/mol" },
      "atlas.density": { "value": 8.908, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 90.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 14.3, "unit": "MS/m" }
      }
    },
    "atlas.element.copper": {
      name: "Copper (Cu)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 9824, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cu",
      "atlas.atomicNumber": 29,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 63.546, "unit": "g/mol" },
      "atlas.density": { "value": 8.96, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 401, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 59.6, "unit": "MS/m" }
      }
    },
    "atlas.element.zinc": {
      name: "Zinc (Zn)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 36520, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Zn",
      "atlas.atomicNumber": 30,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 65.38, "unit": "g/mol" },
      "atlas.density": { "value": 7.14, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 116, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 16.6, "unit": "MS/m" }
      }
    },
    "atlas.element.gallium": {
      name: "Gallium (Ga)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ga",
      "atlas.atomicNumber": 31,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 69.723, "unit": "g/mol" },
      "atlas.density": { "value": 5.91, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 40.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 7.1, "unit": "MS/m" }
      }
    },
    "atlas.element.germanium": {
      name: "Germanium (Ge)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ge",
      "atlas.atomicNumber": 32,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 72.63, "unit": "g/mol" },
      "atlas.density": { "value": 5.323, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 60.2, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.002, "unit": "MS/m" }
      }
    },
    "atlas.element.arsenic": {
      name: "Arsenic (As)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "As",
      "atlas.atomicNumber": 33,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 74.922, "unit": "g/mol" },
      "atlas.density": { "value": 5.727, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 50.2, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 3.3, "unit": "MS/m" }
      }
    },
    "atlas.element.selenium": {
      name: "Selenium (Se)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Se",
      "atlas.atomicNumber": 34,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 78.971, "unit": "g/mol" },
      "atlas.density": { "value": 4.81, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 0.52, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1e-07, "unit": "MS/m" }
      }
    },
    "atlas.element.bromine": {
      name: "Bromine (Br)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Br",
      "atlas.atomicNumber": 35,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "liquid",
      "atlas.weight": { "value": 79.904, "unit": "g/mol" },
      "atlas.density": { "value": 3.1, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 0.122, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.krypton": {
      name: "Krypton (Kr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Kr",
      "atlas.atomicNumber": 36,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 83.798, "unit": "g/mol" },
      "atlas.density": { "value": 3.749, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.00943, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.rubidium": {
      name: "Rubidium (Rb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Rb",
      "atlas.atomicNumber": 37,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 85.468, "unit": "g/mol" },
      "atlas.density": { "value": 1.532, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 58.2, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 8.3, "unit": "MS/m" }
      }
    },
    "atlas.element.strontium": {
      name: "Strontium (Sr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sr",
      "atlas.atomicNumber": 38,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 87.62, "unit": "g/mol" },
      "atlas.density": { "value": 2.64, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 35.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 7.7, "unit": "MS/m" }
      }
    },
    "atlas.element.yttrium": {
      name: "Yttrium (Y)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Y",
      "atlas.atomicNumber": 39,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 88.906, "unit": "g/mol" },
      "atlas.density": { "value": 4.472, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 17.2, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.8, "unit": "MS/m" }
      }
    },
    "atlas.element.zirconium": {
      name: "Zirconium (Zr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Zr",
      "atlas.atomicNumber": 40,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 91.224, "unit": "g/mol" },
      "atlas.density": { "value": 6.52, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 22.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 2.4, "unit": "MS/m" }
      }
    },
    "atlas.element.niobium": {
      name: "Niobium (Nb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Nb",
      "atlas.atomicNumber": 41,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 92.906, "unit": "g/mol" },
      "atlas.density": { "value": 8.57, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 53.7, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 6.7, "unit": "MS/m" }
      }
    },
    "atlas.element.molybdenum": {
      name: "Molybdenum (Mo)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Mo",
      "atlas.atomicNumber": 42,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 95.95, "unit": "g/mol" },
      "atlas.density": { "value": 10.28, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 138, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 18.7, "unit": "MS/m" }
      }
    },
    "atlas.element.technetium": {
      name: "Technetium (Tc)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Tc",
      "atlas.atomicNumber": 43,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 98.0, "unit": "g/mol" },
      "atlas.density": { "value": 11.0, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 50.6, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.ruthenium": {
      name: "Ruthenium (Ru)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ru",
      "atlas.atomicNumber": 44,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 101.07, "unit": "g/mol" },
      "atlas.density": { "value": 12.45, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 117, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 13.7, "unit": "MS/m" }
      }
    },
    "atlas.element.rhodium": {
      name: "Rhodium (Rh)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.47, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Rh",
      "atlas.atomicNumber": 45,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 102.91, "unit": "g/mol" },
      "atlas.density": { "value": 12.41, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 150, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 21.1, "unit": "MS/m" }
      }
    },
    "atlas.element.palladium": {
      name: "Palladium (Pd)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 3.32, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pd",
      "atlas.atomicNumber": 46,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 106.42, "unit": "g/mol" },
      "atlas.density": { "value": 12.023, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 71.8, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 9.5, "unit": "MS/m" }
      }
    },
    "atlas.element.cadmium": {
      name: "Cadmium (Cd)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cd",
      "atlas.atomicNumber": 48,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 112.41, "unit": "g/mol" },
      "atlas.density": { "value": 8.65, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 96.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 13.8, "unit": "MS/m" }
      }
    },
    "atlas.element.indium": {
      name: "Indium (In)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "In",
      "atlas.atomicNumber": 49,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 114.82, "unit": "g/mol" },
      "atlas.density": { "value": 7.31, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 81.8, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 12.5, "unit": "MS/m" }
      }
    },
    "atlas.element.tin": {
      name: "Tin (Sn)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 2683, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sn",
      "atlas.atomicNumber": 50,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 118.71, "unit": "g/mol" },
      "atlas.density": { "value": 7.265, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 66.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 9.1, "unit": "MS/m" }
      }
    },
    "atlas.element.antimony": {
      name: "Antimony (Sb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sb",
      "atlas.atomicNumber": 51,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 121.76, "unit": "g/mol" },
      "atlas.density": { "value": 6.697, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 24.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 2.5, "unit": "MS/m" }
      }
    },
    "atlas.element.tellurium": {
      name: "Tellurium (Te)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Te",
      "atlas.atomicNumber": 52,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 127.6, "unit": "g/mol" },
      "atlas.density": { "value": 6.24, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 1.97, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.001, "unit": "MS/m" }
      }
    },
    "atlas.element.iodine": {
      name: "Iodine (I)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "I",
      "atlas.atomicNumber": 53,
      "atlas.category": "reactive nonmetal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 126.9, "unit": "g/mol" },
      "atlas.density": { "value": 4.93, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 0.449, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1e-13, "unit": "MS/m" }
      }
    },
    "atlas.element.xenon": {
      name: "Xenon (Xe)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 60, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Xe",
      "atlas.atomicNumber": 54,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 131.29, "unit": "g/mol" },
      "atlas.density": { "value": 5.894, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.00565, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.caesium": {
      name: "Caesium (Cs)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cs",
      "atlas.atomicNumber": 55,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 132.91, "unit": "g/mol" },
      "atlas.density": { "value": 1.93, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 35.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 4.8, "unit": "MS/m" }
      }
    },
    "atlas.element.barium": {
      name: "Barium (Ba)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 6000, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ba",
      "atlas.atomicNumber": 56,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 137.33, "unit": "g/mol" },
      "atlas.density": { "value": 3.51, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 18.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 2.9, "unit": "MS/m" }
      }
    },
    "atlas.element.lanthanum": {
      name: "Lanthanum (La)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "La",
      "atlas.atomicNumber": 57,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 138.91, "unit": "g/mol" },
      "atlas.density": { "value": 6.162, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 13.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.6, "unit": "MS/m" }
      }
    },
    "atlas.element.cerium": {
      name: "Cerium (Ce)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ce",
      "atlas.atomicNumber": 58,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 140.12, "unit": "g/mol" },
      "atlas.density": { "value": 6.77, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 11.3, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.4, "unit": "MS/m" }
      }
    },
    "atlas.element.praseodymium": {
      name: "Praseodymium (Pr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pr",
      "atlas.atomicNumber": 59,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 140.91, "unit": "g/mol" },
      "atlas.density": { "value": 6.77, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 12.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.4, "unit": "MS/m" }
      }
    },
    "atlas.element.neodymium": {
      name: "Neodymium (Nd)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Nd",
      "atlas.atomicNumber": 60,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 144.24, "unit": "g/mol" },
      "atlas.density": { "value": 7.01, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 16.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.6, "unit": "MS/m" }
      }
    },
    "atlas.element.promethium": {
      name: "Promethium (Pm)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pm",
      "atlas.atomicNumber": 61,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 145.0, "unit": "g/mol" },
      "atlas.density": { "value": 7.26, "unit": "g/cm3" }
      }
    },
    "atlas.element.samarium": {
      name: "Samarium (Sm)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sm",
      "atlas.atomicNumber": 62,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 150.36, "unit": "g/mol" },
      "atlas.density": { "value": 7.52, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 13.3, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.1, "unit": "MS/m" }
      }
    },
    "atlas.element.europium": {
      name: "Europium (Eu)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Eu",
      "atlas.atomicNumber": 63,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 151.96, "unit": "g/mol" },
      "atlas.density": { "value": 5.264, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 13.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.1, "unit": "MS/m" }
      }
    },
    "atlas.element.gadolinium": {
      name: "Gadolinium (Gd)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Gd",
      "atlas.atomicNumber": 64,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 157.25, "unit": "g/mol" },
      "atlas.density": { "value": 7.9, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 10.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.77, "unit": "MS/m" }
      }
    },
    "atlas.element.terbium": {
      name: "Terbium (Tb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Tb",
      "atlas.atomicNumber": 65,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 158.93, "unit": "g/mol" },
      "atlas.density": { "value": 8.23, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 11.1, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.83, "unit": "MS/m" }
      }
    },
    "atlas.element.dysprosium": {
      name: "Dysprosium (Dy)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Dy",
      "atlas.atomicNumber": 66,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 162.5, "unit": "g/mol" },
      "atlas.density": { "value": 8.54, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 10.7, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.1, "unit": "MS/m" }
      }
    },
    "atlas.element.holmium": {
      name: "Holmium (Ho)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ho",
      "atlas.atomicNumber": 67,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 164.93, "unit": "g/mol" },
      "atlas.density": { "value": 8.79, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 16.2, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.1, "unit": "MS/m" }
      }
    },
    "atlas.element.erbium": {
      name: "Erbium (Er)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Er",
      "atlas.atomicNumber": 68,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 167.26, "unit": "g/mol" },
      "atlas.density": { "value": 9.07, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 14.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.2, "unit": "MS/m" }
      }
    },
    "atlas.element.thulium": {
      name: "Thulium (Tm)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Tm",
      "atlas.atomicNumber": 69,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 168.93, "unit": "g/mol" },
      "atlas.density": { "value": 9.32, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 16.9, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.4, "unit": "MS/m" }
      }
    },
    "atlas.element.ytterbium": {
      name: "Ytterbium (Yb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Yb",
      "atlas.atomicNumber": 70,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 173.05, "unit": "g/mol" },
      "atlas.density": { "value": 6.9, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 38.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 3.6, "unit": "MS/m" }
      }
    },
    "atlas.element.lutetium": {
      name: "Lutetium (Lu)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Lu",
      "atlas.atomicNumber": 71,
      "atlas.category": "lanthanide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 174.97, "unit": "g/mol" },
      "atlas.density": { "value": 9.84, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 16.4, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.8, "unit": "MS/m" }
      }
    },
    "atlas.element.hafnium": {
      name: "Hafnium (Hf)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Hf",
      "atlas.atomicNumber": 72,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 178.49, "unit": "g/mol" },
      "atlas.density": { "value": 13.31, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 23.0, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 3.3, "unit": "MS/m" }
      }
    },
    "atlas.element.tantalum": {
      name: "Tantalum (Ta)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ta",
      "atlas.atomicNumber": 73,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 180.95, "unit": "g/mol" },
      "atlas.density": { "value": 16.69, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 57.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 7.7, "unit": "MS/m" }
      }
    },
    "atlas.element.tungsten": {
      name: "Tungsten (W)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 1744, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "W",
      "atlas.atomicNumber": 74,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 183.84, "unit": "g/mol" },
      "atlas.density": { "value": 19.25, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 173, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 18.9, "unit": "MS/m" }
      }
    },
    "atlas.element.rhenium": {
      name: "Rhenium (Re)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Re",
      "atlas.atomicNumber": 75,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 186.21, "unit": "g/mol" },
      "atlas.density": { "value": 21.02, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 48.0, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 5.6, "unit": "MS/m" }
      }
    },
    "atlas.element.osmium": {
      name: "Osmium (Os)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Os",
      "atlas.atomicNumber": 76,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 190.23, "unit": "g/mol" },
      "atlas.density": { "value": 22.59, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 87.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 12.3, "unit": "MS/m" }
      }
    },
    "atlas.element.iridium": {
      name: "Iridium (Ir)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ir",
      "atlas.atomicNumber": 77,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 192.22, "unit": "g/mol" },
      "atlas.density": { "value": 22.56, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 147, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 19.7, "unit": "MS/m" }
      }
    },
    "atlas.element.platinum": {
      name: "Platinum (Pt)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 2.43, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pt",
      "atlas.atomicNumber": 78,
      "atlas.category": "transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 195.08, "unit": "g/mol" },
      "atlas.density": { "value": 21.45, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 71.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 9.4, "unit": "MS/m" }
      }
    },
    "atlas.element.mercury": {
      name: "Mercury (Hg)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Hg",
      "atlas.atomicNumber": 80,
      "atlas.category": "transition metal",
      "atlas.state": "liquid",
      "atlas.weight": { "value": 200.59, "unit": "g/mol" },
      "atlas.density": { "value": 13.534, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 8.3, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.04, "unit": "MS/m" }
      }
    },
    "atlas.element.thallium": {
      name: "Thallium (Tl)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Tl",
      "atlas.atomicNumber": 81,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 204.38, "unit": "g/mol" },
      "atlas.density": { "value": 11.85, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 46.1, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 6.2, "unit": "MS/m" }
      }
    },
    "atlas.element.lead": {
      name: "Lead (Pb)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 73810, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pb",
      "atlas.atomicNumber": 82,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 207.2, "unit": "g/mol" },
      "atlas.density": { "value": 11.34, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 35.3, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 4.8, "unit": "MS/m" }
      }
    },
    "atlas.element.bismuth": {
      name: "Bismuth (Bi)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 500, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Bi",
      "atlas.atomicNumber": 83,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 208.98, "unit": "g/mol" },
      "atlas.density": { "value": 9.78, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 7.97, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.77, "unit": "MS/m" }
      }
    },
    "atlas.element.polonium": {
      name: "Polonium (Po)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Po",
      "atlas.atomicNumber": 84,
      "atlas.category": "post-transition metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 209.0, "unit": "g/mol" },
      "atlas.density": { "value": 9.2, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 20, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.023, "unit": "MS/m" }
      }
    },
    "atlas.element.astatine": {
      name: "Astatine (At)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "At",
      "atlas.atomicNumber": 85,
      "atlas.category": "metalloid",
      "atlas.state": "solid",
      "atlas.weight": { "value": 210.0, "unit": "g/mol" },
      "atlas.thermalConductivity": { "value": 1.7, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.radon": {
      name: "Radon (Rn)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Rn",
      "atlas.atomicNumber": 86,
      "atlas.category": "noble gas",
      "atlas.state": "gas",
      "atlas.weight": { "value": 222.0, "unit": "g/mol" },
      "atlas.density": { "value": 9.73, "unit": "g/L" },
      "atlas.thermalConductivity": { "value": 0.00361, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0, "unit": "MS/m" }
      }
    },
    "atlas.element.francium": {
      name: "Francium (Fr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Fr",
      "atlas.atomicNumber": 87,
      "atlas.category": "alkali metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 223.0, "unit": "g/mol" },
      "atlas.thermalConductivity": { "value": 15, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.radium": {
      name: "Radium (Ra)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ra",
      "atlas.atomicNumber": 88,
      "atlas.category": "alkaline earth metal",
      "atlas.state": "solid",
      "atlas.weight": { "value": 226.0, "unit": "g/mol" },
      "atlas.density": { "value": 5.5, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 18.6, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 1.0, "unit": "MS/m" }
      }
    },
    "atlas.element.actinium": {
      name: "Actinium (Ac)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ac",
      "atlas.atomicNumber": 89,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 227.0, "unit": "g/mol" },
      "atlas.density": { "value": 10.07, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 12, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.thorium": {
      name: "Thorium (Th)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 40, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Th",
      "atlas.atomicNumber": 90,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 232.04, "unit": "g/mol" },
      "atlas.density": { "value": 11.72, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 54.0, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 6.7, "unit": "MS/m" }
      }
    },
    "atlas.element.protactinium": {
      name: "Protactinium (Pa)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pa",
      "atlas.atomicNumber": 91,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 231.04, "unit": "g/mol" },
      "atlas.density": { "value": 15.37, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 47, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.uranium": {
      name: "Uranium (U)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 596, // rateSource: market
      rateSource: "market",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "U",
      "atlas.atomicNumber": 92,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 238.03, "unit": "g/mol" },
      "atlas.density": { "value": 19.05, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 27.5, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 3.8, "unit": "MS/m" }
      }
    },
    "atlas.element.neptunium": {
      name: "Neptunium (Np)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Np",
      "atlas.atomicNumber": 93,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 237.0, "unit": "g/mol" },
      "atlas.density": { "value": 20.45, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 6.3, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.plutonium": {
      name: "Plutonium (Pu)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Pu",
      "atlas.atomicNumber": 94,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 244.0, "unit": "g/mol" },
      "atlas.density": { "value": 19.82, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 6.74, "unit": "W/(m*K)" },
      "atlas.electricalConductivity": { "value": 0.67, "unit": "MS/m" }
      }
    },
    "atlas.element.americium": {
      name: "Americium (Am)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Am",
      "atlas.atomicNumber": 95,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 243.0, "unit": "g/mol" },
      "atlas.density": { "value": 12.0, "unit": "g/cm3" },
      "atlas.thermalConductivity": { "value": 10, "unit": "W/(m*K)" }
      }
    },
    "atlas.element.curium": {
      name: "Curium (Cm)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cm",
      "atlas.atomicNumber": 96,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 247.0, "unit": "g/mol" },
      "atlas.density": { "value": 13.51, "unit": "g/cm3" }
      }
    },
    "atlas.element.berkelium": {
      name: "Berkelium (Bk)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Bk",
      "atlas.atomicNumber": 97,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 247.0, "unit": "g/mol" },
      "atlas.density": { "value": 14.78, "unit": "g/cm3" }
      }
    },
    "atlas.element.californium": {
      name: "Californium (Cf)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cf",
      "atlas.atomicNumber": 98,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 251.0, "unit": "g/mol" },
      "atlas.density": { "value": 15.1, "unit": "g/cm3" }
      }
    },
    "atlas.element.einsteinium": {
      name: "Einsteinium (Es)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Es",
      "atlas.atomicNumber": 99,
      "atlas.category": "actinide",
      "atlas.state": "solid",
      "atlas.weight": { "value": 252.0, "unit": "g/mol" },
      "atlas.density": { "value": 8.84, "unit": "g/cm3" }
      }
    },
    "atlas.element.fermium": {
      name: "Fermium (Fm)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Fm",
      "atlas.atomicNumber": 100,
      "atlas.category": "actinide",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 257.0, "unit": "g/mol" }
      }
    },
    "atlas.element.mendelevium": {
      name: "Mendelevium (Md)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Md",
      "atlas.atomicNumber": 101,
      "atlas.category": "actinide",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 258.0, "unit": "g/mol" }
      }
    },
    "atlas.element.nobelium": {
      name: "Nobelium (No)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "No",
      "atlas.atomicNumber": 102,
      "atlas.category": "actinide",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 259.0, "unit": "g/mol" }
      }
    },
    "atlas.element.lawrencium": {
      name: "Lawrencium (Lr)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Lr",
      "atlas.atomicNumber": 103,
      "atlas.category": "actinide",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 266.0, "unit": "g/mol" }
      }
    },
    "atlas.element.rutherfordium": {
      name: "Rutherfordium (Rf)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Rf",
      "atlas.atomicNumber": 104,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 267.0, "unit": "g/mol" }
      }
    },
    "atlas.element.dubnium": {
      name: "Dubnium (Db)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Db",
      "atlas.atomicNumber": 105,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 268.0, "unit": "g/mol" }
      }
    },
    "atlas.element.seaborgium": {
      name: "Seaborgium (Sg)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Sg",
      "atlas.atomicNumber": 106,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 269.0, "unit": "g/mol" }
      }
    },
    "atlas.element.bohrium": {
      name: "Bohrium (Bh)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Bh",
      "atlas.atomicNumber": 107,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 270.0, "unit": "g/mol" }
      }
    },
    "atlas.element.hassium": {
      name: "Hassium (Hs)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Hs",
      "atlas.atomicNumber": 108,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 269.0, "unit": "g/mol" }
      }
    },
    "atlas.element.meitnerium": {
      name: "Meitnerium (Mt)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Mt",
      "atlas.atomicNumber": 109,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 278.0, "unit": "g/mol" }
      }
    },
    "atlas.element.darmstadtium": {
      name: "Darmstadtium (Ds)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ds",
      "atlas.atomicNumber": 110,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 281.0, "unit": "g/mol" }
      }
    },
    "atlas.element.roentgenium": {
      name: "Roentgenium (Rg)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Rg",
      "atlas.atomicNumber": 111,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 282.0, "unit": "g/mol" }
      }
    },
    "atlas.element.copernicium": {
      name: "Copernicium (Cn)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Cn",
      "atlas.atomicNumber": 112,
      "atlas.category": "transition metal (predicted)",
      "atlas.state": "liquid (predicted)",
      "atlas.weight": { "value": 285.0, "unit": "g/mol" }
      }
    },
    "atlas.element.nihonium": {
      name: "Nihonium (Nh)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Nh",
      "atlas.atomicNumber": 113,
      "atlas.category": "post-transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 286.0, "unit": "g/mol" }
      }
    },
    "atlas.element.flerovium": {
      name: "Flerovium (Fl)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Fl",
      "atlas.atomicNumber": 114,
      "atlas.category": "post-transition metal (predicted)",
      "atlas.state": "gas (predicted)",
      "atlas.weight": { "value": 289.0, "unit": "g/mol" }
      }
    },
    "atlas.element.moscovium": {
      name: "Moscovium (Mc)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Mc",
      "atlas.atomicNumber": 115,
      "atlas.category": "post-transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 290.0, "unit": "g/mol" }
      }
    },
    "atlas.element.livermorium": {
      name: "Livermorium (Lv)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Lv",
      "atlas.atomicNumber": 116,
      "atlas.category": "post-transition metal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 293.0, "unit": "g/mol" }
      }
    },
    "atlas.element.tennessine": {
      name: "Tennessine (Ts)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Ts",
      "atlas.atomicNumber": 117,
      "atlas.category": "reactive nonmetal (predicted)",
      "atlas.state": "unknown (never observed in bulk quantity)",
      "atlas.weight": { "value": 294.0, "unit": "g/mol" }
      }
    },
    "atlas.element.oganesson": {
      name: "Oganesson (Og)",
      model: `https://${DOMAIN}/assets/badge.glb`,
      thumbnail: `https://${DOMAIN}/assets/badge.png`,
      fungible: true,
      presentation: "collectible",
      exchangeRate: 0.0005, // rateSource: tier-estimate
      rateSource: "tier-estimate",
      holdingCap: 500,
      properties: {
      "atlas.symbol": "Og",
      "atlas.atomicNumber": 118,
      "atlas.category": "noble gas (predicted)",
      "atlas.state": "solid (predicted)",
      "atlas.weight": { "value": 294.0, "unit": "g/mol" }
      }
    }
  };
};
