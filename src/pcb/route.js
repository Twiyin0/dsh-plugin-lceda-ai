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
import { mmToUnit, toMm, UNIT_MM, boardOutline, copperItems, padBBox, parsePcb } from './parser.js';
import { copperGap } from './drc.js';
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
  // "hard" marks cells that may never be opened for a pad: foreign pads, the
  // board edge, and copper that is already routed. Opening such a cell let a
  // later net run straight through an earlier track (the DRC found it, the
  // router's own pad-only check did not).
  const hard = new Map();
  // Cells where a via may not be placed: within (via radius + clearance) of ANY
  // pad. A via is a disc, so on a 0.65 mm pitch connector it cannot fit between
  // two pads - the router used to drop one on the pad centre and violate the
  // clearance to the neighbour. Through-hole pads do not need a via anyway
  // (skipVia handles them), so excluding every pad is both safe and simple.
  const noVia = new Map();
  // A via *inside* a pad is never allowed; one in the ring around a pad is priced
  // rather than forbidden, so the router can still finish when there is no other
  // way across.
  const noViaHard = new Map();
  const viaRadius = opts.viaRadius ?? 1.5;
  const holeToHole = opts.holeToHole ?? (model.drc?.default ?? DEFAULT_DRC.Default).holeToHole ?? 2;


  for (const l of layers) {
    blocked.set(l, new Uint8Array(cols * rows));
    hard.set(l, new Uint8Array(cols * rows));
    noVia.set(l, new Uint8Array(cols * rows));
    noViaHard.set(l, new Uint8Array(cols * rows));
  }
  const idx = (i, j) => j * cols + i;
  const inBounds = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows;

  /** Block every cell within `radius` of a rectangle. */
  const blockRect = (layer, x0, y0, x1, y1, radius = inflate, isHard = false) => {
    const arr = blocked.get(layer);
    if (!arr) return;
    const hardArr = hard.get(layer);
    const i0 = snap(Math.min(x0, x1) - radius, minX, cell);
    const i1 = snap(Math.max(x0, x1) + radius, minX, cell);
    const j0 = snap(Math.min(y0, y1) - radius, minY, cell);
    const j1 = snap(Math.max(y0, y1) + radius, minY, cell);
    for (let j = Math.max(0, j0); j <= Math.min(rows - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(cols - 1, i1); i++) {
        arr[idx(i, j)] = 1;
        if (isHard) hardArr[idx(i, j)] = 1;
      }
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
            || y < outline.minY + inflate || y > outline.maxY - inflate) { arr[idx(i, j)] = 1; hard.get(layer)[idx(i, j)] = 1; }
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
        // pads stay "soft": a net may open its own pad area, while routed copper
        // and the board edge are permanent
        blockRect(layer, bb.minX, bb.minY, bb.maxX, bb.maxY, inflate, false);
        // ... but a via keep-out around every pad is permanent
        // physical requirement only: the via edge must keep the clearance
        const keep = clearance + viaRadius;
        const vi0 = Math.max(0, snap(bb.minX - keep, minX, cell));
        const vi1 = Math.min(cols - 1, snap(bb.maxX + keep, minX, cell));
        const vj0 = Math.max(0, snap(bb.minY - keep, minY, cell));
        const vj1 = Math.min(rows - 1, snap(bb.maxY + keep, minY, cell));
        for (let j = vj0; j <= vj1; j++) for (let i = vi0; i <= vi1; i++) noVia.get(layer)[idx(i, j)] = 1;
        // A via's drill must also keep the hole-to-hole spacing from an existing
        // hole: clearance alone is not enough around a through-hole pad, and the
        // router used to drop a via 0.482 mm from a DIP pin's hole.
        const padHoleR = item.holeR ?? 0;
        if (padHoleR > 0) {
          const holeKeep = holeToHole + padHoleR + viaRadius;
          const hi0 = Math.max(0, snap(bb.minX - holeKeep, minX, cell));
          const hi1 = Math.min(cols - 1, snap(bb.maxX + holeKeep, minX, cell));
          const hj0 = Math.max(0, snap(bb.minY - holeKeep, minY, cell));
          const hj1 = Math.min(rows - 1, snap(bb.maxY + holeKeep, minY, cell));
          for (let j = hj0; j <= hj1; j++) for (let i = hi0; i <= hi1; i++) noVia.get(layer)[idx(i, j)] = 1;
        }
        const hi0 = Math.max(0, snap(bb.minX, minX, cell));
        const hi1 = Math.min(cols - 1, snap(bb.maxX, minX, cell));
        const hj0 = Math.max(0, snap(bb.minY, minY, cell));
        const hj1 = Math.min(rows - 1, snap(bb.maxY, minY, cell));
        for (let j = hj0; j <= hj1; j++) for (let i = hi0; i <= hi1; i++) noViaHard.get(layer)[idx(i, j)] = 1;
      }
      for (const layer of layersForPad) {
        if (!blocked.has(layer)) continue;
        padTerminals.push({
          net: item.net || '', layer, x: item.x, y: item.y,
          // a layer-11 pad is through-hole: it appears once per routing layer but
          // is a single drilled hole
          through: item.layer === 11,
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
          blockRect(item.layer, x, y, x, y, (item.width ?? 1) / 2 + inflate, true);
        }
      }
    } else if (item.kind === 'via') {
      for (const layer of layers) blockRect(layer, item.x, item.y, item.x, item.y, (item.diameter ?? 24) / 2 + inflate, true);
    }
  }

  return {
    cell, clearance, width, inflate, viaRadius, layers, cols, rows, minX, minY, maxX, maxY, blocked, hard, noVia, idx, inBounds,
    toCell: (x, y) => ({ i: snap(x, minX, cell), j: snap(y, minY, cell) }),
    toBoard: (i, j) => ({ x: minX + i * cell, y: minY + j * cell }),
    isBlocked: (layer, i, j) => !inBounds(i, j) || blocked.get(layer)[idx(i, j)] === 1,
    isHard: (layer, i, j) => !inBounds(i, j) || (hard.get(layer)?.[idx(i, j)] ?? 0) === 1,
    isViaAllowed: (i, j) => {
      if (!inBounds(i, j)) return false;
      for (const l of layers) if (noVia.get(l)?.[idx(i, j)] === 1) return false;
      return true;
    },
    /** True when a via would sit inside a pad: never acceptable. */
    isViaForbidden: (i, j) => {
      if (!inBounds(i, j)) return true;
      for (const l of layers) if (noViaHard.get(l)?.[idx(i, j)] === 1) return true;
      return false;
    },
    setBlocked: (layer, i, j, v = 1) => {
      if (!inBounds(i, j) || !blocked.has(layer)) return;
      blocked.get(layer)[idx(i, j)] = v;
      if (v === 1) hard.get(layer)[idx(i, j)] = 1;      // routed copper is permanent
    },
    /** Re-block a cell that was only soft-blocked (used when a pad opening ends). */
    restoreSoft: (layer, i, j) => {
      if (!inBounds(i, j) || !blocked.has(layer)) return;
      blocked.get(layer)[idx(i, j)] = 1;
    },
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
  // Octilinear (45-degree) routing is the default: a real LCEDA board only ever
  // uses 0/45/90/135 degree segments, and a Manhattan-only search forces a right
  // angle at every bend. The octile heuristic stays admissible for diagonal cost
  // sqrt(2), so A* still finds the shortest legal path.
  const octi = opts.octilinear !== false;
  const SQRT2 = 1.41421356;
  const h = (l, i, j) => {
    const dx = Math.abs(i - goal.i), dy = Math.abs(j - goal.j);
    const d = octi ? (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy)) : dx + dy;
    return d + (l === goal.layer ? 0 : viaCost);
  };

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
    if (octi) {
      // A diagonal step is only legal when BOTH orthogonal cells it squeezes
      // between are free: cutting a corner would clip a foreign pad even though
      // the destination cell itself is clear.
      for (const [di, dj] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const i = cur.i + di, j = cur.j + dj;
        if (grid.isBlocked(cur.l, i, j)) continue;
        if (grid.isBlocked(cur.l, cur.i + di, cur.j)) continue;
        if (grid.isBlocked(cur.l, cur.i, cur.j + dj)) continue;
        neighbours.push({ l: cur.l, i, j, cost: SQRT2 });
      }
    }
    // A via inside the keep-out (next to a fine-pitch pad) is a bad idea but not
    // impossible, so it is priced, not forbidden: forbidding it outright made the
    // router unable to finish simple two-layer boards, because the escape from a
    // pad that had just been routed through was only available on the other layer.
    // A via inside the keep-out is priced, not forbidden: forbidding it outright
    // pushed vias next to through-hole pads instead (hole-to-hole errors) and cost
    // routability on both boards.
    // A via inside the keep-out is priced, not forbidden: forbidding it outright
    // pushed vias next to through-hole pads instead (26 hole-to-hole errors on
    // this board) and cost routability on both boards.
    const viaAllowedHere = !grid.isViaAllowed || grid.isViaAllowed(cur.i, cur.j);
    const viaPenalty = viaAllowedHere ? 1 : (opts.keepOutPenalty ?? 12);
    for (const l of layers) {
      if (l === cur.l) continue;
      if (!grid.isBlocked(l, cur.i, cur.j)) neighbours.push({ l, i: cur.i, j: cur.j, cost: viaCost * viaPenalty, via: true });
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

/**
 * Turn a cell path into tracks and vias, merging straight runs.
 *
 * `skipVia(i, j)` suppresses the via at a layer change: a through-hole pad
 * already connects every layer, so drilling a via into it produced two
 * overlapping holes at the same coordinate (the DRC caught 47 of them).
 */
export function pathToCopper(grid, path, { net, width, skipVia = null }) {
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
      if (!skipVia || !skipVia(p.i, p.j)) vias.push({ x: here.x, y: here.y, net });
      layer = p.layer;
      run = [{ x: here.x, y: here.y }];
      continue;
    }
    const q = grid.toBoard(p.i, p.j);
    const prev = run[run.length - 1];
    // collapse collinear steps, including 45-degree runs (a diagonal run is
    // collinear when |dx| == |dy| with the same sign on both axes)
    if (run.length >= 2) {
      const before = run[run.length - 2];
      const d1x = prev.x - before.x, d1y = prev.y - before.y;
      const d2x = q.x - prev.x, d2y = q.y - prev.y;
      const cross = d1x * d2y - d1y * d2x;
      const sameWay = (d1x === 0 || d2x === 0 || Math.sign(d1x) === Math.sign(d2x))
        && (d1y === 0 || d2y === 0 || Math.sign(d1y) === Math.sign(d2y));
      if (cross === 0 && sameWay) { run[run.length - 1] = { x: q.x, y: q.y }; continue; }
    }
    run.push({ x: q.x, y: q.y });
  }
  flush();
  return { tracks, vias };
}

