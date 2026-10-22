// PCB record writer: build the record strings the editor reads back.
//
// Field order is the one `src/pcb/parser.js` documents (taken from the editor's
// own `iu` parsers), so parse(write(x)) round-trips.
//
// Two conventions matter:
//   * geometry is in file units (0.254 mm each)
//   * a footprint's sub-records are ABSOLUTE coordinates, so placing a footprint
//     means translating its records, not just moving the LIB head.
import { PCB_FIELDS, PCB_CANVAS_FIELDS, LAYERS, mmToUnit, toMm } from './parser.js';

let seq = 0;
export const genGid = (prefix = 'gge') => `${prefix}${(Date.now().toString(16) + (seq++).toString(16).padStart(3, '0')).slice(-12)}`;
export const resetGid = () => { seq = 0; };

const fmt = (v) => {
  // NOTE: Number('') is 0, so an empty field must stay empty - writing "0" into
  // net / display / fontFamily makes the editor treat the record differently
  // (a designator text with display="0" never shows up on the board).
  if (v === '' || v === null || v === undefined) return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Number(n.toFixed(4)));
};
const pts = (points) => (points ?? []).map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' ');
const esc = (s) => String(s ?? '').replace(/\^/g, '&#94;').replace(/~/g, '&#126;');

/** Translate a path string by re-emitting absolute M/L commands. */
export function translatePath(pathStr, dx, dy, parsedPoints) {
  if (parsedPoints?.length) {
    return parsedPoints.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x + dx)} ${fmt(p.y + dy)}`).join(' ') + (/(Z|z)\s*$/.test(String(pathStr)) ? ' Z' : '');
  }
  return pathStr ?? '';
}

/** Rotate a point around a centre (degrees, screen coordinates). */
export function rotatePoint(p, cx, cy, deg) {
  if (!deg) return { x: p.x, y: p.y };
  const r = (deg * Math.PI) / 180;
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

/**
 * The point a footprint's geometry is drawn around. In a footprint document this
 * is head.x/head.y (which coincides with the pad centre in every library part
 * checked); a document without a usable head falls back to the pad centre.
 */
export function footprintAnchor(footprintModel) {
  const hx = Number(footprintModel?.headX ?? footprintModel?.head?.x);
  const hy = Number(footprintModel?.headY ?? footprintModel?.head?.y);
  if (Number.isFinite(hx) && Number.isFinite(hy)) return { x: hx, y: hy };
  const fp = footprintModel?.footprints?.[0];
  const pads = fp?.pads ?? [];
  if (!pads.length) return { x: 0, y: 0 };
  const xs = pads.map((p) => Number(p.x)), ys = pads.map((p) => Number(p.y));
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}

/** Bounding box of a footprint's own geometry, relative to its anchor. */
export function footprintExtent(footprintModel) {
  const a = footprintAnchor(footprintModel);
  const fp = footprintModel?.footprints?.[0] ?? {};
  const xs = [], ys = [];
  const push = (x, y) => { if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x - a.x); ys.push(y - a.y); } };
  for (const p of fp.pads ?? []) push(p.x, p.y);
  for (const t of fp.tracks ?? []) for (const q of t.points ?? []) push(q.x, q.y);
  for (const c of fp.circles ?? []) push(c.cx, c.cy);
  for (const r of fp.regions ?? []) for (const q of r.path ?? []) push(q.x, q.y);
  if (!xs.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** A transform that maps a footprint's own coordinates onto the board. */
export function placementTransform(footprintModel, { x, y, rotation = 0, flip = false }) {
  const { x: anchorX, y: anchorY } = footprintAnchor(footprintModel);
  const map = (p) => {
    let q = { x: p.x - anchorX, y: p.y - anchorY };
    if (flip) q = { x: -q.x, y: q.y };
    q = rotatePoint(q, 0, 0, rotation);
    return { x: q.x + x, y: q.y + y };
  };
  return { map, anchorX, anchorY, rotation, flip };
}

// ---------------------------------------------------------------- records

export function padRecord(pad, { map = (p) => p, net = null, number = null, gid = genGid(), layer = null } = {}) {
  const c = map({ x: Number(pad.x), y: Number(pad.y) });
  const points = pad.points?.length ? pts(pad.points.map(map)) : (pad.raw?.pointArr ?? '');
  const holeCenter = pad.raw?.holeCenter ?? '';
  const fields = {
    shape: pad.shape,
    x: c.x, y: c.y,
    width: pad.width, height: pad.height,
    layerid: layer ?? pad.layer,
    net: net ?? pad.net ?? '',
    number: number ?? pad.number,
    holeR: pad.holeR ?? 0,
    pointArr: points,
    rotation: pad.rotation ?? 0,
    gId: gid,
    holeLength: pad.raw?.holeLength ?? 0,
    slotPointArr: pad.raw?.slotPointArr ?? '',
    plated: pad.plated === false ? 'no' : 'yes',
    locked: pad.raw?.locked ?? '0',
    pasteexpansion: pad.raw?.pasteexpansion ?? '',
    solderexpansion: pad.raw?.solderexpansion ?? '',
    holeCenter,
  };
  return ['PAD', ...PCB_FIELDS.PAD.map((f) => fmt(fields[f]))].join('~');
}

export function viaRecord(via, { gid = genGid() } = {}) {
  return ['VIA', fmt(via.x), fmt(via.y), fmt(via.diameter ?? 24), via.net ?? '', fmt(via.holeR ?? 12), gid, '0'].join('~');
}

export function holeRecord(hole, { gid = genGid() } = {}) {
  return ['HOLE', fmt(hole.x), fmt(hole.y), fmt(hole.holeR), gid, '0'].join('~');
}

export function trackRecord(track, { map = (p) => p, net = null, layer = null, gid = genGid() } = {}) {
  const points = (track.points ?? []).map(map);
  // `width` is what the router and the DRC use; `strokeWidth` is the file's name
  // for it. Reading only one of them silently wrote every routed track at the
  // 10-unit default while every check measured 1 unit.
  const width = track.strokeWidth ?? track.width ?? 10;
  return ['TRACK', fmt(width), String(layer ?? track.layer ?? 1), net ?? track.net ?? '', pts(points), gid, '0'].join('~');
}

export function textRecord(text, { map = (p) => p, gid = genGid(), layer = null, body = null, display = null } = {}) {
  const c = map({ x: Number(text.x), y: Number(text.y) });
  const value = body ?? text.text ?? '';
  // Leave pathStr empty unless we have real stroke data: the editor regenerates
  // the glyph path from `text` itself, while a degenerate "M x yLx y" path
  // renders as nothing at all (that is how a designator silently disappears).
  const pathStr = text.pathStr && /[LTHVCSQA]/i.test(text.pathStr) ? text.pathStr : '';
  const fields = {
    type: text.kind ?? text.type ?? 'N',
    x: c.x, y: c.y,
    strokeWidth: text.strokeWidth ?? 0.7,
    rotation: text.rotation ?? 0,
    mirror: text.mirror ?? '0',
    layerid: layer ?? text.layer ?? 3,
    net: text.net ?? '',
    fontSize: text.fontSize ?? 4.5,
    text: value,
    pathStr,
    display: display ?? text.display ?? '',
    gId: gid,
    fontFamily: text.fontFamily ?? '',
    locked: text.raw?.locked ?? '0',
    c_etype: text.raw?.c_etype ?? '',
  };
  return ['TEXT', ...PCB_FIELDS.TEXT.map((f) => fmt(fields[f]))].join('~');
}

export function circleRecord(circle, { map = (p) => p, gid = genGid() } = {}) {
  const c = map({ x: Number(circle.cx), y: Number(circle.cy) });
  return ['CIRCLE', fmt(c.x), fmt(c.y), fmt(circle.r), fmt(circle.strokeWidth ?? 1), String(circle.layer ?? 3), gid, '0', circle.net ?? '', circle.raw?.transformarc ?? ''].join('~');
}

export function rectRecord(rect, { map = (p) => p, gid = genGid() } = {}) {
  const c = map({ x: Number(rect.x), y: Number(rect.y) });
  return ['RECT', fmt(c.x), fmt(c.y), fmt(rect.width), fmt(rect.height), String(rect.layer ?? 1), gid, '0', fmt(rect.strokeWidth ?? 1), rect.fill ?? '', rect.raw?.transform ?? '', rect.net ?? '', rect.raw?.c_etype ?? ''].join('~');
}

export function arcRecord(arc, { map = (p) => p, gid = genGid() } = {}) {
  return ['ARC', fmt(arc.strokeWidth ?? 1), String(arc.layer ?? 3), arc.net ?? '', arc.d ?? '', arc.raw?.c_helper_dots ?? '', gid, '0'].join('~');
}

export function solidRegionRecord(region, { map = (p) => p, gid = genGid(), layer = null, net = null } = {}) {
  const pathStr = translatePath(region.pathStr, 0, 0, (region.path ?? []).map(map));
  return ['SOLIDREGION', String(layer ?? region.layer ?? 1), net ?? region.net ?? '', pathStr, region.regionType ?? 'solid', gid, region.raw?.teardrop ?? '', region.raw?.targetPad ?? '', region.raw?.targetWire ?? '', region.raw?.locked ?? '0'].join('~');
}

export function copperAreaRecord(pour, { map = (p) => p, gid = genGid(), layer = null, net = null } = {}) {
  const points = (pour.path ?? []).map(map);
  const pathStr = points.length ? points.map((p, i) => `${i ? 'L' : 'M'} ${fmt(p.x)} ${fmt(p.y)}`).join(' ') + ' Z' : (pour.pathStr ?? '');
  const fields = {
    strokeWidth: pour.strokeWidth ?? 1,
    layerid: layer ?? pour.layer ?? 1,
    net: net ?? pour.net ?? '',
    pathStr,
    clearanceWidth: pour.clearance ?? 8,
    fillStyle: pour.fillStyle ?? 'solid',
    gId: gid,
    thermal: pour.thermal ?? 'yes',
    keepIsland: pour.keepIsland ?? '1',
    fillData: pour.raw?.fillData ?? pathStr,
    locked: pour.raw?.locked ?? '0',
    name: pour.name ?? '',
    order: pour.raw?.order ?? '0',
    gridTrackWidth: pour.raw?.gridTrackWidth ?? '10',
    gridClearance: pour.raw?.gridClearance ?? '10',
    toBoardOutline: pour.raw?.toBoardOutline ?? '1',
    fabricationImprove: pour.raw?.fabricationImprove ?? 'yes',
    spoke_width: pour.raw?.spoke_width ?? '0',
  };
  return ['COPPERAREA', ...PCB_FIELDS.COPPERAREA.map((f) => fmt(fields[f]))].join('~');
}

export function dimensionRecord(dim, { gid = genGid() } = {}) {
  return ['DIMENSION', String(dim.layer ?? 15), dim.d ?? '', gid, fmt(dim.fontSize ?? 4.5), dim.raw?.locked ?? '0', dim.raw?.measuring_type ?? '', dim.raw?.font_width ?? ''].join('~');
}

/** `package`R0603`Value`10k` -> object */
export function cparaToText(cPara = {}) {
  const parts = [];
  for (const [k, v] of Object.entries(cPara)) {
    if (v === undefined || v === null) continue;
    parts.push(k, String(v));
  }
  return parts.join('`');
}

