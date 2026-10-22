// Routing: track/via primitives plus a two-layer grid maze router.
//
// The router works on the same data the rest of the PCB code uses: a parsed
// board model with pads that already carry their net names (P-04 wrote them).
// It builds a raster of the board, marks everything a track may not touch
// (foreign pads, existing copper, the board edge, all inflated by the clearance
// rule), and connects each net with A*, one pin pair at a time in MST order.
//
// Output is emitted through the writer, so what comes out is the same record
// format the editor reads.
import { mmToUnit, toMm, UNIT_MM, boardOutline, copperItems, padBBox } from './parser.js';
import { trackRecord, viaRecord, genGid, boardDocument, DEFAULT_LAYERS, DEFAULT_DRC } from './writer.js';

const key = (l, i, j) => `${l}:${i}:${j}`;

/** Snap a board coordinate onto the routing grid. */
const snap = (v, origin, cell) => Math.round((v - origin) / cell);

/**
 * Rasterise the board for routing.
 *
 * @param {object} model parsed board
 * @param {{cell?: number, clearance?: number, width?: number, layers?: number[], margin?: number}} opts
 */
export function buildGrid(model, opts = {}) {
  const cell = opts.cell ?? 2;                       // 2 units = 0.508 mm
  const clearance = opts.clearance ?? 2;             // in units
  const width = opts.width ?? 1;                     // track width, in units
  const layers = opts.layers ?? [1, 2];
  const margin = opts.margin ?? 4;
  // a track runs along cell centres, so blocking has to cover the clearance, the
  // track's own half width and one cell of quantisation - otherwise a track can
  // legally sit on a cell whose centre is still inside the pad's clearance ring
  const inflate = clearance + width / 2 + cell;

  const outline = boardOutline(model);
  const minX = (outline?.minX ?? 0) - margin;
  const minY = (outline?.minY ?? 0) - margin;
  const maxX = (outline?.maxX ?? 1000) + margin;
  const maxY = (outline?.maxY ?? 1000) + margin;
  const cols = Math.max(2, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(2, Math.ceil((maxY - minY) / cell));

  const blocked = new Map();                          // layer -> Uint8Array
  for (const l of layers) blocked.set(l, new Uint8Array(cols * rows));
  const idx = (i, j) => j * cols + i;
  const inBounds = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;

  /** Block every cell within `radius` of a rectangle. */
  const blockRect = (layer, x0, y0, x1, y1, radius = inflate) => {
    const arr = blocked.get(layer);
    if (!arr) return;
    const i0 = snap(Math.min(x0, x1) - radius, minX, cell);
    const i1 = snap(Math.max(x0, x1) + radius, minX, cell);
    const j0 = snap(Math.min(y0, y1) - radius, minY, cell);
    const j1 = snap(Math.max(y0, y1) + radius, minY, cell);
    for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) arr[idx(i, j)] = 1;
    }
  };

  // the board edge is a wall on every layer
  if (outline) {
    for (const layer of layers) {
      const arr = blocked.get(layer);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const x = minX + i * cell, y = minY + j * cell;
          if (x < outline.minX + inflate || x > outline.maxX - inflate
            || y < outline.minY + inflate || y > outline.maxY - inflate) arr[idx(i, j)] = 1;
        }
      }
    }
  }

  // existing copper blocks everything that is not on the same net
  const items = copperItems(model);
  const padTerminals = [];                            // {net, layer, i, j, x, y, number, footprint}
  for (const item of items) {
    if (item.kind === 'pad') {
      const layersForPad = item.layer === 11 ? layers : [item.layer];
      const bb = item.bbox ?? { minX: item.x - item.width / 2, maxX: item.x + item.width / 2, minY: item.y - item.height / 2, maxY: item.y + item.height / 2 };
      for (const layer of layersForPad) {
        if (!blocked.has(layer)) continue;
        blockRect(layer, bb.minX, bb.minY, bb.maxX, bb.maxY);
      }
      for (const layer of layersForPad) {
        if (!blocked.has(layer)) continue;
        padTerminals.push({
          net: item.net || '', layer, x: item.x, y: item.y,
          width: item.width ?? 0, height: item.height ?? 0, bbox: bb,
          i: snap(item.x, minX, cell), j: snap(item.y, minY, cell),
          number: item.number, footprint: item.footprint,
        });
      }
    } else if (item.kind === 'track') {
      for (let k = 0; k + 1 < (item.points ?? []).length; k++) {
        const a = item.points[k], b = item.points[k + 1];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 2)));
        for (let s = 0; s <= steps; s++) {
          const x = a.x + ((b.x - a.x) * s) / steps;
          const y = a.y + ((b.y - a.y) * s) / steps;
          blockRect(item.layer, x, y, x, y, (item.width ?? 1) / 2 + inflate);
        }
      }
    } else if (item.kind === 'via') {
      for (const layer of layers) blockRect(layer, item.x, item.y, item.x, item.y, (item.diameter ?? 24) / 2 + inflate);
    }
  }

  return {
    cell, clearance, width, inflate, layers, cols, rows, minX, minY, maxX, maxY, blocked, idx, inBounds,
    toCell: (x, y) => ({ i: snap(x, minX, cell), j: snap(y, minY, cell) }),
    toBoard: (i, j) => ({ x: minX + i * cell, y: minY + j * cell }),
    isBlocked: (layer, i, j) => !inBounds(i, j) || blocked.get(layer)[idx(i, j)] === 1,
    setBlocked: (layer, i, j, v = 1) => { if (inBounds(i, j) && blocked.has(layer)) blocked.get(layer)[idx(i, j)] = v; },
    padTerminals,
    model,
  };
}

