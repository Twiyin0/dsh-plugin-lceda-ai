// Gerber (RS-274X) and Excellon export.
//
// This writes the fabrication data from the board model directly. RS-274X and
// Excellon are public, published formats (Ucamco / IPC-NC-349), so nothing here
// is reverse engineered: the coordinate format, aperture macros, region fills
// and drill headers are all specified. The editor has its own generator inside
// `#worker_main`, but that protocol is not published and driving its save dialog
// is not scriptable, so the writer below is the supported path - and it is
// checked against an independent parser (gerbonara) in the tests.
//
// Geometry is in board units (1 unit = 0.254 mm) and converted on the way out.
import { toMm, UNIT_MM, boardOutline, copperItems, padBBox, layerName } from './parser.js';
import { textStrokes } from './font.js';

/**
 * Silkscreen and other non-copper artwork on a layer.
 *
 * `copperItems()` deliberately only returns copper, so silkscreen needs its own
 * accessor: footprint artwork lives in `footprint.tracks`, top level artwork in
 * `model.elements`, and text carries no strokes (the editor regenerates them),
 * so it is drawn from our own stroke font instead.
 */
export function artworkItems(model, layer) {
  const out = [];
  for (const fp of model.footprints) {
    for (const t of fp.tracks ?? []) if (t.layer === layer) out.push({ kind: 'track', points: t.points, width: t.strokeWidth ?? 1 });
    for (const t of fp.texts ?? []) if (t.layer === layer) out.push({ kind: 'text', text: t.text, x: t.x, y: t.y, size: t.fontSize ?? 4, rotation: t.rotation ?? 0, mirror: t.mirror, strokes: t.pathStr ? null : textStrokes(t.text, { x: t.x, y: t.y, size: t.fontSize ?? 4, rotation: t.rotation ?? 0, mirror: t.mirror, anchor: 'start' }) });
  }
  for (const e of model.elements) {
    if (e.type === 'TRACK' && e.layer === layer) out.push({ kind: 'track', points: e.points, width: e.strokeWidth ?? 1 });
    if (e.type === 'TEXT' && e.layer === layer) out.push({ kind: 'text', text: e.text, x: e.x, y: e.y, size: e.fontSize ?? 4, rotation: e.rotation ?? 0, mirror: e.mirror, strokes: textStrokes(e.text, { x: e.x, y: e.y, size: e.fontSize ?? 4, rotation: e.rotation ?? 0, mirror: e.mirror, anchor: 'start' }) });
  }
  return out;
}

/** Layers that become a Gerber file, with the conventional KiCad-style names. */
export const GERBER_LAYERS = {
  1: { name: 'F_Cu', function: 'Copper,L1,Top', kind: 'copper' },
  2: { name: 'B_Cu', function: 'Copper,L2,Bot', kind: 'copper' },
  3: { name: 'F_SilkS', function: 'Legend,Top', kind: 'silk' },
  4: { name: 'B_SilkS', function: 'Legend,Bot', kind: 'silk' },
  7: { name: 'F_Mask', function: 'Soldermask,Top', kind: 'mask' },
  8: { name: 'B_Mask', function: 'Soldermask,Bot', kind: 'mask' },
  10: { name: 'Edge_Cuts', function: 'Profile,NP', kind: 'outline' },
};

/** 4.6 format, millimetres: value = round(mm * 1e6). */
const COORD = 1e6;
const coord = (mm) => Math.round(mm * COORD);

/**
 * Gerber's Y axis points up, the board model's Y points down.
 *
 * Emitting board coordinates directly mirrored the whole board vertically -
 * silkscreen text came out upside down and every part sat on the wrong side.
 * The origin is moved to the bottom-left corner of the board so the numbers stay
 * positive, which is also what fabrication tools expect.
 */
export function gerberOrigin(model) {
  const outline = boardOutline(model);
  if (outline) return { x: outline.minX, y: outline.maxY };
  return { x: 0, y: 0 };
}

/** Board units -> Gerber millimetres, with the axis flip. */
export function makeTransform(model) {
  const o = gerberOrigin(model);
  return {
    origin: o,
    x: (x) => toMm(x - o.x),
    y: (y) => toMm(o.y - y),
  };
}

