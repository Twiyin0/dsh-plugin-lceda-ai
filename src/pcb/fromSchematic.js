// Schematic -> PCB: place every component's footprint and carry the netlist over.
//
// In the standard edition a board is its own document; connectivity lives in the
// `net` field of each PAD record (plus tracks), so "transferring the netlist"
// means resolving each symbol pin to a footprint pad and stamping the net name
// on it.
//
// Symbol pin numbers and footprint pad numbers do not always agree (an LED
// symbol has pins 1/2 while its footprint pads are C/A). When the numbers match
// we map by number; otherwise we fall back to document order and say so.
import { parseDocument } from '../parser.js';
import { extractNetlist } from '../netlist.js';
import { mmToUnit, toMm, parsePcb } from './parser.js';
import { fetchFootprintForLcsc, resolveFootprintByPackage, footprintRefOf } from './footprint.js';
import { boardDocument, libRecord, boardOutlineRecord, genGid, resetGid, DEFAULT_DRC, DEFAULT_LAYERS, footprintAnchor, footprintExtent } from './writer.js';
import { rulePlace, layoutQuality } from './place.js';

/** Pin number -> net name, from a schematic netlist. */
export function netByPin(netlist) {
  const map = new Map();
  for (const net of netlist.nets ?? []) {
    for (const p of net.pins ?? []) map.set(`${p.ref}.${p.pin}`, net.name);
  }
  return map;
}

/**
 * Pair symbol pins with footprint pads.
 *
 * @returns {{pairs: Array<{pin: string, pad: string}>, byNumber: boolean, missingPads: string[], extraPads: string[]}}
 */
export function pairPinsToPads(pins, pads) {
  const pinNums = pins.map((p) => String(p.number).trim()).filter(Boolean);
  const padNums = pads.map((p) => String(p).trim()).filter(Boolean);
  const padSet = new Set(padNums);
  const byNumber = pinNums.length > 0 && pinNums.every((n) => padSet.has(n));
  const pairs = [];
  if (byNumber) {
    for (const n of pinNums) pairs.push({ pin: n, pad: n });
  } else {
    // document order: symbol pins in the order they appear, pads sorted naturally
    const sorted = [...padNums].sort((a, b) => {
      const na = Number(a), nb = Number(b);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return String(a).localeCompare(String(b));
    });
    for (let i = 0; i < Math.min(pinNums.length, sorted.length); i++) pairs.push({ pin: pinNums[i], pad: sorted[i] });
  }
  const usedPads = new Set(pairs.map((p) => p.pad));
  return {
    pairs,
    byNumber,
    missingPads: pinNums.filter((n) => !usedPads.has(n)),
    extraPads: padNums.filter((n) => !usedPads.has(n)),
  };
}

/**
 * Shelf packing: left to right until the row is full, then a new row.
 *
 * Sizes come from the real footprints, so a DIP-40 does not land on top of its
 * neighbours. This is deliberately simple - P-05 does the rule-based placement.
 */
export function shelfPositions(entries, { originX = 4000, originY = 3000, maxWidthMm = 120, gapMm = 2.5 } = {}) {
  const maxWidth = mmToUnit(maxWidthMm);
  const gap = mmToUnit(gapMm);
  const out = new Map();
  let cursorX = 0, rowTop = 0, rowHeight = 0;
  for (const e of entries) {
    const w = e.extent?.width ?? 0, h = e.extent?.height ?? 0;
    if (cursorX > 0 && cursorX + w > maxWidth) {
      cursorX = 0;
      rowTop += rowHeight + gap;
      rowHeight = 0;
    }
    const x = originX + cursorX + w / 2;
    const y = originY + rowTop + h / 2;
    out.set(e.ref, { x: Math.round(x), y: Math.round(y), rotation: e.rotation ?? 0 });
    cursorX += w + gap;
    rowHeight = Math.max(rowHeight, h);
  }
  return out;
}

/**
 * Build a board document from a schematic.
 *
 * @param {string|object} input schematic file path or parsed document
 * @param {{refresh?: boolean, pitchMm?: number, columns?: number, originX?: number, originY?: number, positions?: object, marginMm?: number, drc?: object, onProgress?: Function}} opts
 */
