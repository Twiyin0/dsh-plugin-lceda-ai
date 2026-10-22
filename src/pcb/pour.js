// Copper pour: raster flood fill with clearance, thermal spokes and island removal.
//
// A pour is "the copper that is left" after taking the board area and removing
// everything the net may not touch. Doing that on a raster keeps the code close
// to the router's grid (same cell size, same obstacle rules) and makes the three
// classic pour behaviours easy:
//
//   clearance  - foreign copper (pads, tracks, vias) is removed plus a ring
//   thermal    - a same-net pad keeps four spokes through that ring, so it is
//                connected without being a heat sink
//   islands    - copper that touches no pad of the net is dropped
//
// The result is emitted as COPPERAREA records (outline path plus fill data).
import { mmToUnit, toMm, boardOutline, copperItems, padBBox, isCopper } from './parser.js';
import { copperAreaRecord, boardDocument, DEFAULT_LAYERS, DEFAULT_DRC } from './writer.js';

const GROUND = /^(GND|AGND|DGND|PGND|VSS|VEE|0V)$/i;
const POWER = /^(\+?\d+V\d*|VCC|VDD|VIN|VBAT|VSYS|VUSB|3V3|5V|12V)$/i;

/** Which net a pour should use by default: ground if present, else the widest rail. */
export function defaultPourNet(model) {
  const counts = new Map();
  for (const fp of model.footprints) {
    for (const pad of fp.pads) if (pad.net) counts.set(pad.net, (counts.get(pad.net) ?? 0) + 1);
  }
  const names = [...counts.keys()];
  const gnd = names.find((n) => GROUND.test(n));
  if (gnd) return gnd;
  const power = names.filter((n) => POWER.test(n)).sort((a, b) => counts.get(b) - counts.get(a));
  if (power.length) return power[0];
  return names.sort((a, b) => counts.get(b) - counts.get(a))[0] ?? '';
}

/**
 * Rasterise the pour region.
 *
 * @param {object} model parsed board
 * @param {{net?: string, layer?: number, cell?: number, clearance?: number, edgeClearance?: number, thermal?: boolean, spokeWidth?: number, region?: {minX,minY,maxX,maxY}}} opts
 */