/** Aperture shapes we can express with a standard aperture. */
function apertureFor(pad) {
  const w = pad.width ?? 0, h = pad.height ?? 0;
  const shape = String(pad.shape ?? 'RECT').toUpperCase();
  const rot = ((pad.rotation ?? 0) % 360 + 360) % 360;
  if (shape === 'ELLIPSE' || shape === 'CIRCLE' || shape === 'ROUND') {
    const d = Math.max(w, h);
    return { code: 'C', params: [d] };
  }
  if (shape === 'OVAL' || shape === 'OBROUND') {
    if (rot % 180 === 90) return { code: 'O', params: [h, w] };
    return { code: 'O', params: [w, h] };
  }
  // rectangles: a quarter turn swaps the sides, anything else needs a region
  if (rot % 180 === 0) return { code: 'R', params: [w, h] };
  if (rot % 180 === 90) return { code: 'R', params: [h, w] };
  return null;
}

/** Polygon outline of a pad, used when no standard aperture fits (or it is rotated). */
function padPolygon(pad) {
  if (pad.points?.length >= 3) return pad.points.map((p) => ({ x: p.x, y: p.y }));
  const w = (pad.width ?? 0) / 2, h = (pad.height ?? 0) / 2;
  const rot = ((pad.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([dx, dy]) => ({
    x: pad.x + dx * cos - dy * sin,
    y: pad.y + dx * sin + dy * cos,
  }));
}

const g = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''));

/** Header shared by every file. */
function header(functionName) {
  return [
    `%TF.GenerationSoftware,LCEDA-AI,pcb-gerber,1.0*%`,
    `%TF.FileFunction,${functionName}*%`,
    '%FSLAX46Y46*%',
    '%MOMM*%',
    '%LPD*%',
    'G01*',
  ];
}

/**
 * Build one Gerber file for a layer.
 *
 * @param {object} model parsed board
 * @param {number} layer layer id (see GERBER_LAYERS)
 * @param {{solderMaskExpansion?: number, useRegions?: boolean}} opts
 */
export function gerberForLayer(model, layer, opts = {}) {
  const meta = GERBER_LAYERS[layer];
  if (!meta) throw new Error(`layer ${layer} is not exported to Gerber`);
  const tf = makeTransform(model);
  const out = header(meta.function);
  const apertures = new Map();          // key -> Dnn
  const body = [];
  let nextD = 10;

  const definitions = [];
  /**
   * Register an aperture and emit its %ADD% definition exactly once.
   *
   * An earlier version registered the code first and then checked "already
   * known", so the definition line was never written and the files referenced
   * undefined apertures - our own parser did not care, gerbonara did.
   */
  const useAperture = (key, def) => {
    if (apertures.has(key)) return apertures.get(key);
    const code = `D${nextD++}`;
    apertures.set(key, code);
    definitions.push(`%ADD${code.slice(1)}${def}*%`);
    return code;
  };

  const at = (p) => `X${coord(tf.x(p.x))}Y${coord(tf.y(p.y))}`;
  const flash = (x, y, d) => body.push(`${d}*`, `X${coord(tf.x(x))}Y${coord(tf.y(y))}D03*`);
  const drawPath = (points, d) => {
    body.push(`${d}*`, `${at(points[0])}D02*`);
    for (const p of points.slice(1)) body.push(`${at(p)}D01*`);
  };
  const region = (points) => {
    body.push('G36*', `${at(points[0])}D02*`, 'G01*');
    for (const p of points.slice(1)) body.push(`${at(p)}D01*`);
    const first = points[0], last = points[points.length - 1];
    if (first.x !== last.x || first.y !== last.y) body.push(`${at(first)}D01*`);
    body.push('G37*');
  };

  const maskExpansion = opts.solderMaskExpansion ?? 0;   // in units
  const isMask = meta.kind === 'mask';
  const isCopper = meta.kind === 'copper';

  // --- pads ---------------------------------------------------------------
  const pads = copperItems(model).filter((i) => i.kind === 'pad');
  for (const pad of pads) {
    const padLayer = pad.layer ?? 1;
    const onLayer = padLayer === 11 ? (layer === 1 || layer === 2) : padLayer === layer;
    const onMask = isMask && (padLayer === 11 ? (layer === 7 || layer === 8) : (layer === 7 ? padLayer === 1 : padLayer === 8));
    if (!onLayer && !onMask) continue;
    // through-hole pads keep their mask opening (the drill is a separate file)
    const shape = pad;
    const grown = isMask && maskExpansion
      ? { ...pad, width: (pad.width ?? 0) + maskExpansion * 2, height: (pad.height ?? 0) + maskExpansion * 2 }
      : pad;
    const ap = apertureFor(grown);
    if (ap && !opts.useRegions) {
      const params = ap.params.map((v) => toMm(v).toFixed(4)).join('X');
      const d = useAperture(`${ap.code},${params}`, `${ap.code},${params}`);
      flash(pad.x, pad.y, d);
    } else {
      region(padPolygon(grown));
    }
  }

  // --- tracks -------------------------------------------------------------
  if (isCopper) {
    const tracks = copperItems(model).filter((i) => i.kind === 'track' && i.layer === layer);
    for (const track of tracks) {
      const key = `C,${toMm(track.width ?? 1).toFixed(4)}`;
      drawPath(track.points, useAperture(key, key));
    }
  }

  // --- silkscreen artwork (footprint outlines plus reference text) ----------
  if (meta.kind === 'silk') {
    for (const item of artworkItems(model, layer)) {
      if (item.kind === 'track') {
        if ((item.points ?? []).length < 2) continue;
        const key = `C,${toMm(item.width ?? 1).toFixed(4)}`;
        drawPath(item.points, useAperture(key, key));
      } else {
        // text: either its own stroke data or our font
        const strokes = item.strokes ?? [];
        if (!strokes.length) continue;
        const key = `C,${toMm(item.size ? item.size / 8 : 0.5).toFixed(4)}`;
        const d = useAperture(key, key);
        for (const stroke of strokes) if (stroke.length >= 2) drawPath(stroke, d);
      }
    }
  }

  // --- vias (copper only, they are through holes) --------------------------
  if (isCopper) {
    for (const via of copperItems(model).filter((i) => i.kind === 'via')) {
      const key = `C,${toMm(via.diameter ?? 3).toFixed(4)}`;
      flash(via.x, via.y, useAperture(key, key));
    }
  }

  // --- pours --------------------------------------------------------------
  if (isCopper) {
    for (const pour of copperItems(model).filter((i) => i.kind === 'pour' && (i.layer === layer || i.layer === 11))) {
      for (const loop of pour.loops ?? [pour.path]) {
        if (loop?.length >= 3) region(loop);
      }
    }
  }

  // --- board outline ------------------------------------------------------
  if (meta.kind === 'outline') {
    const outline = boardOutline(model);
    const key = `C,${toMm(opts.outlineWidth ?? 4).toFixed(4)}`;
    const d = useAperture(key, key);
    for (const item of outline?.items ?? []) {
      if (item.points?.length >= 2) drawPath(item.points, d);
    }
  }

  const files = [...out, ...definitions, ...body, 'M02*'];
  return files.join('\n') + '\n';
}

