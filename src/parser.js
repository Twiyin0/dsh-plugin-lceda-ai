// Parser for 嘉立创EDA (LCEDA standard edition) schematic documents (.esch JSON).
// Produces a typed model consumed by the renderer / netlist / report modules.
import {
  ELECTRICAL_TYPES, DEFAULT_FONT, DEFAULT_FONT_SIZE, parseSize, num, splitPoints, parseAttrs,
  isNetFlagKind,
} from './format.js';

function fields(s) { return String(s).split('~'); }

function style(f, i = 1) {
  // common trailing style: color~width~dash~[fill]~id~locked
  const color = f[i] ?? '';
  const width = num(f[i + 1], 1);
  const dash = f[i + 2] ?? '';
  const id = f[i + 4] ?? f[i + 3] ?? '';
  return { color, width, dash, id };
}

function parseTextRecord(f, ctx) {
  // Embedded component text:  T~kind~x~y~rot~color~font~size~bold~italic~vis~placeholder~text~?~anchor~id~locked~
  // Top-level annotation:     T~?~x~y~rot~color~font~size~bold~italic~vis~text~id~...
  const embedded = f.length >= 15 && /^[NPLTMCBDA]$/.test(f[1] || '');
  if (embedded) {
    return {
      type: 'text', kind: f[1], x: num(f[2]), y: num(f[3]), rot: num(f[4]),
      color: f[5] || '#000080', font: f[6] || DEFAULT_FONT, size: parseSize(f[7]),
      bold: !!f[8], italic: !!f[9], text: f[12] ?? '', anchor: f[14] || 'start',
      id: f[15] ?? '', _raw: f.join('~'),
    };
  }
  // annotation fallback (classic EasyEDA layout)
  return {
    type: 'text', kind: 'annotation', x: num(f[2]), y: num(f[3]), rot: num(f[4]),
    color: f[5] || '#000080', font: f[6] || DEFAULT_FONT, size: parseSize(f[7]),
    bold: !!f[8], italic: !!f[9], text: f[11] ?? '', anchor: f[13] || 'start',
    id: f[12] ?? '', _raw: f.join('~'),
  };
}

function parsePin(block, libOrigin) {
  // P~show~elec~number~"x y"~orient~id~locked ^^ point ^^ path~color ^^ nameBlock ^^ numBlock ^^ dot ^^ clock
  const [head, ...segs] = block.split('^^');
  const show = true;
  let elec = 0, number = '', point = [0, 0], orient = 0, id = '', locked = '0';
  const hf = head.split('~');
  if (hf.length >= 8) {
    // P ~ show ~ elec ~ number ~ x ~ y ~ orient ~ id ~ locked
    point = [num(hf[4]), num(hf[5])];
    elec = num(hf[2]); number = hf[3] ?? '';
    orient = num(hf[6]); id = hf[7] ?? ''; locked = hf[8] ?? '0';
  }
  const seg = (i) => (segs[i] ?? '').split('~');
  const pathSeg = seg(1); // "M x y h w" ~ color
  // text block layout: vis~x~y~rot~text~anchor~tx~ty~color
  const readBlock = (raw) => {
    const t = String(raw ?? '').split('~');
    return {
      visible: t[0] === '1' || t[0] === 'show',
      x: num(t[1]), y: num(t[2]), rot: num(t[3]),
      text: t[4] ?? '', anchor: t[5] || 'start',
      color: String(t[8] ?? '').startsWith('#') ? t[8] : (t[9] ?? ''),
      font: DEFAULT_FONT, size: DEFAULT_FONT_SIZE,
    };
  };
  const nameB = readBlock(segs[2]);
  const numB = readBlock(segs[3]);
  const dotSeg = (segs[4] ?? '').split('~');
  const clockSeg = (segs[5] ?? '').split('~');
  return {
    type: 'pin',
    show,
    elec,
    elecName: ELECTRICAL_TYPES[elec] ?? `elec${elec}`,
    number: String(number),
    name: nameB.text || String(number),
    x: point[0], y: point[1],
    orient,
    id, locked,
    path: pathSeg[0] ?? '', color: pathSeg[1] || '#800',
    nameText: nameB, numText: numB,
    dot: dotSeg[0] === '1', clock: (clockSeg[0] ?? '') === '1',
    libOrigin,
  };
}