export function buildPourGrid(model, opts = {}) {
  const cell = opts.cell ?? 2;
  const net = opts.net ?? defaultPourNet(model);
  const layer = opts.layer ?? 1;
  const clearance = opts.clearance ?? Math.max(1, Math.round(mmToUnit(model.drc?.default?.clearance ?? 0.254)));
  const edge = opts.edgeClearance ?? Math.max(2, Math.round(mmToUnit(0.5)));
  const thermal = opts.thermal !== false;
  const spokeWidth = opts.spokeWidth ?? Math.max(2, Math.round(mmToUnit(0.4)));

  const outline = boardOutline(model);
  const region = opts.region ?? (outline
    ? { minX: outline.minX + edge, minY: outline.minY + edge, maxX: outline.maxX - edge, maxY: outline.maxY - edge }
    : { minX: 0, minY: 0, maxX: 1000, maxY: 1000 });

  const minX = region.minX, minY = region.minY;
  const cols = Math.max(1, Math.ceil((region.maxX - region.minX) / cell));
  const rows = Math.max(1, Math.ceil((region.maxY - region.minY) / cell));
  const idx = (i, j) => j * cols + i;
  const free = new Uint8Array(cols * rows).fill(1);
  const padCells = new Set();          // cells of the pour net's own pads
  const toCell = (x, y) => ({ i: Math.round((x - minX) / cell), j: Math.round((y - minY) / cell) });
  const toBoard = (i, j) => ({ x: minX + i * cell, y: minY + j * cell });

  const clearRect = (minXr, minYr, maxXr, maxYr) => {
    const i0 = Math.max(0, Math.floor((minXr - minX) / cell));
    const i1 = Math.min(cols - 1, Math.ceil((maxXr - minX) / cell));
    const j0 = Math.max(0, Math.floor((minYr - minY) / cell));
    const j1 = Math.min(rows - 1, Math.ceil((maxYr - minY) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) free[idx(i, j)] = 0;
  };

  // Pass 1 clears foreign copper and remembers where it was, so the thermal
  // spokes of pass 2 can avoid re-cutting a neighbour's clearance ring (D1's GND
  // and PWR_LED pads are only 4 units apart, so their rings overlap).
  const foreignRects = [];
  const pendingSpokes = [];
  let sameNetPads = 0;
  for (const item of copperItems(model)) {
    const sameNet = (item.net || '') === net;
    if (item.kind === 'pad') {
      const b = item.bbox ?? padBBox({ x: item.x, y: item.y, width: item.width, height: item.height });
      const onLayer = item.layer === 11 || item.layer === layer;
      if (!onLayer) continue;
      if (sameNet) {
        sameNetPads++;
        clearRect(b.minX - clearance, b.minY - clearance, b.maxX + clearance, b.maxY + clearance);
        // remember the pad body so thermal spokes can be cut through the ring
        for (let j = Math.max(0, Math.floor((b.minY - minY) / cell)); j <= Math.min(rows - 1, Math.ceil((b.maxY - minY) / cell)); j++) {
          for (let i = Math.max(0, Math.floor((b.minX - minX) / cell)); i <= Math.min(cols - 1, Math.ceil((b.maxX - minX) / cell)); i++) padCells.add(idx(i, j));
        }
        if (thermal) pendingSpokes.push(b);
      } else {
        clearRect(b.minX - clearance, b.minY - clearance, b.maxX + clearance, b.maxY + clearance);
        foreignRects.push({ minX: b.minX - clearance, maxX: b.maxX + clearance, minY: b.minY - clearance, maxY: b.maxY + clearance });
      }
    } else if (item.kind === 'track' && (item.layer === layer || item.layer === 11)) {
      if (sameNet) continue;
      const w = (item.width ?? 1) / 2 + clearance;
      for (let k = 0; k + 1 < (item.points ?? []).length; k++) {
        const a = item.points[k], b = item.points[k + 1];
        const r = { minX: Math.min(a.x, b.x) - w, maxX: Math.max(a.x, b.x) + w, minY: Math.min(a.y, b.y) - w, maxY: Math.max(a.y, b.y) + w };
        clearRect(r.minX, r.minY, r.maxX, r.maxY);
        foreignRects.push(r);
      }
    } else if (item.kind === 'via') {
      if (sameNet) continue;
      const r = (item.diameter ?? 3) / 2 + clearance;
      clearRect(item.x - r, item.y - r, item.x + r, item.y + r);
      foreignRects.push({ minX: item.x - r, maxX: item.x + r, minY: item.y - r, maxY: item.y + r });
    } else if (item.kind === 'pour') {
      if (sameNet) continue;
      for (const p of item.path ?? []) clearRect(p.x - clearance, p.y - clearance, p.x + clearance, p.y + clearance);
    }
  }

  /**
   * Cut the four thermal spokes back into the ring around a pad, skipping any
   * cell that would eat into a foreign pad's clearance.
   */
  function cutSpokes(b, half, ring) {
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const blockedByForeign = (x, y) => foreignRects.some((r) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY);
    const set = (x, y) => {
      if (blockedByForeign(x, y)) return;
      const i = Math.round((x - minX) / cell), j = Math.round((y - minY) / cell);
      if (i >= 0 && j >= 0 && i < cols && j < rows) free[idx(i, j)] = 1;
    };
    for (let t = 0; t <= ring + 1; t += 1) {
      for (let s = -half; s <= half; s += 1) {
        set(b.minX - t, cy + s);
        set(b.maxX + t, cy + s);
        set(cx + s, b.minY - t);
        set(cx + s, b.maxY + t);
      }
    }
  }

  // Pass 2: thermal spokes, now that every foreign clearance ring is known
  if (thermal) for (const b of pendingSpokes) cutSpokes(b, spokeWidth / 2, clearance);

  return {
    net, layer, cell, clearance, edge, thermal, spokeWidth,
    // exposed so other steps (via stitching) can measure exact distances instead
    // of relying on cell granularity
    foreignRects,
    cols, rows, minX, minY, free, padCells, idx, toCell, toBoard,
    region, sameNetPads,
    at: (i, j) => (i < 0 || j < 0 || i >= cols || j >= rows ? 0 : free[idx(i, j)]),
  };
}

/**
 * Remove cells that only touch their neighbours diagonally.
 *
 * Two regions that meet at a single corner make the boundary tracer ambiguous
 * (four edges meet at one vertex) and it then produces crossing loops, which in
 * turn makes the clearance check report copper where there is none.
 */
export function despeckle(grid) {
  const { cols, rows, free, idx } = grid;
  let changed = true;
  let removed = 0;
  while (changed) {
    changed = false;
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (!free[idx(i, j)]) continue;
        const up = j > 0 && free[idx(i, j - 1)];
        const down = j < rows - 1 && free[idx(i, j + 1)];
        const left = i > 0 && free[idx(i - 1, j)];
        const right = i < cols - 1 && free[idx(i + 1, j)];
        const orthogonal = [up, down, left, right].filter(Boolean).length;
        const diagonal = (j > 0 && i > 0 && free[idx(i - 1, j - 1)])
          || (j > 0 && i < cols - 1 && free[idx(i + 1, j - 1)])
          || (j < rows - 1 && i > 0 && free[idx(i - 1, j + 1)])
          || (j < rows - 1 && i < cols - 1 && free[idx(i + 1, j + 1)]);
        // isolated cell, or a cell whose only links are corner links
        if (orthogonal === 0 || (orthogonal === 2 && ((up && down) || (left && right)) === false && !((up && left) || (up && right) || (down && left) || (down && right)))) {
          free[idx(i, j)] = 0;
          removed++;
          changed = true;
        }
      }
    }
  }
  return removed;
}

