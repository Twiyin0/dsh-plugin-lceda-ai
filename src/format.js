// LCEDA (嘉立创EDA 标准版) schematic (.esch / Sheet_*.json) record format constants.
//
// Reverse-engineered from 嘉立创EDA 6.5.51 (Contents/Resources/editor/6.5.51.asar,
// jsapi.min.js serializer functions gnrWire/gnrPin/gnrPowerPort/...) and verified
// against a real project (K11C_Board_ex / power_IO sheet).
//
// A schematic document is JSON: { head, canvas, shape: [ "TYPE~f1~f2~...", ... ], BBox, colors }
// LIB records embed sub-shapes separated by "#@$". Pin/flag records use "^^" for
// sub-blocks. All coordinates use a math-like Y axis (up = more negative stored y).

export const ELECTRICAL_TYPES = {
  0: 'unspecified',
  1: 'input',
  2: 'output',
  3: 'bidirectional',
  4: 'power',
  5: 'passive',
  6: 'open-collector',
  7: 'open-emitter',
  8: 'hiz',
};

export const DEFAULT_FONT = 'Verdana';
export const DEFAULT_FONT_SIZE = 7; // "7pt" is the editor default; empty size == 7pt
export const NETLABEL_DEFAULT_FONT = 'Times New Roman';

// Netflag graphic kinds seen in the wild (F records). The *text* field carries the
// actual net name (e.g. kind part_netLabel_VCC with text "3V3" -> net "3V3").
export function isNetFlagKind(kind) {
  return typeof kind === 'string' && kind.startsWith('part_netLabel');
}

export function parseSize(v) {
  if (v === undefined || v === null || v === '') return DEFAULT_FONT_SIZE;
  const m = String(v).match(/^([0-9.]+)(pt|px)?$/);
  if (!m) return DEFAULT_FONT_SIZE;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) ? n : DEFAULT_FONT_SIZE;
}

export function num(v, d = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

export function splitPoints(s) {
  const t = String(s).trim();
  if (!t) return [];
  const parts = t.split(/\s+/).map(Number);
  const out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) out.push([parts[i], parts[i + 1]]);
  return out;
}

// Parse a "key`value`key`value..." attribute string (LIB field 3).
export function parseAttrs(s) {
  const parts = String(s).split('`');
  const out = {};
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i].trim()] = parts[i + 1];
  return out;
}
