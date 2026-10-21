// Document authoring: create a fresh sheet, place symbols, wire pins by reference,
// and build a whole schematic from a declarative spec.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from './parser.js';
import { extractNetlist } from './netlist.js';
import { fmt } from './path.js';
import {
  BUILTIN_SYMBOLS, buildSymbolShapes, passiveGraphics, makeComponent, makeNetFlag,
  genUuid, shapesCenter, pinCenter, translateShapes, headerSpec,
} from './symbol.js';

const SHEET_W = 1160;
const SHEET_H = 820;
const FRAME_COLOR = '#880000';
const VALUE_COLOR = '#0000FF';

let seq = 0;
const id = () => {
  seq = (seq + 1) % 0xffff;
  return `gge${Date.now().toString(16).slice(-6)}${seq.toString(16).padStart(4, '0')}${Math.floor(Math.random() * 0xff).toString(16)}`;
};

const textRec = ({ x, y, text, size = 8, color = '#880000', anchor = 'start', rot = 0, bold = false }) =>
  ['T', 'L', fmt(x), fmt(y), String(rot), color, 'Arial', fmt(size), bold ? '1' : '', '', '', 'comment', String(text), '1', anchor, id(), '0', ''].join('~');

/** Plain A4-landscape sheet frame with zone ticks and a title block. */
export function buildFrame() {
  const shapes = [];
  const rect = (x, y, w, h, width = 1, color = FRAME_COLOR) =>
    shapes.push(['R', fmt(x), fmt(y), '', '', fmt(w), fmt(h), color, String(width), '0', 'none', id(), '0'].join('~'));
  const line = (x1, y1, x2, y2, width = 1) =>
    shapes.push(['PL', `${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)}`, FRAME_COLOR, String(width), '0', 'none', id(), '0'].join('~'));

  rect(8, 8, SHEET_W - 16, SHEET_H - 16, 1);
  rect(22, 22, SHEET_W - 44, SHEET_H - 44, 2);

  // zone ticks: 6 columns, 4 rows
  const cols = 6, rows = 4;
  const x0 = 22, y0 = 22, w = SHEET_W - 44, h = SHEET_H - 44;
  for (let c = 1; c < cols; c++) {
    const x = x0 + (w / cols) * c;
    line(x, y0, x, y0 + 10);
    line(x, y0 + h - 10, x, y0 + h);
  }
  for (let r = 1; r < rows; r++) {
    const y = y0 + (h / rows) * r;
    line(x0, y, x0 + 10, y);
    line(x0 + w - 10, y, x0 + w, y);
  }
  for (let c = 0; c < cols; c++) {
    const x = x0 + (w / cols) * (c + 0.5);
    shapes.push(textRec({ x, y: y0 + 8, text: String(c + 1), size: 8, anchor: 'middle' }));
    shapes.push(textRec({ x, y: y0 + h - 2, text: String(c + 1), size: 8, anchor: 'middle' }));
  }
  for (let r = 0; r < rows; r++) {
    const y = y0 + (h / rows) * (r + 0.5) + 3;
    shapes.push(textRec({ x: x0 + 6, y, text: String.fromCharCode(65 + r), size: 8 }));
    shapes.push(textRec({ x: x0 + w - 6, y, text: String.fromCharCode(65 + r), size: 8, anchor: 'end' }));
  }

  // title block (bottom right)
  const tx = 600, ty = 700, tw = 535, th = 96;
  rect(tx, ty, tw, th, 1);
  line(tx, ty + 32, tx + tw, ty + 32, 1);
  line(tx, ty + 64, tx + tw, ty + 64, 1);
  line(tx + 450, ty + 32, tx + 450, ty + th, 1);
  line(tx + 150, ty + 64, tx + 150, ty + th, 1);
  return shapes;
}