/**
 * Excellon drill file.
 *
 * @param {object} model parsed board
 * @param {{plated?: boolean, layer?: 'both'}} opts plated = vias and through-hole pads; NPTH = mounting holes
 */
export function excellon(model, opts = {}) {
  const plated = opts.plated !== false;
  const tf = makeTransform(model);
  const hits = [];
  for (const item of copperItems(model)) {
    if (plated && item.kind === 'via') hits.push({ x: item.x, y: item.y, d: (item.holeR ?? 0) * 2, plated: true });
    if (plated && item.kind === 'pad' && (item.holeR ?? 0) > 0) hits.push({ x: item.x, y: item.y, d: item.holeR * 2, plated: true });
    if (!plated && item.kind === 'hole') hits.push({ x: item.x, y: item.y, d: (item.holeR ?? 0) * 2, plated: false });
  }
  const tools = new Map();
  for (const hit of hits) {
    const key = toMm(hit.d).toFixed(3);
    if (!tools.has(key)) tools.set(key, `T${tools.size + 1}`);
  }
  const lines = ['M48', 'FMAT,2', 'METRIC,TZ', '; LCEDA-AI pcb-gerber 1.0'];
  for (const [dia, tool] of tools) lines.push(`${tool}C${dia}`);
  lines.push('%', 'G90', 'G05');
  for (const [dia, tool] of tools) {
    lines.push(tool);
    for (const hit of hits) if (toMm(hit.d).toFixed(3) === dia) lines.push(`X${tf.x(hit.x).toFixed(3)}Y${tf.y(hit.y).toFixed(3)}`);
  }
  lines.push('T0', 'M30');
  return lines.join('\n') + '\n';
}

/** Suggested file name for a layer. */
export function gerberFileName(name, layer) {
  return layer === 'drill' ? `${name}.drl` : `${name}-${GERBER_LAYERS[layer].name}.gbr`;
}