/** A* between two cells; returns a list of {layer,i,j} or null. */
export function routeCells(grid, start, goal, opts = {}) {
  const { layers } = grid;
  const viaCost = opts.viaCost ?? 6;
  const startKey = key(start.layer, start.i, start.j);
  const goalKey = key(goal.layer, goal.i, goal.j);
  const h = (l, i, j) => Math.abs(i - goal.i) + Math.abs(j - goal.j) + (l === goal.layer ? 0 : viaCost);

  const open = new Map([[startKey, { l: start.layer, i: start.i, j: start.j, g: 0, f: h(start.layer, start.i, start.j), prev: null }]]);
  const best = new Map([[startKey, 0]]);
  const closed = new Set();
  let guard = 0;

  while (open.size && guard++ < 400000) {
    // pick the lowest f (small maps: linear scan is fine and deterministic)
    let curKey = null, cur = null;
    for (const [k, node] of open) if (!cur || node.f < cur.f) { curKey = k; cur = node; }
    open.delete(curKey);
    if (curKey === goalKey) {
      const path = [];
      for (let n = cur; n; n = n.prev) path.push({ layer: n.l, i: n.i, j: n.j });
      return path.reverse();
    }
    closed.add(curKey);
    const neighbours = [];
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const i = cur.i + di, j = cur.j + dj;
      if (!grid.isBlocked(cur.l, i, j)) neighbours.push({ l: cur.l, i, j, cost: 1 });
    }
    for (const l of layers) {
      if (l === cur.l) continue;
      if (!grid.isBlocked(l, cur.i, cur.j)) neighbours.push({ l, i: cur.i, j: cur.j, cost: viaCost, via: true });
    }
    for (const nb of neighbours) {
      const k = key(nb.l, nb.i, nb.j);
      if (closed.has(k)) continue;
      const g = cur.g + nb.cost;
      if (best.has(k) && best.get(k) <= g) continue;
      best.set(k, g);
      open.set(k, { l: nb.l, i: nb.i, j: nb.j, g, f: g + h(nb.l, nb.i, nb.j), prev: cur });
    }
  }
  return null;
}

