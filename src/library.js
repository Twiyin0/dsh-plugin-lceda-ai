// Component discovery: built-in catalogue, LCSC part lookup (real EasyEDA symbols),
// and inventory of parts already used in a project.
import { BUILTIN_SYMBOLS } from './symbol.js';
import { partFromApi } from './create.js';
import { readCache, writeCache } from './cache.js';

const API = 'https://easyeda.com/api/products';
// The standard edition editor talks to this host for its own component library.
const STD = 'https://lceda.cn/api/components';
const STD_VERSION = '6.5.51';
const cache = new Map();
const stdCache = new Map();

/** Offline catalogue search over the built-in symbols. */
export function findBuiltin(query = '') {
  const q = String(query).toLowerCase().trim();
  return Object.entries(BUILTIN_SYMBOLS)
    .filter(([key, entry]) => {
      if (!q) return true;
      const hay = [key, entry.title, entry.package, ...(entry.keywords ?? [])].join(' ').toLowerCase();
      return hay.includes(q);
    })
    .map(([key, entry]) => ({
      symbol: key,
      title: entry.title,
      prefix: entry.prefix,
      package: entry.package,
      pins: entry.spec.pins.length,
      defaultValue: entry.defaultValue,
    }));
}

export const isLcscNumber = (s) => /^C\d{3,}$/i.test(String(s).trim());

/** Canonical LCEDA standard-library names for the built-in symbols. */
export const STANDARD_EQUIVALENTS = {
  stc89c52rc: ['STC89C52RC', 'STC89C52'],
  resistor: ['R_0603_US', 'R_0603_EU'],
  capacitor: ['C_0603_US', 'C_0603_EU'],
  capacitor_pol: ['C_Tan_SMD_A_US', 'C_Tan_SMD_A_EU', 'CASE-A_3216'],
  crystal: ['HC-49S', 'XTAL', 'HC-49SMD'],
  switch: ['SW-SMD_4P', 'TS-1187A', 'K2-3.6x6.1'],
  led: ['LED-0603', 'LED0603', 'LED_0603'],
  header: ['HDR-M-2.54_1x5', 'HDR-M-2.54_1x2'],
};

/**
 * Known-good pinouts used to pick (and sanity-check) library symbols.
 *
 * Only parts whose pinout is unambiguous are listed: the point is to reject a
 * library symbol that draws the right package with the wrong pin names. Each
 * entry cites where the table comes from; a pin may carry several equivalent
 * names ("PC6/RESET"), which the matcher treats as a set.
 */
