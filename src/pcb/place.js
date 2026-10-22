// Rule-based placement for a board built from a schematic.
//
// The rules are the ones a hardware engineer applies by hand, in the order that
// matters:
//   1. connectors go along the board edge they are wired towards
//   2. the biggest IC anchors the middle
//   3. a decoupling capacitor sits next to the power pin it serves
//   4. everything else clusters near the parts it shares nets with
//   5. overlaps and out-of-board parts are resolved by a local nudge
//
// Placement quality is reported (ratsnest length, overlaps, parts outside the
// outline) so a bad result is visible instead of silently ugly.
import { mmToUnit, toMm, UNIT_MM } from './parser.js';

/** Connector-ish references and packages. */
const CONNECTOR_REF = /^(J|P|CN|CON)\d/i;
const CONNECTOR_PKG = /(HDR|HEADER|CONN|SOCKET|PLUG|USB|RJ45|TERMINAL|FPC|FFC|DIP-?SW|TYPE-?C)/i;
const POWER_NET = /^(\+?\d+V\d*|VCC|VDD|VIN|VBAT|VSYS|VUSB|3V3|5V|12V)$/i;
const GROUND_NET = /^(GND|AGND|DGND|PGND|VSS|VEE|0V)$/i;

/** Bucket a component by what it is. */
export function classify(entry) {
  const pins = entry.pins?.length ?? 0;
  if (CONNECTOR_REF.test(entry.ref) || CONNECTOR_PKG.test(entry.package ?? '')) return 'connector';
  if (pins >= 6) return 'ic';
  if (pins === 2) {
    const nets = Object.values(entry.netsByPad ?? {});
    const power = nets.some((n) => POWER_NET.test(n));
    const ground = nets.some((n) => GROUND_NET.test(n));
    if (power && ground) return 'decoupling';
    if (/^(Y|X)\d/i.test(entry.ref) || /(XTAL|CRYSTAL|晶振)/i.test(entry.package ?? '')) return 'crystal';
    return 'passive';
  }
  return 'other';
}

const rectsOverlap = (a, b, gap = 0) => !(a.maxX + gap <= b.minX || b.maxX + gap <= a.minX || a.maxY + gap <= b.minY || b.maxY + gap <= a.minY);

/** Component footprint box in mm, relative to the placement point. */
function boxOf(entry) {
  const e = entry.extent ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: e.minX * UNIT_MM, minY: e.minY * UNIT_MM, maxX: e.maxX * UNIT_MM, maxY: e.maxY * UNIT_MM, w: (e.maxX - e.minX) * UNIT_MM, h: (e.maxY - e.minY) * UNIT_MM };
}

const place = (box, x, y) => ({ minX: x + box.minX, minY: y + box.minY, maxX: x + box.maxX, maxY: y + box.maxY });

/** Which nets a component shares with others. */
export function neighboursOf(netlist) {
  const byRef = new Map();
  const netOfRef = new Map();
  for (const net of netlist.nets ?? []) {
    for (const p of net.pins ?? []) {
      if (!byRef.has(p.ref)) byRef.set(p.ref, new Set());
      if (!netOfRef.has(p.ref)) netOfRef.set(p.ref, new Set());
      netOfRef.get(p.ref).add(net.name);
    }
    const refs = [...new Set((net.pins ?? []).map((p) => p.ref))];
    for (const a of refs) for (const b of refs) if (a !== b) byRef.get(a).add(b);
  }
  return { neighbours: byRef, netsOf: netOfRef };
}

/**
 * Decide where each component goes.
 *
 * @param {Array} entries [{ref, package, pins, netsByPad, extent}]
 * @param {{netlist: object, boardWidthMm?: number, gapMm?: number, edgeMm?: number}} opts
 * @returns {{positions: Map<string, {x:number,y:number,rotation:number}>, board: {widthMm:number,heightMm:number}, notes: string[]}}
 */
/**
 * Order parts so that electrically related ones end up next to each other:
 * start from the biggest IC, walk the netlist (BFS), then the connectors, then
 * whatever is left. Packing that order compactly beats a roomy grid.
 */