/**
 * A placed footprint: `LIB~x~y~c_para~...#@$<sub-record>#@$<sub-record>...`
 *
 * Sub-records are translated into board coordinates (they are absolute in the
 * file format) and their pads can be given nets.
 */
export function libRecord(footprintModel, {
  x, y, rotation = 0, flip = false, cPara = {}, gid = genGid(), layer = 1,
  netsByPad = null, designator = '', value = '', showDesignator = true, showValue = true,
} = {}) {
  const { map } = placementTransform(footprintModel, { x, y, rotation, flip });
  const subs = [];
  const fp = footprintModel.footprints?.[0] ?? { pads: [], tracks: [], texts: [], circles: [], rects: [], arcs: [], regions: [], others: [] };

  for (const pad of fp.pads ?? []) {
    const net = netsByPad ? (netsByPad[String(pad.number)] ?? '') : pad.net ?? '';
    subs.push(padRecord(pad, { map, net }));
  }
  for (const t of fp.tracks ?? []) subs.push(trackRecord(t, { map }));
  for (const c of fp.circles ?? []) subs.push(circleRecord(c, { map }));
  for (const r of fp.rects ?? []) subs.push(rectRecord(r, { map }));
  for (const a of fp.arcs ?? []) subs.push(arcRecord(a, { map }));
  for (const r of fp.regions ?? []) subs.push(solidRegionRecord(r, { map }));
  for (const o of fp.others ?? []) {
    if (o.type === 'COPPERAREA') subs.push(copperAreaRecord(o, { map }));
    else if (o.type === 'TEXT') subs.push(textRecord(o, { map }));
  }

  // Designator (type P) and value (type N): the editor shows these on the silk
  // layer. Coordinates default to just above the footprint's pad row.
  const padXs = (fp.pads ?? []).map((p) => p.x), padYs = (fp.pads ?? []).map((p) => p.y);
  const anchor = map({
    x: padXs.length ? (Math.min(...padXs) + Math.max(...padXs)) / 2 : x,
    y: padYs.length ? Math.min(...padYs) : y,
  });
  if (showDesignator && designator) {
    subs.push(textRecord({ kind: 'P', x: anchor.x, y: anchor.y - 8, text: designator, layer: 3, fontSize: 4.5, fontFamily: '' }, { map: (p) => p }));
  }
  if (showValue && value) {
    subs.push(textRecord({ kind: 'N', x: anchor.x, y: anchor.y + 12, text: value, layer: 3, fontSize: 4.5, fontFamily: '' }, { map: (p) => p }));
  }

  const head = [
    'LIB', fmt(x), fmt(y), cparaToText(cPara), String(rotation), '0', gid, String(layer),
    footprintModel.head?.uuid ?? '', '0', '0', '', 'yes', '', '',
  ].join('~');
  return subs.length ? [head, ...subs].join('#@$') : head;
}