export const PINOUT_REFERENCES = {
  stc89c52rc: {
    package: 'DIP-40',
    source: 'STC89C51RC/RD+ datasheet 1.4 Pin Descriptions, p.7',
    pins: {
      1: 'P1.0', 2: 'P1.1', 3: 'P1.2', 4: 'P1.3', 5: 'P1.4', 6: 'P1.5', 7: 'P1.6', 8: 'P1.7',
      9: 'RST', 10: 'P3.0', 11: 'P3.1', 12: 'P3.2', 13: 'P3.3', 14: 'P3.4', 15: 'P3.5',
      16: 'P3.6', 17: 'P3.7', 18: 'XTAL2', 19: 'XTAL1', 20: 'GND',
      21: 'P2.0', 22: 'P2.1', 23: 'P2.2', 24: 'P2.3', 25: 'P2.4', 26: 'P2.5', 27: 'P2.6', 28: 'P2.7',
      29: 'PSEN', 30: 'ALE', 31: 'EA', 32: 'P0.7', 33: 'P0.6', 34: 'P0.5', 35: 'P0.4',
      36: 'P0.3', 37: 'P0.2', 38: 'P0.1', 39: 'P0.0', 40: 'VCC',
    },
    aliases: { RXD: 'P3.0', TXD: 'P3.1', 'RD#': 'P3.7', 'WR#': 'P3.6', INT0: 'P3.2', INT1: 'P3.3', T0: 'P3.4', T1: 'P3.5', T2: 'P1.0', T2EX: 'P1.1', EA: 'EA', VPP: 'EA', PROG: 'ALE', RST1: 'RST' },
  },
  ne555: {
    package: 'DIP-8',
    source: 'NE555/SE555 standard timer pinout (TI/ST datasheets)',
    pins: { 1: 'GND', 2: 'TRIG', 3: 'OUT', 4: 'RESET', 5: 'CTRL', 6: 'THR', 7: 'DIS', 8: 'VCC' },
    aliases: { CV: 'CTRL', CONT: 'CTRL', TRIGGER: 'TRIG', THRESHOLD: 'THR', DISCHARGE: 'DIS', OUT1: 'OUT' },
  },
  lm358: {
    package: 'DIP-8',
    source: 'LM358/LM2904 dual op-amp pinout (TI datasheet)',
    pins: { 1: 'OUT1', 2: 'IN1-', 3: 'IN1+', 4: 'GND', 5: 'IN2+', 6: 'IN2-', 7: 'OUT2', 8: 'VCC' },
    aliases: { VEE: 'GND', VCC1: 'VCC', 'IN1-': 'IN1-', 'IN1+': 'IN1+' },
  },
  hc595: {
    package: 'DIP-16',
    source: '74HC595 8-bit shift register pinout (Nexperia/TI datasheet)',
    pins: {
      1: 'QB', 2: 'QC', 3: 'QD', 4: 'QE', 5: 'QF', 6: 'QG', 7: 'QH', 8: 'GND',
      9: "QH'", 10: 'SRCLR', 11: 'SRCLK', 12: 'RCLK', 13: 'OE', 14: 'SER', 15: 'QA', 16: 'VCC',
    },
    aliases: { 'QH*': "QH'", RCLR: 'SRCLR', SRCLR1: 'SRCLR', SHCP: 'SRCLK', STCP: 'RCLK', DS: 'SER', Q0: 'QA', Q1: 'QB', Q2: 'QC', Q3: 'QD', Q4: 'QE', Q5: 'QF', Q6: 'QG', Q7: 'QH', G: 'OE', OE1: 'OE' },
  },
  atmega328p: {
    package: 'DIP-28',
    source: 'ATmega328P PDIP pinout (Microchip datasheet, 28-pin PDIP)',
    pins: {
      1: 'PC6', 2: 'PD0', 3: 'PD1', 4: 'PD2', 5: 'PD3', 6: 'PD4', 7: 'VCC', 8: 'GND',
      9: 'PB6', 10: 'PB7', 11: 'PD5', 12: 'PD6', 13: 'PD7', 14: 'PB0', 15: 'PB1', 16: 'PB2',
      17: 'PB3', 18: 'PB4', 19: 'PB5', 20: 'AVCC', 21: 'AREF', 22: 'GND', 23: 'PC0', 24: 'PC1',
      25: 'PC2', 26: 'PC3', 27: 'PC4', 28: 'PC5',
    },
    aliases: { RESET: 'PC6', XTAL1: 'PB6', XTAL2: 'PB7', RXD: 'PD0', TXD: 'PD1', INT0: 'PD2', INT1: 'PD3', T0: 'PD4', T1: 'PD5', AIN0: 'PD6', AIN1: 'PD7', ICP1: 'PB0', OC1A: 'PB1', SS: 'PB2', MOSI: 'PB3', MISO: 'PB4', SCK: 'PB5', ADC0: 'PC0', ADC1: 'PC1', ADC2: 'PC2', ADC3: 'PC3', SDA: 'PC4', SCL: 'PC5', A4: 'PC4', A5: 'PC5' },
  },
  ams1117: {
    package: 'SOT-223',
    source: 'AMS1117-3.3 SOT-223 pinout (AMS datasheet; tab is VOUT)',
    pins: { 1: 'GND', 2: 'VOUT', 3: 'VIN' },
    aliases: { ADJ: 'GND', TAB: 'VOUT', OUT: 'VOUT', IN: 'VIN', VI: 'VIN', VO: 'VOUT' },
  },
  ch340g: {
    package: 'SOP-16',
    source: 'CH340G USB-UART pinout (WCH datasheet)',
    pins: {
      1: 'GND', 2: 'TXD', 3: 'RXD', 4: 'V3', 5: 'UD+', 6: 'UD-', 7: 'XI', 8: 'XO',
      9: 'CTS#', 10: 'DSR#', 11: 'RI#', 12: 'DCD#', 13: 'DTR#', 14: 'RTS#', 15: 'R232', 16: 'VCC',
    },
    aliases: { DPLUS: 'UD+', DMINUS: 'UD-', XIN: 'XI', XOUT: 'XO', TXD1: 'TXD', RXD1: 'RXD', V33: 'V3', V3V3: 'V3' },
  },
};