/**
 * Force every segment onto the 0/45/90/135 degree grid LCEDA boards are drawn on.
 *
 * Landing a track on a pad centre snaps the endpoint off the routing grid, which
 * leaves a short segment at an arbitrary angle (8 deg, 153 deg, ...). Real boards
 * never show those: a corner is either orthogonal or a 45-degree chamfer. Any
 * illegal segment is therefore split into an orthogonal run plus a 45-degree run,
 * which is exactly how the editor's interactive router draws it.
 */
export function legalizeAngles(points) {
  if (!points || points.length < 2) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const adx = Math.abs(dx), ady = Math.abs(dy);
    if (adx < 0.01 && ady < 0.01) continue;                       // duplicate point
    if (adx < 0.01 || ady < 0.01 || Math.abs(adx - ady) < 0.01) { out.push(b); continue; }
    if (adx > ady) out.push({ x: a.x + Math.sign(dx) * (adx - ady), y: a.y });
    else out.push({ x: a.x, y: a.y + Math.sign(dy) * (ady - adx) });
    out.push(b);
  }
  return out;
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
  const viaDiameterOpt = opts.viaDiameter ?? Math.max(3, Math.round(mmToUnit((model.drc?.default ?? DEFAULT_DRC.Default).viaHoleDiameter ?? 0.6)));
  const grid = buildGrid(model, { clearance, viaRadius: viaDiameterOpt / 2, ...opts });
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
      // Pads with no net are still copper: the micro-USB shield pads are netless
      // and a VBUS track ran 0.22 mm from one of them. They must be avoided too,
      // so they are kept here and never match a routing net.
      const b = padBBox(pad);
      allPads.push({ net: pad.net || '', x: pad.x, y: pad.y, minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY });
    }
  }
  const nearestForeign = (x, y, net) => {
    let best = Infinity;
    for (const p of allPads) {
      if (p.net && p.net === net) continue;
      const dx = Math.max(p.minX - x, 0, x - p.maxX);
      const dy = Math.max(p.minY - y, 0, y - p.maxY);
      const d = Math.hypot(dx, dy);
      if (d < best) best = d;
    }
    return best;
  };
  // A pad opening must leave room for the LARGEST copper the router may place
  // there. Using only the track half width let a via (radius 1.5 units) land
  // 0.84 units from a neighbouring pad of another net, which the DRC flagged.
  const viaRadius = (opts.viaDiameter ?? Math.max(3, Math.round(mmToUnit((model.drc?.default ?? DEFAULT_DRC.Default).viaHoleDiameter ?? 0.6)))) / 2;
  // The opening guard is about TRACKS: it must let a track leave the pad, so it
  // uses the track half width. Making it via-sized (radius 1.5) stopped a pad's
  // own centre cell from opening whenever a different-net pad sat 6 units away,
  // which made those nets unroutable. Vias are handled by the keep-out mask.
  // NOTE: adding one cell of margin here (clearance + width/2 + cell) fixed the
  // negative-clearance turns on the DIP-40 board (35 -> 4 errors) but broke the
  // 13-part demo board (0 -> 1 error), so the escape margin still needs a rule
  // that distinguishes a 2.54 mm DIP row from a 0603 pad pair.
  // Two escape margins. The strict one adds a full cell to the clearance, which
  // is what the blocking raster itself uses: any cell opened under it stays legal
  // even after the track end is snapped to a pad centre that sits off grid. The
  // relaxed one is the bare clearance, and is used only when the strict margin
  // leaves a pad with nowhere to go (a 0603 pad pair, a 0.65 mm connector) - then
  // the pad still escapes and any resulting violation is reported by the DRC
  // instead of silently making the net unroutable.
  const neededStrict = clearance + width / 2 + (opts.cell ?? 2);
  const neededRelaxed = clearance + width / 2;

  // cells of through-hole pads: a layer change there needs no via
  // Every cell within the hole-to-hole spacing of a through-hole pad, not just
  // the pad's own cell: a via dropped one cell beside a DIP pin measured a
  // -0.445 mm hole-to-hole gap. Same-net pads are not exempt - the clearance rule
  // skips them, the drill spacing does not.
  const drcRules = model.drc?.default ?? DEFAULT_DRC.Default;
  const holeToHole = opts.holeToHole ?? drcRules.holeToHole ?? 2;
  const viaHoleRadius = (opts.viaDrill ?? drcRules.viaHoleD ?? 1) / 2;
  const throughHoleCells = new Set();
  for (const p of grid.padTerminals) {
    if (!p.through) continue;
    const keep = Math.ceil(((p.holeR ?? 1) + viaHoleRadius + holeToHole) / grid.cell);
    for (let di = -keep; di <= keep; di++) for (let dj = -keep; dj <= keep; dj++) {
      throughHoleCells.add(`${p.i + di}:${p.j + dj}`);
    }
  }
  const skipVia = (i, j) => throughHoleCells.has(`${i}:${j}`);

  /**
   * Cells covered by pads, per net. Reserving routed copper must skip them: a
   * via dropped next to a pad otherwise marks the pad's own cells as hard, and
   * the next edge of that net can never open the pad again.
   */
  const ownPadCells = new Map();          // `${net}|${layers}` -> Set of `${layer}:${i}:${j}`
  for (const pad of grid.padTerminals) {
    const bb = pad.bbox ?? { minX: pad.x - (pad.width ?? 0) / 2, maxX: pad.x + (pad.width ?? 0) / 2, minY: pad.y - (pad.height ?? 0) / 2, maxY: pad.y + (pad.height ?? 0) / 2 };
    const layersForPad = pad.layer === 11 ? grid.layers : [pad.layer];
    const key0 = `${pad.net}|${layersForPad.join(',')}`;
    if (!ownPadCells.has(key0)) ownPadCells.set(key0, new Set());
    const set = ownPadCells.get(key0);
    const i0 = snap(bb.minX, grid.minX, grid.cell), i1 = snap(bb.maxX, grid.minX, grid.cell);
    const j0 = snap(bb.minY, grid.minY, grid.cell), j1 = snap(bb.maxY, grid.minY, grid.cell);
    for (let j = j0 - 1; j <= j1 + 1; j++) {
      for (let i = i0 - 1; i <= i1 + 1; i++) for (const l of layersForPad) set.add(`${l}:${i}:${j}`);
    }
  }
  const isOwnPadCell = (net, layer, i, j) => {
    for (const [k, set] of ownPadCells) {
      const [n, layers] = k.split('|');
      if (n !== net || !layers.split(',').includes(String(layer))) continue;
      if (set.has(`${layer}:${i}:${j}`)) return true;
    }
    return false;
  };

  const openPad = (pad) => {
    const strict = [];
    const relaxed = [];
    // Open the pad's OWN rectangle (plus clearance), never a square of radius
    // max(halfW, halfH): that square reaches 10 units sideways and unblocks the
    // neighbouring through-hole pad, which the router then happily crosses.
    const bb = pad.bbox ?? { minX: pad.x - (pad.width ?? 0) / 2, maxX: pad.x + (pad.width ?? 0) / 2, minY: pad.y - (pad.height ?? 0) / 2, maxY: pad.y + (pad.height ?? 0) / 2 };
    // Open far enough to clear the pad's OWN blocking ring, not just the pad plus
    // the clearance: the ring is `inflate` wide, so a smaller window left the pad
    // an island inside its own blocked cells and the router could only escape by
    // dropping a via on the pad.
    const reach = grid.inflate + grid.cell;
    const i0 = snap(bb.minX - reach, grid.minX, grid.cell);
    const i1 = snap(bb.maxX + reach, grid.minX, grid.cell);
    const j0 = snap(bb.minY - reach, grid.minY, grid.cell);
    const j1 = snap(bb.maxY + reach, grid.minY, grid.cell);
    for (const layer of grid.layers) {
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (!grid.isBlocked(layer, i, j)) continue;
          // never open a cell that is blocked by foreign copper or the board edge
          if (grid.isHard(layer, i, j)) continue;
          const at = grid.toBoard(i, j);
          // A cell inside the pad's own body is always walkable: it is the same
          // net, so no clearance applies. Guarding it too isolated a fine-pitch
          // pad from its own escape route (the micro-USB pads are 0.65 mm apart,
          // so every cell around them failed the foreign-pad test and the only
          // way out was a via dropped on the pad).
          const insideOwnPad = at.x >= bb.minX && at.x <= bb.maxX && at.y >= bb.minY && at.y <= bb.maxY;
          if (insideOwnPad) { strict.push([layer, i, j]); continue; }
          const gapToForeign = nearestForeign(at.x, at.y, pad.net);
          if (gapToForeign >= neededStrict) strict.push([layer, i, j]);
          else if (gapToForeign >= neededRelaxed) relaxed.push([layer, i, j]);
        }
      }
    }
    // A pad needs a few cells to be able to leave at all; if the strict margin
    // does not give it that many, fall back to the relaxed set.
    const cells = strict.length >= 4 ? strict : [...strict, ...relaxed];
    for (const [layer, i, j] of cells) grid.setBlocked(layer, i, j, 0);
    return cells;
  };
  const closeCells = (cells) => {
    for (const [l, i, j] of cells) {
      if (grid.isHard(l, i, j)) continue;      // reserved copper stays reserved
      grid.restoreSoft(l, i, j);
    }
  };

  // Escape difficulty first: a net leaving a 0.65 mm pitch connector has very few
  // legal paths, so it must be routed before the easy nets fill the board. Then
  // fewest pads, then shortest span. Ordering by span alone left the UART and
  // crystal nets unroutable even though each of them routes fine on its own.
  const pitchOf = new Map();
  for (const fp of model.footprints) {
    const pads = (fp.pads ?? []).filter((p) => p.net);
    const xs = [...new Set(pads.map((p) => p.x))].sort((a, b) => a - b);
    const ys = [...new Set(pads.map((p) => p.y))].sort((a, b) => a - b);
    const gaps = [];
    for (const list of [xs, ys]) for (let i = 1; i < list.length; i++) if (list[i] - list[i - 1] > 0.5) gaps.push(list[i] - list[i - 1]);
    pitchOf.set(fp.name, gaps.length ? Math.min(...gaps) : 99);
  }
  const order = [...netOf.entries()]
    .map(([net, pads]) => {
      const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y);
      const span = (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
      const pitch = Math.min(...pads.map((p) => pitchOf.get(p.footprint) ?? 99));
      return { net, pads, span, pitch, padCount: new Set(pads.map((p) => `${p.footprint}.${p.number}`)).size };
    })
    .filter((n) => n.pads.length > 1 && (!opts.nets || opts.nets.includes(n.net)))
    .sort((a, b) => a.pitch - b.pitch || a.padCount - b.padCount || a.span - b.span || a.net.localeCompare(b.net));

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
      const path = routeCells(grid, { layer: a.layer, i: a.i, j: a.j }, { layer: b.layer, i: b.i, j: b.j }, { viaCost: opts.viaCost ?? 6, octilinear: opts.octilinear !== false });
      if (process.env.LCEDA_ROUTE_DEBUG) {
        const hardNear = [];
        for (let di = -6; di <= 6; di++) for (let dj = -6; dj <= 6; dj++) {
          if (grid.isHard(a.layer, a.i + di, a.j + dj)) hardNear.push(`${a.i + di},${a.j + dj}`);
        }
        const row = [];
        for (let i = a.i - 2; i <= a.i + 8; i++) row.push(`${i}${grid.isBlocked(a.layer, i, a.j) ? 'X' : '.'}${grid.isHard(a.layer, i, a.j) ? 'H' : ''}`);
        console.error('   start row:', row.join(' '));
        console.error(`[route] ${net} ${a.footprint}.${a.number}->${b.footprint}.${b.number}`,
          `opened=${opened.length}`, `start=${a.layer}:${a.i},${a.j} blk=${grid.isBlocked(a.layer, a.i, a.j)}`,
          `goal=${b.layer}:${b.i},${b.j} blk=${grid.isBlocked(b.layer, b.i, b.j)}`,
          path ? `path=${path.length}` : 'FAIL',
          hardNear.length ? `hardNear=${hardNear.slice(0, 8).join(' ')}` : '');
      }
      closeCells(opened);
      if (!path) {
        ok = false;
        failed.push({ net, from: `${a.footprint}.${a.number}`, to: `${b.footprint}.${b.number}` });
        continue;
      }
      const produced = pathToCopper(grid, path, { net, width, skipVia });
      // Land the ends exactly on the pad centres. The grid snaps to cell centres,
      // and on a 0.65 mm pitch connector that 0.4 unit offset was the difference
      // between 0.221 mm and a legal 0.32 mm to the neighbouring pad.
      if (produced.tracks.length) {
        const first = produced.tracks[0];
        if (first.layer === a.layer) {
          first.points[0] = { x: a.x, y: a.y };
          // keep the escape segment axis aligned, otherwise the slant walks the
          // track back towards the neighbouring pad further along
          if (first.points.length >= 2) {
            const p1 = first.points[1];
            if (Math.abs(p1.y - a.y) >= Math.abs(p1.x - a.x)) p1.x = a.x;
            else p1.y = a.y;
          }
        }
        const last = produced.tracks[produced.tracks.length - 1];
        if (last.layer === b.layer) {
          const n = last.points.length;
          last.points[n - 1] = { x: b.x, y: b.y };
          if (n >= 2) {
            const p = last.points[n - 2];
            if (Math.abs(p.y - b.y) >= Math.abs(p.x - b.x)) p.x = b.x;
            else p.y = b.y;
          }
        }
      }
      for (const t of produced.tracks) t.points = legalizeAngles(t.points);
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
            // One extra cell: the track ends are snapped onto pad centres that sit
            // off grid, and that sub-cell shift was eating the track-to-track
            // clearance (0.145 mm measured where 0.254 mm is required).
            const radius = Math.ceil((width / 2 + grid.clearance) / grid.cell) + 1;
            for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) {
              if (isOwnPadCell(net, track.layer, c.i + di, c.j + dj)) continue;
              grid.setBlocked(track.layer, c.i + di, c.j + dj, 1);
            }
          }
        }
      }
      for (const via of produced.vias) {
        const c = grid.toCell(via.x, via.y);
        const radius = Math.ceil((viaDiameter / 2 + grid.clearance) / grid.cell);
        // (no via-vs-via keep-out: pricing vias out around other vias cost both
        // routability and a lot of time, and the DRC still checks the result)
        for (const l of grid.layers) for (let di = -radius; di <= radius; di++) for (let dj = -radius; dj <= radius; dj++) {
          if (isOwnPadCell(net, l, c.i + di, c.j + dj)) continue;
          grid.setBlocked(l, c.i + di, c.j + dj, 1);
        }
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

/**
 * Nudge vias that ended up too close to foreign copper.
 *
 * The maze router prices bad via spots but will still use one when there is no
 * alternative, which leaves a handful of near misses. This pass tries small
 * offsets around each offending via and moves the endpoints of the tracks that
 * meet it along, so the connection survives. It never invents copper: if no
 * offset is legal the via stays where it is and the DRC reports it.
 */
export function legalizeVias(model, tracks, vias, opts = {}) {
  const clearance = opts.clearance ?? 1;
  const maxShift = opts.maxShift ?? 8;
  const eps = 0.75;
  // Match the DRC's rule set: only copper that carries a net, and only pads,
  // tracks and vias (pours are handled by their own check). Netless pads are the
  // decorative pads some footprints carry, and the DRC ignores them too.
  const foreign = copperItems(model).filter((i) => i.net && ['pad', 'track', 'via'].includes(i.kind));
  const asTrack = (t) => ({ kind: 'track', net: t.net || '', layer: t.layer, width: t.width ?? 1, points: t.points });
  const asVia = (v) => ({ kind: 'via', net: v.net || '', layer: 11, x: v.x, y: v.y, diameter: v.diameter ?? 3 });
  const legal = (candidate, net) => {
    for (const other of foreign) {
      if ((other.net || '') === (net || '')) continue;
      // a via spans every layer, so a pad on any layer matters
      if (copperGap(candidate, other) < clearance - 0.01) return false;
    }
    for (const other of tracks) {
      if (other === candidate.source) continue;
      if ((other.net || '') === (net || '')) continue;
      if (copperGap(candidate, asTrack(other)) < clearance - 0.01) return false;
    }
    for (const other of vias) {
      if (other === candidate.source) continue;
      if ((other.net || '') === (net || '')) continue;
      if (copperGap(candidate, asVia(other)) < clearance - 0.01) return false;
    }
    return true;
  };

  let moved = 0;
  const unresolved = [];
  for (const via of vias) {
    if (legal(asVia(via), via.net)) continue;
    const attached = [];
    for (const t of tracks) {
      if (!t.points?.length) continue;
      const first = t.points[0], last = t.points[t.points.length - 1];
      if (Math.hypot(first.x - via.x, first.y - via.y) < eps) attached.push({ track: t, index: 0 });
      else if (Math.hypot(last.x - via.x, last.y - via.y) < eps) attached.push({ track: t, index: t.points.length - 1 });
    }
    let placed = null;
    outer:
    for (let r = 1; r <= maxShift && !placed; r++) {
      for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
        const candidate = { ...via, x: via.x + dx, y: via.y + dy };
        if (!legal(asVia(candidate), via.net)) continue;
        // the moved endpoints must be legal too
        const saved = attached.map(({ track, index }) => ({ ...track.points[index] }));
        attached.forEach(({ track, index }) => { track.points[index] = { x: candidate.x, y: candidate.y }; });
        const okEnds = attached.every(({ track }) => legal(asTrack(track), track.net));
        if (okEnds) { placed = candidate; break outer; }
        attached.forEach(({ track, index }, i) => { track.points[index] = saved[i]; });
      }
    }
    if (placed) { via.x = placed.x; via.y = placed.y; moved++; }
    else unresolved.push({ x: via.x, y: via.y, net: via.net });
  }
  return { moved, unresolved };
}

