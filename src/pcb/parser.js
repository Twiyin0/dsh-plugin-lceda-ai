// PCB / footprint document parser for 嘉立创EDA standard edition.
//
// Field order and semantics were read out of the editor's own parser module
// (`iu` in js/main.min.js of 6.5.51), and the coordinate unit was measured
// against real library footprints:
//
//   2.54 mm pitch header  -> 10.000 file units
//   R0603 pad pitch       ->  5.932 file units -> 1.507 mm
//
// so 1 file unit = 0.254 mm = 10 mil. (The canvas `snapSize` is expressed in mm,
// e.g. 0.03937 mm = 1 mil, which is where the confusion usually starts.)
//
// Record grammar, identical in spirit to the schematic format:
//   fields inside a record are separated by "~"
//   sub-shapes inside a record are separated by "^^"
//   sub-records inside LIB / SHEET / PLANEZONE are separated by "#@$"
import fs from 'node:fs/promises';
import path from 'node:path';

export const UNIT_MM = 0.254;          // one file unit in millimetres (10 mil)
export const toMm = (v) => Number(v) * UNIT_MM;
export const mmToUnit = (v) => Number(v) / UNIT_MM;

/** Layer ids, from the editor's own table (`cc`). */
export const LAYERS = {
  1: 'TopLayer', 2: 'BottomLayer', 3: 'TopSilkLayer', 4: 'BottomSilkLayer',
  5: 'TopPasteMaskLayer', 6: 'BottomPasteMaskLayer', 7: 'TopSolderMaskLayer', 8: 'BottomSolderMaskLayer',
  9: 'Ratlines', 10: 'BoardOutLine', 11: 'Multi-Layer', 12: 'Document', 13: 'TopAssembly',
  14: 'BottomAssembly', 15: 'Mechanical', 16: 'TopComponents', 17: 'BottomComponents',
  18: 'Substrate', 19: '3DModel', 99: 'ComponentShapeLayer', 100: 'LeadShapeLayer', 101: 'ComponentMarkingLayer',
};
for (let i = 21; i <= 52; i++) LAYERS[i] = `Inner${i - 20}`;
for (let i = 53; i <= 84; i++) LAYERS[i] = `Substrate${i - 52}`;

export const layerName = (id) => LAYERS[Number(id)] ?? `Layer${id}`;
export const isCopper = (id) => {
  const n = Number(id);
  return n === 1 || n === 2 || n === 11 || (n >= 21 && n <= 52);
};

/** Per-record field names, copied from the editor's `iu.<TYPE>` parsers. */
export const PCB_FIELDS = {
  PAD: ['shape', 'x', 'y', 'width', 'height', 'layerid', 'net', 'number', 'holeR', 'pointArr', 'rotation', 'gId', 'holeLength', 'slotPointArr', 'plated', 'locked', 'pasteexpansion', 'solderexpansion', 'holeCenter'],
  VIA: ['x', 'y', 'diameter', 'net', 'holeR', 'gId', 'locked'],
  HOLE: ['x', 'y', 'holeR', 'gId', 'locked'],
  TRACK: ['strokeWidth', 'layerid', 'net', 'pointArr', 'gId', 'locked'],
  COPPERAREA: ['strokeWidth', 'layerid', 'net', 'pathStr', 'clearanceWidth', 'fillStyle', 'gId', 'thermal', 'keepIsland', 'fillData', 'locked', 'name', 'order', 'gridTrackWidth', 'gridClearance', 'toBoardOutline', 'fabricationImprove', 'spoke_width'],
  SOLIDREGION: ['layerid', 'net', 'pathStr', 'type', 'gId', 'teardrop', 'targetPad', 'targetWire', 'locked'],
  RECT: ['x', 'y', 'width', 'height', 'layerid', 'gId', 'locked', 'strokeWidth', 'fill', 'transform', 'net', 'c_etype'],
  CIRCLE: ['cx', 'cy', 'r', 'strokeWidth', 'layerid', 'gId', 'locked', 'net', 'transformarc'],
  ARC: ['strokeWidth', 'layerid', 'net', 'd', 'c_helper_dots', 'gId', 'locked'],
  TEXT: ['type', 'x', 'y', 'strokeWidth', 'rotation', 'mirror', 'layerid', 'net', 'fontSize', 'text', 'pathStr', 'display', 'gId', 'fontFamily', 'locked', 'c_etype'],
  DIMENSION: ['layerid', 'd', 'gId', 'fontSize', 'locked', 'measuring_type', 'font_width'],
  PLANEZONE: ['layerid', 'net', 'fillStyle', 'gId'],
  LIB: ['x', 'y', 'c_para', 'rotation', 'importFlag', 'gId', 'layerid', 'uuid', 'utime', 'locked', 'bind_sch_id', 'add_into_bom', 'datastrid', 'uuid_3d'],
  SHEET: ['x', 'y', 'locked', 'layerid', 'gId'],
};
export const PCB_CANVAS_FIELDS = ['viewWidth', 'viewHeight', 'backGround', 'gridVisible', 'gridColor', 'gridSize', 'canvasWidth', 'canvasHeight', 'gridStyle', 'snapSize', 'unit', 'routingWidth', 'routingAngle', 'copperAreaDisplay', 'altSnapSize', 'originX', 'originY', 'routeConflict', 'removeLoop'];
export const PCB_HEAD_FIELDS = ['docType', 'editorVersion', 'c_para'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

/** `a~b~c` + field names -> object (mirrors the editor's str2Obj). */
function fieldsToObject(fields, parts, offset = 0) {
  const out = {};
  for (let i = 0; i < fields.length; i++) {
    const raw = parts[i + offset] ?? '';
    out[fields[i]] = raw;
  }
  return out;
}

/** A footprint's `c_para` uses backticks: package`R0603`Supplier Part`C25804`. */
export function parseCpara(text) {
  const out = {};
  if (!text) return out;
  const parts = String(text).split('`');
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i];
    if (key) out[key] = parts[i + 1];
  }
  return out;
}