/** Turn a cell path into tracks and vias, merging straight runs. */
export function pathToCopper(grid, path, { net, width }) {
  const tracks = [];
  const vias = [];
  let run = [{ x: grid.toBoard(path[0].i, path[0].j).x, y: grid.toBoard(path[0].i, path[0].j).y }];
  let layer = path[0].layer;
  const flush = () => {
    if (run.length >= 2) tracks.push({ layer, net, width, points: run });
    run = [];
  };
  for (let k = 1; k < path.length; k++) {
    const p = path[k];
    if (p.layer !== layer) {
      const here = grid.toBoard(p.i, p.j);
      run.push({ x: here.x, y: here.y });
      flush();
      vias.push({ x: here.x, y: here.y, net });
      layer = p.layer;
      run = [{ x: here.x, y: here.y }];
      continue;
    }
    const q = grid.toBoard(p.i, p.j);
    const prev = run[run.length - 1];
    // collapse collinear steps
    if (run.length >= 2) {
      const before = run[run.length - 2];
      const collinear = (before.x === prev.x && prev.x === q.x) || (before.y === prev.y && prev.y === q.y);
      if (collinear) { run[run.length - 1] = { x: q.x, y: q.y }; continue; }
    }
    run.push({ x: q.x, y: q.y });
  }
  flush();
  return { tracks, vias };
}

/** Minimum spanning tree over the pads of one net (Prim, Manhattan distance). */
export function mstOrder(pads) {
  if (pads.length <= 1) return [];
  const used = new Set([0]);
  const edges = [];
  while (used.size < pads.length) {
    let best = null;
    for (const a of used) {
      for (let b = 0; b < pads.length; b++) {
        if (used.has(b)) continue;
        const d = Math.abs(pads[a].x - pads[b].x) + Math.abs(pads[a].y - pads[b].y);
        if (!best || d < best.d) best = { a, b, d };
      }
    }
    if (!best) break;
    used.add(best.b);
    edges.push([best.a, best.b]);
  }
  return edges;
}

/**
 * Route a whole board.
 *
 * @param {object} model parsed board
 * @param {{cell?: number, clearance?: number, width?: number, viaDiameter?: number, viaHole?: number, maxNets?: number, nets?: string[]}} opts
 */