export function clusterOrder(entries, netlist) {
  const { neighbours } = neighboursOf(netlist ?? { nets: [] });
  const byRef = new Map(entries.map((e) => [e.ref, e]));
  const ics = entries.filter((e) => classify(e) === 'ic').sort((a, b) => (b.pins?.length ?? 0) - (a.pins?.length ?? 0));
  const connectors = entries.filter((e) => classify(e) === 'connector');
  const seen = new Set();
  const order = [];
  const visit = (e) => {
    if (!e || seen.has(e.ref)) return;
    seen.add(e.ref);
    order.push(e);
  };
  for (const ic of ics) {
    visit(ic);
    // decoupling capacitors go immediately after the IC they serve, so the
    // packer puts them beside its power pins rather than at the end of the row
    for (const ref of neighbours.get(ic.ref) ?? []) {
      const e = byRef.get(ref);
      if (e && classify(e) === 'decoupling') visit(e);
    }
    // then breadth-first over the netlist, closest partners first
    const queue = [...(neighbours.get(ic.ref) ?? [])];
    while (queue.length) {
      const ref = queue.shift();
      const e = byRef.get(ref);
      if (!e || seen.has(ref)) continue;
      visit(e);
      for (const next of neighbours.get(ref) ?? []) if (!seen.has(next)) queue.push(next);
    }
  }
  for (const c of connectors) visit(c);
  for (const e of entries) visit(e);
  return order;
}

/** Pack one ordered list of parts into rows (all in millimetres). */
export function packShelf(order, { maxWidthMm = 120, gapMm = 1.5, edgeMm = 2.5 } = {}) {
  const placed = new Map();
  let cursorX = 0, rowTop = 0, rowHeight = 0;
  for (const item of order) {
    const w = item.box.w, h = item.box.h;
    if (cursorX > 0 && cursorX + w + gapMm > maxWidthMm) {
      cursorX = 0;
      rowTop += rowHeight + gapMm;
      rowHeight = 0;
    }
    const x = cursorX + w / 2;
    const y = rowTop + h / 2;
    placed.set(item.ref, { x, y, box: place(item.box, x, y), kind: item.kind, rotation: 0 });
    cursorX += w + gapMm;
    rowHeight = Math.max(rowHeight, h);
  }
  // a part wider than the row can still collide: push it down until it is clear
  let fixes = 0;
  const all = () => [...placed.values()].map((p) => p.box);
  for (const item of order) {
    const p = placed.get(item.ref);
    let guard = 0;
    while (guard++ < 200 && all().some((b) => b !== p.box && rectsOverlap(p.box, b, gapMm))) {
      p.y += item.box.h + gapMm;
      p.box = place(item.box, p.x, p.y);
      fixes++;
    }
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of placed.values()) {
    minX = Math.min(minX, p.box.minX); maxX = Math.max(maxX, p.box.maxX);
    minY = Math.min(minY, p.box.minY); maxY = Math.max(maxY, p.box.maxY);
  }
  return {
    placed,
    fixes,
    board: {
      minX: minX - edgeMm, minY: minY - edgeMm, maxX: maxX + edgeMm, maxY: maxY + edgeMm,
      widthMm: +((maxX - minX) + edgeMm * 2).toFixed(2),
      heightMm: +((maxY - minY) + edgeMm * 2).toFixed(2),
    },
  };
}

const byPinsDesc = (a, b) => (b.pins?.length ?? 0) - (a.pins?.length ?? 0);
const byRef = (a, b) => String(a.ref).localeCompare(String(b.ref), undefined, { numeric: true });

/**
 * Rule-based placement: try a handful of deterministic orderings and row widths,
 * score each layout (overlaps and out-of-board first, then ratsnest length and a
 * small area penalty) and keep the best one.
 */