const parsePoints = (str) => {
  const v = String(str ?? '').trim();
  if (!v) return [];
  const n = v.split(/\s+/).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push({ x: n[i], y: n[i + 1] });
  return pts;
};

/** Parse a path string like "M 1 2 L 3 4" / relative "h 5" into points (best effort). */
export function parsePath(str) {
  const s = String(str ?? '').trim();
  if (!s) return [];
  const out = [];
  let cx = 0, cy = 0;
  const tokens = s.match(/[MmLlHhVvCcSsQqAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let cmd = null;
  const nums = [];
  const flush = () => {
    if (!cmd) return;
    const c = cmd.toUpperCase();
    if (c === 'M' || c === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = cmd === 'm' || cmd === 'l' ? cx + nums[i] : nums[i];
        cy = cmd === 'm' || cmd === 'l' ? cy + nums[i + 1] : nums[i + 1];
        out.push({ x: cx, y: cy });
      }
    } else if (c === 'H') {
      for (const v of nums) { cx = cmd === 'h' ? cx + v : v; out.push({ x: cx, y: cy }); }
    } else if (c === 'V') {
      for (const v of nums) { cy = cmd === 'v' ? cy + v : v; out.push({ x: cx, y: cy }); }
    }
    nums.length = 0;
  };
  for (const tk of tokens) {
    if (/[A-Za-z]/.test(tk)) { flush(); cmd = tk; }
    else nums.push(Number(tk));
  }
  flush();
  return out;
}

const parseType = (cmd, record, isSheet) => {
  const fields = PCB_FIELDS[cmd];
  const parts = String(record).split('~');
  const raw = fieldsToObject(fields, parts, 1);
  const out = { type: cmd, raw };
  switch (cmd) {
    case 'PAD':
      Object.assign(out, {
        shape: raw.shape,
        x: num(raw.x), y: num(raw.y),
        width: num(raw.width), height: num(raw.height),
        layer: Number(raw.layerid), net: raw.net || '',
        number: raw.number, holeR: num(raw.holeR) || 0,
        rotation: num(raw.rotation) || 0,
        points: parsePoints(raw.pointArr),
        plated: raw.plated !== 'no',
      });
      break;
    case 'VIA':
      Object.assign(out, { x: num(raw.x), y: num(raw.y), diameter: num(raw.diameter), holeR: num(raw.holeR), net: raw.net || '', layer: 11 });
      break;
    case 'HOLE':
      Object.assign(out, { x: num(raw.x), y: num(raw.y), holeR: num(raw.holeR), layer: 11 });
      break;
    case 'TRACK':
      Object.assign(out, { strokeWidth: num(raw.strokeWidth), layer: Number(raw.layerid), net: raw.net || '', points: parsePoints(raw.pointArr) });
      break;
    case 'COPPERAREA':
      Object.assign(out, {
        strokeWidth: num(raw.strokeWidth), layer: Number(raw.layerid), net: raw.net || '',
        clearance: num(raw.clearanceWidth), fillStyle: raw.fillStyle,
        thermal: raw.thermal, keepIsland: raw.keepIsland, name: raw.name || '',
        path: parsePath(raw.pathStr), pathStr: raw.pathStr,
      });
      break;
    case 'SOLIDREGION':
      Object.assign(out, { layer: Number(raw.layerid), net: raw.net || '', path: parsePath(raw.pathStr), pathStr: raw.pathStr, regionType: raw.type });
      break;
    case 'RECT':
      Object.assign(out, { x: num(raw.x), y: num(raw.y), width: num(raw.width), height: num(raw.height), layer: Number(raw.layerid), strokeWidth: num(raw.strokeWidth), fill: raw.fill, net: raw.net || '' });
      break;
    case 'CIRCLE':
      Object.assign(out, { cx: num(raw.cx), cy: num(raw.cy), r: num(raw.r), strokeWidth: num(raw.strokeWidth), layer: Number(raw.layerid), net: raw.net || '' });
      break;
    case 'ARC':
      Object.assign(out, { layer: Number(raw.layerid), strokeWidth: num(raw.strokeWidth), net: raw.net || '', d: raw.d, points: parsePath(raw.d) });
      break;
    case 'TEXT':
      Object.assign(out, {
        x: num(raw.x), y: num(raw.y), layer: Number(raw.layerid), net: raw.net || '',
        text: raw.text, fontSize: num(raw.fontSize), rotation: num(raw.rotation) || 0,
        mirror: raw.mirror, display: raw.display, fontFamily: raw.fontFamily, kind: raw.type,
      });
      break;
    case 'DIMENSION':
      Object.assign(out, { layer: Number(raw.layerid), d: raw.d, fontSize: num(raw.fontSize), points: parsePath(raw.d) });
      break;
    case 'PLANEZONE':
      Object.assign(out, { layer: Number(raw.layerid), net: raw.net || '', fillStyle: raw.fillStyle, zones: [] });
      break;
    default:
      break;
  }
  return out;
};

/** Parse one document (PCB: docType 3, footprint: docType 4, module: 14). */
export function parsePcb(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : input;
  const head = doc.head ?? {};
  const docType = String(head.docType ?? '');
  const cPara = typeof head.c_para === 'string' ? parseCpara(head.c_para) : (head.c_para ?? {});
  const canvasParts = String(Array.isArray(doc.canvas) ? doc.canvas[0] : doc.canvas ?? '').split('~');
  const canvas = fieldsToObject(PCB_CANVAS_FIELDS, canvasParts, 1);

  const layers = new Map();
  for (const line of doc.layers ?? []) {
    const f = String(line).split('~');
    if (!f[0]) continue;
    layers.set(Number(f[0]), { id: Number(f[0]), name: f[1] || layerName(f[0]), color: f[2] || '', visible: f[3] !== 'false', active: f[4] === 'true', config: f[5] !== 'false', transparency: f[6] });
  }
  if (!layers.size) {
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 11, 12]) layers.set(id, { id, name: layerName(id), color: '', visible: true, active: false, config: true });
  }

  const footprints = [];
  const elements = [];
  for (const record of doc.shape ?? []) {
    const str = String(record);
    const cut = str.indexOf('~');
    const cmd = (cut > 0 ? str.slice(0, cut) : str).toUpperCase();
    if (cmd === 'LIB' || cmd === 'SHEET') {
      const subs = str.split('#@$');
      const headFields = PCB_FIELDS[cmd];
      const h = fieldsToObject(headFields, subs[0].split('~'), 1);
      const fp = {
        type: cmd,
        x: num(h.x), y: num(h.y),
        rotation: num(h.rotation) || 0,
        layer: Number(h.layerid) || 1,
        gId: h.gId,
        uuid: h.uuid || '',
        locked: h.locked === '1',
        addIntoBom: h.add_into_bom !== 'no',
        bindSchId: h.bind_sch_id || '',
        cPara: typeof h.c_para === 'string' ? parseCpara(h.c_para) : (h.c_para ?? {}),
        name: '',
        pads: [], tracks: [], texts: [], regions: [], circles: [], arcs: [], rects: [], others: [],
      };
      fp.name = fp.cPara.name || fp.cPara.package || fp.cPara.pre || '';
      for (const sub of subs.slice(1)) {
        if (!sub) continue;
        const c2 = sub.indexOf('~');
        const t = (c2 > 0 ? sub.slice(0, c2) : sub).toUpperCase();
        if (!PCB_FIELDS[t]) continue;
        const parsed = parseType(t, sub);
        if (t === 'PAD') fp.pads.push(parsed);
        else if (t === 'TRACK') fp.tracks.push(parsed);
        else if (t === 'TEXT') fp.texts.push(parsed);
        else if (t === 'SOLIDREGION' || t === 'COPPERAREA') fp.regions.push(parsed);
        else if (t === 'CIRCLE') fp.circles.push(parsed);
        else if (t === 'ARC') fp.arcs.push(parsed);
        else if (t === 'RECT') fp.rects.push(parsed);
        else fp.others.push(parsed);
      }
      footprints.push(fp);
      continue;
    }
    if (!PCB_FIELDS[cmd]) continue;
    const parsed = parseType(cmd, str);
    if (cmd === 'PLANEZONE') {
      for (const sub of str.split('#@$').slice(1)) {
        const f = sub.split('~');
        parsed.zones.push({ gId: f[0], pathStr: f[1] ?? '', path: parsePath(f[1] ?? '') });
      }
    }
    if (cmd === 'TRACK' && parsed.points.length < 2) continue;
    if (cmd === 'TEXT' && !String(parsed.text ?? '').trim()) continue;
    elements.push(parsed);
  }

  // A footprint document (docType 4) keeps its PAD/TRACK/... records at the top
  // level: the document *is* the footprint. A board (docType 3) wraps every
  // placed footprint in a LIB record instead.
  if (docType === '4' || docType === '14' || docType === '16') {
    const self = {
      type: 'SELF',
      // a footprint document keeps its PAD/TRACK records in absolute library-canvas
      // coordinates (verified: R0603 pads at 4000/3000 == head.x/y), so the
      // container must not add an offset of its own
      x: 0, y: 0,
      headX: num(head.x ?? 0), headY: num(head.y ?? 0),
      rotation: 0, layer: 1, gId: '', uuid: head.uuid || '',
      locked: false, addIntoBom: true, bindSchId: '',
      cPara, name: cPara.name || cPara.package || cPara.pre || '',
      pads: [], tracks: [], texts: [], regions: [], circles: [], arcs: [], rects: [], others: [],
    };
    const keep = [];
    for (const e of elements) {
      const bucket = { PAD: 'pads', TRACK: 'tracks', TEXT: 'texts', SOLIDREGION: 'regions', COPPERAREA: 'regions', CIRCLE: 'circles', ARC: 'arcs', RECT: 'rects' }[e.type];
      if (bucket) self[bucket].push(e);
      else keep.push(e);
    }
    elements.length = 0;
    elements.push(...keep);
    footprints.push(self);
  }

  const drc = doc.DRCRULE ?? {};
  const model = {
    docType,
    // the original record strings: additive edits (routing, pours) re-emit these
    // instead of rebuilding them from the parsed objects
    rawShape: (doc.shape ?? []).map(String),
    isFootprint: docType === '4',
    isBoard: docType === '3',
    title: doc.title ?? '',
    head, cPara, canvas, layers,
    unit: { name: 'unit', mm: UNIT_MM, note: '1 unit = 0.254 mm = 10 mil' },
    drc: {
      default: drc.Default ?? {},
      perNet: Object.fromEntries(Object.entries(drc).filter(([k]) => k !== 'Default' && k !== 'isRealtime' && k !== 'checkObjectToCopperarea' && k !== 'showDRCRangeLine')),
      isRealtime: drc.isRealtime !== false,
    },
    netColors: doc.netColors ?? {},
    preference: doc.preference ?? {},
    footprints,
    elements,
    counts: {
      footprints: footprints.length,
      pads: footprints.reduce((n, f) => n + f.pads.length, 0),
      tracks: elements.filter((e) => e.type === 'TRACK').length + footprints.reduce((n, f) => n + f.tracks.length, 0),
      vias: elements.filter((e) => e.type === 'VIA').length,
      holes: elements.filter((e) => e.type === 'HOLE').length,
      copperAreas: elements.filter((e) => e.type === 'COPPERAREA').length,
      solidRegions: elements.filter((e) => e.type === 'SOLIDREGION').length,
      texts: elements.filter((e) => e.type === 'TEXT').length,
      dimensions: elements.filter((e) => e.type === 'DIMENSION').length,
    },
  };
  return model;
}

