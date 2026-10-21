// Automatic placement and orthogonal routing for spec-built sheets.
//
// A spec should not have to know sheet coordinates: give it parts and
// connections, and this module lays the parts out on a grid around the biggest
// one and routes the wires with short stubs plus one or two bends. Hand-placed
// coordinates always win, so a partly manual sheet still works.
import { buildSymbolShapes, headerSpec, makeComponent, artExtent, passiveGraphics } from './symbol.js';
import { BUILTIN_SYMBOLS } from './symbol.js';

const round = (v, g = 5) => Math.round(v / g) * g;

/** Pin records of a component record, in sheet coordinates. */
function pinsOf(subRecords) {
  const out = [];
  for (const raw of subRecords) {
    if (!raw.startsWith('P~')) continue;
    const head = raw.split('^^')[0].split('~');
    const point = (raw.split('^^')[1] ?? '').trim().split(/\s+/).map(Number);
    const nameBlock = (raw.split('^^')[3] ?? '').split('~');
    out.push({
      number: String(head[3] ?? '').trim(),
      name: String(nameBlock[4] ?? '').trim(),
      x: point[0],
      y: point[1],
      orient: Number(head[6]) || 0,
    });
  }
  return out;
}

/** Build the shape list a component spec would be placed with. */
function shapesFor(comp) {
  if (comp.part) {
    const d = comp.part.doc ?? comp.part;
    return { shapes: d.shape.map(String), value: comp.value ?? d.head?.c_para?.name ?? '' };
  }
  if (!comp.symbol) throw new Error('each component needs either "symbol", "part" or explicit coordinates');
  if (comp.symbol === 'header' && comp.pins) return { shapes: buildSymbolShapes(headerSpec(comp.pins)), value: comp.value ?? '' };
  const entry = BUILTIN_SYMBOLS[comp.symbol];
  if (!entry) throw new Error(`unknown built-in symbol "${comp.symbol}"`);
  // same composition as create.js#symbolShapes: body/pins plus passive artwork
  const shapes = buildSymbolShapes(entry.spec);
  if (entry.graphics) shapes.push(...passiveGraphics(entry.graphics, entry.spec));
  return { shapes, value: comp.value ?? entry.defaultValue ?? '' };
}

/**
 * Measure one component: artwork bounding box and pin offsets relative to the
 * component origin (the point a spec would call x/y).
 */
export function measureComponent(comp) {
  const { shapes } = shapesFor(comp);
  const record = makeComponent({ shapes, x: 0, y: 0, ref: comp.ref ?? 'X?', value: '', rot: comp.rot ?? 0 });
  const subs = record.split('#@$').slice(1);
  const box = artExtent(subs);
  const pins = pinsOf(subs);
  return {
    ref: comp.ref,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
    minX: box.minX,
    minY: box.minY,
    maxX: box.maxX,
    maxY: box.maxY,
    pins,
  };
}

const boxesOverlap = (a, b, gap) => !(a.maxX + gap <= b.minX || b.maxX + gap <= a.minX || a.maxY + gap <= b.minY || b.maxY + gap <= a.minY);

const shiftBox = (m, x, y) => ({
  minX: m.minX + x, maxX: m.maxX + x, minY: m.minY + y, maxY: m.maxY + y,
});

/**
 * Place components that have no coordinates.
 *
 * The part with the most pins becomes the anchor in the middle of the sheet;
 * everything else is stacked in columns to its right and left, starting near the
 * anchor's vertical centre and growing outwards. A grid scan is the fallback for
 * parts that still collide.
 *
 * @returns {{components: object[], placements: Array, warnings: string[]}}
 */