/**
 * Route nets one at a time, in the order given.
 *
 * The whole-board router has to guess a good order, and on a board with a 0.65 mm
 * pitch connector it guesses wrong: the UART and crystal nets route fine on their
 * own but lose the race for space when everything is routed together. Calling the
 * router once per net, in a caller-chosen order, gives each one a clear board -
 * the same "route the hard nets first" a person would do.
 *
 * @param {object} model parsed board
 * @param {string[]} order net names, in the order to route them
 * @param {object} opts forwarded to autoroute
 */
export function routeInOrder(model, order, opts = {}) {
  let board = JSON.parse(JSON.stringify(model.doc ?? { shape: model.rawShape }));
  const passes = [];
  for (const net of order) {
    const current = parsePcb(board);
    const result = routeBoard(current, { ...opts, nets: [net] });
    board = result.doc;
    passes.push({ net, ok: result.stats.routed === 1, tracks: result.stats.tracks, vias: result.stats.vias, lengthMm: result.stats.lengthMm });
  }
  const finalModel = parsePcb(board);
  return {
    doc: board,
    model: finalModel,
    passes,
    stats: {
      nets: order.length,
      routed: passes.filter((p) => p.ok).length,
      failed: passes.filter((p) => !p.ok).map((p) => p.net),
      tracks: passes.reduce((n, p) => n + p.tracks, 0),
      vias: passes.reduce((n, p) => n + p.vias, 0),
      lengthMm: +passes.reduce((n, p) => n + p.lengthMm, 0).toFixed(1),
    },
  };
}

