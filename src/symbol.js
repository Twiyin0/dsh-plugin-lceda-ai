// Symbol generator: builds LCEDA `LIB` component records from a compact pin spec,
// plus the built-in symbol catalog used when drawing schematics from scratch.
//
// Everything here is in sheet coordinates (y grows downward). A symbol is authored
// around its own centre (0,0) and then translated to the placement point.
import { fmt, rotatePath, rotatePoints, parsePath, toAbsolute } from './path.js';

let counter = 0;
const genId = () => {
  counter = (counter + 1) % 0xffff;
  return `gge${Date.now().toString(16).slice(-6)}${counter.toString(16).padStart(4, '0')}${Math.floor(Math.random() * 0xff).toString(16)}`;
};
export const genUuid = () => {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s;
};

const BODY_COLOR = '#880000';
const PIN_COLOR = '#880000';
const PIN_NUM_COLOR = '#0000FF';
const NAME_COLOR = '#000080';

/**
 * Build symbol shapes around the origin.
 * @param {object} spec { width, height, pins:[{number,name,side,elec}], pinLen, font }
 */
export function buildSymbolShapes(spec) {
  const width = spec.width ?? 100;
  const height = spec.height ?? 100;
  const pinLen = spec.pinLen ?? 20;
  const font = spec.font ?? 9;
  const x1 = -width / 2, y1 = -height / 2, x2 = width / 2, y2 = height / 2;
  // where the pin line stops (defaults to the body edge); passives override it so
  // the pin visibly touches the plate/triangle instead of leaving a gap
  const insetX = spec.pinInset ?? width / 2;
  const insetY = spec.pinInset ?? height / 2;
  const shapes = [];

  // body
  if (spec.body !== false) {
    shapes.push(['R', fmt(x1), fmt(y1), '', '', fmt(width), fmt(height), spec.bodyColor ?? BODY_COLOR, String(spec.bodyWidth ?? 2), '0', 'none', genId(), '0'].join('~'));
  }

  // group pins by side, distribute evenly
  const sides = { L: [], R: [], T: [], B: [] };
  for (const p of spec.pins ?? []) sides[p.side ?? 'L'].push(p);

  const placeColumn = (list, side) => {
    const n = list.length;
    if (!n) return;
    const pitch = Math.min(10, (height - 20) / Math.max(n, 1));
    const total = (n - 1) * pitch;
    const startY = -total / 2;
    list.forEach((p, i) => {
      const y = startY + i * pitch;
      const left = side === 'L';
      const cx = left ? -(insetX + pinLen) : insetX + pinLen;
      const cy = y;
      const orient = left ? 180 : 0;
      const path = left
        ? `M ${fmt(cx)} ${fmt(cy)} h ${pinLen}`
        : `M ${fmt(cx)} ${fmt(cy)} h ${-pinLen}`;
      shapes.push(pinRecord({ p, cx, cy, orient, path, font, side, hideText: spec.showPinText === false, pinLen }));
    });
  };
  const placeRow = (list, side) => {
    const n = list.length;
    if (!n) return;
    const pitch = Math.min(10, (width - 20) / Math.max(n, 1));
    const total = (n - 1) * pitch;
    const startX = -total / 2;
    list.forEach((p, i) => {
      const x = startX + i * pitch;
      const top = side === 'T';
      const cx = x;
      const cy = top ? -(insetY + pinLen) : insetY + pinLen;
      const orient = top ? 270 : 90;
      const path = top
        ? `M ${fmt(cx)} ${fmt(cy)} v ${pinLen}`
        : `M ${fmt(cx)} ${fmt(cy)} v ${-pinLen}`;
      shapes.push(pinRecord({ p, cx, cy, orient, path, font, side, vertical: true, up: top, hideText: spec.showPinText === false, pinLen }));
    });
  };
  placeColumn(sides.L, 'L');
  placeColumn(sides.R, 'R');
  placeRow(sides.T, 'T');
  placeRow(sides.B, 'B');

  // value above the body, designator below it (patched at placement)
  shapes.push(['T', 'N', fmt(x1 + 2), fmt(y1 - 5), '0', NAME_COLOR, 'Arial', fmt(font), '', '', '', 'comment', 'U?', '1', 'start', genId(), '0', ''].join('~'));
  shapes.push(['T', 'P', fmt(x1 + 2), fmt(y2 + 13), '0', NAME_COLOR, 'Arial', fmt(font), '', '', '', 'comment', 'U?', '1', 'start', genId(), '0', ''].join('~'));
  return shapes;
}