/** Map a symbol name / library title onto a reference table. */
const PINOUT_MATCHERS = [
  [/^(stc89c5|stc89le5|stc89c52)/i, 'stc89c52rc'],
  [/^(ne|se|lm|tlc|icm|na)?\s*555/i, 'ne555'],
  [/^(lm|lm2904|ne|rc|ts|mc|ua)?\s*358|^(lm2904)/i, 'lm358'],
  [/^(sn)?74(hc|hct|ls)?595|^hc595/i, 'hc595'],
  [/^atmega328/i, 'atmega328p'],
  [/^ams1117/i, 'ams1117'],
  [/^(ch|ch340|ch340g|ch341)/i, 'ch340g'],
];

/** Resolve a reference by built-in key, library title, or part number. */
export function findPinoutReference(nameOrKey) {
  const key = String(nameOrKey ?? '');
  if (PINOUT_REFERENCES[key]) return { key, ref: PINOUT_REFERENCES[key] };
  for (const [re, refKey] of PINOUT_MATCHERS) {
    if (re.test(key)) return { key: refKey, ref: PINOUT_REFERENCES[refKey] };
  }
  return null;
}

/** Pin number + name of one `P~` record. */
export function pinInfoOf(record) {
  const blocks = String(record).split('^^');
  const head = blocks[0].split('~');
  const nameBlock = (blocks[3] ?? '').split('~');
  return { number: String(head[3] ?? '').trim(), name: String(nameBlock[4] ?? '').trim() };
}

/**
 * All the names a pin may legitimately carry, upper-cased and de-hashed.
 * "P3.0(RXD)/TXD" -> {"P3.0", "RXD", "TXD"}; slash, parentheses and trailing
 * hash marks are the three styles LCEDA libraries actually use.
 */
