// Vias: rule model, layer-change placement and stitching.
//
// The router already drops a via wherever a track changes layer; this module
// adds the rest of the story:
//
//   rules    - diameter / drill / annular ring / hole-to-hole, from the board's
//              DRC block with per-net overrides
//   stitching- a lattice of vias inside a pour, tying the copper to the other
//              layer and to the plane (the classic "stitch the ground")
//   checking - clearance to foreign copper and hole-to-hole spacing
//
// Via *type* (through / blind / buried) is modelled but only through vias are
// emitted: the standard edition stores the layer span per via and the editor
// only offers blind/buried on boards that declare the extra layers, so guessing
// a span would produce a board the editor cannot manufacture.
import { mmToUnit, toMm, copperItems, padBBox, UNIT_MM } from './parser.js';
import { viaRecord, boardDocument, DEFAULT_DRC } from './writer.js';
import { buildPourGrid, fillPour } from './pour.js';

/** Via kinds, with the layer span each one covers. */
export const VIA_TYPES = {
  through: { layers: 'all', note: '贯穿所有层(默认,编辑器无条件支持)' },
  blind: { layers: 'outer-to-inner', note: '盲孔:外层到内层,需要板厂支持' },
  buried: { layers: 'inner-to-inner', note: '埋孔:内层到内层,需要板厂支持' },
};

/**
 * Every piece of copper a through via has to keep its distance from.
 *
 * A via spans all layers, so this is deliberately layer-agnostic: the pour grid
 * only knows about its own layer, and using it left stitching vias 0.127 mm too
 * close to tracks routed on the other side.
 */
export function copperObstacles(model) {
  const out = [];
  for (const item of copperItems(model)) {
    if (item.kind === 'pad') {
      // Use the full pad: the DRC computes pad extents from the rotation and the
      // OVAL spine, and a stitched via placed against a smaller box than the DRC
      // checks measured 0.089 mm from a SOP-16 pad.
      const b = padBBox(item);
      out.push({ kind: 'pad', net: item.net || '', minX: b.minX, maxX: b.maxX, minY: b.minY, maxY: b.maxY, ref: `${item.footprint}.${item.number}` });
    } else if (item.kind === 'track') {
      const w = (item.width ?? 1) / 2;
      for (let k = 0; k + 1 < (item.points ?? []).length; k++) {
        const a = item.points[k], b = item.points[k + 1];
        out.push({ kind: 'track', net: item.net || '', minX: Math.min(a.x, b.x) - w, maxX: Math.max(a.x, b.x) + w, minY: Math.min(a.y, b.y) - w, maxY: Math.max(a.y, b.y) + w });
      }
    } else if (item.kind === 'via') {
      const r = (item.diameter ?? 3) / 2;
      out.push({ kind: 'via', net: item.net || '', minX: item.x - r, maxX: item.x + r, minY: item.y - r, maxY: item.y + r, holeR: item.holeR ?? 1 });
    }
  }
  return out;
}

/** Resolve the via geometry a board (and optionally a net) should use. */
export function viaRules(model, { net = null, netClass = null } = {}) {
  const drc = model?.drc?.default ?? DEFAULT_DRC.Default;
  const perNet = model?.drc?.perNet ?? {};
  const rule = (net && perNet[net]) || (netClass && perNet[netClass]) || {};
  const diameterMm = rule.viaHoleDiameter ?? drc.viaHoleDiameter ?? 0.6;
  const drillMm = rule.viaHoleD ?? drc.viaHoleD ?? 0.3;
  const clearanceMm = rule.clearance ?? drc.clearance ?? 0.254;
  const trackWidthMm = rule.trackWidth ?? drc.trackWidth ?? 0.254;
  const diameter = Math.max(2, Math.round(mmToUnit(diameterMm)));
  const drill = Math.max(1, Math.round(mmToUnit(drillMm)));
  return {
    type: rule.viaType ?? 'through',
    diameter, drill,
    annularRing: +(((diameter - drill) / 2) * UNIT_MM).toFixed(3),
    clearance: Math.max(1, Math.round(mmToUnit(clearanceMm))),
    trackWidth: Math.max(1, Math.round(mmToUnit(trackWidthMm))),
    holeToHole: Math.max(2, Math.round(mmToUnit(rule.holeToHole ?? 0.5))),
    // a via is only manufacturable if the ring is at least ~0.05 mm
    ok: (diameter - drill) / 2 * UNIT_MM >= 0.05,
  };
}

/**
 * Stitching vias: place a lattice of vias inside a pour of `net`.
 *
 * Cells come from the pour's own raster, so a via can only land where the pour
 * has copper - which already respects the clearance rule.
 *
 * @param {{net?: string, spacingMm?: number, edgeMm?: number, cell?: number, layer?: number, max?: number}} opts
 */