function pinRecord({ p, cx, cy, orient, path, font, side, vertical = false, up = false, hideText = false, pinLen = 20 }) {
  const show = p.hidden ? 'none' : 'show';
  const elec = p.elec ?? 0;
  const number = String(p.number);
  const name = String(p.name ?? p.number);
  let nameB, numB;
  if (!vertical) {
    // names inside the body, numbers outside above the pin line
    const nameX = side === 'L' ? cx + pinLen + 4 : cx - pinLen - 4;
    const nameAnchor = side === 'L' ? 'start' : 'end';
    const numX = side === 'L' ? cx - 6 : cx + 6;
    const numAnchor = side === 'L' ? 'end' : 'start';
    nameB = `1~${fmt(nameX)}~${fmt(cy + 3)}~0~${name}~${nameAnchor}~~~${NAME_COLOR}`;
    numB = `1~${fmt(numX)}~${fmt(cy - 3)}~0~${number}~${numAnchor}~~~${PIN_NUM_COLOR}`;
  } else {
    // vertical pin: names run along the pin, numbers offset to the side
    const nameY = up ? cy + pinLen + 10 : cy - pinLen - 10;
    const numY = up ? cy + pinLen + 2 : cy - pinLen - 2;
    nameB = `1~${fmt(cx + 3)}~${fmt(nameY)}~270~${name}~start~~~${NAME_COLOR}`;
    numB = `1~${fmt(cx - 4)}~${fmt(numY)}~0~${number}~end~~~${PIN_NUM_COLOR}`;
  }
  const nameVisible = hideText || p.showName === false ? '0' : '1';
  const numVisible = hideText || p.showNumber === false ? '0' : '1';
  nameB = nameB.replace(/^1~/, `${nameVisible}~`);
  numB = numB.replace(/^1~/, `${numVisible}~`);
  const blocks = [
    `P~${show}~${elec}~${number}~${fmt(cx)}~${fmt(cy)}~${orient}~${genId()}~0`,
    `${fmt(cx)} ${fmt(cy)}`,
    `${path}~${PIN_COLOR}`,
    nameB,
    numB,
    '0', '0',
  ];
  return blocks.join('^^');
}

/** Translate every coordinate of a symbol shape (they are already sheet-absolute). */
export function translateShapes(shapes, dx, dy) {
  return shapes.map((raw) => translateRecord(raw, dx, dy));
}

// Minimal record translator (kept local so symbol generation has no edit.js dependency).
export function translateRecord(raw, dx, dy) {
  if (raw.startsWith('P~')) return translatePin(raw, dx, dy);
  const a = String(raw).split('~');
  switch (a[0]) {
    case 'T': a[2] = fmt(+a[2] + dx); a[3] = fmt(+a[3] + dy); break;
    case 'R': case 'E': a[1] = fmt(+a[1] + dx); a[2] = fmt(+a[2] + dy); break;
    case 'PL': case 'PG': a[1] = shiftPoints(a[1], dx, dy); break;
    case 'PT': case 'A': a[1] = shiftPath(a[1], dx, dy); break;
    default: break;
  }
  return a.join('~');
}

function shiftPoints(str, dx, dy) {
  const n = String(str).trim().split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push(fmt(n[i] + dx), fmt(n[i + 1] + dy));
  return out.join(' ');
}