export function rulePlace(entries, opts = {}) {
  const gap = opts.gapMm ?? 1.5;
  const edge = opts.edgeMm ?? 2.5;
  const notes = [];
  const items = entries.map((e) => ({ ...e, kind: classify(e), box: boxOf(e) }));
  if (!items.length) return { positions: new Map(), board: { minX: 0, minY: 0, maxX: 0, maxY: 0, widthMm: 0, heightMm: 0 }, notes, quality: null };

  const clustered = clusterOrder(items, opts.netlist);
  // Reading order of the schematic: the sheet was laid out by function, so
  // packing in that order keeps the USB/LDO/CH340 block next to the MCU instead
  // of scattering the parts and leaving the UART and crystal nets unroutable.
  const schematicOrder = [...items].sort((a, b) => (a.schX ?? 0) - (b.schX ?? 0) || (a.schY ?? 0) - (b.schY ?? 0));
  const orders = [
    ...(opts.useSchematicOrder ? [{ name: 'schematic', order: schematicOrder }] : []),
    { name: 'cluster', order: clustered },
    { name: 'cluster-rev', order: [...clustered].reverse() },
    { name: 'pins', order: [...items].sort(byPinsDesc) },
    { name: 'ref', order: [...items].sort(byRef) },
  ];
  const widths = opts.widths ?? [60, 80, 100, 120, 160];

  let best = null;
  let tried = 0;
  for (const { name, order } of orders) {
    for (const maxWidthMm of widths) {
      const packed = packShelf(order, { maxWidthMm, gapMm: gap, edgeMm: edge });
      const placements = order.map((i) => {
        const p = packed.placed.get(i.ref);
        return { ref: i.ref, x: mmToUnit(p.x), y: mmToUnit(p.y), extent: i.extent };
      });
      const outline = {
        minX: mmToUnit(packed.board.minX), minY: mmToUnit(packed.board.minY),
        maxX: mmToUnit(packed.board.maxX), maxY: mmToUnit(packed.board.maxY),
      };
      const quality = layoutQuality(placements, opts.netlist ?? { nets: [] }, outline);
      const score = quality.overlaps * 1000 + quality.outside * 1000 + quality.ratsnestMm + (packed.board.widthMm * packed.board.heightMm) * 0.004;
      tried++;
      if (!best || score < best.score) {
        best = { score, name, maxWidthMm, packed, placements, outline, quality };
      }
    }
  }
  if (best.packed.fixes) notes.push(`${best.packed.fixes} 次下移以消除重叠`);

  const positions = new Map(best.placements.map((p) => [p.ref, { x: Math.round(p.x), y: Math.round(p.y), rotation: 0 }]));
  return {
    positions,
    board: {
      minX: best.outline.minX, minY: best.outline.minY, maxX: best.outline.maxX, maxY: best.outline.maxY,
      widthMm: best.packed.board.widthMm, heightMm: best.packed.board.heightMm,
    },
    quality: best.quality,
    strategy: { order: best.name, rowWidthMm: best.maxWidthMm, tried },
    notes,
  };
}

/**
 * Placement quality: ratsnest length (half-perimeter of every net's bounding
 * box), overlaps between parts, and parts outside the outline. Lower is better.
 */
export function layoutQuality(placements, netlist, outline) {
  const pos = new Map(placements.map((p) => [p.ref, p]));
  let ratsnest = 0;
  for (const net of netlist.nets ?? []) {
    const pts = (net.pins ?? []).map((p) => pos.get(p.ref)).filter(Boolean);
    if (pts.length < 2) continue;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    ratsnest += ((Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys))) * UNIT_MM;
  }
  let overlaps = 0;
  const boxes = placements.map((p) => ({ ref: p.ref, box: { minX: p.x + (p.extent?.minX ?? 0), minY: p.y + (p.extent?.minY ?? 0), maxX: p.x + (p.extent?.maxX ?? 0), maxY: p.y + (p.extent?.maxY ?? 0) } }));
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) if (rectsOverlap(boxes[i].box, boxes[j].box)) overlaps++;
  }
  const outside = outline
    ? boxes.filter((b) => b.box.minX < outline.minX || b.box.maxX > outline.maxX || b.box.minY < outline.minY || b.box.maxY > outline.maxY).length
    : 0;
  return {
    ratsnestMm: +ratsnest.toFixed(1),
    overlaps,
    outside,
    components: placements.length,
  };
}
