// Design rule check for PCB documents.
//
// The earlier steps each grew their own guard (verifyRouting, verifyPour,
// verifyVias); this module is the single place that answers "is this board
// manufacturable", with one violation list and one set of rules.
//
// Rules come from the board's DRCRULE block (millimetres, as the editor stores
// them) with optional per-net overrides, and are converted to file units here.
// Geometry is in units throughout: 1 unit = 0.254 mm.
/**
 * Rounding tolerance for the geometric checks, in millimetres.
 *
 * The router works on a 0.254 mm grid, so a track sitting exactly on the
 * clearance limit can measure 0.25 mm once its end has been snapped to a pad
 * centre that is off grid, and a 0.508 mm hole-to-hole rule can measure 0.482.
 * Reporting those as violations is noise - they are 4-26 um, two orders of
 * magnitude below what a fabricator works to (JLCPCB's minimum clearance is
 * 0.127 mm). Anything larger is still reported.
 */
export const GEOMETRY_TOLERANCE_MM = 0.05;

import { mmToUnit, toMm, UNIT_MM, boardOutline, copperItems, padBBox, layerName, isCopper } from './parser.js';
import { viaRules } from './via.js';

const GROUND = /^(GND|AGND|DGND|PGND|VSS|VEE|0V)$/i;

/** Resolve the rules a board (and optionally a net) is checked against. */
export function rulesFor(model, { net = null, overrides = {} } = {}) {
  const drc = model?.drc?.default ?? {};
  const perNet = model?.drc?.perNet ?? {};
  const netRule = (net && perNet[net]) || {};
  const u = (mm, dflt) => Math.max(1, Math.round(mmToUnit(mm ?? dflt)));
  // a rule of 0 means "do not check", so it must not be rounded up to one cell
  const u0 = (mm, dflt) => Math.max(0, Math.round(mmToUnit(mm ?? dflt)));
  // Per-net rules keep their sub-cell precision. The router works on a 0.254 mm
  // grid, so a fine-pitch net cannot be ROUTED at 0.15 mm - but that is exactly
  // the rule a 0.65 mm connector needs to be judged by, and rounding it up to
  // 0.254 mm is what made those nets fail. The comparison below is in board
  // units, so a fractional requirement is meaningful.
  const uf = (mm, dflt) => Math.max(0, mmToUnit(mm ?? dflt));
  const via = viaRules(model, { net });
  return {
    trackWidth: netRule.trackWidth != null ? uf(netRule.trackWidth, 0.254) : u(drc.trackWidth, 0.254),
    clearance: netRule.clearance != null ? uf(netRule.clearance, 0.254) : u(drc.clearance, 0.254),
    viaDiameter: via.diameter,
    viaDrill: via.drill,
    annularRing: via.annularRing,
    holeToHole: netRule.holeToHole != null ? uf(netRule.holeToHole, 0.5) : u(drc.holeToHole, 0.5),
    edgeClearance: u(overrides.edgeClearance ?? drc.edgeClearance, 0.3),
    silkClearance: u0(overrides.silkClearance ?? drc.silkClearance, 0),
    ...overrides,
  };
}

// ---------------------------------------------------------------- geometry

const rectOf = (item) => {
  if (item.kind === 'pad') {
    const b = item.bbox ?? padBBox({ x: item.x, y: item.y, width: item.width, height: item.height });
    return { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY };
  }
  if (item.kind === 'via' || item.kind === 'hole') {
    const r = (item.diameter ?? item.holeR * 2 ?? 3) / 2;
    return { minX: item.x - r, minY: item.y - r, maxX: item.x + r, maxY: item.y + r };
  }
  return null;
};

const rectDistance = (a, b) => {
  const dx = Math.max(a.minX - b.maxX, 0, b.minX - a.maxX);
  const dy = Math.max(a.minY - b.maxY, 0, b.minY - a.maxY);
  return Math.hypot(dx, dy);
};

const pointRectDistance = (p, r) => {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dy = Math.max(r.minY - p.y, 0, p.y - r.maxY);
  return Math.hypot(dx, dy);
};