/** Board outline: geometry drawn on the BoardOutLine layer (10). */
export function boardOutline(model) {
  const items = [];
  for (const e of model.elements) {
    if (e.layer === 10) items.push(e);
  }
  const pts = [];
  for (const e of items) {
    if (e.type === 'TRACK') pts.push(...e.points);
    else if (e.type === 'RECT') pts.push({ x: e.x - e.width / 2, y: e.y - e.height / 2 }, { x: e.x + e.width / 2, y: e.y + e.height / 2 });
    else if (e.type === 'CIRCLE') pts.push({ x: e.cx - e.r, y: e.cy - e.r }, { x: e.cx + e.r, y: e.cy + e.r });
  }
  if (!pts.length) return null;
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  return {
    minX, minY, maxX, maxY, items,
    widthMm: toMm(maxX - minX), heightMm: toMm(maxY - minY),
  };
}

/**
 * A pad's real footprint on the board.
 *
 * POLYGON pads carry width/height 0 and put their shape in `points` (absolute
 * coordinates), so anything measuring a pad - the router, the clearance check,
 * the renderer - has to look at the polygon first.
 */
export function padBBox(pad) {
  if (pad?.points?.length) {
    const xs = pad.points.map((p) => p.x), ys = pad.points.map((p) => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY, fromPolygon: true };
  }
  const w = Number(pad?.width) || 0, h = Number(pad?.height) || 0;
  return { minX: pad.x - w / 2, maxX: pad.x + w / 2, minY: pad.y - h / 2, maxY: pad.y + h / 2, width: w, height: h, fromPolygon: false };
}