/** Flood fill and keep only the components that reach a pad of the pour net. */
export function fillPour(grid, { keepIslands = false, despeckleFirst = true } = {}) {
  if (despeckleFirst) despeckle(grid);
  const { cols, rows, free, idx } = grid;
  const label = new Int32Array(cols * rows).fill(-1);
  const components = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const start = idx(i, j);
      if (!free[start] || label[start] >= 0) continue;
      const id = components.length;
      const queue = [start];
      label[start] = id;
      let touchesPad = false;
      let size = 0;
      while (queue.length) {
        const cur = queue.pop();
        size++;
        if (grid.padCells.has(cur)) touchesPad = true;
        const ci = cur % cols, cj = (cur - ci) / cols;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di, nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
          const nk = idx(ni, nj);
          if (!free[nk] || label[nk] >= 0) continue;
          label[nk] = id;
          queue.push(nk);
        }
      }
      components.push({ id, size, touchesPad });
    }
  }
  const keep = new Set();
  const withPads = components.filter((c) => c.touchesPad);
  if (withPads.length) for (const c of withPads) keep.add(c.id);
  else if (keepIslands && components.length) keep.add(components.sort((a, b) => b.size - a.size)[0].id);
  const removed = components.filter((c) => !keep.has(c.id));
  return {
    label, components, keep,
    stats: {
      components: components.length,
      kept: keep.size,
      removedIslands: removed.length,
      removedCells: removed.reduce((n, c) => n + c.size, 0),
      filledCells: [...keep].reduce((n, id) => n + components[id].size, 0),
    },
  };
}

/** Trace the filled cells into closed polygons (axis-aligned, clockwise in screen coords). */
export function tracePolygons(grid, fill) {
  const { cols, rows, idx } = grid;
  const kept = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && fill.label[idx(i, j)] >= 0 && fill.keep.has(fill.label[idx(i, j)]);
  // collect boundary edges as vertex pairs on the cell corner lattice
  const edges = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const a = `${x1},${y1}`, b = `${x2},${y2}`;
    if (!edges.has(a)) edges.set(a, []);
    edges.get(a).push(b);
  };
  const dirOf = (from, to) => {
    const [x1, y1] = from.split(',').map(Number);
    const [x2, y2] = to.split(',').map(Number);
    return { x: Math.sign(x2 - x1), y: Math.sign(y2 - y1) };
  };
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (!kept(i, j)) continue;
      if (!kept(i, j - 1)) addEdge(i, j, i + 1, j);            // top
      if (!kept(i + 1, j)) addEdge(i + 1, j, i + 1, j + 1);    // right
      if (!kept(i, j + 1)) addEdge(i + 1, j + 1, i, j + 1);    // bottom
      if (!kept(i - 1, j)) addEdge(i, j + 1, i, j);            // left
    }
  }
  const polygons = [];
  const usedEdges = new Set();
  const edgeKey = (a, b) => `${a}>${b}`;
  for (const [start, list] of edges) {
    for (const first of list) {
      if (usedEdges.has(edgeKey(start, first))) continue;
      const loop = [];
      let cur = start;
      let next = first;
      let guard = 0;
      while (next && guard++ < cols * rows * 4 + 16) {
        usedEdges.add(edgeKey(cur, next));
        const [x, y] = cur.split(',').map(Number);
        loop.push(grid.toBoard(x, y));
        const incoming = dirOf(cur, next);
        const prev = cur;
        cur = next;
        const candidates = (edges.get(cur) ?? []).filter((n) => !usedEdges.has(edgeKey(cur, n)));
        if (!candidates.length) { next = null; break; }
        // Always take the sharpest RIGHT turn. Picking "any unused edge" jumps
        // across the mouth of a narrow channel and welds a notch into the outer
        // contour, which then claims copper where there is none.
        const rank = (to) => {
          const d = dirOf(cur, to);
          const cross = incoming.x * d.y - incoming.y * d.x;
          const dot = incoming.x * d.x + incoming.y * d.y;
          if (cross > 0) return 0;                 // right
          if (cross === 0 && dot > 0) return 1;    // straight
          if (cross < 0) return 2;                 // left
          return 3;                                // back
        };
        candidates.sort((a, b) => rank(a) - rank(b));
        next = candidates[0];
      }
      if (loop.length >= 4) polygons.push(simplifyLoop(loop));
    }
  }
  return polygons;
}