/** Board outline as a closed track on layer 10 (BoardOutLine). */
export function boardOutlineRecord({ minX, minY, maxX, maxY, width = 10 }, { gid = genGid() } = {}) {
  const points = [
    { x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }, { x: minX, y: minY },
  ];
  return trackRecord({ strokeWidth: width, layer: 10, net: '', points }, { gid });
}

export const DEFAULT_LAYERS = [
  '1~TopLayer~#FF0000~true~true',
  '2~BottomLayer~#0000FF~true~false',
  '3~TopSilkLayer~#FFCC00~true~false',
  '4~BottomSilkLayer~#66CC33~true~false',
  '5~TopPasteMaskLayer~#808080~true~false',
  '6~BottomPasteMaskLayer~#800000~true~false',
  '7~TopSolderMaskLayer~#800080~true~false',
  '8~BottomSolderMaskLayer~#AA00FF~true~false',
  '10~BoardOutLine~#FFFFFF~true~false',
  '11~Multi-Layer~#C0C0C0~true~false',
  '12~Document~#FFFFFF~true~false',
];

export const DEFAULT_DRC = {
  Default: { trackWidth: 0.254, clearance: 0.254, viaHoleDiameter: 0.6, viaHoleD: 0.3 },
  isRealtime: true,
  checkObjectToCopperarea: true,
  showDRCRangeLine: true,
};