export function autoroute(model, opts = {}) {
  // the DRC block stores millimetres; geometry is in units (1 unit = 0.254 mm)
  const drc = model.drc?.default ?? DEFAULT_DRC.Default;
  const width = opts.width ?? Math.max(1, Math.round(mmToUnit(drc.trackWidth ?? 0.254)));
  const clearance = opts.clearance ?? Math.max(1, Math.round(mmToUnit(drc.clearance ?? 0.254)));
  const grid = buildGrid(model, { clearance, ...opts });
  const netOf = new Map();
  for (const pad of grid.padTerminals) {
    if (!pad.net) continue;
    if (!netOf.has(pad.net)) netOf.set(pad.net, []);
    netOf.get(pad.net).push(pad);
  }

  /**
   * A pad blocks its own cells, so a track could never leave it. Opening a 3x3
   * window is not enough for a 2.54 mm pitch through-hole pad: the whole pad
   * area (plus its clearance ring) has to be walkable while routing that net,
   * and only for that net.
   */
  // Every pad of every net, as a rectangle - used to make sure that opening a
  // pad's own window never exposes a neighbour's clearance ring (0603 parts sit
  // only ~6 units apart, so the windows do overlap).
  const allPads = [];
  for (const fp of model.footprints) {
    for (const pad of fp.pads) {
      if (!pad.net) continue;
      const b = padBBox(pad);
      allPads.push({ net: pad.net, x: pad.x, y: pad.y, minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY });
    }
  }
  const nearestForeign = (x, y, net) => {
    let best = Infinity;
    for (const p of allPads) {
      if (p.net === net) continue;
      const dx = Math.max(p.minX - x, 0, x - p.maxX);
      const dy = Math.max(p.minY - y, 0, y - p.maxY);
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    return best;
  };
  const needed = clearance + width / 2;

  const openPad = (pad) => {
    const cells = [];
    // Open the pad's OWN rectangle (plus clearance), never a square of radius
    // max(halfW, halfH): that square reaches 10 units sideways and unblocks the
    // neighbouring through-hole pad, which the router then happily crosses.
    const bb = pad.bbox ?? { minX: pad.x - (pad.width ?? 0) / 2, maxX: pad.x + (pad.width ?? 0) / 2, minY: pad.y - (pad.height ?? 0) / 2, maxY: pad.y + (pad.height ?? 0) / 2 };
    const i0 = snap(bb.minX - clearance, grid.minX, grid.cell);
    const i1 = snap(bb.maxX + clearance, grid.minX, grid.cell);
    const j0 = snap(bb.minY - clearance, grid.minY, grid.cell);
    const j1 = snap(bb.maxY + clearance, grid.minY, grid.cell);
    for (const layer of grid.layers) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!grid.isBlocked(layer, i, j)) continue;
          const at = grid.toBoard(i, j);
          // never open a cell that would let the track violate a foreign pad
          if (nearestForeign(at.x, at.y, pad.net) < needed) continue;
          grid.setBlocked(layer, i, j, 0);
          cells.push([layer, i, j]);
        }
      }
    }
    return cells;
  };
  const closeCells = (cells) => { for (const [l, i, j] of cells) grid.setBlocked(l, i, j, 1); };

  // route short nets first: they are the ones that get boxed in
  const order = [...netOf.entries()]
    .map(([net, pads]) => {
      const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y);
      const span = (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
      return { net, pads, span };
    })
    .filter((n) => n.pads.length > 1 && (!opts.nets || opts.nets.includes(n.net)))
    .sort((a, b) => a.span - b.span || a.net.localeCompare(b.net));

  const tracks = [];
  const vias = [];
  const routed = [];
  const failed = [];
  const viaDiameter = opts.viaDiameter ?? Math.max(3, Math.round(mmToUnit(drc.viaHoleDiameter ?? 0.6)));
  const viaHole = opts.viaHole ?? Math.max(1, Math.round(mmToUnit(drc.viaHoleD ?? 0.3)));

  for (const { net, pads } of order) {
    const edges = mstOrder(pads);
    let ok = true;
    const netTracks = [];
    const netVias = [];
    for (const [ai, bi] of edges) {
      const a = pads[ai], b = pads[bi];
      // walkable while routing this net: the two pads' own areas
      const opened = [...openPad(a), ...openPad(b)];
      const path = routeCells(grid, { layer: a.layer, i: a.i, j: a.j }, { layer: b.layer, i: b.i, j: b.j }, { viaCost: opts.viaCost ?? 6 });
      closeCells(opened);
      if (!path) {
        ok = false;
        failed.push({ net, from: `${a.footprint}.${a.number}`, to: `${b.footprint}.${b.number}` });
        continue;
      }
      const produced = pathToCopper(grid, path, { net, width });
      netTracks.push(...produced.tracks);
      netVias.push(...produced.vias);
      // reserve the new copper so later nets keep their distance
      for (const track of produced.tracks) {
        for (let k = 0; k + 1 < track.points.length; k++) {
          const p0 = track.points[k], p1 = track.points[k + 1];
          const steps = Math.max(1, Math.ceil(Math.hypot(p1.x - p0.x, p1.y - p0.y) / (grid.cell / 2)));
          for (let s = 0; s <= steps; s++) {
            const x = p0.x + ((p1.x - p0.x) * s) / steps;
            const y = p0.y + ((p1.y - p0.y) * s) / steps;
            const c = grid.toCell(x, y);
            const radius = Math.ceil((width / 2 + grid.clearance) / grid.cell);
            for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) grid.setBlocked(track.layer, c.i + di, c.j + dj, 1);
          }
        }
      }
      for (const via of produced.vias) {
        const c = grid.toCell(via.x, via.y);
        const radius = Math.ceil((viaDiameter / 2 + grid.clearance) / grid.cell);
        for (const l of grid.layers) for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) grid.setBlocked(l, c.i + di, c.j + dj, 1);
      }
    }
    if (netTracks.length || netVias.length) {
      tracks.push(...netTracks);
      vias.push(...netVias);
      if (ok) routed.push(net); else failed.push({ net, partial: true });
    }
  }

  const lengthUnits = tracks.reduce((n, t) => n + t.points.slice(1).reduce((m, p, i) => m + Math.abs(p.x - t.points[i].x) + Math.abs(p.y - t.points[i].y), 0), 0);
  return {
    tracks, vias, routed, failed,
    stats: {
      nets: order.length,
      routed: routed.length,
      failed: failed.length,
      tracks: tracks.length,
      vias: vias.length,
      lengthMm: +toMm(lengthUnits).toFixed(1),
    },
  };
}

