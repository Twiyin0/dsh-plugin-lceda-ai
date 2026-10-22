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

/**
 * Functional placement: keep each functional block together and put the
 * connectors on the board edge they need.
 *
 * The rule placer optimises a single global shelf, which scatters a design: on
 * the USB download board the micro-USB connector ended up in the middle of the
 * board (where it cannot be plugged in) and the CH340G sat away from its crystal
 * and its decoupling. This placer works one level up - it packs each declared
 * group into its own block, shelf-packs the blocks, and then slides the
 * connector blocks onto the requested edge, rotating them so the mating side
 * faces out.
 *
 * @param {Array} entries parts with `extent`, `pins`, `netsByPad`
 * @param {object} opts
 *   groups: [{ name, refs:[], edge?:'left'|'right'|'top'|'bottom', rot?:0|90|180|270,
 *              maxWidthMm?:number }]
 *   boardWidthMm, gapMm, edgeMm
 */
export function functionalPlace(entries, opts = {}) {
  const gap = opts.gapMm ?? 1.5;
  const edge = opts.edgeMm ?? 2.5;
  const notes = [];
  const items = entries.map((e) => ({ ...e, kind: classify(e), box: boxOf(e) }));
  const byRef = new Map(items.map((i) => [i.ref, i]));
  if (!items.length) return { positions: new Map(), board: { minX: 0, minY: 0, maxX: 0, maxY: 0, widthMm: 0, heightMm: 0 }, notes, quality: null };

  const groups = (opts.groups ?? []).filter((g) => (g.refs ?? []).some((r) => byRef.has(r)));
  const claimed = new Set(groups.flatMap((g) => g.refs));
  const rest = items.filter((i) => !claimed.has(i.ref));
  if (rest.length) groups.push({ name: 'rest', refs: rest.map((i) => i.ref) });

  // ---- pack every group into a block of its own -------------------------
  const blocks = [];
  for (const g of groups) {
    const members = g.refs.map((r) => byRef.get(r)).filter(Boolean);
    const rot = g.rot ?? 0;
    if (rot % 180 === 90) for (const m of members) m.box = { ...m.box, w: m.box.h, h: m.box.w };
    const inner = packShelf(members, { maxWidthMm: g.maxWidthMm ?? 55, gapMm: gap, edgeMm: 0 });
    const boxes = [...inner.placed.values()].map((p) => p.box);
    const minX = Math.min(...boxes.map((b) => b.minX)), minY = Math.min(...boxes.map((b) => b.minY));
    const maxX = Math.max(...boxes.map((b) => b.maxX)), maxY = Math.max(...boxes.map((b) => b.maxY));
    blocks.push({ name: g.name, edge: g.edge ?? null, rot, members, inner, minX, minY, w: maxX - minX, h: maxY - minY });
  }

  // ---- shelf-pack the interior blocks -----------------------------------
  const left = blocks.filter((b) => b.edge === 'left');
  const right = blocks.filter((b) => b.edge === 'right');
  const interior = blocks.filter((b) => !b.edge);
  const leftW = left.reduce((n, b) => Math.max(n, b.w), 0);
  const rightW = right.reduce((n, b) => Math.max(n, b.w), 0);
  const target = opts.boardWidthMm ?? 100;
  // The interior row width must fit at least one whole block, otherwise every
  // block lands on a row of its own and the board becomes a long strip (which is
  // what a 20 mm interior did to a 24-part design: 127 x 41 mm instead of a
  // usable rectangle).
  const widest = interior.reduce((n, b) => Math.max(n, b.w), 0);
  const innerWidth = Math.max(widest, target - leftW - rightW - gap * 4);
  const packed = packShelf(interior.map((b) => ({ ref: b.name, kind: 'block', box: { minX: 0, minY: 0, maxX: b.w, maxY: b.h, w: b.w, h: b.h } })), { maxWidthMm: innerWidth, gapMm: gap * 2, edgeMm: 0 });
  notes.push(`功能分区:${blocks.length} 个区块(左侧 ${left.length} / 内部 ${interior.length} / 右侧 ${right.length}),内部行宽 ${Math.round(innerWidth)}mm`);

  // ---- assemble: interior first, then slide the edge blocks in ----------
  const offsetX = leftW + gap * 2;
  const offsetY = 0;
  const placed = new Map();
  for (const b of interior) {
    const p = packed.placed.get(b.name);
    for (const m of b.members) {
      const q = b.inner.placed.get(m.ref);
      placed.set(m.ref, { x: q.x - b.minX + p.x - b.w / 2 + offsetX, y: q.y - b.minY + p.y - b.h / 2 + offsetY, kind: m.kind, box: null, rotation: b.rot, entry: m });
    }
  }
  const interiorBox = packed.board;
  const boardH = Math.max(interiorBox.heightMm, ...left.map((b) => b.h), ...right.map((b) => b.h), 20);
  let cursorY = 0;
  for (const b of left) {
    for (const m of b.members) {
      const q = b.inner.placed.get(m.ref);
      placed.set(m.ref, { x: q.x - b.minX + gap, y: q.y - b.minY + cursorY + (boardH - b.h) / 2, kind: m.kind, box: null, rotation: b.rot, entry: m });
    }
    cursorY += b.h + gap * 2;
  }
  cursorY = 0;
  for (const b of right) {
    for (const m of b.members) {
      const q = b.inner.placed.get(m.ref);
      placed.set(m.ref, { x: q.x - b.minX + offsetX + interiorBox.widthMm + gap * 2, y: q.y - b.minY + cursorY + (boardH - b.h) / 2, kind: m.kind, box: null, rotation: b.rot, entry: m });
    }
    cursorY += b.h + gap * 2;
  }

  // ---- normalise to (0,0) and rebuild the outline ------------------------
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [ref, p] of placed) {
    const m = byRef.get(ref);
    const half = { w: m.box.w / 2, h: m.box.h / 2 };
    minX = Math.min(minX, p.x - half.w); maxX = Math.max(maxX, p.x + half.w);
    minY = Math.min(minY, p.y - half.h); maxY = Math.max(maxY, p.y + half.h);
  }
  const shiftX = edge - minX, shiftY = edge - minY;
  const placements = [];
  for (const [ref, p] of placed) {
    const m = byRef.get(ref);
    const x = p.x + shiftX, y = p.y + shiftY;
    const box = { minX: x - m.box.w / 2, minY: y - m.box.h / 2, maxX: x + m.box.w / 2, maxY: y + m.box.h / 2 };
    p.box = box;
    placements.push({ ref, x: mmToUnit(x), y: mmToUnit(y), extent: m.extent });
  }
  const outline = {
    minX: mmToUnit(0), minY: mmToUnit(0),
    maxX: mmToUnit(maxX - minX + edge * 2), maxY: mmToUnit(maxY - minY + edge * 2),
  };
  const quality = layoutQuality(placements, opts.netlist ?? { nets: [] }, outline);
  const positions = new Map();
  for (const [ref, p] of placed) positions.set(ref, { x: Math.round(mmToUnit(p.x + shiftX)), y: Math.round(mmToUnit(p.y + shiftY)), rotation: p.rotation });
  return {
    positions,
    board: {
      minX: outline.minX, minY: outline.minY, maxX: outline.maxX, maxY: outline.maxY,
      widthMm: (maxX - minX) + edge * 2, heightMm: (maxY - minY) + edge * 2,
    },
    quality,
    strategy: { order: 'functional', groups: blocks.map((b) => ({ name: b.name, edge: b.edge, rot: b.rot })) },
    notes,
  };
}