export function newDocument({ title = 'Sheet_1', company = '', rev = '1.0', date = '', drawnBy = '', sheetIndex = 1, sheetTotal = 1, frame = true } = {}) {
  const frameShapes = frame ? buildFrame() : [];
  const frameLib = frameShapes.length
    ? makeComponent({
      shapes: frameShapes, x: SHEET_W / 2, y: SHEET_H / 2, ref: 'A', value: 'A', attrs: { package: 'NONE' },
      showName: false, showNumber: false,
    })
    : null;
  // The frame's shapes are authored in sheet coordinates; makeComponent recentres
  // them, so rebuild it without the offset.
  const frameRecord = frameLib ? rebuildFrame(frameShapes) : null;

  const titleTexts = [
    textRec({ x: 606, y: 726, text: 'TITLE:', size: 9 }),
    textRec({ x: 660, y: 726, text: title, size: 12, color: VALUE_COLOR }),
    textRec({ x: 1058, y: 726, text: 'REV:', size: 9 }),
    textRec({ x: 1090, y: 726, text: rev, size: 9, color: VALUE_COLOR }),
    textRec({ x: 606, y: 758, text: 'Date:', size: 8 }),
    textRec({ x: 646, y: 758, text: date, size: 8, color: VALUE_COLOR }),
    textRec({ x: 770, y: 758, text: 'Drawn By:', size: 8 }),
    textRec({ x: 846, y: 758, text: drawnBy, size: 8, color: VALUE_COLOR }),
    textRec({ x: 1058, y: 758, text: 'Sheet:', size: 8 }),
    textRec({ x: 1100, y: 758, text: `${sheetIndex}/${sheetTotal}`, size: 8, color: VALUE_COLOR }),
    textRec({ x: 606, y: 788, text: 'Company:', size: 8 }),
    textRec({ x: 672, y: 788, text: company, size: 8, color: VALUE_COLOR }),
  ];

  return {
    head: {
      docType: '1', editorVersion: '6.5.51', newgId: true, c_para: { 'Prefix Start': '1' },
      c_spiceCmd: 'null', hasIdFlag: true, uuid: genUuid(), x: '0', y: '0', portOfADImportHack: '',
      importFlag: 0, transformList: '',
    },
    canvas: 'CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0',
    shape: [frameRecord, ...titleTexts].filter(Boolean),
    BBox: { x: 0, y: 0, width: SHEET_W, height: SHEET_H },
    colors: {},
  };
}

function rebuildFrame(frameShapes) {
  // frame records already live in sheet coordinates: keep them verbatim
  const head = ['LIB', '0', '0', 'package`NONE`Contributor`lceda-ai`', '', '0', 'frame_lib_1',
    genUuid(), genUuid(), '0', '', 'no', 'no', '', String(Math.floor(Date.now() / 1000)), ''].join('~');
  return `${head}#@$${frameShapes.join('#@$')}`;
}

/** Shape set for a built-in symbol key. */
export function symbolShapes(key) {
  const entry = BUILTIN_SYMBOLS[key];
  if (!entry) throw new Error(`unknown built-in symbol "${key}". Available: ${Object.keys(BUILTIN_SYMBOLS).join(', ')}`);
  const shapes = buildSymbolShapes(entry.spec);
  if (entry.graphics) shapes.push(...passiveGraphics(entry.graphics, entry.spec));
  return shapes;
}

/** Place a built-in symbol or a fetched part document. */
export function placeComponent(doc, { symbol, part, ref, value, pins, labelSide, x, y, rot = 0, attrs = {} }) {
  let shapes;
  let meta = {};
  if (part) {
    const d = part.doc ?? part;
    shapes = d.shape.map(String);
    meta = { package: d.package ?? '', lcsc: d.lcsc ?? '', mfrPart: d.mfrPart ?? '' };
  } else {
    const entry = BUILTIN_SYMBOLS[symbol];
    if (!entry) throw new Error(`unknown built-in symbol "${symbol}". Available: ${Object.keys(BUILTIN_SYMBOLS).join(', ')}`);
    // headers take their pin count from the placement request
    const dynSpec = symbol === 'header' && pins ? headerSpec(pins) : null;
    shapes = dynSpec ? buildSymbolShapes(dynSpec) : symbolShapes(symbol);
    meta = { package: entry.package };
    if (dynSpec) meta.pinCount = dynSpec.pins.length;
    if (value === undefined) value = entry.defaultValue;
  }
  if (!ref) throw new Error('placeComponent needs a ref (designator)');
  const rec = makeComponent({
    shapes, x, y, ref, value: value ?? '', rot,
    attrs: { ...meta, ...attrs },
    labelLayout: symbol === 'header' ? 'above' : undefined,
    labelSide,
  });
  const existing = doc.shape.filter((s) => s.startsWith('LIB~'));
  for (const raw of existing) {
    const { designatorOf } = localHelpers();
    if (designatorOf(raw) === ref) throw new Error(`designator "${ref}" already used in this sheet`);
  }
  doc.shape.push(rec);
  growBBox(doc, x, y);
  return rec;
}