/**
 * Self-check the router's own output: a track must not pass through a pad of a
 * different net. (The full rule engine is P-09; this only guards routing.)
 */
/** Shortest distance between an axis-aligned segment and a rectangle. */
function segRectDistance(a, b, rect) {
  const cx = Math.max(rect.minX, Math.min(a.x, rect.maxX));
  const cy = Math.max(rect.minY, Math.min(a.y, rect.maxY));
  // sample-free: distance from the segment to the closest point of the rect
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((cx - a.x) * dx + (cy - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = a.x + t * dx, py = a.y + t * dy;
  const qx = Math.max(rect.minX, Math.min(px, rect.maxX));
  const qy = Math.max(rect.minY, Math.min(py, rect.maxY));
  return Math.hypot(px - qx, py - qy);
}

export function verifyRouting(model, tracks, { clearance = 1, epsilon = 0.01 } = {}) {
  const foreign = [];
  for (const fp of model.footprints) {
    for (const pad of fp.pads) {
      if (!pad.net) continue;
      const b = padBBox(pad);
      foreign.push({ net: pad.net, layer: pad.layer, ref: `${fp.name}.${pad.number}`, rect: { minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY } });
    }
  }
  const violations = [];
  for (const t of tracks) {
    const half = (t.width ?? 1) / 2;
    for (let k = 0; k + 1 < t.points.length; k++) {
      const a = t.points[k], b = t.points[k + 1];
      for (const pad of foreign) {
        if (pad.net === t.net) continue;
        // a track on one layer cannot clash with an SMD pad on another
        // (layer 11 = through-hole = every layer)
        if (pad.layer !== 11 && pad.layer !== t.layer) continue;
        const d = segRectDistance(a, b, pad.rect) - half;
        if (d < clearance - epsilon) {
          violations.push({ net: t.net, layer: t.layer, pad: pad.ref, padNet: pad.net, gapMm: +(d * UNIT_MM).toFixed(3) });
        }
      }
    }
  }
  return { ok: violations.length === 0, violations: violations.slice(0, 20), count: violations.length };
}

/** Autoroute a board and return a new document with the copper added. */
export function routeBoard(model, opts = {}) {
  const result = autoroute(model, opts);
  const drc = model.drc?.default ?? DEFAULT_DRC.Default;
  const viaDiameter = opts.viaDiameter ?? Math.max(3, Math.round(mmToUnit(drc.viaHoleDiameter ?? 0.6)));
  const viaHole = opts.viaHole ?? Math.max(1, Math.round(mmToUnit(drc.viaHoleD ?? 0.3)));
  const shape = [...(model.rawShape ?? [])];
  for (const t of result.tracks) shape.push(trackRecord(t));
  for (const v of result.vias) shape.push(viaRecord({ ...v, diameter: viaDiameter, holeR: viaHole }));
  const doc = boardDocument({
    shape,
    layers: [...model.layers.values()].map((l) => `${l.id}~${l.name}~${l.color}~${l.visible}~${l.active}`),
    drc: model.drc?.default ? { Default: model.drc.default, isRealtime: true } : DEFAULT_DRC,
    originX: model.canvas?.originX ?? 4000,
    originY: model.canvas?.originY ?? 3000,
  });
  return { doc, ...result };
}