function parseNetFlag(s) {
  const [head, ...segs] = s.split('^^');
  const f = fields(head);
  const kind = f[1];
  const anchor = splitPoints(segs[0] ?? '')[0] ?? [num(f[2]), num(f[3])];
  // text block: text~color~tx~ty~rot~anchor~vis~font~size~id
  const t = (segs[1] ?? '').split('~');
  const graphics = [];
  for (let i = 2; i < segs.length; i++) {
    const g = parseShape(segs[i], true);
    if (g) graphics.push(g);
  }
  return {
    type: 'netflag', kind, isNetFlag: true,
    x: num(f[2]), y: num(f[3]), rot: num(f[4]), id: f[5] ?? '',
    anchor,
    text: t[0] ?? '', color: t[1] || '#000000',
    tx: num(t[2], anchor[0]), ty: num(t[3], anchor[1]),
    textRot: num(t[4]), textAnchor: t[5] || 'start',
    font: t[7] || 'Times New Roman', size: parseSize(t[8]),
    graphics,
  };
}

export function parseShape(s, embedded = false) {
  const kind = String(s).split('~', 1)[0];
  switch (kind) {
    case 'W': { // wire: points~color~width~dash~id~locked
      const f = fields(s);
      return { type: 'wire', points: splitPoints(f[1]), ...style(f, 2), _raw: s };
    }
    case 'N': { // net label: x~y~rot~color~text~id~anchor~tx~ty~font~size~?
      const f = fields(s);
      return {
        type: 'netlabel', x: num(f[1]), y: num(f[2]), rot: num(f[3]),
        color: f[4] || '#0000ff', text: f[5] ?? '', id: f[6] ?? '',
        anchor: f[7] || 'start', tx: num(f[8], num(f[1])), ty: num(f[9], num(f[2])),
        font: f[10] || 'Times New Roman', size: parseSize(f[11]), _raw: s,
      };
    }
    case 'J': { // junction: x~y~r~color~id~locked
      const f = fields(s);
      return { type: 'junction', x: num(f[1]), y: num(f[2]), r: num(f[3], 2.5), color: f[4] || '#CC0000', id: f[5] ?? '', _raw: s };
    }
    case 'F': return parseNetFlag(s);
    case 'T': return parseTextRecord(fields(s));
    case 'PT': case 'A': { // path (svg d)~color~width~dash~(fill)~id~locked
      const f = fields(s);
      return { type: 'path', d: f[1] ?? '', ...style(f, 2), fill: looksColor(f[5]) ? f[5] : '', _raw: s };
    }
    case 'PL': { // polyline: points~color~width~dash~id~locked
      const f = fields(s);
      return { type: 'polyline', points: splitPoints(f[1]), ...style(f, 2), _raw: s };
    }
    case 'PG': { // polygon: points~color~width~dash~fill~id~locked
      const f = fields(s);
      return { type: 'polygon', points: splitPoints(f[1]), color: f[2] || '', width: num(f[3], 1), dash: f[4] ?? '', fill: f[5] && looksColor(f[5]) ? f[5] : '', id: f[6] ?? '', _raw: s };
    }
    case 'R': { // rect: x~y~rx~ry~w~h~color~width~dash~(fill)~id~locked
      const f = fields(s);
      return {
        type: 'rect', x: num(f[1]), y: num(f[2]), rx: num(f[3]), ry: num(f[4]),
        w: num(f[5]), h: num(f[6]), color: f[7] || '', width: num(f[8], 1), dash: f[9] ?? '',
        fill: looksColor(f[10]) ? f[10] : '', id: f[11] ?? f[12] ?? '', _raw: s,
      };
    }
    case 'E': { // ellipse: cx~cy~rx~ry~color~width~dash~fill~id~locked
      const f = fields(s);
      return { type: 'ellipse', x: num(f[1]), y: num(f[2]), rx: num(f[3]), ry: num(f[4]), color: f[5] || '', width: num(f[6], 1), dash: f[7] ?? '', fill: looksColor(f[8]) ? f[8] : '', id: f[9] ?? '', _raw: s };
    }
    case 'Pimage': { // ...~x~y~w~h~dataURI
      const f = fields(s);
      const di = f.findIndex((v) => v.startsWith('data:'));
      const data = di >= 0 ? f[di] : '';
      const nums = f.slice(0, di >= 0 ? di : f.length).filter((v) => /^-?[0-9.]+$/.test(v)).map(Number);
      // last four numbers before the data URI are x, y, w, h
      const [x = 0, y = 0, w = 0, h = 0] = nums.slice(-4);
      return { type: 'image', x, y, w, h, data, _raw: s.slice(0, 60) + '…' };
    }
    case 'P': return parsePin(s, null);
    default: return { type: 'unknown', kind, _raw: String(s).slice(0, 120) };
  }
}

function looksColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

// Parse a LIB (component instance). Embedded shapes are pre-transformed to sheet
// coordinates by the editor (rotation is baked in), so no transform is applied.
function parseLib(s) {
  const parts = s.split('#@$');
  const f = fields(parts[0]);
  const lib = {
    type: 'component',
    x: num(f[1]), y: num(f[2]),
    attrs: parseAttrs(f[3] ?? ''),
    rot: num(f[4]),
    id: f[6] ?? '',
    libUuid: f[7] ?? '',
    schUuid: f[8] ?? '',
    shapes: [], pins: [], texts: [],
    isFrame: false,
  };
  for (let i = 1; i < parts.length; i++) {
    const raw = parts[i];
    const k = raw.split('~', 1)[0];
    if (k === 'P') { lib.pins.push(parsePin(raw, [lib.x, lib.y])); continue; }
    const sh = parseShape(raw, true);
    if (!sh) continue;
    lib.shapes.push(sh);
    if (sh.type === 'text') lib.texts.push(sh);
    if (sh.type === 'image') lib.images = lib.images ?? [], lib.images.push(sh);
  }
  // semantic extraction
  lib.isFrame = lib.id.startsWith('frame_lib') || (lib.attrs.package ?? '').toUpperCase() === 'NONE' && lib.pins.length === 0;
  lib.designator = (lib.texts.find((t) => t.kind === 'P') ?? {}).text ?? '';
  lib.value = (lib.texts.find((t) => t.kind === 'N') ?? {}).text ?? '';
  lib.name = lib.attrs['spiceSymbolName'] ?? lib.attrs['Manufacturer Part'] ?? lib.value;
  lib.package = lib.attrs['package'] ?? '';
  lib.mfrPart = lib.attrs['Manufacturer Part'] ?? '';
  lib.lcscPart = lib.attrs['Supplier Part'] ?? '';
  lib.supplier = lib.attrs['Supplier'] ?? '';
  lib.manufacturer = lib.attrs['Manufacturer'] ?? '';
  return lib;
}

export function parseDocument(json) {
  const doc = typeof json === 'string' ? JSON.parse(json) : json;
  if (!doc || doc.head?.docType !== '1') {
    // docType 1 = schematic (标准版). 2 = symbol, 3 = pcb ...
  }
  const top = [];
  const components = [];
  const warnings = [];
  for (const s of doc.shape ?? []) {
    const kind = String(s).split('~', 1)[0];
    if (kind === 'LIB') { const lib = parseLib(s); components.push(lib); top.push(lib); continue; }
    const sh = parseShape(s, false);
    if (!sh) continue;
    if (sh.type === 'unknown') warnings.push(`unknown top-level shape kind "${sh.kind}": ${sh._raw}`);
    top.push(sh);
  }
  const bb = doc.BBox ?? {};
  const canvas = String(doc.canvas ?? '').split('~');
  return {
    head: doc.head ?? {},
    docType: doc.head?.docType,
    editorVersion: doc.head?.editorVersion ?? '',
    canvas: { bg: canvas[3] ?? '#FFFFFF', gridColor: canvas[5] ?? '#CCCCCC', gridSize: num(canvas[6], 5) },
    bbox: { x: num(bb.x), y: num(bb.y), w: num(bb.width, 1000), h: num(bb.height, 800) },
    shapes: top,
    components,
    warnings,
    uuid: doc.head?.uuid ?? '',
  };
}