export function canvasRecord({ originX = 4000, originY = 3000, unit = 'mm', snapSize = 0.03937, gridSize = 10, background = '#000000' } = {}) {
  const fields = {
    viewWidth: 1000, viewHeight: 1000, backGround: background, gridVisible: 'yes', gridColor: '#FFFFFF',
    gridSize, canvasWidth: 1000, canvasHeight: 1000, gridStyle: 'line', snapSize, unit,
    routingWidth: 1, routingAngle: 45, copperAreaDisplay: 'visible', altSnapSize: 0.5,
    originX, originY, routeConflict: 0, removeLoop: 'none',
  };
  return ['CA', ...PCB_CANVAS_FIELDS.map((f) => fields[f])].join('~');
}

/** Assemble a board document (docType 3). */
export function boardDocument({ title = '', shape = [], layers = DEFAULT_LAYERS, drc = DEFAULT_DRC, canvas = {}, originX = 4000, originY = 3000, editorVersion = '6.5.51' } = {}) {
  return {
    head: { docType: '3', editorVersion, c_para: '' },
    canvas: canvasRecord({ originX, originY, ...canvas }),
    layers: [...layers],
    shape: [...shape],
    DRCRULE: JSON.parse(JSON.stringify(drc)),
    ...(title ? { title } : {}),
  };
}

export const unit = { mm: 0.254, toUnits: mmToUnit, toMm };