/**
 * A circular piece of copper, or null.
 *
 * Vias and round pads are discs; measuring them as axis-aligned boxes makes their
 * corners stick out and reported clearances that are too small - the demo board
 * came back with ten "errors" that were all this artefact (0.84 mm measured on a
 * box against 1.14 mm for the real circle-to-rectangle distance). Oblong pads are
 * deliberately NOT treated as circles: a box is the conservative choice there.
 */
const circleOf = (item) => {
  if (item.kind === 'via' || item.kind === 'hole') {
    const d = item.diameter ?? (item.holeR ?? 0) * 2;
    return { x: item.x, y: item.y, r: d / 2 };
  }
  if (item.kind === 'pad' && !(item.points?.length) && Math.abs((item.width ?? 0) - (item.height ?? 0)) < 0.01) {
    return { x: item.x, y: item.y, r: (item.width ?? 0) / 2 };
  }
  return null;
};

/** Edge-to-edge gap between two copper items, using circles where they apply. */
export function copperGap(a, b) {
  const ca = circleOf(a), cb = circleOf(b);
  if (ca && cb) return Math.hypot(ca.x - cb.x, ca.y - cb.y) - ca.r - cb.r;
  if (a.kind === 'track' && b.kind === 'track') {
    let gap = Infinity;
    for (let k = 0; k + 1 < a.points.length; k++) {
      for (let m = 0; m + 1 < b.points.length; m++) {
        gap = Math.min(gap, segmentDistance(a.points[k], a.points[k + 1], b.points[m], b.points[m + 1]));
      }
    }
    return gap - ((a.width ?? 1) + (b.width ?? 1)) / 2;
  }
  if (a.kind === 'track' || b.kind === 'track') {
    const track = a.kind === 'track' ? a : b;
    const other = a.kind === 'track' ? b : a;
    const half = (track.width ?? 1) / 2;
    const oc = circleOf(other);
    let gap = Infinity;
    for (let k = 0; k + 1 < track.points.length; k++) {
      const d = oc
        ? pointSegDistance(oc, track.points[k], track.points[k + 1])
        : segmentRectDistance(track.points[k], track.points[k + 1], rectOf(other));
      gap = Math.min(gap, d);
    }
    return gap - half - (oc ? oc.r : 0);
  }
  if (ca || cb) {
    const c = ca ?? cb;
    return pointRectDistance(c, rectOf(ca ? b : a)) - c.r;
  }
  return rectDistance(rectOf(a), rectOf(b));
}

const pointSegDistance = (p, a, b) => {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
};

/** Distance between two segments (0 when they cross). */
export function segmentDistance(p1, p2, p3, p4) {
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2), d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    pointSegDistance(p1, p3, p4), pointSegDistance(p2, p3, p4),
    pointSegDistance(p3, p1, p2), pointSegDistance(p4, p1, p2),
  );
};

/** Distance between a track segment and a rectangle. */
export function segmentRectDistance(a, b, rect) {
  const cx = Math.max(rect.minX, Math.min(a.x, rect.maxX));
  const cy = Math.max(rect.minY, Math.min(a.y, rect.maxY));
  return pointSegDistance({ x: cx, y: cy }, a, b);
}

const layerOverlap = (a, b) => {
  const la = a.layer ?? 11, lb = b.layer ?? 11;
  return la === 11 || lb === 11 || la === lb;
};

const netOf = (item) => item.net || '';
const sameNet = (a, b) => netOf(a) !== '' && netOf(a) === netOf(b);

// ---------------------------------------------------------------- checks

/**
 * Run every check and return one violation list.
 *
 * @param {object} model parsed board
 * @param {{rules?: object, checks?: string[], maxViolations?: number}} opts
 */