function shiftPath(d, dx, dy) {
  const toks = [];
  const re = /([a-zA-Z])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(String(d)))) toks.push(m[1] ? m[1] : Number(m[2]));
  const out = [];
  let cmd = '';
  let abs = true;
  let idx = 0;
  const need = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  for (const t of toks) {
    if (typeof t === 'string') { cmd = t; abs = t === t.toUpperCase(); out.push(t); idx = 0; continue; }
    const up = cmd.toUpperCase();
    if (!abs) { out.push(fmt(t)); idx++; continue; }
    if (up === 'M' || up === 'L' || up === 'T') out.push(fmt(t + (idx % 2 === 0 ? dx : dy)));
    else if (up === 'H') out.push(fmt(t + dx));
    else if (up === 'V') out.push(fmt(t + dy));
    else if (up === 'C' || up === 'S' || up === 'Q') out.push(fmt(t + ([0, 2, 4].includes(idx % 6) ? dx : dy)));
    else if (up === 'A') out.push(fmt(idx === 5 ? t + dx : idx === 6 ? t + dy : t));
    else out.push(fmt(t));
    idx++;
    if (idx >= (need[up] ?? 0)) idx = 0;
  }
  return out.join(' ');
}

function translatePin(raw, dx, dy) {
  const segs = raw.split('^^');
  const h = segs[0].split('~');
  h[4] = fmt(+h[4] + dx); h[5] = fmt(+h[5] + dy);
  segs[0] = h.join('~');
  if (segs[1]) {
    const p = segs[1].trim().split(/\s+/).map(Number);
    segs[1] = `${fmt(p[0] + dx)} ${fmt(p[1] + dy)}`;
  }
  if (segs[2]) {
    const [d, c] = segs[2].split('~');
    segs[2] = `${shiftPath(d, dx, dy)}~${c ?? ''}`;
  }
  for (const i of [3, 4]) {
    if (!segs[i]) continue;
    const b = segs[i].split('~');
    b[1] = fmt(+b[1] + dx); b[2] = fmt(+b[2] + dy);
    segs[i] = b.join('~');
  }
  if (segs[5]) {
    const b = segs[5].split('~');
    if (b[1]) {
      const p = b[1].trim().split(/\s+/).map(Number);
      b[1] = `${fmt(p[0] + dx)} ${fmt(p[1] + dy)}`;
    }
    segs[5] = b.join('~');
  }
  if (segs[6]) {
    const b = segs[6].split('~');
    if (b[1]) b[1] = shiftPath(b[1], dx, dy);
    segs[6] = b.join('~');
  }
  return segs.join('^^');
}

/** Geometrical centre of a set of symbol shapes, used as the placement anchor. */
export function artExtent(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const raw of shapes) {
    if (raw.startsWith('T~')) continue;           // labels must not feed back into their own placement
    if (raw.startsWith('P~')) {
      const h = raw.split('^^')[0].split('~');
      add(+h[4], +h[5]);
      const b = raw.split('^^')[1];
      if (b) { const p = b.trim().split(/\s+/).map(Number); add(p[0], p[1]); }
    } else if (raw.startsWith('R~')) {
      const a = raw.split('~');
      add(+a[1], +a[2]); add(+a[1] + +a[5], +a[2] + +a[6]);
    } else if (raw.startsWith('E~')) {
      const a = raw.split('~');
      add(+a[1] - +a[3], +a[2] - +a[4]); add(+a[1] + +a[3], +a[2] + +a[4]);
    } else if (raw.startsWith('PL~') || raw.startsWith('PG~')) {
      const n = raw.split('~')[1].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < n.length; i += 2) add(n[i], n[i + 1]);
    } else if (raw.startsWith('PT~')) {
      const d = raw.split('~')[1] ?? '';
      for (const c of toAbsolute(parsePath(d))) {
        if (c.cmd === 'M' || c.cmd === 'L' || c.cmd === 'T') {
          for (let i = 0; i + 1 < c.params.length; i += 2) add(c.params[i], c.params[i + 1]);
        } else if (c.cmd === 'A') add(c.params[5], c.params[6]);
        else if (c.cmd === 'C') { add(c.params[0], c.params[1]); add(c.params[4], c.params[5]); }
        else if (c.cmd === 'S' || c.cmd === 'Q') { add(c.params[0], c.params[1]); add(c.params[2], c.params[3]); }
      }
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, minY, maxX, maxY };
}