function pinTokens(name, ref) {
  const tokens = new Set();
  const push = (raw) => {
    const t = String(raw ?? '').toUpperCase().replace(/[#*\s]+/g, '').trim();
    if (!t) return;
    tokens.add(t);
    const alias = ref?.aliases?.[t];
    if (alias) tokens.add(String(alias).toUpperCase().replace(/[#*\s]+/g, ''));
  };
  const text = String(name ?? '');
  for (const part of text.split('/')) {
    const m = /^([^(]+)(?:\(([^)]*)\))?/.exec(part.trim());
    if (m) { push(m[1]); if (m[2]) for (const alt of m[2].split(/[,/]/)) push(alt); }
    else push(part);
  }
  // a GPIO name like P1.0 may be written P1_0 or P10 in some libraries
  for (const t of [...tokens]) {
    const gpio = /^P(\d)[._](\d)$/.exec(t);
    if (gpio) tokens.add(`P${gpio[1]}${gpio[2]}`);
  }
  return tokens;
}

/**
 * Supply rails are named differently by every library; VCC/VDD/VIN all mean the
 * positive rail of a small part, GND/VSS/VEE the return. Keep analog rails
 * (AVCC, VDDA, VBAT, VREF) out of the equivalence so they stay distinguishable.
 */
const SUPPLY_GROUPS = [
  new Set(['VCC', 'VDD', 'VIN', 'VS', 'V+', 'VDDIO']),
  new Set(['GND', 'VSS', 'VEE', '0V', 'GNDA']),
];
const supplyGroup = (token) => SUPPLY_GROUPS.findIndex((g) => g.has(token));

/** Whether two pin names denote the same pin. */
function samePin(a, b, ref) {
  const ta = pinTokens(a, ref);
  const tb = pinTokens(b, ref);
  for (const t of ta) if (tb.has(t)) return true;
  // VCC vs VDD, GND vs VSS: same rail, different library convention
  for (const t of ta) {
    const g = supplyGroup(t);
    if (g === -1) continue;
    for (const u of tb) if (supplyGroup(u) === g) return true;
  }
  return false;
}

/**
 * Compare a symbol's pin names with a known reference pinout.
 * @returns {{total:number, matched:number, ratio:number, mismatches:Array}}
 */
export function validatePinout(doc, keyOrName) {
  const found = findPinoutReference(keyOrName);
  const ref = found?.ref;
  if (!ref) return { total: 0, matched: 0, ratio: 1, mismatches: [], unknown: true };
  const pins = (doc?.shape ?? []).filter((r) => String(r).startsWith('P~')).map(pinInfoOf);
  let matched = 0; const mismatches = [];
  for (const p of pins) {
    const want = ref.pins[p.number];
    if (!want) continue;
    if (samePin(p.name, want, ref)) matched++;
    else mismatches.push({ pin: p.number, got: p.name, want });
  }
  const total = Object.keys(ref.pins).length;
  return { total, matched, ratio: matched / total, mismatches, source: ref.source, reference: found.key };
}

/** Heuristic drawing quality: real symbols have visible pin stubs and a body that
 *  spans the pin rows. Box-only or mis-proportioned symbols score low. */
export function symbolQuality(doc) {
  const rects = (doc?.shape ?? []).filter((r) => String(r).startsWith('R~')).map((r) => {
    const a = String(r).split('~');
    return { x: +a[1], y: +a[2], w: +a[5], h: +a[6] };
  }).sort((a, b) => b.w * b.h - a.w * a.h);
  const pins = (doc?.shape ?? []).filter((r) => String(r).startsWith('P~')).map((r) => {
    const h = String(r).split('^^')[0].split('~');
    return { x: +h[4], y: +h[5] };
  });
  if (!rects.length || pins.length < 2) return 0;
  const body = rects[0];
  const spanX = Math.max(...pins.map((p) => p.x)) - Math.min(...pins.map((p) => p.x));
  const spanY = Math.max(...pins.map((p) => p.y)) - Math.min(...pins.map((p) => p.y));
  const stubX = spanX ? (spanX - body.w) / 2 : 0;
  const stubY = spanY ? (body.h - spanY) / 2 : 0;
  let q = 0;
  if (body.h >= spanY * 0.98) q += 2;          // body spans the pin rows
  if (stubX >= 4 && stubX <= 40) q += 2;       // visible pin stubs
  if (stubY >= 4) q += 1;                      // breathing room above/below
  if (body.w >= 40 && body.h >= 40) q += 1;    // not a tiny box
  return q;
}

const stdBody = (wd) => new URLSearchParams({
  type: '3', 'doctype[]': '2', uid: 'user', returnListStyle: 'classifyarr', wd, version: STD_VERSION,
});

/** Search the LCEDA standard library (the one the editor's 元件库 panel uses). */
export async function searchStandard(wd, { timeoutMs = 15000 } = {}) {
  const q = String(wd ?? '').trim();
  if (q.length < 2) return [];
  if (stdCache.has(q)) return stdCache.get(q);
  const cachedHits = await readCache('search', q);
  if (cachedHits) { stdCache.set(q, cachedHits); return cachedHits; }
  let res;
  try {
    res = await fetch(`${STD}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'lceda-ai/0.2', accept: 'application/json' },
      body: stdBody(q),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`cannot reach the LCEDA standard library (${e.message})`);
  }
  if (!res.ok) throw new Error(`standard library search failed: HTTP ${res.status}`);
  const body = await res.json();
  const lists = body?.result?.lists ?? {};
  const out = [];
  for (const [bucket, items] of Object.entries(lists)) {
    for (const c of items ?? []) {
      // dataStr arrives as an object for some buckets and as a JSON string for others
      let doc = c.dataStr ?? null;
      if (typeof doc === 'string') {
        try { doc = JSON.parse(doc); } catch { doc = null; }
      }
      out.push({
        bucket,                                  // lcsc | easyeda | user | mine | following
        uuid: c.uuid,
        title: c.title,
        package: doc?.head?.c_para?.package ?? '',
        pins: (doc?.shape ?? []).filter((r) => String(r).startsWith('P~')).length,
        lcsc: c.lcsc?.number ?? '',
        doc,
      });
    }
  }
  stdCache.set(q, out);
  await writeCache('search', q, out);
  return out;
}

/** Fetch one standard-library component by uuid (returns a placement-ready part). */
export async function fetchStandard(uuid, { timeoutMs = 15000 } = {}) {
  const key = String(uuid);
  if (cache.has(`std:${key}`)) return cache.get(`std:${key}`);
  const cachedDoc = await readCache('std', key);
  if (cachedDoc) {
    const part = { doc: cachedDoc, title: cachedDoc.head?.c_para?.name ?? key, uuid: key, source: 'standard' };
    cache.set(`std:${key}`, part);
    return part;
  }
  let res;
  try {
    res = await fetch(`${STD}/${key}?version=${STD_VERSION}`, {
      headers: { 'user-agent': 'lceda-ai/0.2', accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new Error(`cannot reach the LCEDA standard library (${e.message})`);
  }
  if (!res.ok) throw new Error(`standard library fetch failed: HTTP ${res.status} for ${key}`);
  const body = await res.json();
  const r = body?.result;
  if (!r?.dataStr) throw new Error(`standard component ${key} has no symbol`);
  const doc = typeof r.dataStr === 'string' ? JSON.parse(r.dataStr) : r.dataStr;
  const part = {
    doc: {
      ...doc,
      package: doc.head?.c_para?.package ?? '',
      lcsc: r.lcsc?.number ?? '',
      mfrPart: r.title ?? '',
    },
    title: r.title ?? key,
    uuid: r.uuid ?? key,
    source: 'standard',
  };
  cache.set(`std:${key}`, part);
  await writeCache('std', key, part.doc);
  return part;
}

/**
 * Resolve a standard-library part for a built-in symbol key.
 * Picks the first candidate title whose pin count matches what the caller needs.
 */
/** Number of pins in a fetched symbol document. */
export function pinCountOf(doc) {
  return (doc?.shape ?? []).filter((r) => String(r).startsWith('P~')).length;
}

export async function resolveStandard(symbol, { pins } = {}) {
  const candidates = STANDARD_EQUIVALENTS[symbol];
  if (!candidates) throw new Error(`no standard-library equivalent for "${symbol}"`);
  let best = null;
  for (const title of candidates) {
    let hits;
    try { hits = await searchStandard(title); } catch { continue; }
    const exact = hits.filter((h) => h.title.toLowerCase() === title.toLowerCase());
    const loose = hits.filter((h) => h.title.toLowerCase().includes(title.toLowerCase().split('_')[0]));
    for (const hit of [...exact, ...loose]) {
      let part;
      try { part = await fetchStandard(hit.uuid); } catch { continue; }
      const n = pinCountOf(part.doc);
      if (pins && n !== pins) continue;   // the search payload is a stub: filter after fetching
      if (!n) continue;                   // box-only placeholder, not a real symbol
      // Symbols for the same part are not equally good: prefer the one whose pin
      // names agree with the datasheet, and never return a clearly wrong pinout.
      const check = validatePinout(part.doc, symbol);
      if (!check.unknown) {
        part.pinout = check;
        if (check.ratio < 0.75) continue;
        const score = check.ratio * 10 + symbolQuality(part.doc);
        part.pinout = { ...check, score };
        if (!best || score > best.pinout.score) best = part;
        if (check.ratio === 1 && symbolQuality(part.doc) >= 5) return part;
        continue;
      }
      return part;
    }
  }
  return best;
}

/** Resolve a standard-library part by its exact title (e.g. "R_0603_US"). */
export async function resolveStandardByTitle(title, { pins } = {}) {
  const q = String(title ?? '').trim();
  if (!q) return null;
  let hits = [];
  try { hits = await searchStandard(q); } catch { return null; }
  // Many users upload the same symbol with stray packages; the most common
  // package among the exact-title hits is almost always the real one.
  const freq = new Map();
  for (const h of hits) if (h.title.toLowerCase() === q.toLowerCase()) freq.set(h.package, (freq.get(h.package) ?? 0) + 1);
  const byFreq = (a, b) => (freq.get(b.package) ?? 0) - (freq.get(a.package) ?? 0);
  const ordered = [
    ...hits.filter((h) => h.title.toLowerCase() === q.toLowerCase()).sort(byFreq),
    ...hits.filter((h) => h.title.toLowerCase().includes(q.toLowerCase())).sort(byFreq),
  ];
  for (const hit of ordered) {
    let part;
    try { part = await fetchStandard(hit.uuid); } catch { continue; }
    const n = pinCountOf(part.doc);
    if (!n) continue;
    if (pins && n !== pins) continue;
    return part;
  }
  return null;
}

const isUuid = (s) => /^[0-9a-f]{32}$/i.test(String(s).trim());

/**
 * One entry point for "give me this part": uuid, LCSC number, built-in key,
 * or a standard-library title. Standard library is always tried first.
 */
export async function resolvePart(what, { pins, preferStandard = true } = {}) {
  const q = String(what ?? '').trim();
  if (!q) throw new Error('resolvePart needs a part identifier');
  if (isUuid(q)) return fetchStandard(q);
  if (isLcscNumber(q)) {
    if (preferStandard) {
      const std = await resolveStandardByTitle(q, { pins }).catch(() => null);
      if (std) return std;
    }
    return fetchPart(q);
  }
  if (BUILTIN_SYMBOLS[q] && preferStandard) {
    const std = await resolveStandard(q, { pins });
    if (std) return std;
  }
  return (await resolveStandardByTitle(q, { pins })) ?? null;
}

/** Best-effort: standard library first, then the LCSC product API. */
export async function fetchPreferred(spec) {
  const { symbol, lcsc, standardUuid, pins } = spec;
  if (standardUuid) return fetchStandard(standardUuid);
  if (symbol) {
    const std = await resolveStandard(symbol, { pins });
    if (std) return std;
  }
  if (lcsc) return fetchPart(lcsc);
  return null;
}

/**
 * Fetch a real part (symbol + metadata) by LCSC part number.
 * Uses the same endpoint the standard edition editor calls.
 */
export async function fetchPart(lcsc, { timeoutMs = 15000 } = {}) {
  const key = String(lcsc).trim().toUpperCase();
  if (!isLcscNumber(key)) throw new Error(`"${lcsc}" is not an LCSC part number (expected Cnnnnnn)`);
  if (cache.has(key)) return cache.get(key);
  const url = `${API}/${key}/components?version=6.5.2`;
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': 'lceda-ai/0.2', accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(`cannot reach the LCSC library (${e.message}); built-in symbols still work offline`);
  }
  if (!res.ok) throw new Error(`LCSC lookup failed: HTTP ${res.status} for ${key}`);
  const body = await res.json();
  if (!body?.success || !body.result?.dataStr) throw new Error(`LCSC part ${key} not found or has no symbol`);
  const part = partFromApi(body.result);
  part.title = body.result.title ?? key;
  cache.set(key, part);
  return part;
}

/** List parts already used in one or more schematic files (offline inventory). */
export async function partsInFiles(files, parseDocument) {
  const fs = await import('node:fs/promises');
  const out = [];
  for (const file of files) {
    try {
      const doc = parseDocument(await fs.readFile(file, 'utf8'));
      for (const c of doc.components) {
        if (c.isFrame) continue;
        out.push({
          from: file,
          ref: c.designator,
          value: c.value,
          package: c.package,
          lcsc: c.lcscPart,
          mfrPart: c.mfrPart,
          pins: c.pins.length,
        });
      }
    } catch { /* ignore unreadable file */ }
  }
  return out;
}

/**
 * Unified search used by the tool: builtin catalogue, LCSC number lookup, project inventory.
 * @returns {Promise<object>} structured search result
 */
export async function searchComponents({ query = '', files = [], parseDocument }) {
  const result = { query, builtin: [], online: null, inventory: [], notes: [] };
  result.builtin = findBuiltin(query).slice(0, 30);
  if (query && query.length >= 2 && !isLcscNumber(query)) {
    try {
      // many users upload the same symbol: keep one per title+package
      const seen = new Set();
      const hits = (await searchStandard(query)).filter((h) => {
        const key = `${h.title}|${h.package}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 12);
      result.standard = hits.map((h) => ({
        uuid: h.uuid, title: h.title, package: h.package, pins: h.pins, lcsc: h.lcsc, bucket: h.bucket,
      }));
    } catch (e) { result.notes.push(e.message); }
  }
  if (isLcscNumber(query)) {
    try {
      const part = await fetchPart(query);
      result.online = {
        lcsc: part.lcsc,
        title: part.title,
        package: part.doc.package,
        mfrPart: part.doc.mfrPart,
        pins: (part.doc.shape ?? []).filter((s) => String(s).startsWith('P~')).length,
        symbol: part.doc.shape,
      };
    } catch (e) {
      result.notes.push(e.message);
    }
  } else if (query) {
    if (!result.standard?.length) result.notes.push('no standard-library match; pass an LCSC part number (e.g. C14047) or a standard uuid');
  }
  if (files.length && parseDocument) {
    const inv = await partsInFiles(files, parseDocument);
    const q = String(query).toLowerCase();
    result.inventory = inv.filter((p) => !q || [p.ref, p.value, p.package, p.lcsc, p.mfrPart].join(' ').toLowerCase().includes(q));
  }
  return result;
}