function localHelpers() {
  return {
    designatorOf(raw) {
      const subs = raw.split('#@$').slice(1);
      for (const s of subs) if (s.startsWith('T~P~')) return s.split('~')[12];
      return '';
    },
  };
}

export function growBBox(doc, x, y, pad = 40) {
  const bb = doc.BBox;
  if (x - pad < bb.x) { bb.width += bb.x - (x - pad); bb.x = x - pad; }
  if (x + pad > bb.x + bb.width) bb.width = x + pad - bb.x;
  if (y - pad < bb.y) { bb.height += bb.y - (y - pad); bb.y = y - pad; }
  if (y + pad > bb.y + bb.height) bb.height = y + pad - bb.y;
}

/** index of pin connection points: "U1.19" -> {x,y} */
export function pinIndex(doc) {
  const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  const map = new Map();
  for (const c of parsed.components) {
    for (const p of c.pins) map.set(`${c.designator}.${p.number}`, { x: p.x, y: p.y, name: p.name });
  }
  return map;
}

function resolvePoint(pins, at, where) {
  if (Array.isArray(at)) return { x: Number(at[0]), y: Number(at[1]) };
  if (at && typeof at === 'object' && 'x' in at) return { x: Number(at.x), y: Number(at.y) };
  if (typeof at === 'string') {
    const p = pins.get(at);
    if (!p) {
      const known = [...pins.keys()].slice(0, 20).join(', ');
      throw new Error(`${where}: unknown pin reference "${at}" (known e.g. ${known})`);
    }
    return { x: p.x, y: p.y };
  }
  throw new Error(`${where}: expected a pin reference ("U1.1") or [x, y]`);
}

export function addWire(doc, points) {
  if (points.length < 2) throw new Error('a wire needs at least 2 points');
  const rec = ['W', points.map((p) => `${fmt(p.x)} ${fmt(p.y)}`).join(' '), '#008800', '1', '0', 'none', id(), '0'].join('~');
  doc.shape.push(rec);
  for (const p of points) growBBox(doc, p.x, p.y, 10);
  return rec;
}

export function addLabel(doc, { x, y, text, rot = 0, anchor = 'start' }) {
  const tx = anchor === 'end' ? x - 2 : x + 2;
  doc.shape.push(['N', fmt(x), fmt(y), String(rot), '#0000ff', String(text), id(), anchor,
    fmt(tx), fmt(y - 4), 'Times New Roman', '7pt', '0'].join('~'));
}

export function addFlag(doc, { x, y, text, kind = 'part_netLabel_gnD', rot = 0 }) {
  doc.shape.push(makeNetFlag({ x, y, text, kind, rot }));
  growBBox(doc, x, y, 20);
}

export function addJunction(doc, { x, y }) {
  doc.shape.push(['J', fmt(x), fmt(y), '2.5', '#CC0000', id(), '0'].join('~'));
}

export function addText(doc, { x, y, text, size = 9, color = '#000080', anchor = 'start' }) {
  doc.shape.push(textRec({ x, y, text, size, color, anchor }));
}

/**
 * Build a schematic from a declarative spec.
 * spec = { title, company, rev, date, drawnBy, components:[{symbol|part, ref, value, x, y, rot}],
 *          wires:[{from,to}|{points:[[x,y],...]}], labels:[{text,at,rot}], flags:[{text,kind,at,rot}],
 *          junctions:[{at}], texts:[{text,at,size,color}] }
 */