/**
 * Zoned placement: every part is placed inside a rectangle the caller names.
 *
 * Automatic packing optimises area, and area is not what makes a board readable.
 * On the USB download board the reference design (and every hand-made board) puts
 * the micro-USB on the edge it plugs in from, the regulator next to its input
 * connector, the USB-serial chip next to its crystal, and the MCU with its
 * decoupling in one block. This placer takes those zones as data and packs each
 * one locally, so the result is predictable and stays that way as parts change.
 *
 * @param {Array} entries parts with `extent`
 * @param {object} opts zones: [{ name, refs:[], at:[xMm,yMm], maxWidthMm, rot? }]
 */
export function zonedPlace(entries, opts = {}) {
  const gap = opts.gapMm ?? 1.5;
  const edge = opts.edgeMm ?? 2.5;
  const notes = [];
  const items = entries.map((e) => ({ ...e, kind: classify(e), box: boxOf(e) }));
  const byRef = new Map(items.map((i) => [i.ref, i]));
  if (!items.length) return { positions: new Map(), board: { minX: 0, minY: 0, maxX: 0, maxY: 0, widthMm: 0, heightMm: 0 }, notes, quality: null };

  const zones = (opts.zones ?? []).filter((z) => (z.refs ?? []).some((r) => byRef.has(r)));
  const claimed = new Set(zones.flatMap((z) => z.refs));
  const rest = items.filter((i) => !claimed.has(i.ref));
  if (rest.length) {
    const maxY = Math.max(0, ...zones.map((z) => z.at[1]));
    zones.push({ name: 'rest', refs: rest.map((i) => i.ref), at: [opts.restAt?.[0] ?? 4, opts.restAt?.[1] ?? maxY + 20], maxWidthMm: opts.restWidthMm ?? 40 });
  }

  const placed = new Map();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const z of zones) {
    const members = z.refs.map((r) => byRef.get(r)).filter(Boolean);
    const rot = z.rot ?? 0;
    if (rot % 180 === 90) for (const m of members) m.box = { ...m.box, w: m.box.h, h: m.box.w };
    const packed = packShelf(members, { maxWidthMm: z.maxWidthMm ?? 40, gapMm: z.gapMm ?? gap, edgeMm: 0 });
    for (const m of members) {
      const p = packed.placed.get(m.ref);
      const x = z.at[0] + p.x - packed.board.minX;
      const y = z.at[1] + p.y - packed.board.minY;
      placed.set(m.ref, { x, y, rotation: rot, entry: m });
      minX = Math.min(minX, x - m.box.w / 2); maxX = Math.max(maxX, x + m.box.w / 2);
      minY = Math.min(minY, y - m.box.h / 2); maxY = Math.max(maxY, y + m.box.h / 2);
    }
    notes.push(`${z.name}: ${members.length} 个器件 @ ${z.at[0]},${z.at[1]}mm${rot ? ` rot${rot}` : ''}`);
  }

  const shiftX = edge - minX, shiftY = edge - minY;
  const placements = [];
  const boxes = new Map();
  for (const [ref, p] of placed) {
    const m = byRef.get(ref);
    const x = p.x + shiftX, y = p.y + shiftY;
    p.x = x; p.y = y;
    boxes.set(ref, { minX: x - m.box.w / 2, minY: y - m.box.h / 2, maxX: x + m.box.w / 2, maxY: y + m.box.h / 2 });
    placements.push({ ref, x: mmToUnit(x), y: mmToUnit(y), extent: m.extent });
  }
  const widthMm = (maxX - minX) + edge * 2, heightMm = (maxY - minY) + edge * 2;
  const outline = { minX: 0, minY: 0, maxX: mmToUnit(widthMm), maxY: mmToUnit(heightMm) };
  const quality = layoutQuality(placements, opts.netlist ?? { nets: [] }, outline);
  // zoned placement is explicit, so an overlap is a mistake in the zone data:
  // report it rather than silently nudging parts around
  let overlaps = 0;
  const refs = [...boxes.keys()];
  for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) {
    const a = boxes.get(refs[i]), b = boxes.get(refs[j]);
    if (a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY) overlaps++;
  }
  const positions = new Map();
  for (const [ref, p] of placed) positions.set(ref, { x: Math.round(mmToUnit(p.x)), y: Math.round(mmToUnit(p.y)), rotation: p.rotation });
  return {
    positions,
    board: { minX: 0, minY: 0, maxX: outline.maxX, maxY: outline.maxY, widthMm, heightMm },
    quality: { ...quality, overlaps },
    strategy: { order: 'zoned', zones: zones.map((z) => ({ name: z.name, at: z.at, refs: z.refs.length })) },
    notes,
  };
}