export function shapesCenter(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const raw of shapes) {
    if (raw.startsWith('P~')) {
      const h = raw.split('^^')[0].split('~');
      add(+h[4], +h[5]);
      const b = raw.split('^^')[1];
      if (b) { const p = b.trim().split(/\s+/).map(Number); add(p[0], p[1]); }
    } else if (raw.startsWith('T~')) {
      const a = raw.split('~'); add(+a[2], +a[3]);
    } else if (raw.startsWith('R~') || raw.startsWith('E~')) {
      const a = raw.split('~');
      add(+a[1], +a[2]);
      if (a[0] === 'R') add(+a[1] + +a[5], +a[2] + +a[6]);
      else { add(+a[1] - +a[3], +a[2] - +a[4]); add(+a[1] + +a[3], +a[2] + +a[4]); }
    } else if (raw.startsWith('PL~') || raw.startsWith('PG~')) {
      const n = raw.split('~')[1].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < n.length; i += 2) add(n[i], n[i + 1]);
    }
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, minY, maxX, maxY };
}

/**
 * Wrap symbol shapes into a component instance (`LIB` record) placed at (x, y).
 */
export function pinCenter(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;
  for (const raw of shapes) {
    if (!raw.startsWith('P~')) continue;
    const h = raw.split('^^')[0].split('~');
    const px = Number(h[4]), py = Number(h[5]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    n++;
  }
  if (!n) return shapesCenter(shapes);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, minX, minY, maxX, maxY };
}

export function makeComponent({ shapes, x, y, ref, value, attrs = {}, rot = 0, showName = true, showNumber = true, labelLayout, labelSide }) {
  const c = pinCenter(shapes);
  const dx = x - c.x, dy = y - c.y;
  let moved = translateShapes(shapes, dx, dy);

  // Fetched LCSC symbols carry no value/designator texts: synthesise them.
  const hasValue = moved.some((r) => r.startsWith('T~N~'));
  const hasRef = moved.some((r) => r.startsWith('T~P~'));
  if (!hasValue || !hasRef) {
    const b = pinCenter(moved);
    const id = () => genId();
    const extra = [];
    if (!hasValue) extra.push(['T', 'N', fmt(b.minX), fmt(b.minY - 6), '0', NAME_COLOR, 'Arial', '9', '', '', '', 'comment', String(value ?? ''), '1', 'start', id(), '0', ''].join('~'));
    if (!hasRef) extra.push(['T', 'P', fmt(b.minX), fmt(b.maxY + 14), '0', NAME_COLOR, 'Arial', '9', '', '', '', 'comment', String(ref ?? ''), '1', 'start', id(), '0', ''].join('~'));
    moved = [...moved, ...extra];
  }

  if (rot) moved = moved.map((raw) => rotateShapeRecord(raw, x, y, rot));

  // Upright, non-overlapping value/designator placement: tall symbols get their
  // labels beside them (left = designator, right = value), wide ones above/below.
  {
    const b = artExtent(moved);
    const tall = labelLayout === 'above'
      ? false
      : (b.maxY - b.minY) > (b.maxX - b.minX) && (b.maxX - b.minX) < 60;
    const midY = (b.minY + b.maxY) / 2;
    moved = moved.map((raw) => {
      const mirror = labelSide === 'mirror';
      if (raw.startsWith('T~N~')) {
        const a = raw.split('~');
        if (tall && mirror) { a[2] = fmt(b.minX - 14); a[3] = fmt(midY + 3); a[14] = 'end'; }
        else if (tall) { a[2] = fmt(b.maxX + 14); a[3] = fmt(midY + 3); a[14] = 'start'; }
        else { a[2] = fmt(b.minX); a[3] = fmt(b.maxY + 13); a[14] = 'start'; }
        a[4] = '0';
        return a.join('~');
      }
      if (raw.startsWith('T~P~')) {
        const a = raw.split('~');
        if (tall && mirror) { a[2] = fmt(b.maxX + 14); a[3] = fmt(midY - 4); a[14] = 'start'; }
        else if (tall) { a[2] = fmt(b.minX - 14); a[3] = fmt(midY - 4); a[14] = 'end'; }
        else { a[2] = fmt(b.minX); a[3] = fmt(b.minY - 6); a[14] = 'start'; }
        a[4] = '0';
        return a.join('~');
      }
      return raw;
    });
  }

  // patch designator (T~P) and value (T~N)
  moved = moved.map((raw) => {
    if (raw.startsWith('T~N~')) {
      const a = raw.split('~');
      a[12] = String(value ?? '');
      return a.join('~');
    }
    if (raw.startsWith('T~P~')) {
      const a = raw.split('~');
      a[12] = String(ref ?? '');
      return a.join('~');
    }
    return raw;
  });

  const attrStr = Object.entries({
    package: attrs.package ?? 'NONE',
    'Supplier Part': attrs.lcsc ?? '',
    Manufacturer: attrs.manufacturer ?? '',
    'Manufacturer Part': attrs.mfrPart ?? '',
    Contributor: 'lceda-ai',
    spicePre: (String(ref ?? 'U').match(/^[A-Za-z]+/) ?? ['U'])[0],
    ...attrs,
  })
    .map(([k, v]) => `${k}\`${v}`)
    .join('`') + '`';

  const head = ['LIB', fmt(x), fmt(y), attrStr, String(rot), '0', genId(), genUuid(), genUuid(), '0', '',
    showName ? 'yes' : 'no', showNumber ? 'yes' : 'no', '', String(Math.floor(Date.now() / 1000)), ''].join('~');
  return `${head}#@$${moved.join('#@$')}`;
}