export function autoPlace(components, opts = {}) {
  const { width = 1160, height = 820, margin = 90, gap = 24, grid = 5, links = [] } = opts;
  const measured = components.map((c) => ({ comp: c, m: measureComponent(c) }));
  const placed = new Map();          // ref -> {x, y, box}
  const warnings = [];
  const free = [];

  for (const item of measured) {
    const { comp } = item;
    if (Number.isFinite(comp.x) && Number.isFinite(comp.y)) {
      placed.set(comp.ref, { x: comp.x, y: comp.y, box: shiftBox(item.m, comp.x, comp.y) });
    } else {
      free.push(item);
    }
  }
  if (!free.length) return { components, placements: [...placed].map(([ref, p]) => ({ ref, ...p })), warnings };

  // anchor: explicit, else the part with the most pins
  const anchor = free.find((f) => f.comp.anchor === true)
    ?? [...free].sort((a, b) => b.m.pins.length - a.m.pins.length)[0];
  const ax = round((width - anchor.m.width) / 2 - anchor.m.minX, grid);
  const ay = round((height - anchor.m.height) / 2 - anchor.m.minY, grid);
  placed.set(anchor.comp.ref, { x: ax, y: ay, box: shiftBox(anchor.m, ax, ay) });
  const others = free.filter((f) => f !== anchor).sort((a, b) => b.m.pins.length - a.m.pins.length || a.m.height - b.m.height);

  const fits = (box) => box.minX >= margin && box.maxX <= width - margin && box.minY >= margin && box.maxY <= height - margin
    && ![...placed.values()].some((p) => boxesOverlap(box, p.box, gap));

  // Which side of the anchor does this part belong to? Vote by the anchor pin it
  // talks to, then propagate through the netlist so a part wired to a left-side
  // part also lands on the left (otherwise its wire has to cross the anchor).
  const anchorRef = anchor.comp.ref;
  const neighbours = new Map();
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    if (!neighbours.has(a)) neighbours.set(a, []);
    if (!neighbours.has(b)) neighbours.set(b, []);
    neighbours.get(a).push(b);
    neighbours.get(b).push(a);
  };
  for (const link of links) {
    const [fa, fb] = [String(link.from ?? ''), String(link.to ?? '')];
    if (!fa.includes('.') || !fb.includes('.')) continue;
    addEdge(fa.split('.')[0], fb.split('.')[0]);
  }
  const sideOf = new Map();
  const pinSide = (ref, pinNumber) => {
    const pin = anchor.m.pins.find((p) => p.number === pinNumber);
    return pin ? (pin.x < 0 ? -1 : 1) : null;
  };
  for (const link of links) {
    const [fa, fb] = [String(link.from ?? ''), String(link.to ?? '')];
    for (const [x, y] of [[fa, fb], [fb, fa]]) {
      // x is the anchor pin, y is the other part's pin
      if (!x.startsWith(`${anchorRef}.`) || y.startsWith(`${anchorRef}.`)) continue;
      const side = pinSide(anchorRef, x.split('.').slice(1).join('.'));
      if (side) sideOf.set(y.split('.')[0], side);
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const item of others) {
      if (sideOf.has(item.comp.ref)) continue;
      for (const nb of neighbours.get(item.comp.ref) ?? []) {
        if (!sideOf.has(nb)) continue;
        sideOf.set(item.comp.ref, sideOf.get(nb));
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  if (process.env.LAYOUT_DEBUG) {
    console.error('[layout] anchor', anchorRef, 'sides', JSON.stringify([...sideOf]), 'neighbours', JSON.stringify([...neighbours]));
    console.error('[layout] anchor pins x:', anchor.m.pins.slice(0, 4).map((p) => p.number + '@' + p.x).join(' '));
  }

  const tryColumns = (item) => {
    const anchorBox = placed.get(anchor.comp.ref).box;
    const midY = (anchorBox.minY + anchorBox.maxY) / 2;
    const preferred = sideOf.get(item.comp.ref);
    const sides = preferred ? [preferred, -preferred] : [1, -1];
    // preferred side first, then the other, each walking outwards
    for (let col = 0; col < 6; col++) {
      for (const side of sides) {
        const x = side > 0
          ? round(anchorBox.maxX + gap + 40 + col * 120, grid)
          : round(anchorBox.minX - gap - 40 - item.m.width - col * 120, grid);
        for (let step = 0; step < 8; step++) {
          const y = round(midY - item.m.height / 2 + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 60, grid);
          const box = shiftBox(item.m, x, y);
          if (fits(box)) return { x, y, box };
        }
      }
    }
    return null;
  };

  const tryScan = (item) => {
    for (let y = margin; y + item.m.height <= height - margin; y += grid * 4) {
      for (let x = margin; x + item.m.width <= width - margin; x += grid * 4) {
        const box = shiftBox(item.m, x, y);
        if (fits(box)) return { x, y, box };
      }
    }
    return null;
  };

  for (const item of others) {
    const spot = tryColumns(item) ?? tryScan(item);
    if (!spot) {
      warnings.push(`自动布局:放不下 ${item.comp.ref}(图纸 ${width}x${height} 不够),已退到右下角,请手动指定 x/y`);
      const box = shiftBox(item.m, width - margin - item.m.width, height - margin - item.m.height);
      placed.set(item.comp.ref, { x: box.minX - item.m.minX, y: box.minY - item.m.minY, box });
      continue;
    }
    placed.set(item.comp.ref, spot);
  }

  const out = components.map((c) => {
    const p = placed.get(c.ref);
    if (!p) return c;
    if (Number.isFinite(c.x) && Number.isFinite(c.y)) return c;
    return { ...c, x: p.x, y: p.y };
  });
  return { components: out, placements: [...placed].map(([ref, p]) => ({ ref, ...p })), warnings };
}

/**
 * Outward direction of a pin. The record's orientation is authoritative
 * (180 = the pin leaves to the left, 0 = right, 270 = up, 90 = down); geometry
 * is only a fallback, and it fails for a 1xN header whose pins all sit on the
 * connector's centre line.
 */
function outwardOf(pin, center) {
  if (pin && typeof pin.orient === 'number') {
    if (pin.orient === 180) return [-1, 0];
    if (pin.orient === 0) return [1, 0];
    if (pin.orient === 270) return [0, -1];
    if (pin.orient === 90) return [0, 1];
  }
  return center ? outward(pin, center) : null;
}

/** Outward direction of a pin, derived from the component centre. */
function outward(pin, center) {
  const dx = pin.x - center.x;
  const dy = pin.y - center.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? [1, 0] : [-1, 0];
  return dy >= 0 ? [0, 1] : [0, -1];
}

const boxOf = (b) => ({
  minX: Math.min(b.minX, b.maxX), maxX: Math.max(b.minX, b.maxX),
  minY: Math.min(b.minY, b.maxY), maxY: Math.max(b.minY, b.maxY),
});

/** Does an axis-aligned segment pass through a box (inflated by `pad`)? */
function segmentCrossesBox(p, q, box, pad = 2) {
  const b = boxOf(box);
  const minX = b.minX - pad, maxX = b.maxX + pad, minY = b.minY - pad, maxY = b.maxY + pad;
  if (p.y === q.y) {
    const [x1, x2] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
    return p.y > minY && p.y < maxY && x2 > minX && x1 < maxX;
  }
  if (p.x === q.x) {
    const [y1, y2] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
    return p.x > minX && p.x < maxX && y2 > minY && y1 < maxY;
  }
  return false;
}

/** How many foreign pins a candidate path would touch (a touch = a short). */
function pathPinHits(pts, pins) {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i], pts[i + 1]];
    for (const pin of pins) {
      if (pin.x === p.x && pin.y === p.y) continue;
      if (pin.x === q.x && pin.y === q.y) continue;
      if (segmentCrossesBox(p, q, { minX: pin.x, maxX: pin.x, minY: pin.y, maxY: pin.y }, 0.5)) n++;
    }
  }
  return n;
}