export async function boardFromSchematic(input, opts = {}) {
  const {
    refresh = false, pitchMm = 12.7, columns = 8,
    originX = 4000, originY = 3000, positions = null, marginMm = 5, drc = DEFAULT_DRC,
    outlineWidth = 10, onProgress = null, placement = 'rule',
  } = opts;

  const doc = typeof input === 'string' ? parseDocument(await (await import('node:fs/promises')).readFile(input, 'utf8')) : input;
  const netlist = extractNetlist(doc);
  const components = (doc.components ?? []).filter((c) => c.designator && !c.isFrame);
  const netOf = netByPin(netlist);

  const warnings = [];
  const placed = [];
  const failed = [];

  // 1. resolve footprints first: placement should skip parts we cannot place
  for (const c of components) {
    const lcsc = c.lcscPart || c.cPara?.['Supplier Part'] || '';
    const pkg = c.package || c.cPara?.package || '';
    const pins = c.pins ?? [];
    let fp = null;
    let how = '';
    try {
      if (lcsc) {
        const r = await fetchFootprintForLcsc(lcsc, { refresh });
        if (r.model) { fp = r; how = `lcsc:${lcsc}`; }
      }
      if (!fp && pkg) {
        const r = await resolveFootprintByPackage(pkg, { pins, refresh });
        if (r.model) { fp = r; how = `package:${pkg}`; }
      }
    } catch (e) {
      warnings.push(`${c.designator}: 取封装失败(${e.message})`);
    }
    if (!fp) {
      failed.push({ ref: c.designator, package: pkg, lcsc, reason: pkg ? '找不到封装' : '既无封装名也无立创编号' });
      if (onProgress) onProgress({ ref: c.designator, ok: false });
      continue;
    }
    const pads = fp.model.footprints?.[0]?.pads ?? [];
    const pairing = pairPinsToPads(pins, pads.map((p) => p.number));
    if (!pairing.byNumber && pairing.pairs.length) {
      warnings.push(`${c.designator}: 符号引脚号(${pins.map((p) => p.number).join(',')})与封装焊盘号(${pads.map((p) => p.number).join(',')})不一致,按顺序对应`);
    }
    if (pairing.missingPads.length) warnings.push(`${c.designator}: 这些引脚没有对应焊盘 ${pairing.missingPads.join(',')}`);

    const netsByPad = {};
    for (const { pin, pad } of pairing.pairs) {
      const net = netOf.get(`${c.designator}.${pin}`) ?? '';
      if (net) netsByPad[String(pad)] = net;
    }
    placed.push({ component: c, footprint: fp, pads, pairing, netsByPad, how });
    if (onProgress) onProgress({ ref: c.designator, ok: true, footprint: fp.title, pins: pins.length, pads: pads.length });
  }

  // 2. positions
  const layoutNotes = [];
  let auto;
  let ruleBoard = null;
  if (placement === 'rule') {
    const entries = placed.map((p) => ({
      ref: p.component.designator,
      package: p.component.package ?? '',
      pins: p.component.pins ?? [],
      netsByPad: p.netsByPad,
      extent: footprintExtent(p.footprint.model),
    }));
    const ruled = rulePlace(entries, { netlist, boardWidthMm: opts.boardWidthMm, gapMm: opts.gapMm ?? 1.5, edgeMm: opts.edgeMm ?? 2.5 });
    layoutNotes.push(...ruled.notes);
    if (ruled.strategy) layoutNotes.push(`布局策略:${ruled.strategy.order} 顺序 / 行宽 ${ruled.strategy.rowWidthMm}mm(试了 ${ruled.strategy.tried} 种)`);
    ruleBoard = ruled.board;
    // rulePlace already returns file units starting near 0: shift the whole
    // board so its top-left lands on originX/originY (no unit conversion here -
    // converting twice is what once produced a 370 mm board)
    const dx = originX - ruleBoard.minX;
    const dy = originY - ruleBoard.minY;
    auto = new Map([...ruled.positions].map(([ref, p]) => [ref, { x: Math.round(p.x + dx), y: Math.round(p.y + dy), rotation: p.rotation }]));
  } else {
    auto = shelfPositions(placed.map((p) => ({
      ref: p.component.designator,
      rotation: 0,
      extent: footprintExtent(p.footprint.model),
    })), { originX, originY, maxWidthMm: opts.maxWidthMm ?? 120, gapMm: opts.gapMm ?? 2.5 });
  }
  for (const p of placed) {
    const want = positions?.[p.component.designator];
    if (Array.isArray(want)) {
      p.pos = { x: Number(want[0]), y: Number(want[1]), rotation: Number(want[2] ?? 0) };
    } else if (want && typeof want === 'object') {
      p.pos = { x: Number(want.x), y: Number(want.y), rotation: Number(want.rotation ?? 0) };
    } else {
      p.pos = auto.get(p.component.designator);
    }
  }

  // 3. records
  resetGid();
  const shape = [];
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const bump = (x, y) => {
    bounds.minX = Math.min(bounds.minX, x); bounds.maxX = Math.max(bounds.maxX, x);
    bounds.minY = Math.min(bounds.minY, y); bounds.maxY = Math.max(bounds.maxY, y);
  };

  for (const p of placed) {
    const c = p.component;
    const cPara = {
      package: c.package || p.footprint.model.cPara?.package || '',
      'Supplier Part': c.lcscPart || '',
      'Manufacturer Part': c.mfrPart || '',
      Value: c.value ?? '',
      name: c.designator,
    };
    shape.push(libRecord(p.footprint.model, {
      x: p.pos.x, y: p.pos.y, rotation: p.pos.rotation,
      cPara, designator: c.designator, value: c.value ?? '',
      netsByPad: p.netsByPad,
    }));
    const anchor = footprintAnchor(p.footprint.model);
    const extent = footprintExtent(p.footprint.model);
    bump(p.pos.x + extent.minX, p.pos.y + extent.minY);
    bump(p.pos.x + extent.maxX, p.pos.y + extent.maxY);
    for (const pad of p.pads) bump(p.pos.x + (pad.x - anchor.x), p.pos.y + (pad.y - anchor.y));
  }

  if (!placed.length) throw new Error('没有任何器件被放置:请检查封装是否可取到');

  // 4. board outline around the placements
  const margin = mmToUnit(marginMm);
  const outline = placement === 'rule' && ruleBoard
    ? {
      minX: originX, minY: originY,
      maxX: originX + (ruleBoard.maxX - ruleBoard.minX),
      maxY: originY + (ruleBoard.maxY - ruleBoard.minY),
    }
    : {
      minX: bounds.minX - margin, minY: bounds.minY - margin,
      maxX: bounds.maxX + margin, maxY: bounds.maxY + margin,
    };
  shape.push(boardOutlineRecord({ ...outline, width: outlineWidth }));

  const centerX = (outline.minX + outline.maxX) / 2;
  const centerY = (outline.minY + outline.maxY) / 2;
  const board = boardDocument({
    title: opts.title ?? '',
    shape,
    layers: opts.layers ?? DEFAULT_LAYERS,
    drc,
    originX: Math.round(centerX),
    originY: Math.round(centerY),
  });

  const model = parsePcb(board);
  const quality = layoutQuality(
    placed.map((p) => ({
      ref: p.component.designator, x: p.pos.x, y: p.pos.y,
      extent: footprintExtent(p.footprint.model),
    })),
    netlist,
    { minX: outline.minX, minY: outline.minY, maxX: outline.maxX, maxY: outline.maxY },
  );
  return {
    doc: board,
    text: JSON.stringify(board),
    model,
    netlist,
    placements: placed.map((p) => ({
      ref: p.component.designator, value: p.component.value ?? '', package: p.component.package ?? '',
      footprint: p.footprint.title, footprintUuid: p.footprint.uuid, via: p.how,
      x: p.pos.x, y: p.pos.y, rotation: p.pos.rotation,
      pins: p.pairing.pairs.length, pads: p.pads.length,
      nets: Object.values(p.netsByPad).length,
      byNumber: p.pairing.byNumber,
    })),
    failed,
    warnings: [...warnings, ...layoutNotes],
    quality,
    board: {
      minX: outline.minX, minY: outline.minY, maxX: outline.maxX, maxY: outline.maxY,
      widthMm: +toMm(outline.maxX - outline.minX).toFixed(2),
      heightMm: +toMm(outline.maxY - outline.minY).toFixed(2),
    },
    stats: {
      components: placed.length,
      failed: failed.length,
      pads: model.counts.pads,
      nets: new Set(placed.flatMap((p) => Object.values(p.netsByPad))).size,
      outlineWidth: outlineWidth,
    },
  };
}