/** Net flag (power/ground symbol) as an `F` record, oriented by `rot` (0=up,90=right,180=down,270=left). */
export function makeNetFlag({ x, y, text, kind = 'part_netLabel_gnD', rot = 0 }) {
  const r = ((rot % 360) + 360) % 360;
  const dirs = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
  const [dx, dy] = dirs[r] ?? dirs[0];
  const px = -dy, py = dx; // perpendicular
  const isGnd = /gnD/i.test(kind);
  const pts = [];
  const seg = (a, b) => pts.push([a, b]);

  const at = (d, s2 = 0) => [x + dx * d + px * s2, y + dy * d + py * s2];
  // stem
  seg(at(0), at(10));
  if (isGnd) {
    // three shrinking bars, like the editor's own ground symbol
    for (const [d, half] of [[10, 9], [12, 6], [14, 3]]) seg(at(d, -half), at(d, half));
  } else {
    seg(at(10, -5), at(10, 5));
  }

  const gfx = pts.map(([a, b]) =>
    `PL~${fmt(a[0])} ${fmt(a[1])} ${fmt(b[0])} ${fmt(b[1])}~#000000~1~0~${a[0] === b[0] && a[1] === b[1] ? 'none' : 'transparent'}~${genId()}~0`);

  // label offset per orientation (kept clear of the bars and of the pins)
  let tx = x, ty = y - 14, anchor = 'middle';
  if (r === 0) { tx = x; ty = y - 16; anchor = 'middle'; }
  else if (r === 90) { tx = x + 18; ty = y + 4; anchor = 'start'; }
  else if (r === 180) { tx = x; ty = y + 30; anchor = 'middle'; }
  else if (r === 270) { tx = x - 18; ty = y + 4; anchor = 'end'; }

  const id = genId();
  const head = ['F', kind, fmt(x), fmt(y), String(rot), id, '', '0'].join('~');
  const anchorBlock = `${fmt(x)}~${fmt(y)}`;
  const textBlock = [String(text), '#000000', fmt(tx), fmt(ty), '0', anchor, '1', 'Times New Roman', '9pt', `flag_${id}`].join('~');
  return [head, anchorBlock, textBlock, ...gfx].join('^^');
}

// ---------------------------------------------------------------- catalog