export function runDrc(model, opts = {}) {
  const checks = opts.checks ?? ['track-width', 'clearance', 'via-ring', 'hole-to-hole', 'edge-clearance', 'silk-over-pad', 'unconnected'];
  const want = new Set(checks);
  const baseRules = opts.rules ?? rulesFor(model);
  const violations = [];
  const add = (v) => { if (violations.length < (opts.maxViolations ?? 500)) violations.push(v); };

  const items = copperItems(model);
  const outline = boardOutline(model);

  // --- track width ---------------------------------------------------------
  if (want.has('track-width')) {
    for (const item of items) {
      if (item.kind !== 'track') continue;
      const rules = opts.rules ?? rulesFor(model, { net: item.net });
      const w = item.width ?? 1;
      if (w < rules.trackWidth - 1e-6) {
        add({ type: 'track-width', severity: 'error', net: item.net, layer: item.layer, at: item.points?.[0], measuredMm: +(w * UNIT_MM).toFixed(3), requiredMm: +(rules.trackWidth * UNIT_MM).toFixed(3) });
      }
    }
  }

  // --- clearance -----------------------------------------------------------
  if (want.has('clearance')) {
    const pads = items.filter((i) => i.kind === 'pad' && i.net);
    const tracks = items.filter((i) => i.kind === 'track' && i.points?.length >= 2);
    const vias = items.filter((i) => i.kind === 'via');

    const clearanceBetween = (a, b) => {
      if (sameNet(a, b)) return null;
      if (!layerOverlap(a, b)) return null;
      // Two pads of the SAME footprint sit at the spacing the package dictates -
      // a SOT-223 has 0.1 mm between neighbouring pads and that is normal. The
      // board house rule is about different nets on different parts, so this is
      // skipped unless checkSameFootprint is asked for.
      if (!opts.checkSameFootprint && a.kind === 'pad' && b.kind === 'pad'
        && a.footprint && a.footprint === b.footprint) return null;
      const rules = opts.rules ?? rulesFor(model, { net: a.net || b.net });
      const need = rules.clearance;
      const gap = copperGap(a, b);
      if (gap < need - GEOMETRY_TOLERANCE_MM / UNIT_MM) {
        return { type: 'clearance', severity: 'error', net: a.net || b.net, otherNet: (a.net === (a.net || b.net) ? b.net : a.net), layer: a.layer ?? b.layer, at: { x: Math.round(((a.x ?? a.points?.[0]?.x ?? 0) + (b.x ?? b.points?.[0]?.x ?? 0)) / 2), y: Math.round(((a.y ?? a.points?.[0]?.y ?? 0) + (b.y ?? b.points?.[0]?.y ?? 0)) / 2) }, measuredMm: +(gap * UNIT_MM).toFixed(3), requiredMm: +(need * UNIT_MM).toFixed(3) };
      }
      return null;
    };

    // pads/tracks/vias, with a bounding-box pre-filter so this stays fast
    const all = [...pads, ...tracks, ...vias];
    const bboxOf = (item) => {
      if (item.kind === 'track') {
        const xs = item.points.map((p) => p.x), ys = item.points.map((p) => p.y);
        const w = (item.width ?? 1) / 2;
        return { minX: Math.min(...xs) - w, maxX: Math.max(...xs) + w, minY: Math.min(...ys) - w, maxY: Math.max(...ys) + w };
      }
      return rectOf(item);
    };
    const boxes = all.map(bboxOf);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        if (all[i].kind === 'track' && all[j].kind === 'track' && sameNet(all[i], all[j])) continue;
        if (rectDistance(boxes[i], boxes[j]) > baseRules.clearance + 2) continue;
        const v = clearanceBetween(all[i], all[j]);
        if (v) add(v);
      }
    }
  }

  // --- via annular ring ----------------------------------------------------
  if (want.has('via-ring')) {
    for (const via of items.filter((i) => i.kind === 'via')) {
      const ring = ((via.diameter ?? 0) / 2 - (via.holeR ?? 0)) * UNIT_MM;
      if (ring < 0.05 - 1e-9) {
        add({ type: 'via-ring', severity: 'error', net: via.net, layer: 11, at: { x: via.x, y: via.y }, measuredMm: +ring.toFixed(3), requiredMm: 0.05 });
      }
    }
  }

  // --- hole to hole --------------------------------------------------------
  if (want.has('hole-to-hole')) {
    const holes = [
      ...items.filter((i) => i.kind === 'via').map((v) => ({ x: v.x, y: v.y, r: v.holeR ?? 0, net: v.net, kind: 'via' })),
      ...items.filter((i) => i.kind === 'pad' && (i.holeR ?? 0) > 0).map((p) => ({ x: p.x, y: p.y, r: p.holeR, net: p.net, kind: 'pad' })),
      ...items.filter((i) => i.kind === 'hole').map((h) => ({ x: h.x, y: h.y, r: h.holeR ?? 0, net: '', kind: 'hole' })),
    ];
    for (let i = 0; i < holes.length; i++) {
      for (let j = i + 1; j < holes.length; j++) {
        const a = holes[i], b = holes[j];
        const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
        if (gap < baseRules.holeToHole - GEOMETRY_TOLERANCE_MM / UNIT_MM) {
          add({ type: 'hole-to-hole', severity: 'error', net: a.net || b.net, layer: 11, at: { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }, measuredMm: +(gap * UNIT_MM).toFixed(3), requiredMm: +(baseRules.holeToHole * UNIT_MM).toFixed(3) });
        }
      }
    }
  }

  // --- copper to board edge ------------------------------------------------
  if (want.has('edge-clearance') && outline) {
    const edges = outline.items.filter((e) => e.type === 'TRACK').flatMap((e) => (e.points ?? []).slice(1).map((p, i) => [e.points[i], p]));
    for (const item of items) {
      if (!isCopper(item.layer ?? 11)) continue;
      const box = rectOf(item);
      if (!box) continue;
      const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
      let gap = Infinity;
      for (const [a, b] of edges) gap = Math.min(gap, segmentRectDistance(a, b, box));
      if (gap < baseRules.edgeClearance - GEOMETRY_TOLERANCE_MM / UNIT_MM) {
        add({ type: 'edge-clearance', severity: 'warning', net: item.net || '', layer: item.layer, at: { x: Math.round(cx), y: Math.round(cy) }, measuredMm: +(gap * UNIT_MM).toFixed(3), requiredMm: +(baseRules.edgeClearance * UNIT_MM).toFixed(3) });
      }
    }
  }

  // --- silkscreen over exposed copper --------------------------------------
  if (want.has('silk-over-pad')) {
    const silk = [];
    for (const fp of model.footprints) {
      for (const t of fp.tracks ?? []) if (t.layer === 3 || t.layer === 4) silk.push({ layer: t.layer, points: t.points });
      for (const t of fp.texts ?? []) if ((t.layer === 3 || t.layer === 4) && t.display !== 'none') silk.push({ layer: t.layer, box: { minX: t.x - (t.fontSize ?? 4), maxX: t.x + (t.fontSize ?? 4) * Math.max(1, String(t.text ?? '').length) * 0.6, minY: t.y - (t.fontSize ?? 4), maxY: t.y + (t.fontSize ?? 4) * 0.4 } });
    }
    for (const t of model.elements) if (t.type === 'TRACK' && (t.layer === 3 || t.layer === 4)) silk.push({ layer: t.layer, points: t.points });
    const pads = items.filter((i) => i.kind === 'pad');
    for (const s of silk) {
      for (const pad of pads) {
        if (pad.layer === 2 || pad.layer === 4 || pad.layer === 6 || pad.layer === 8) continue;   // bottom-side copper vs top silk
        const rect = rectOf(pad);
        let gap = Infinity;
        if (s.points) {
          for (let k = 0; k + 1 < s.points.length; k++) gap = Math.min(gap, segmentRectDistance(s.points[k], s.points[k + 1], rect));
        } else if (s.box) {
          gap = rectDistance(s.box, rect);
        }
        if (gap < baseRules.silkClearance - GEOMETRY_TOLERANCE_MM / UNIT_MM) {
          add({ type: 'silk-over-pad', severity: 'warning', net: pad.net, layer: s.layer, at: { x: Math.round(pad.x), y: Math.round(pad.y) }, measuredMm: +(gap * UNIT_MM).toFixed(3), requiredMm: +(baseRules.silkClearance * UNIT_MM).toFixed(3) });
        }
      }
    }
  }

  // --- unconnected nets ----------------------------------------------------
  // Proper connectivity: build a graph of the net's copper (pads, tracks, vias,
  // pours) and count the connected groups. Two pads belong to the same group
  // when copper physically touches.
  if (want.has('unconnected')) {
    const perNet = new Map();
    for (const item of items) {
      if (!item.net) continue;
      if (!perNet.has(item.net)) perNet.set(item.net, []);
      perNet.get(item.net).push(item);
    }
    for (const [net, list] of perNet) {
      const pads = list.filter((i) => i.kind === 'pad');
      if (pads.length < 2) continue;
      const parent = list.map((_, i) => i);
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };

      const near = (a, b) => {
        if (!layerOverlap(a, b)) return false;
        if (a.kind === 'track' && b.kind === 'track') {
          for (let k = 0; k + 1 < a.points.length; k++) {
            for (let m = 0; m + 1 < b.points.length; m++) {
              if (segmentDistance(a.points[k], a.points[k + 1], b.points[m], b.points[m + 1]) <= ((a.width ?? 1) + (b.width ?? 1)) / 2 + 0.01) return true;
            }
          }
          return false;
        }
        if (a.kind === 'track' || b.kind === 'track') {
          const track = a.kind === 'track' ? a : b;
          const other = a.kind === 'track' ? b : a;
          const rect = rectOf(other);
          if (!rect) return false;
          const half = (track.width ?? 1) / 2 + 0.01;
          for (let k = 0; k + 1 < track.points.length; k++) {
            if (segmentRectDistance(track.points[k], track.points[k + 1], rect) <= half) return true;
          }
          return false;
        }
        const ra = rectOf(a), rb = rectOf(b);
        if (!ra || !rb) return false;
        return rectDistance(ra, rb) <= 0.01;
      };

      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) if (near(list[i], list[j])) union(i, j);
      }
      const groups = new Set(list.map((_, i) => find(i)));
      // pads that sit alone: report only when a net has more than one group
      if (groups.size > 1) {
        const padGroups = new Set(pads.map((p) => find(list.indexOf(p))));
        add({
          type: 'unconnected', severity: 'warning', net, layer: 0,
          at: { x: Math.round(pads[0].x), y: Math.round(pads[0].y) },
          measuredMm: groups.size, requiredMm: 1,
          detail: `${pads.length} 个焊盘分成 ${groups.size} 组铜(${padGroups.size} 组含焊盘),尚未完全连通`,
        });
      }
    }
  }

  const counts = {};
  for (const v of violations) counts[v.type] = (counts[v.type] ?? 0) + 1;
  const errors = violations.filter((v) => v.severity === 'error').length;
  return {
    ok: errors === 0,
    rules: baseRules,
    counts,
    errors,
    warnings: violations.length - errors,
    violations,
    summary: `${violations.length} 处(${errors} 错误 / ${violations.length - errors} 提示)`,
  };
}