/** Export every layer plus the drill files. */
export function exportGerber(model, { name = 'board', layers = null } = {}) {
  const wanted = layers ?? Object.keys(GERBER_LAYERS).map(Number);
  const files = [];
  for (const layer of wanted) {
    files.push({ layer, name: gerberFileName(name, layer), text: gerberForLayer(model, layer) });
  }
  files.push({ layer: 'drill', name: gerberFileName(name, 'drill'), text: excellon(model, { plated: true }) });
  const npth = excellon(model, { plated: false });
  if (/\nX/.test(npth)) files.push({ layer: 'drill-npth', name: `${name}-NPTH.drl`, text: npth });
  return { files, name };
}

// ---------------------------------------------------------------- self check

/**
 * Minimal RS-274X reader used to check our own output.
 *
 * It understands the subset we emit (FSLAX46Y46, MOMM, ADD C/R/O, D01/D02/D03,
 * G36/G37 regions) and returns the counts and bounding box, which is enough to
 * catch a file that lost its pads, used the wrong units or wrote coordinates
 * outside the board.
 */
export function parseGerber(text) {
  const result = { apertures: [], flashes: [], draws: [], regions: [], bounds: null, units: null, format: null, errors: [] };
  let cur = null;                     // current point
  let inRegion = false;
  let region = null;
  const extend = (x, y) => {
    if (!result.bounds) result.bounds = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      result.bounds.minX = Math.min(result.bounds.minX, x);
      result.bounds.minY = Math.min(result.bounds.minY, y);
      result.bounds.maxX = Math.max(result.bounds.maxX, x);
      result.bounds.maxY = Math.max(result.bounds.maxY, y);
    }
  };
  const toMmValue = (raw) => {
    if (!result.format) { result.errors.push('coordinate before %FSLAX%'); return 0; }
    const { intDigits, decDigits } = result.format;
    const neg = raw.startsWith('-');
    const digits = raw.replace(/^[-+]/, '').padStart(intDigits + decDigits, '0');
    const value = Number(digits.slice(0, intDigits)) + Number(digits.slice(intDigits)) / 10 ** decDigits;
    return neg ? -value : value;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('%FSLAX')) {
      const m = line.match(/%FSLAX(\d)(\d)Y(\d)(\d)\*%/);
      if (m) result.format = { intDigits: Number(m[1]), decDigits: Number(m[2]) };
      continue;
    }
    if (line.startsWith('%MO')) { result.units = line.includes('IN') ? 'inch' : 'mm'; continue; }
    if (line.startsWith('%ADD')) {
      const m = line.match(/%ADD(\d+)([A-Z]+),([^*]*)\*%/);
      if (m) result.apertures.push({ d: `D${m[1]}`, shape: m[2], params: m[3].split('X').map(Number) });
      continue;
    }
    if (line === 'G36*') { inRegion = true; region = []; continue; }
    if (line === 'G37*') { inRegion = false; if (region?.length) result.regions.push(region); region = null; continue; }
    if (line === 'M02*') break;
    const m = line.match(/^(?:G0[123]\*)?(?:X(-?\d+))?(?:Y(-?\d+))?D0([123])\*$/);
    if (m) {
      const x = m[1] !== undefined ? toMmValue(m[1]) : cur?.x ?? 0;
      const y = m[2] !== undefined ? toMmValue(m[2]) : cur?.y ?? 0;
      const op = m[3];
      extend(x, y);
      if (op === '3') result.flashes.push({ x, y });
      else if (op === '1') {
        result.draws.push({ from: cur ? { ...cur } : null, to: { x, y } });
        if (inRegion && region) region.push({ x, y });
      } else if (op === '2') {
        if (inRegion && region && !region.length) region.push({ x, y });
      }
      cur = { x, y };
    }
  }
  return result;
}

/**
 * Compare the exported files with the board they came from.
 *
 * @returns {{ok: boolean, checks: object[], problems: string[]}}
 */
