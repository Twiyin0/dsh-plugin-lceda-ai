// Footprint management: find the footprint behind a symbol, keep an offline
// index, and check that a symbol's pin numbers line up with the footprint's pads.
//
// The link is the product API's `packageDetail` (docType 4) - the schematic
// symbol and the PCB footprint are separate library documents, and nothing else
// in the data says which footprint belongs to which symbol.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchStandard, fetchPart, searchStandard } from '../library.js';
import { readCache, writeCache } from '../cache.js';
import { parsePcb, readPcbFile } from './parser.js';

/** { uuid, title } of the footprint referenced by a fetched part, or null. */
export function footprintRefOf(part) {
  const pd = part?.doc?.packageDetail ?? part?.packageDetail;
  if (!pd?.uuid) return null;
  return { uuid: pd.uuid, title: pd.title ?? part?.doc?.package ?? '', docType: pd.docType };
}

/** Package name recorded on a symbol (c_para.package, else the part's package). */
export function packageOf(part) {
  const doc = part?.doc ?? part ?? {};
  return doc.head?.c_para?.package ?? doc.package ?? '';
}

/** LCSC number recorded on a symbol. */
export function lcscOf(part) {
  const doc = part?.doc ?? part ?? {};
  return doc.head?.c_para?.['Supplier Part'] ?? doc.lcsc ?? '';
}

/**
 * Fetch and parse one footprint document (cached on disk; pass `{ refresh: true }`
 * or set LCEDA_NO_CACHE=1 to bypass).
 */
export async function fetchFootprint(uuid, { title = '', refresh = false } = {}) {
  const key = String(uuid);
  if (!refresh) {
    const cached = await readCache('fp', key);
    if (cached) return { uuid: key, title: title || cached.title || '', model: parsePcb(cached.doc), fromCache: true };
  }
  const part = await fetchStandard(key);
  const doc = part.doc;
  const resolvedTitle = title || doc?.head?.c_para?.package || part.title || '';
  await writeCache('fp', key, { doc, title: resolvedTitle });
  return { uuid: key, title: resolvedTitle, model: parsePcb(doc), fromCache: false };
}

/** Symbol (LCSC number) -> footprint document. */
export async function fetchFootprintForLcsc(lcsc, opts = {}) {
  const part = await fetchPart(lcsc);
  const ref = footprintRefOf(part);
  if (!ref) {
    return { uuid: '', title: '', model: null, error: `${lcsc} (${part.title}) 没有关联封装(packageDetail 缺失)` };
  }
  const fp = await fetchFootprint(ref.uuid, { title: ref.title, ...opts });
  return { ...fp, part, ref };
}

/** Pin numbers + names of a schematic symbol document (docType 2) or LIB record. */
export function symbolPins(doc) {
  const records = [];
  for (const raw of doc?.shape ?? doc?.shapes ?? []) {
    const str = String(raw);
    if (str.startsWith('P~')) records.push(str);
    else if (str.startsWith('LIB~')) {
      for (const sub of str.split('#@$').slice(1)) if (sub.startsWith('P~')) records.push(sub);
    }
  }
  return records.map((r) => {
    const head = r.split('^^')[0].split('~');
    const nameBlock = (r.split('^^')[3] ?? '').split('~');
    return { number: String(head[3] ?? '').trim(), name: String(nameBlock[4] ?? '').trim(), orient: Number(head[6]) || 0 };
  });
}

/**
 * Smallest pad pitch of a footprint, in mm - the number that tells a human
 * whether the package can actually be routed (0.8 mm LQFP vs 2.54 mm DIP).
 */
export function minPitchMm(model) {
  const pads = (model?.footprints ?? []).flatMap((f) => f.pads ?? []);
  if (pads.length < 2) return null;
  const xs = [...new Set(pads.map((p) => p.x))].sort((a, b) => a - b);
  const ys = [...new Set(pads.map((p) => p.y))].sort((a, b) => a - b);
  const gaps = [];
  for (const list of [xs, ys]) for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] > 0.5) gaps.push(list[i] - list[i - 1]);
  if (!gaps.length) return null;
  return +(Math.min(...gaps) * 0.254).toFixed(3);
}