export function buildFromSpec(spec = {}) {
  const doc = newDocument(spec);
  for (const c of spec.components ?? []) placeComponent(doc, c);
  const pins = pinIndex(doc);
  for (const w of spec.wires ?? []) {
    if (w.points) addWire(doc, w.points.map((p) => resolvePoint(pins, p, 'wire.points')));
    else if (w.from && w.to) {
      const a = resolvePoint(pins, w.from, 'wire.from');
      const b = resolvePoint(pins, w.to, 'wire.to');
      const pts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
      if (w.via) pts.push(...w.via.map((p) => resolvePoint(pins, p, 'wire.via')));
      addWire(doc, pts);
    } else throw new Error('each wire needs either "points" or "from"/"to"');
  }
  for (const l of spec.labels ?? []) {
    const p = resolvePoint(pins, l.at, 'label.at');
    addLabel(doc, { x: p.x, y: p.y, text: l.text, rot: l.rot ?? 0, anchor: l.anchor ?? 'start' });
  }
  for (const f of spec.flags ?? []) {
    const p = resolvePoint(pins, f.at, 'flag.at');
    addFlag(doc, { x: p.x, y: p.y, text: f.text, kind: f.kind, rot: f.rot ?? 0 });
  }
  for (const j of spec.junctions ?? []) {
    const p = resolvePoint(pins, j.at, 'junction.at');
    addJunction(doc, { x: p.x, y: p.y });
  }
  for (const t of spec.texts ?? []) {
    const p = resolvePoint(pins, t.at, 'text.at');
    addText(doc, { x: p.x, y: p.y, text: t.text, size: t.size, color: t.color });
  }
  const text = JSON.stringify(doc);
  const parsed = parseDocument(JSON.parse(text));
  const netlist = extractNetlist(parsed);
  return { doc, text, parsed, netlist, warnings: parsed.warnings };
}

/** Fluent authoring API: place symbols, then wire/label/flag by pin reference. */
export class SchematicBuilder {
  constructor(opts = {}) {
    this.doc = newDocument(opts);
    this.notes = [];
  }

  place(entry) {
    placeComponent(this.doc, entry);
    return this;
  }

  /** pin reference index: "U1.19" -> {x, y, name} */
  pins() { return pinIndex(this.doc); }

  pt(ref) {
    if (Array.isArray(ref)) return { x: Number(ref[0]), y: Number(ref[1]) };
    if (ref && typeof ref === 'object' && 'x' in ref) return { x: Number(ref.x), y: Number(ref.y) };
    const p = this.pins().get(String(ref));
    if (!p) throw new Error(`unknown pin reference "${ref}"`);
    return { x: p.x, y: p.y };
  }

  wire(points) {
    addWire(this.doc, points.map((p) => this.pt(p)));
    return this;
  }

  label(text, at, opts = {}) {
    const p = this.pt(at);
    addLabel(this.doc, { x: p.x, y: p.y, text, ...opts });
    return this;
  }

  /**
   * Add a power/ground flag.
   * Accepts (text, at) with the kind inferred from the text, or the explicit
   * (text, kind, at) form used by the spec builder.
   */
  flag(text, kind, at, opts = {}) {
    let point = at;
    let flagKind = kind;
    if (point === undefined) { point = kind; flagKind = undefined; }
    if (flagKind && typeof flagKind === 'object') { opts = point ?? {}; point = flagKind; flagKind = undefined; }
    const p = this.pt(point);
    const inferred = /gnd|ground|地/i.test(String(text)) ? 'part_netLabel_gnD' : 'part_netLabel_+5V';
    addFlag(this.doc, { x: p.x, y: p.y, text, kind: flagKind ?? inferred, ...opts });
    return this;
  }

  junction(at) {
    const p = this.pt(at);
    addJunction(this.doc, { x: p.x, y: p.y });
    return this;
  }

  text(text, at, opts = {}) {
    const p = this.pt(at);
    addText(this.doc, { x: p.x, y: p.y, text, ...opts });
    return this;
  }

  /** Offsets a pin by (dx, dy) without needing the pin index. */
  offset(ref, dx, dy) {
    const p = this.pt(ref);
    return { x: p.x + dx, y: p.y + dy };
  }

  build() {
    const text = JSON.stringify(this.doc);
    const parsed = parseDocument(JSON.parse(text));
    const netlist = extractNetlist(parsed);
    return { doc: this.doc, text, parsed, netlist, warnings: parsed.warnings };
  }
}

export async function writeDocument(file, docOrText) {
  const text = typeof docOrText === 'string' ? docOrText : JSON.stringify(docOrText);
  await fs.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${path.resolve(file)}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, path.resolve(file));
  return text;
}

/** Convert a fetched EasyEDA part document into a placeable part descriptor. */
export function partFromApi(result) {
  const doc = result.dataStr ?? result;
  const lcsc = result.lcsc?.number ?? result.szpNumber ?? '';
  return {
    doc: {
      shape: (doc.shape ?? []).map(String),
      package: doc.package ?? result.packageDetail?.title ?? '',
      lcsc,
      mfrPart: result.title ?? '',
    },
    title: result.title ?? '',
    lcsc,
    tags: result.tags ?? [],
  };
}