const P = (number, name, side, elec = 0) => ({ number, name, side, elec });

const STC_PINS = [
  P(1, 'P1.0', 'L', 3), P(2, 'P1.1', 'L', 3), P(3, 'P1.2', 'L', 3), P(4, 'P1.3', 'L', 3),
  P(5, 'P1.4', 'L', 3), P(6, 'P1.5', 'L', 3), P(7, 'P1.6', 'L', 3), P(8, 'P1.7', 'L', 3),
  P(9, 'RST', 'L', 1), P(10, 'P3.0/RXD', 'L', 3), P(11, 'P3.1/TXD', 'L', 3), P(12, 'P3.2/INT0', 'L', 3),
  P(13, 'P3.3/INT1', 'L', 3), P(14, 'P3.4/T0', 'L', 3), P(15, 'P3.5/T1', 'L', 3), P(16, 'P3.6/WR', 'L', 3),
  P(17, 'P3.7/RD', 'L', 3), P(18, 'XTAL2', 'L', 3), P(19, 'XTAL1', 'L', 3), P(20, 'GND', 'L', 4),
  P(21, 'P2.0', 'R', 3), P(22, 'P2.1', 'R', 3), P(23, 'P2.2', 'R', 3), P(24, 'P2.3', 'R', 3),
  P(25, 'P2.4', 'R', 3), P(26, 'P2.5', 'R', 3), P(27, 'P2.6', 'R', 3), P(28, 'P2.7', 'R', 3),
  P(29, 'PSEN', 'R', 2), P(30, 'ALE', 'R', 2), P(31, 'EA/VPP', 'R', 1), P(32, 'P0.7', 'R', 3),
  P(33, 'P0.6', 'R', 3), P(34, 'P0.5', 'R', 3), P(35, 'P0.4', 'R', 3), P(36, 'P0.3', 'R', 3),
  P(37, 'P0.2', 'R', 3), P(38, 'P0.1', 'R', 3), P(39, 'P0.0', 'R', 3), P(40, 'VCC', 'R', 4),
];

/** A 1xN pin header symbol: pins on the left, 10-unit pitch, room to breathe. */
export function headerSpec(n = 5) {
  const count = Math.max(2, Math.min(20, Math.round(n)));
  const pins = [];
  for (let i = 1; i <= count; i++) pins.push(P(i, String(i), 'L'));
  return {
    width: 24,
    height: count * 10 + 20,
    pinLen: 20,
    showPinText: false,   // a 1xN header reads better with net labels than pin numbers
    pins,
  };
}