/** Every copper item (tracks / pads / vias / pours) with its layer and net. */
export function copperItems(model) {
  const out = [];
  for (const e of model.elements) {
    if (e.type === 'TRACK' && isCopper(e.layer)) out.push({ kind: 'track', net: e.net, layer: e.layer, width: e.strokeWidth, points: e.points });
    if (e.type === 'VIA') out.push({ kind: 'via', net: e.net, layer: e.layer, x: e.x, y: e.y, diameter: e.diameter, holeR: e.holeR });
    if (e.type === 'COPPERAREA') out.push({ kind: 'pour', net: e.net, layer: e.layer, path: e.path });
  }
  // A footprint's sub-records are stored in ABSOLUTE document coordinates: the
  // LIB x/y is the component anchor, not a translation. Verified against the
  // editor, which renders a LIB at (1000,1000) whose pads say 4002.966 at
  // exactly 4002.966.
  for (const fp of model.footprints) {
    for (const pad of fp.pads) {
      const bbox = padBBox(pad);
      out.push({
        kind: 'pad', net: pad.net, layer: pad.layer, x: pad.x, y: pad.y,
        width: bbox.width, height: bbox.height, bbox,
        number: pad.number, footprint: fp.name, rotation: pad.rotation, anchor: { x: fp.x, y: fp.y },
      });
    }
    for (const t of fp.tracks) if (isCopper(t.layer)) out.push({ kind: 'track', net: t.net, layer: t.layer, width: t.strokeWidth, points: t.points, footprint: fp.name });
  }
  return out;
}