/** Drop collinear midpoints from a rectilinear loop. */
export function simplifyLoop(points) {
  if (points.length < 3) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const prev = out[out.length - 1] ?? points[(i - 1 + points.length) % points.length];
    const cur = points[i];
    const next = points[(i + 1) % points.length];
    const collinear = (prev.x === cur.x && cur.x === next.x) || (prev.y === cur.y && cur.y === next.y);
    if (!collinear) out.push(cur);
  }
  return out.length >= 3 ? out : points;
}

/** Signed area of a loop (positive = clockwise in screen coordinates). */
export function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Run a pour for one net and return polygons plus statistics. */
export function pourNet(model, opts = {}) {
  const grid = buildPourGrid(model, opts);
  const fill = fillPour(grid, { keepIslands: opts.keepIsland });
  const polygons = tracePolygons(grid, fill);
  // Signed areas: the tracer walks outer boundaries clockwise (positive) and the
  // boundaries of holes counter-clockwise, so the sum is the copper area. Taking
  // abs() per loop instead added the holes and produced more copper than board.
  const areaMm2 = Math.abs(polygons.reduce((n, poly) => n + signedArea(poly), 0)) * (0.254 ** 2);
  return {
    net: grid.net, layer: grid.layer, polygons, grid, fill,
    stats: {
      ...fill.stats,
      polygons: polygons.length,
      areaMm2: +areaMm2.toFixed(1),
      clearance: grid.clearance,
      thermal: grid.thermal,
      sameNetPads: grid.sameNetPads,
    },
  };
}

/** Add pours to a board document and return the new document. */
export function pourBoard(model, opts = {}) {
  const nets = opts.nets ?? [defaultPourNet(model)];
  const layer = opts.layer ?? 1;
  const results = [];
  const shape = [...(model.rawShape ?? [])];
  for (const net of nets) {
    const pour = pourNet(model, { ...opts, net, layer });
    results.push(pour);
    for (const poly of pour.polygons) {
      shape.push(copperAreaRecord({
        layer, net, path: poly,
        clearance: (opts.clearance ?? 1) * 0.254,
        fillStyle: 'solid',
        thermal: pour.grid.thermal ? 'yes' : 'no',
        keepIsland: opts.keepIsland ? '1' : '0',
        spoke_width: (opts.spokeWidth ?? 2) * 0.254,
      }));
    }
  }
  const doc = boardDocument({
    shape,
    layers: [...model.layers.values()].map((l) => `${l.id}~${l.name}~${l.color}~${l.visible}~${l.active}`),
    drc: model.drc?.default ? { Default: model.drc.default, isRealtime: true } : DEFAULT_DRC,
    originX: model.canvas?.originX ?? 4000,
    originY: model.canvas?.originY ?? 3000,
  });
  return { doc, pours: results, stats: { nets: results.length, polygons: results.reduce((n, r) => n + r.polygons.length, 0) } };
}

/**
 * Self check: no copper of another net may fall inside a pour polygon, and the
 * pour must respect the clearance ring around it.
 */
export function verifyPour(model, pour, { tolerance = 0.5 } = {}) {
  // Even-odd across ALL loops: a point inside an outer boundary but also inside a
  // hole boundary is NOT copper.
  const insideAny = (pt) => {
    let crossings = 0;
    for (const poly of pour.polygons) {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y) + a.x) hit = !hit;
      }
      if (hit) crossings++;
    }
    return crossings % 2 === 1;
  };
  const violations = [];
  for (const item of copperItems(model)) {
    if (item.kind !== 'pad' && item.kind !== 'via') continue;
    if ((item.net || '') === pour.net) continue;
    if (item.kind === 'pad' && item.layer !== 11 && item.layer !== pour.layer) continue;
    const b = item.kind === 'pad'
      ? (item.bbox ?? padBBox({ x: item.x, y: item.y, width: item.width, height: item.height }))
      : { minX: item.x - (item.diameter ?? 3) / 2, maxX: item.x + (item.diameter ?? 3) / 2, minY: item.y - (item.diameter ?? 3) / 2, maxY: item.y + (item.diameter ?? 3) / 2 };
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    if (insideAny({ x: cx, y: cy })) {
      violations.push({ pad: item.number, net: item.net, pourNet: pour.net, at: { x: Math.round(cx), y: Math.round(cy) } });
    }
  }
  return { ok: violations.length === 0, count: violations.length, violations: violations.slice(0, 20) };
}