export function verifyGerber(model, exported, { toleranceMm = 0.01 } = {}) {
  const problems = [];
  const checks = [];
  const byLayer = new Map(exported.files.map((f) => [f.layer, f]));

  const copperPads = copperItems(model).filter((i) => i.kind === 'pad');
  const vias = copperItems(model).filter((i) => i.kind === 'via');
  const tracks = copperItems(model).filter((i) => i.kind === 'track');

  // top copper: every pad and via must be flashed, every track drawn
  const top = byLayer.get(1);
  if (!top) problems.push('缺少顶层铜文件');
  else {
    const parsed = parseGerber(top.text);
    const realFlashes = copperPads.filter((p) => p.layer === 11 || p.layer === 1).length + vias.length;
    checks.push({ name: 'top-copper-flashes', expected: realFlashes, actual: parsed.flashes.length });
    if (parsed.flashes.length !== realFlashes) problems.push(`顶层铜 flash 数不符:${parsed.flashes.length} != ${realFlashes}`);
    // every drawn segment must come from a track or a pour outline
    const expectedSegments = tracks.filter((t) => t.layer === 1).reduce((n, t) => n + Math.max(0, t.points.length - 1), 0)
      + copperItems(model).filter((i) => i.kind === 'pour' && i.layer === 1).reduce((n, p) => n + Math.max(0, (p.path?.length ?? 0)), 0);
    checks.push({ name: 'top-copper-segments', expected: expectedSegments, actual: parsed.draws.length });
    if (parsed.units !== 'mm') problems.push(`顶层铜单位不是 mm:${parsed.units}`);
    if (!parsed.format) problems.push('顶层铜缺少坐标格式声明');
    const used = new Set((top.text.match(/^D(\d+)\*$/gm) ?? []).map((d) => d.replace('*', '')));
    const defined = new Set(parsed.apertures.map((a) => a.d));
    const missing = [...used].filter((d) => !defined.has(d));
    checks.push({ name: 'top-copper-apertures', expected: used.size, actual: defined.size });
    if (missing.length) problems.push(`顶层铜引用了未定义的孔径:${missing.join(',')}`);
    // every flash must sit on a pad or via
    const tf = makeTransform(model);
    const points = [
      ...copperPads.filter((p) => p.layer === 11 || p.layer === 1).map((p) => ({ x: tf.x(p.x), y: tf.y(p.y) })),
      ...vias.map((v) => ({ x: tf.x(v.x), y: tf.y(v.y) })),
    ];
    let matched = 0;
    for (const f of parsed.flashes) {
      if (points.some((p) => Math.abs(p.x - f.x) < toleranceMm && Math.abs(p.y - f.y) < toleranceMm)) matched++;
    }
    checks.push({ name: 'top-copper-flash-positions', expected: realFlashes, actual: matched });
    if (matched !== realFlashes) problems.push(`顶层铜有 ${realFlashes - matched} 个 flash 不对应任何焊盘/过孔`);
  }

  // drill: every hole must appear once
  const drill = byLayer.get('drill');
  const expectedHoles = vias.length + copperPads.filter((p) => (p.holeR ?? 0) > 0).length;
  if (!drill) problems.push('缺少钻孔文件');
  else {
    const hits = (drill.text.match(/^X-?[\d.]+Y-?[\d.]+$/gm) ?? []).length;
    checks.push({ name: 'drill-hits', expected: expectedHoles, actual: hits });
    if (hits !== expectedHoles) problems.push(`钻孔数不符:${hits} != ${expectedHoles}`);
    if (!/^M48/m.test(drill.text) || !/M30\s*$/.test(drill.text)) problems.push('钻孔文件缺少 M48/M30');
    if (!/METRIC/.test(drill.text)) problems.push('钻孔文件没有声明公制');
  }

  // outline
  const outline = byLayer.get(10);
  if (!outline) problems.push('缺少板框文件');
  else {
    const parsed = parseGerber(outline.text);
    const modelOutline = boardOutline(model);
    if (modelOutline) {
      const wMm = toMm(modelOutline.maxX - modelOutline.minX), hMm = toMm(modelOutline.maxY - modelOutline.minY);
      const gw = parsed.bounds ? parsed.bounds.maxX - parsed.bounds.minX : 0;
      const gh = parsed.bounds ? parsed.bounds.maxY - parsed.bounds.minY : 0;
      checks.push({ name: 'outline-size', expected: `${wMm.toFixed(2)}x${hMm.toFixed(2)}`, actual: `${gw.toFixed(2)}x${gh.toFixed(2)}` });
      if (Math.abs(gw - wMm) > 0.5 || Math.abs(gh - hMm) > 0.5) problems.push(`板框尺寸不符:${gw.toFixed(2)}x${gh.toFixed(2)} vs ${wMm.toFixed(2)}x${hMm.toFixed(2)}`);
    }
  }

  return { ok: problems.length === 0, checks, problems };
}