export async function readPcbFile(file) {
  const text = await fs.readFile(file, 'utf8');
  const model = parsePcb(text);
  model.file = path.resolve(file);
  return model;
}

/** Human/machine readable summary (used by the CLI and the report). */
export function pcbSummary(model) {
  const outline = boardOutline(model);
  return {
    file: model.file,
    docType: model.docType,
    kind: model.isFootprint ? 'footprint' : (model.isBoard ? 'board' : `docType ${model.docType}`),
    title: model.title,
    name: model.cPara.name || model.cPara.package || '',
    package: model.cPara.package || '',
    layers: [...model.layers.values()].filter((l) => l.visible).map((l) => l.name),
    counts: model.counts,
    footprints: model.footprints.map((f) => {
      // for a footprint document the useful position is the geometry centre
      let x = f.x, y = f.y;
      if (f.type === 'SELF' && f.pads.length) {
        const xs = f.pads.map((p) => p.x), ys = f.pads.map((p) => p.y);
        x = (Math.min(...xs) + Math.max(...xs)) / 2;
        y = (Math.min(...ys) + Math.max(...ys)) / 2;
      }
      return {
        name: f.name, package: f.cPara.package || '', x, y, rotation: f.rotation,
        pads: f.pads.length, uuid: f.uuid, value: f.cPara.value || f.cPara.Value || '',
      };
    }),
    board: outline ? { widthMm: +outline.widthMm.toFixed(3), heightMm: +outline.heightMm.toFixed(3) } : null,
    drc: model.drc.default,
  };
}