/** Collinear overlap with an already routed segment (= an accidental join). */
function segmentsOverlap(a, b, c, d, pad = 0.5) {
  const horizontal = a.y === b.y && c.y === d.y && Math.abs(a.y - c.y) < pad;
  if (horizontal) {
    const [a1, a2] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [c1, c2] = [Math.min(c.x, d.x), Math.max(c.x, d.x)];
    return Math.min(a2, c2) - Math.max(a1, c1) > pad;
  }
  const vertical = a.x === b.x && c.x === d.x && Math.abs(a.x - c.x) < pad;
  if (vertical) {
    const [a1, a2] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    const [c1, c2] = [Math.min(c.y, d.y), Math.max(c.y, d.y)];
    return Math.min(a2, c2) - Math.max(a1, c1) > pad;
  }
  return false;
}

function pathWireHits(pts, segments) {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const seg of segments) if (segmentsOverlap(pts[i], pts[i + 1], seg[0], seg[1])) n++;
  }
  return n;
}

/** How many placed parts a candidate path would cut through. */
function pathCrossings(pts, boxes) {
  let n = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    for (const box of boxes) if (segmentCrossesBox(pts[i], pts[i + 1], box)) n++;
  }
  return n;
}

const pathLength = (pts) => pts.slice(1).reduce((n, p, i) => n + Math.abs(p.x - pts[i].x) + Math.abs(p.y - pts[i].y), 0);