export function stitchVias(model, opts = {}) {
  const net = opts.net ?? '';
  if (!net) return { vias: [], stats: { placed: 0, net: '', reason: 'no net given' } };
  const cell = opts.cell ?? 2;
  const spacingMm = opts.spacingMm ?? 5;
  const edgeMm = opts.edgeMm ?? 1;
  const rules = viaRules(model, { net });
  const grid = buildPourGrid(model, { net, cell, layer: opts.layer ?? 1, thermal: true });
  const fill = fillPour(grid);
  const step = Math.max(1, Math.round(mmToUnit(spacingMm) / cell));
  const edgeCells = Math.max(1, Math.round(mmToUnit(edgeMm) / cell));

  const kept = (i, j) => {
    if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return false;
    const label = fill.label[grid.idx(i, j)];
    return label >= 0 && fill.keep.has(label);
  };
  /** A via needs solid copper around it, not a one-cell sliver. */
  const solid = (i, j) => {
    for (let di = -edgeCells; di <= edgeCells; di++) {
      for (let dj = -edgeCells; dj <= edgeCells; dj++) if (!kept(i + di, j + dj)) return false;
    }
    return true;
  };
  // Exact rule: the via's own edge must keep the clearance to foreign copper.
  // A cell being "kept copper" only proves the clearance for a point, and a via
  // is a disc - relying on the cell grid left the edge 0.127 mm too close.
  const viaRadius = rules.diameter / 2;
  const needed = rules.clearance + viaRadius;
  const obstacles = copperObstacles(model).filter((o) => (o.net || '') !== net);
  const clearOfForeign = (x, y) => {
    for (const r of obstacles) {
      const dx = Math.max(r.minX - x, 0, x - r.maxX);
      const dy = Math.max(r.minY - y, 0, y - r.maxY);
      if (Math.hypot(dx, dy) < needed) return false;
    }
    return true;
  };

  const vias = [];
  const max = opts.max ?? 400;
  const start = Math.floor(step / 2);
  for (let j = start; j < grid.rows && vias.length < max; j += step) {
    for (let i = start; i < grid.cols && vias.length < max; i += step) {
      if (!solid(i, j)) continue;
      const at = grid.toBoard(i, j);
      if (!clearOfForeign(at.x, at.y)) continue;
      vias.push({ x: at.x, y: at.y, net, diameter: rules.diameter, holeR: rules.drill / 2, type: rules.type });
    }
  }

  return {
    vias,
    rules,
    stats: {
      net, placed: vias.length, spacingMm, cell,
      diameterMm: +(rules.diameter * UNIT_MM).toFixed(3),
      drillMm: +(rules.drill * UNIT_MM).toFixed(3),
      annularRingMm: rules.annularRing,
      copperCells: fill.stats.filledCells,
    },
  };
}

/**
 * Check vias against everything that is not their own net, plus hole-to-hole
 * spacing between vias.
 */
export function verifyVias(model, vias, { rules = null, clearance = null, holeToHole = null } = {}) {
  const base = rules ?? viaRules(model);
  const need = clearance ?? base.clearance;
  const holeGap = holeToHole ?? base.holeToHole;
  const violations = [];

  const obstacles = copperObstacles(model);

  for (const via of vias) {
    const r = (via.diameter ?? base.diameter) / 2;
    for (const o of obstacles) {
      if ((o.net || '') === (via.net || '')) continue;
      // a through via touches every layer, so layer filtering is not needed here
      const dx = Math.max(o.minX - via.x, 0, via.x - o.maxX);
      const dy = Math.max(o.minY - via.y, 0, via.y - o.maxY);
      const gap = Math.hypot(dx, dy) - r;
      if (gap < need - 0.01) {
        violations.push({ kind: 'clearance', via: { x: via.x, y: via.y }, net: via.net, other: o.ref ?? o.kind, otherNet: o.net, gapMm: +(gap * UNIT_MM).toFixed(3) });
      }
    }
  }
  // hole to hole
  const holes = [...vias, ...copperItems(model).filter((i) => i.kind === 'via').map((v) => ({ x: v.x, y: v.y, holeR: v.holeR ?? 1 }))];
  for (let i = 0; i < holes.length; i++) {
    for (let j = i + 1; j < holes.length; j++) {
      const a = holes[i], b = holes[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y) - (a.holeR ?? 1) - (b.holeR ?? 1);
      if (d < holeGap - 0.01) {
        violations.push({ kind: 'hole-to-hole', via: { x: a.x, y: a.y }, other: `${b.x},${b.y}`, gapMm: +(d * UNIT_MM).toFixed(3) });
      }
    }
  }
  return { ok: violations.length === 0, count: violations.length, violations: violations.slice(0, 20) };
}

/** Add stitching vias to a board and return the new document. */
export function viaBoard(model, opts = {}) {
  const stitched = stitchVias(model, opts);
  const shape = [...(model.rawShape ?? [])];
  for (const via of stitched.vias) shape.push(viaRecord(via));
  const doc = boardDocument({
    shape,
    layers: [...model.layers.values()].map((l) => `${l.id}~${l.name}~${l.color}~${l.visible}~${l.active}`),
    drc: model.drc?.default ? { Default: model.drc.default, isRealtime: true } : DEFAULT_DRC,
    originX: model.canvas?.originX ?? 4000,
    originY: model.canvas?.originY ?? 3000,
  });
  return { doc, ...stitched };
}