export const BUILTIN_SYMBOLS = {
  stc89c52rc: {
    title: 'STC89C52RC (8051, DIP-40)',
    prefix: 'U',
    keywords: ['stc89c52rc', 'stc89c52', 'stc89', '8051', 'mcu', '51', 'dip40'],
    package: 'DIP-40',
    spec: { width: 140, height: 240, pins: STC_PINS },
    defaultValue: 'STC89C52RC',
  },
  resistor: {
    title: 'Resistor',
    prefix: 'R',
    keywords: ['r', 'resistor', 'res', '电阻'],
    package: 'R0603',
    spec: { width: 24, height: 10, pinLen: 20, bodyColor: '#A00000', bodyWidth: 1, showPinText: false, pins: [P(1, '1', 'L'), P(2, '2', 'R')] },
    defaultValue: '10k',
  },
  capacitor: {
    title: 'Capacitor (non-polarized)',
    prefix: 'C',
    keywords: ['c', 'cap', 'capacitor', '电容'],
    package: 'C0603',
    spec: { width: 5, height: 24, pinLen: 25.5, pinInset: 2.5, body: false, showPinText: false, pins: [P(1, '1', 'L'), P(2, '2', 'R')] },
    defaultValue: '100n',
    graphics: 'cap',
  },
  capacitor_pol: {
    title: 'Capacitor (polarized / electrolytic)',
    prefix: 'C',
    keywords: ['cp', 'cap pol', 'electrolytic', '电解', '钽电容'],
    package: 'CASE-A_3216',
    spec: { width: 9, height: 24, pinLen: 25.5, pinInset: 2.5, body: false, showPinText: false, pins: [P(1, '1', 'L'), P(2, '2', 'R')] },
    defaultValue: '10u',
    graphics: 'cap_pol',
  },
  crystal: {
    title: 'Crystal (2 pin)',
    prefix: 'Y',
    keywords: ['y', 'xtal', 'crystal', '晶振'],
    package: 'HC-49S',
    spec: { width: 14, height: 24, pinLen: 21, pinInset: 7, body: false, showPinText: false, pins: [P(1, '1', 'L'), P(2, '2', 'R')] },
    defaultValue: '11.0592MHz',
    graphics: 'crystal',
  },
  switch: {
    title: 'Push button (2 pin)',
    prefix: 'SW',
    keywords: ['sw', 'button', 'push', '按键', '开关'],
    package: 'SW-SMD_2P',
    spec: { width: 16, height: 20, pinLen: 20, body: false, showPinText: false, pins: [P(1, '1', 'L'), P(2, '2', 'R')] },
    defaultValue: 'RESET',
    graphics: 'switch',
  },
  led: {
    title: 'LED',
    prefix: 'D',
    keywords: ['led', '发光二极管'],
    package: 'LED0603',
    spec: { width: 16, height: 20, pinLen: 20, body: false, showPinText: false, pins: [P(1, 'A', 'L'), P(2, 'K', 'R')] },
    defaultValue: 'RED',
    graphics: 'led',
  },
  header: {
    title: 'Pin header (1xN)',
    prefix: 'J',
    keywords: ['header', 'hdr', 'pin header', '排针'],
    package: 'HDR-M-2.54_1XN',
    // height/pins are derived from the requested pin count at placement time
    spec: headerSpec(5),
    defaultValue: 'HDR',
  },
};

/** Complete artwork for the passive catalogue entries (body rect disabled for these). */
export function passiveGraphics(kind, spec) {
  const h = spec.height ?? 16;
  const c = '#A00000';
  const y1 = -h / 2, y2 = h / 2;
  const out = [];
  const pl = (pts, color = c, width = 2) =>
    out.push(['PL', pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' '), color, String(width), '0', 'none', genId(), '0'].join('~'));

  if (kind === 'cap') {
    pl([[-2.5, y1], [-2.5, y2]], c, 2);
    pl([[2.5, y1], [2.5, y2]], c, 2);
  } else if (kind === 'cap_pol') {
    pl([[-2.5, y1], [-2.5, y2]], c, 2);
    out.push(['PT', `M 4 ${fmt(y1)} A ${fmt(h * 0.7)} ${fmt(h * 0.7)} 0 0 0 4 ${fmt(y2)}`, c, '2', '0', 'none', genId(), '0'].join('~'));
    out.push(['T', 'L', fmt(-9), fmt(y1 + 1), '0', c, 'Arial', '7', '', '', '', 'comment', '+', '1', 'start', genId(), '0', ''].join('~'));
  } else if (kind === 'crystal') {
    pl([[-7, y1 + 1], [-7, y2 - 1]], c, 2);
    pl([[7, y1 + 1], [7, y2 - 1]], c, 2);
    out.push(['R', fmt(-4), fmt(y1 + 2), '', '', '8', fmt(h - 4), c, '1', '0', 'none', genId(), '0'].join('~'));
  } else if (kind === 'switch') {
    pl([[-7, -8], [-7, 8]], c, 2);
    pl([[7, -8], [7, 8]], c, 2);
    pl([[-10, -10], [10, -10]], c, 2);
    pl([[0, -10], [0, -15]], c, 2);
  } else if (kind === 'led') {
    out.push(['PG', `${fmt(-6)} ${fmt(-7)} ${fmt(6)} ${fmt(-7)} ${fmt(0)} ${fmt(7)}`, c, '1', '0', c, genId(), '0'].join('~'));
    pl([[6, -8], [6, 8]], c, 2);
  }
  return out;
}