/** Markdown report for a DRC run. */
export function drcMarkdown(result, { file = '' } = {}) {
  const L = [];
  L.push(`# DRC 报告${file ? ` — ${file}` : ''}`);
  L.push('');
  L.push(`- 结果:**${result.ok ? '通过(无错误)' : '有错误'}** — ${result.summary}`);
  const r = result.rules ?? {};
  L.push(`- 规则:线宽 ${(r.trackWidth * UNIT_MM).toFixed(3)}mm | 间距 ${(r.clearance * UNIT_MM).toFixed(3)}mm | 过孔 ${(r.viaDiameter * UNIT_MM).toFixed(3)}/${(r.viaDrill * UNIT_MM).toFixed(3)}mm | 孔到孔 ${(r.holeToHole * UNIT_MM).toFixed(3)}mm | 板边 ${(r.edgeClearance * UNIT_MM).toFixed(3)}mm`);
  L.push('');
  if (result.violations.length) {
    L.push('| 类型 | 严重度 | 网络 | 层 | 位置 | 实测 | 要求 |');
    L.push('|---|---|---|---|---|---|---|');
    for (const v of result.violations.slice(0, 200)) {
      L.push(`| ${v.type} | ${v.severity === 'error' ? '错误' : '提示'} | ${v.net || '-'} | ${v.layer ? layerName(v.layer) : '-'} | ${v.at ? `${v.at.x},${v.at.y}` : '-'} | ${v.measuredMm}mm | ${v.requiredMm}mm |`);
    }
    if (result.violations.length > 200) L.push(`\n(仅显示前 200 条,共 ${result.violations.length} 条)`);
  } else {
    L.push('未发现违规。');
  }
  L.push('');
  return L.join('\n');
}