/** Pad numbers of a parsed footprint model. */
export function padNumbers(model) {
  return (model?.footprints ?? []).flatMap((f) => f.pads.map((p) => String(p.number).trim()));
}

/**
 * Check that every symbol pin has a footprint pad and vice versa.
 *
 * `missing` (a pin with no pad) is a real error - the part cannot be soldered.
 * `extra` (a pad with no pin) is usually fine: thermal pads, shield pads and
 * mechanical pads legitimately have no schematic pin.
 */
export function checkMapping(pins, pads, { packageName = '', footprintPackage = '' } = {}) {
  const pinNums = pins.map((p) => String(p.number).trim()).filter(Boolean);
  const padNums = pads.map((p) => String(p).trim()).filter(Boolean);
  const pinSet = new Set(pinNums);
  const padSet = new Set(padNums);
  const missing = [...pinSet].filter((n) => !padSet.has(n));
  const extra = [...padSet].filter((n) => !pinSet.has(n));
  const duplicates = padNums.filter((n, i) => padNums.indexOf(n) !== i);
  return {
    ok: missing.length === 0 && pinNums.length > 0,
    symbolPins: pinNums.length,
    footprintPads: padNums.length,
    missing,
    extra,
    duplicatePads: [...new Set(duplicates)],
    packageName,
    footprintPackage,
    packageMatches: !packageName || !footprintPackage || packageName === footprintPackage,
  };
}

/** Map every component of a schematic to a footprint + mapping verdict. */
export async function mapSchematic(doc, { refresh = false, offline = false } = {}) {
  const rows = [];
  for (const c of doc.components ?? []) {
    const cPara = c.cPara ?? {};
    // parseDocument() already lifts these out of c_para; raw documents may not
    const lcsc = c.lcscPart ?? cPara['Supplier Part'] ?? c.lcsc ?? '';
    const pkg = c.package ?? cPara.package ?? '';
    const row = { ref: c.designator, value: c.value ?? cPara.Value ?? cPara.value ?? '', package: pkg, lcsc, footprint: '', status: '', detail: '' };
    const pins = c.pins?.length ? c.pins.map((p) => ({ number: p.number, name: p.name })) : symbolPins({ shape: c.libRecords ?? [] });
    row.pins = pins.length;
    if (!lcsc) {
      // standard-library symbols carry no LCSC number: resolve by package name
      if (!pkg) {
        row.status = 'no-package';
        row.detail = '既没有立创编号也没有封装名';
        rows.push(row);
        continue;
      }
      try {
        const fp = await resolveFootprintByPackage(pkg, { pins, refresh });
        if (!fp.model) {
          row.status = 'no-footprint';
          row.detail = fp.error ?? '';
          rows.push(row);
          continue;
        }
        row.footprint = fp.title || fp.uuid;
        row.footprintUuid = fp.uuid;
        row.via = 'package';
        row.check = fp.check;
        row.status = fp.check?.ok ? (fp.check.extra.length ? 'ok-extra' : 'ok') : 'mismatch';
        row.detail = fp.check?.ok
          ? (fp.check.extra.length ? `按封装名匹配「${pkg}」;封装多出焊盘 ${fp.check.extra.join(',')}` : `按封装名匹配「${pkg}」;引脚与焊盘一一对应`)
          : `按封装名匹配「${pkg}」;封装缺少焊盘 ${(fp.check?.missing ?? []).join(',')}`;
      } catch (e) {
        row.status = 'error';
        row.detail = e.message;
      }
      rows.push(row);
      continue;
    }
    try {
      const fp = await fetchFootprintForLcsc(lcsc, { refresh });
      if (!fp.model) {
        row.status = 'no-footprint';
        row.detail = fp.error ?? '';
        rows.push(row);
        continue;
      }
      row.footprint = fp.title || fp.uuid;
      row.footprintUuid = fp.uuid;
      row.via = 'lcsc';
      const check = checkMapping(pins, padNumbers(fp.model), { packageName: pkg, footprintPackage: fp.model.cPara?.package ?? '' });
      row.check = check;
      row.status = check.ok ? (check.extra.length ? 'ok-extra' : 'ok') : 'mismatch';
      row.detail = check.ok
        ? (check.extra.length ? `封装多出焊盘 ${check.extra.join(',')}(可能是散热/固定盘)` : '引脚与焊盘一一对应')
        : `封装缺少焊盘 ${check.missing.join(',')}`;
    } catch (e) {
      row.status = 'error';
      row.detail = e.message;
    }
    rows.push(row);
  }
  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.status === 'ok' || r.status === 'ok-extra').length,
    mismatch: rows.filter((r) => r.status === 'mismatch').length,
    missing: rows.filter((r) => r.status === 'no-footprint' || r.status === 'no-lcsc' || r.status === 'no-package' || r.status === 'error').length,
  };
  return { rows, summary };
}