const fieldsOf = (raw) => String(raw).split('~');
const joinFields = (a) => a.join('~');

// --- local record rotation (self-contained: symbol.js must not depend on edit.js) ---
function rotateShapeRecord(raw, ox, oy, angle) {
  if (raw.startsWith('P~')) return rotatePin(raw, ox, oy, angle);
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rp = (x, y) => [ox + (x - ox) * cos - (y - oy) * sin, oy + (x - ox) * sin + (y - oy) * cos];
  const quarter = Math.round(angle / 90) % 2 !== 0;
  const a = fieldsOf(raw);
  switch (a[0]) {
    case 'T': {
      const [x, y] = rp(+a[2], +a[3]);
      a[2] = fmt(x); a[3] = fmt(y);
      a[4] = fmt((((Number(a[4]) || 0) + angle) % 360 + 360) % 360);
      break;
    }
    case 'R': {
      const x = +a[1], y = +a[2], w = +a[5], h = +a[6];
      const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => rp(px, py));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      const minx = Math.min(...xs), miny = Math.min(...ys);
      a[1] = fmt(minx); a[2] = fmt(miny);
      a[5] = fmt(Math.max(...xs) - minx); a[6] = fmt(Math.max(...ys) - miny);
      break;
    }
    case 'E': {
      const [x, y] = rp(+a[1], +a[2]);
      a[1] = fmt(x); a[2] = fmt(y);
      if (quarter) { const t = a[3]; a[3] = a[4]; a[4] = t; }
      break;
    }
    case 'PL': case 'PG': a[1] = rotatePoints(a[1], ox, oy, angle); break;
    case 'PT': case 'A': a[1] = rotatePath(a[1], ox, oy, angle); break;
    case 'Pimage': {
      const [x, y] = rp(+a[1], +a[2]);
      a[1] = fmt(x); a[2] = fmt(y);
      break;
    }
    default: break;
  }
  return joinFields(a);
}

function rotatePin(raw, ox, oy, angle) {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const rp = (x, y) => [ox + (x - ox) * cos - (y - oy) * sin, oy + (x - ox) * sin + (y - oy) * cos];
  const segs = raw.split('^^');
  const h = fieldsOf(segs[0]);
  if (h.length >= 7) {
    const [x, y] = rp(+h[4], +h[5]);
    h[4] = fmt(x); h[5] = fmt(y);
    h[6] = fmt((((Number(h[6]) || 0) + angle) % 360 + 360) % 360);
  }
  segs[0] = joinFields(h);
  if (segs[1]) {
    const p = segs[1].trim().split(/\s+/).map(Number);
    const [x, y] = rp(p[0], p[1]);
    segs[1] = `${fmt(x)} ${fmt(y)}`;
  }
  if (segs[2]) {
    const [d, c] = segs[2].split('~');
    segs[2] = `${rotatePath(d, ox, oy, angle)}~${c ?? ''}`;
  }
  for (const i of [3, 4]) {
    if (!segs[i]) continue;
    const b = fieldsOf(segs[i]);
    const [x, y] = rp(+b[1], +b[2]);
    b[1] = fmt(x); b[2] = fmt(y);
    b[3] = fmt((((Number(b[3]) || 0) + angle) % 360 + 360) % 360);
    if (b[6] && b[6].trim() !== '') {
      const [tx, ty] = rp(+b[6], +b[7]);
      b[6] = fmt(tx); b[7] = fmt(ty);
    }
    segs[i] = joinFields(b);
  }
  if (segs[5]) {
    const b = fieldsOf(segs[5]);
    if (b[1]) {
      const p = b[1].trim().split(/\s+/).map(Number);
      const [x, y] = rp(p[0], p[1]);
      b[1] = `${fmt(x)} ${fmt(y)}`;
    }
    segs[5] = joinFields(b);
  }
  if (segs[6]) {
    const b = fieldsOf(segs[6]);
    if (b[1]) b[1] = rotatePath(b[1], ox, oy, angle);
    segs[6] = joinFields(b);
  }
  return segs.join('^^');
}