/**
 * Route one connection with orthogonal segments.
 *
 * Candidate paths: the direct L, plus detours above, below, left and right of
 * the placed parts. The candidate with the fewest crossings against the
 * component boxes wins, then the shortest — a wire routed through a part would
 * silently short its pins together.
 */
export function routeConnection(from, to, {
  fromCenter, toCenter, stub = 20, grid = 5, obstacles = [], pins = [], segments = [],
  fromPin, toPin,
} = {}) {
  const a = { x: from.x, y: from.y };
  const b = { x: to.x, y: to.y };
  const da = outwardOf(fromPin, fromCenter)
    ?? (fromCenter ? outward(a, fromCenter)
      : (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? [Math.sign(b.x - a.x) || 1, 0] : [0, Math.sign(b.y - a.y) || 1]));
  const db = outwardOf(toPin, toCenter) ?? (toCenter ? outward(b, toCenter) : [-da[0], -da[1]]);
  const a1 = { x: a.x + da[0] * stub, y: a.y + da[1] * stub };
  const b1 = { x: b.x + db[0] * stub, y: b.y + db[1] * stub };

  const direct = [a, a1];
  if (a1.x !== b1.x && a1.y !== b1.y) {
    if (da[0] !== 0) direct.push({ x: b1.x, y: a1.y });
    else direct.push({ x: a1.x, y: b1.y });
  }
  direct.push(b1, b);

  const boxes = obstacles.map(boxOf);
  // a wire that touches a foreign pin or lies on another wire silently joins nets,
  // so both cost far more than a detour
  const score = (path) => ({
    pins: pathPinHits(path, pins),
    wires: pathWireHits(path, segments),
    boxes: pathCrossings(path, boxes),
    len: pathLength(path),
  });
  const better = (a2, b2) => (a2.pins - b2.pins) || (a2.wires - b2.wires) || (a2.boxes - b2.boxes) || (a2.len - b2.len);

  let best = direct;
  let bestScore = score(direct);
  if (bestScore.pins || bestScore.wires || bestScore.boxes) {
    const baseTop = Math.min(a.y, b.y, ...boxes.map((x) => x.minY), Infinity) - 40;
    const baseBottom = Math.max(a.y, b.y, ...boxes.map((x) => x.maxY), -Infinity) + 40;
    const baseLeft = Math.min(a.x, b.x, ...boxes.map((x) => x.minX), Infinity) - 40;
    const baseRight = Math.max(a.x, b.x, ...boxes.map((x) => x.maxX), -Infinity) + 40;
    const candidates = [];
    for (const off of [0, 25, 50, 90]) {
      const top = baseTop - off, bottom = baseBottom + off, left = baseLeft - off, right = baseRight + off;
      candidates.push(
        [a, a1, { x: a1.x, y: top }, { x: b1.x, y: top }, b1, b],
        [a, a1, { x: a1.x, y: bottom }, { x: b1.x, y: bottom }, b1, b],
        [a, a1, { x: left, y: a1.y }, { x: left, y: b1.y }, b1, b],
        [a, a1, { x: right, y: a1.y }, { x: right, y: b1.y }, b1, b],
      );
    }
    for (const cand of candidates) {
      const cs = score(cand);
      if (better(cs, bestScore) < 0) { best = cand; bestScore = cs; }
    }
  }
  const pts = best;

  // endpoints stay exactly on the pins (a 2-unit snap would disconnect them);
  // only interior bends are snapped to the grid
  const snapped = [];
  const lastIndex = pts.length - 1;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = (i === 0 || i === lastIndex) ? { x: p.x, y: p.y } : { x: round(p.x, grid), y: round(p.y, grid) };
    const last = snapped[snapped.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) snapped.push(q);
  }
  const out = [];
  for (const p of snapped) {
    const n = out.length;
    if (n >= 2) {
      const [p0, p1] = [out[n - 2], out[n - 1]];
      if ((p0.x === p1.x && p1.x === p.x) || (p0.y === p1.y && p1.y === p.y)) { out[n - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}