/** Search the standard library's footprint category (doctype 4). */
export async function searchFootprints(query, { limit = 8 } = {}) {
  const hits = await searchStandard(query, { doctype: 4 });
  return hits.slice(0, limit).map((h) => ({ uuid: h.uuid, title: h.title, package: h.doc?.head?.c_para?.package ?? '', docType: h.doc?.head?.docType ?? '' }));
}

/**
 * Resolve a footprint from a package name alone (for standard-library symbols
 * that carry no LCSC number): try the candidates and keep the first whose pads
 * actually cover the symbol's pins.
 */
export async function resolveFootprintByPackage(pkg, { pins = [], limit = 8, refresh = false } = {}) {
  const wanted = new Set(pins.map((p) => String(p.number).trim()));
  let candidates = [];
  try {
    candidates = await searchFootprints(pkg, { limit });
  } catch (e) {
    return { uuid: '', title: '', model: null, error: e.message, tried: 0 };
  }
  let tried = 0;
  let best = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    if (!c.uuid) continue;
    try {
      const fp = await fetchFootprint(c.uuid, { title: c.title, refresh });
      tried++;
      const check = checkMapping(pins, padNumbers(fp.model), { packageName: pkg, footprintPackage: fp.model.cPara?.package ?? '' });
      if (!check.ok) continue;
      // Score instead of taking the first hit: a 44-pad LQFP also "covers" a
      // 40-pin symbol, but it is the wrong package - an exact pad set wins.
      const extras = check.extra.length;
      const score = extras * 10 + Math.abs(check.footprintPads - check.symbolPins) + (check.packageMatches ? 0 : 2);
      if (score < bestScore) {
        bestScore = score;
        best = { ...fp, check, tried, extras };
      }
      if (score === 0) break;
    } catch {
      // unreadable candidate: keep looking
    }
  }
  if (best) {
    return {
      ...best,
      tried,
      note: best.extras ? `最接近的封装仍多出 ${best.extras} 个焊盘(散热/固定盘)` : undefined,
    };
  }
  return { uuid: '', title: '', model: null, error: `标准库里没有可用于 ${pkg} 的封装`, tried };
}

/** Index footprint documents in a folder by package name and uuid (offline). */
export async function footprintIndex(dir) {
  const byPackage = new Map();
  const byUuid = new Map();
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /\.(json|epcb)$/i.test(f)).map((f) => path.join(dir, f));
  } catch {
    return { byPackage, byUuid, files: 0 };
  }
  for (const file of files) {
    try {
      const model = await readPcbFile(file);
      // only real footprint documents belong in the index
      if (!model.isFootprint || (!model.counts.pads && !model.footprints.length)) continue;
      const pkg = model.cPara.package || model.cPara.name || path.basename(file);
      const entry = { file, package: pkg, uuid: model.head?.uuid ?? '', pads: model.counts.pads };
      byPackage.set(pkg, entry);
      if (entry.uuid) byUuid.set(entry.uuid, entry);
    } catch {
      // not a footprint document: skip
    }
  }
  return { byPackage, byUuid, files: files.length };
}