/** Autoroute a board and return a new document with the copper added. */
export function routeBoard(model, opts = {}) {
  const result = autoroute(model, opts);
  const legalized = opts.legalizeVias === false ? { moved: 0, unresolved: [] } : legalizeVias(model, result.tracks, result.vias, { clearance: opts.clearance ?? 1 });
  const drc = model.drc?.default ?? DEFAULT_DRC.Default;
  const viaDiameter = opts.viaDiameter ?? Math.max(3, Math.round(mmToUnit(drc.viaHoleDiameter ?? 0.6)));
  const viaHole = opts.viaHole ?? Math.max(1, Math.round(mmToUnit(drc.viaHoleD ?? 0.3)));
  const shape = [...(model.rawShape ?? [])];
  for (const t of result.tracks) shape.push(trackRecord(t));
  for (const v of result.vias) shape.push(viaRecord({ ...v, diameter: viaDiameter, holeR: viaHole }));
  const doc = boardDocument({
    shape,
    // no explicit layer table: boardDocument writes the editor's full 53-layer
    // stack, which is what the editor needs to build its layer panel
    drc: model.drc?.default ? { Default: model.drc.default, isRealtime: true } : DEFAULT_DRC,
    originX: model.canvas?.originX ?? 4000,
    originY: model.canvas?.originY ?? 3000,
  });
  return { doc, ...result, legalized };
}

