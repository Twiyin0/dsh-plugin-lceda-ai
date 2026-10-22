// Editing engine for LCEDA standard schematics.
//
// The document is JSON whose `shape` array holds flat "TYPE~field~field" records,
// so every edit is a string-level rewrite of the touched records followed by a
// full re-parse: the result is validated by rebuilding the netlist and diffing it
// against the pre-edit netlist. Files are written atomically with a .bak copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from './parser.js';
import { extractNetlist } from './netlist.js';
import { fmt, translatePath, rotatePath, translatePoints, rotatePoints } from './path.js';

const WIRE_COLOR = '#008800';
const JUNCTION_COLOR = '#CC0000';
const LABEL_COLOR = '#0000ff';
const GRID = 5;

let idCounter = 0;
function genId() {
  idCounter = (idCounter + 1) % 0xffff;
  const t = Date.now().toString(16).slice(-8);
  return `gge${t}${idCounter.toString(16).padStart(4, '0')}`;
}
function genUuid() {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s;
}

const fieldsOf = (s) => s.split('~');
const joinFields = (a) => a.join('~');
const trimNum = (v) => (Number.isFinite(v) ? v : 0);

function libSplit(raw) {
  const idx = raw.indexOf('#@$');
  if (idx === -1) return { head: raw, subs: [] };
  return { head: raw.slice(0, idx), subs: raw.slice(idx + 3).split('#@$') };
}
const libJoin = ({ head, subs }) => (subs.length ? `${head}#@$${subs.join('#@$')}` : head);

function parseAttrPairs(s) {
  const a = String(s ?? '').split('`');
  const out = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([a[i], a[i + 1]]);
  return out;
}
function joinAttrPairs(pairs, trailingTick) {
  return pairs.map(([k, v]) => `${k}\`${v}`).join('`') + (trailingTick ? '`' : '');
}

function isFrameInfo(info) {
  return String(info.id).startsWith('frame_lib')
    || (String(info.attrs.package ?? '').toUpperCase() === 'NONE' && !info.subs.some((x) => x.startsWith('P~')));
}

function libInfo(raw) {
  const { head, subs } = libSplit(raw);
  const h = fieldsOf(head);
  const pairs = parseAttrPairs(h[3]);
  const attrs = {};
  for (const [k, v] of pairs) if (k) attrs[k] = v;
  const info = {
    x: Number(h[1]) || 0, y: Number(h[2]) || 0, rot: Number(h[4]) || 0,
    id: h[6] ?? '', attrs, attrsRaw: h[3] ?? '', pairs,
    designator: '', value: '', head, subs, h,
  };
  for (const sub of subs) {
    if (sub.startsWith('T~P~')) info.designator = fieldsOf(sub)[12] ?? '';
    else if (sub.startsWith('T~N~')) info.value = fieldsOf(sub)[12] ?? '';
  }
  return info;
}

// ---------------------------------------------------------------- transforms

function movePimage(a, dx, dy) {
  const di = a.findIndex((v) => v.startsWith('data:'));
  const end = di === -1 ? a.length : di;
  const nums = [];
  for (let i = 1; i < end; i++) if (/^-?[0-9.]+$/.test(a[i])) nums.push(i);
  const last4 = nums.slice(-4);
  if (last4.length === 4) {
    a[last4[0]] = fmt(+a[last4[0]] + dx);
    a[last4[1]] = fmt(+a[last4[1]] + dy);
  }
}

function movePin(raw, dx, dy) {
  const segs = raw.split('^^');
  const h = fieldsOf(segs[0]);
  if (h.length >= 6) { h[4] = fmt(+h[4] + dx); h[5] = fmt(+h[5] + dy); }
  segs[0] = joinFields(h);
  if (segs[1]) {
    const p = segs[1].trim().split(/\s+/).map(Number);
    segs[1] = `${fmt(p[0] + dx)} ${fmt(p[1] + dy)}`;
  }
  if (segs[2]) {
    const [d, c] = segs[2].split('~');
    segs[2] = `${translatePath(d, dx, dy)}~${c ?? ''}`;
  }
  for (const i of [3, 4]) {
    if (!segs[i]) continue;
    const b = fieldsOf(segs[i]);
    b[1] = fmt(+b[1] + dx); b[2] = fmt(+b[2] + dy);
    if (b[6] && b[6].trim() !== '') { b[6] = fmt(+b[6] + dx); b[7] = fmt(+b[7] + dy); }
    segs[i] = joinFields(b);
  }
  if (segs[5]) {
    const b = fieldsOf(segs[5]);
    if (b[1]) {
      const p = b[1].trim().split(/\s+/).map(Number);
      b[1] = `${fmt(p[0] + dx)} ${fmt(p[1] + dy)}`;
    }
    segs[5] = joinFields(b);
  }
  if (segs[6]) {
    const b = fieldsOf(segs[6]);
    if (b[1]) b[1] = translatePath(b[1], dx, dy);
    segs[6] = joinFields(b);
  }
  return segs.join('^^');
}

function translateRecord(raw, dx, dy) {
  if (raw.startsWith('P~')) return movePin(raw, dx, dy);
  const a = fieldsOf(raw);
  switch (a[0]) {
    case 'T': a[2] = fmt(+a[2] + dx); a[3] = fmt(+a[3] + dy); break;
    case 'R': case 'E': a[1] = fmt(+a[1] + dx); a[2] = fmt(+a[2] + dy); break;
    case 'PL': case 'PG': a[1] = translatePoints(a[1], dx, dy); break;
    case 'PT': case 'A': a[1] = translatePath(a[1], dx, dy); break;
    case 'Pimage': movePimage(a, dx, dy); break;
    default: break;
  }
  return joinFields(a);
}

function rotateSub(raw, ox, oy, angle) {
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

/** Rotate one raw record (T/R/E/PL/PT/PG/P) around (ox, oy) by `angle` degrees. */
export function rotateRecord(raw, ox, oy, angle) {
  return rotateSub(raw, ox, oy, angle);
}

// ------------------------------------------------------------------ geometry

function pointSegDist2(px, py, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = px - a[0], wy = py - a[1];
  const l2 = vx * vx + vy * vy;
  if (l2 < 1e-9) return (px - a[0]) ** 2 + (py - a[1]) ** 2;
  let t = (wx * vx + wy * vy) / l2;
  t = Math.max(0, Math.min(1, t));
  return (px - a[0] - t * vx) ** 2 + (py - a[1] - t * vy) ** 2;
}
const onSeg = (p, a, b, eps = 0.75) => pointSegDist2(p[0], p[1], a, b) <= eps * eps;

function recordId(raw) {
  if (raw.startsWith('LIB~')) return libInfo(raw).id;
  if (raw.startsWith('P~')) return null;
  const a = fieldsOf(raw);
  switch (a[0]) {
    case 'W': case 'N': return a[6] ?? null;
    case 'J': case 'F': return a[5] ?? null;
    default: return null;
  }
}

// --------------------------------------------------------------- the editor

class Editor {
  constructor(json) {
    this.json = json;
    this.shape = json.shape;
    this.changes = [];
    this.warnings = [];
    this.notes = [];
  }

  libEntries({ includeFrames = false } = {}) {
    const out = [];
    for (let i = 0; i < this.shape.length; i++) {
      if (!this.shape[i].startsWith('LIB~')) continue;
      const info = libInfo(this.shape[i]);
      if (!includeFrames && isFrameInfo(info)) continue;
      out.push({ i, raw: this.shape[i], info });
    }
    return out;
  }

  libByRef(ref) {
    const hits = this.libEntries().filter((e) => e.info.designator === ref);
    if (!hits.length) {
      const known = this.libEntries().map((e) => e.info.designator).filter(Boolean);
      throw new Error(`component "${ref}" not found. Known designators: ${known.join(', ')}`);
    }
    if (hits.length > 1) throw new Error(`component "${ref}" matched ${hits.length} symbols`);
    return hits[0];
  }

  updateLib(entry, { head, subs }) {
    this.shape[entry.i] = libJoin({ head, subs });
  }

  setTextSub(ref, kind, text) {
    const e = this.libByRef(ref);
    const { head, subs } = libSplit(e.raw);
    const k = subs.findIndex((s) => s.startsWith(`T~${kind}~`));
    if (k < 0) throw new Error(`component "${ref}" has no ${kind === 'N' ? 'value' : 'designator'} text record`);
    const a = fieldsOf(subs[k]);
    const old = a[12] ?? '';
    if (String(old) === String(text)) return;
    a[12] = String(text);
    subs[k] = joinFields(a);
    this.updateLib(e, { head, subs });
    return old;
  }

  setValue(ref, value) {
    const old = this.setTextSub(ref, 'N', value);
    if (old !== undefined) this.changes.push(`set_value ${ref}: "${old}" → "${value}"`);
  }

  setDesignator(ref, to) {
    if (this.libEntries().some((x) => x.info.designator === to)) throw new Error(`designator "${to}" already exists`);
    const old = this.setTextSub(ref, 'P', to);
    if (old !== undefined) this.changes.push(`set_designator ${ref} → ${to}`);
  }

  setAttr(ref, key, value) {
    const e = this.libByRef(ref);
    const { head, subs } = libSplit(e.raw);
    const h = fieldsOf(head);
    const trailing = String(h[3] ?? '').endsWith('`');
    const pairs = parseAttrPairs(h[3]);
    const idx = pairs.findIndex(([k]) => k.toLowerCase() === String(key).toLowerCase());
    const old = idx >= 0 ? pairs[idx][1] : undefined;
    if (idx >= 0) pairs[idx][1] = String(value);
    else pairs.push([String(key), String(value)]);
    h[3] = joinAttrPairs(pairs, trailing);
    this.shape[e.i] = libJoin({ head: joinFields(h), subs });
    this.changes.push(`set_attr ${ref}.${key}: ${old === undefined ? '(新增)' : `"${old}"`} → "${value}"`);
  }

  move(ref, dx, dy) {
    if (!dx && !dy) return;
    const e = this.libByRef(ref);
    const { head, subs } = libSplit(e.raw);
    const h = fieldsOf(head);
    h[1] = fmt(+h[1] + dx); h[2] = fmt(+h[2] + dy);
    this.shape[e.i] = libJoin({ head: joinFields(h), subs: subs.map((s) => translateRecord(s, dx, dy)) });
    this.changes.push(`move ${ref} by (${fmt(dx)}, ${fmt(dy)})`);
  }

  moveTo(ref, x, y) {
    const e = this.libByRef(ref);
    this.move(ref, x - e.info.x, y - e.info.y);
  }

  rotate(ref, angle) {
    const norm = ((angle % 360) + 360) % 360;
    if (![0, 90, 180, 270].includes(norm)) throw new Error('rotate supports multiples of 90 degrees');
    if (!norm) return;
    const e = this.libByRef(ref);
    const { head, subs } = libSplit(e.raw);
    const h = fieldsOf(head);
    h[4] = fmt((((Number(h[4]) || 0) + norm) % 360 + 360) % 360);
    this.shape[e.i] = libJoin({ head: joinFields(h), subs: subs.map((s) => rotateSub(s, e.info.x, e.info.y, norm)) });
    this.changes.push(`rotate ${ref} by ${norm}° around (${fmt(e.info.x)}, ${fmt(e.info.y)})`);
  }

  deleteComponent(ref) {
    const e = this.libByRef(ref);
    this.shape.splice(e.i, 1);
    this.changes.push(`delete_component ${ref}`);
    this.warnings.push(`删除 ${ref} 后,原本连到它引脚上的导线端会悬空,请检查并清理`);
  }

  nextDesignator(base) {
    const used = new Set(this.libEntries().map((e) => e.info.designator).filter(Boolean));
    const m = /^([A-Za-z_]+)(\d+)$/.exec(base);
    const prefix = m ? m[1] : base.replace(/\d+$/, '');
    let n = m ? Number(m[2]) + 1 : 1;
    while (used.has(`${prefix}${n}`)) n += 1;
    return `${prefix}${n}`;
  }

  duplicate(ref, { to, dx = 20, dy = 0, value } = {}) {
    const e = this.libByRef(ref);
    const newRef = to || this.nextDesignator(e.info.designator);
    if (this.libEntries().some((x) => x.info.designator === newRef)) throw new Error(`designator "${newRef}" already exists`);
    // fresh ids inside the clone
    const idMap = new Map();
    let clone = e.raw.replace(/gge[0-9a-zA-Z]+/g, (m) => {
      if (!idMap.has(m)) idMap.set(m, genId());
      return idMap.get(m);
    });
    // fresh uuids / hash in the LIB header
    const { head, subs } = libSplit(clone);
    const h = fieldsOf(head);
    if (h[7]) h[7] = genUuid();
    if (h[8]) h[8] = genUuid();
    if (h[15]) h[15] = genUuid();
    clone = libJoin({ head: joinFields(h), subs: subs.map((s) => translateRecord(s, dx, dy)) });
    this.shape.push(clone);
    const created = this.libEntries().find((x) => x.info.id === libInfo(clone).id) ?? { i: this.shape.length - 1, raw: clone, info: libInfo(clone) };
    // rename + optional value
    if (created) {
      const split2 = libSplit(this.shape[created.i]);
      const pIdx = split2.subs.findIndex((s) => s.startsWith('T~P~'));
      if (pIdx >= 0) { const a = fieldsOf(split2.subs[pIdx]); a[12] = newRef; split2.subs[pIdx] = joinFields(a); }
      if (value !== undefined) {
        const nIdx = split2.subs.findIndex((s) => s.startsWith('T~N~'));
        if (nIdx >= 0) { const a = fieldsOf(split2.subs[nIdx]); a[12] = String(value); split2.subs[nIdx] = joinFields(a); }
      }
      this.shape[created.i] = libJoin(split2);
    }
    this.changes.push(`duplicate_component ${ref} → ${newRef}${value !== undefined ? ` (value ${value})` : ''} at (${fmt(e.info.x + dx)}, ${fmt(e.info.y + dy)})`);
    return newRef;
  }

  addWire(points) {
    const pts = points.map((p) => [Number(p[0]), Number(p[1])]);
    if (pts.length < 2) throw new Error('add_wire needs at least 2 points');
    for (const [x, y] of pts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('add_wire points must be numeric [x, y]');
    }
    const id = genId();
    this.shape.push(['W', pts.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join(' '), WIRE_COLOR, '1', '0', 'none', id, '0'].join('~'));
    this.changes.push(`add_wire ${id}: ${pts.map(([x, y]) => `(${fmt(x)}, ${fmt(y)})`).join(' → ')}`);
    for (const [x, y] of pts) {
      if (Math.abs(x % GRID) > 1e-6 || Math.abs(y % GRID) > 1e-6) {
        this.warnings.push(`导线端点 (${fmt(x)}, ${fmt(y)}) 不在 ${GRID} 单位网格上,立创EDA里可能对不齐`);
        break;
      }
    }
    return id;
  }

  addJunction(x, y) {
    const id = genId();
    this.shape.push(['J', fmt(x), fmt(y), '2.5', JUNCTION_COLOR, id, '0'].join('~'));
    this.changes.push(`add_junction ${id} at (${fmt(x)}, ${fmt(y)})`);
    return id;
  }

  addNetLabel(x, y, text, rot = 0) {
    const id = genId();
    this.shape.push(['N', fmt(x), fmt(y), String(rot), LABEL_COLOR, String(text), id, 'start', fmt(x + 2), fmt(y - 2.5), 'Times New Roman', '7pt', '0'].join('~'));
    this.changes.push(`add_net_label "${text}" at (${fmt(x)}, ${fmt(y)})`);
    return id;
  }

  addNetFlag(x, y, text, kind) {
    const k = kind || 'part_netLabel_gnD';
    const template = this.shape.find((raw) => raw.startsWith(`F~${k}~`));
    if (!template) throw new Error(`no existing "${k}" net flag in this sheet to clone; supported kinds are the ones already used in the file`);
    const src = { x: Number(fieldsOf(template)[2]), y: Number(fieldsOf(template)[3]) };
    const dx = x - src.x, dy = y - src.y;
    const segs = template.split('^^');
    const h = fieldsOf(segs[0]);
    h[2] = fmt(x); h[3] = fmt(y); h[5] = genId();
    for (let i = 7; i < h.length; i++) if (/^gge[0-9a-f]+$/.test(h[i])) h[i] = genId();
    segs[0] = joinFields(h);
    if (segs[1]) {
      const p = segs[1].trim().split(/[\s~]+/).map(Number);
      segs[1] = `${fmt(p[0] + dx)}~${fmt(p[1] + dy)}`;
    }
    if (segs[2]) {
      const b = fieldsOf(segs[2]);
      b[0] = String(text);
      b[2] = fmt(Number(b[2]) + dx); b[3] = fmt(Number(b[3]) + dy);
      if (b[9]) b[9] = `flag_${genId()}`;
      segs[2] = joinFields(b);
    }
    for (let i = 3; i < segs.length; i++) segs[i] = translateRecord(segs[i], dx, dy);
    this.shape.push(segs.join('^^'));
    this.changes.push(`add_net_flag "${text}" (${k}) at (${fmt(x)}, ${fmt(y)})`);
  }

  deleteElement(id) {
    for (let i = 0; i < this.shape.length; i++) {
      if (recordId(this.shape[i]) === id) {
        const kind = this.shape[i].split('~', 1)[0];
        this.shape.splice(i, 1);
        this.changes.push(`delete_element ${kind} ${id}`);
        return;
      }
    }
    throw new Error(`element id "${id}" not found`);
  }

  deleteWiresAt(x, y) {
    const before = this.shape.length;
    const removed = [];
    this.shape = this.json.shape = this.json.shape.filter((raw) => {
      if (!raw.startsWith('W~')) return true;
      const pts = fieldsOf(raw)[1].trim().split(/\s+/).map(Number);
      for (let i = 0; i + 1 < pts.length; i += 2) {
        if (Math.abs(pts[i] - x) < 1e-6 && Math.abs(pts[i + 1] - y) < 1e-6) { removed.push(recordId(raw)); return false; }
      }
      return true;
    });
    if (!removed.length) throw new Error(`no wire touches (${fmt(x)}, ${fmt(y)})`);
    this.changes.push(`delete_wires_at (${fmt(x)}, ${fmt(y)}): ${removed.join(', ')}`);
    if (this.shape.length === before) throw new Error('internal: nothing removed');
  }

  moveElement(id, dx, dy) {
    for (let i = 0; i < this.shape.length; i++) {
      const raw = this.shape[i];
      if (recordId(raw) !== id) continue;
      if (raw.startsWith('LIB~')) { this.move(libInfo(raw).designator, dx, dy); return; }
      if (raw.startsWith('W~')) { this.shape[i] = translateRecord(raw, dx, dy); }
      else if (raw.startsWith('N~')) {
        const a = fieldsOf(raw);
        a[1] = fmt(+a[1] + dx); a[2] = fmt(+a[2] + dy);
        a[8] = fmt(+a[8] + dx); a[9] = fmt(+a[9] + dy);
        this.shape[i] = joinFields(a);
      } else if (raw.startsWith('J~')) {
        const a = fieldsOf(raw);
        a[1] = fmt(+a[1] + dx); a[2] = fmt(+a[2] + dy);
        this.shape[i] = joinFields(a);
      } else if (raw.startsWith('F~')) {
        this.shape[i] = translateRecord(raw, dx, dy);
      } else {
        throw new Error(`move_element does not support ${raw.split('~', 1)[0]} records`);
      }
      this.changes.push(`move_element ${id} by (${fmt(dx)}, ${fmt(dy)})`);
      return;
    }
    throw new Error(`element id "${id}" not found`);
  }

  describe() {
    const wires = [];
    const labels = [];
    const flags = [];
    const junctions = [];
    for (const raw of this.shape) {
      if (raw.startsWith('W~')) {
        const a = fieldsOf(raw);
        const pts = a[1].trim().split(/\s+/).map(Number);
        const out = [];
        for (let i = 0; i + 1 < pts.length; i += 2) out.push(`${fmt(pts[i])},${fmt(pts[i + 1])}`);
        wires.push(`${a[6]}: ${out.join(' → ')}`);
      } else if (raw.startsWith('N~')) {
        const a = fieldsOf(raw);
        labels.push(`${a[6]}: "${a[5]}" @ (${fmt(+a[1])}, ${fmt(+a[2])}) rot ${a[3]}`);
      } else if (raw.startsWith('F~')) {
        const a = fieldsOf(raw);
        const segs = raw.split('^^');
        flags.push(`${a[5]}: "${(segs[2] ?? '').split('~')[0]}" (${a[1]}) @ (${fmt(+a[2])}, ${fmt(+a[3])})`);
      } else if (raw.startsWith('J~')) {
        const a = fieldsOf(raw);
        junctions.push(`${a[5]}: @ (${fmt(+a[1])}, ${fmt(+a[2])})`);
      }
    }
    this.notes.push(`导线 (${wires.length}):`);
    this.notes.push(...wires.map((l) => `  ${l}`));
    this.notes.push(`网络标签 (${labels.length}):`);
    this.notes.push(...labels.map((l) => `  ${l}`));
    this.notes.push(`电源标志 (${flags.length}):`);
    this.notes.push(...flags.map((l) => `  ${l}`));
    this.notes.push(`结点 (${junctions.length}):`);
    this.notes.push(...junctions.map((l) => `  ${l}`));
  }
}

// -------------------------------------------------------------- validation

function contentExtent(doc) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const s of doc.shapes) {
    switch (s.type) {
      case 'wire': case 'polyline': case 'polygon': for (const [x, y] of s.points ?? []) add(x, y); break;
      case 'junction': case 'netlabel': add(s.x, s.y); break;
      case 'netflag': add(s.anchor[0], s.anchor[1]); add(s.x, s.y); break;
      case 'text': add(s.x, s.y); break;
      case 'image': add(s.x, s.y); add(s.x + (s.w ?? 0), s.y + (s.h ?? 0)); break;
      case 'ellipse': add(s.x - s.rx, s.y - s.ry); add(s.x + s.rx, s.y + s.ry); break;
      case 'component':
        add(s.x, s.y);
        for (const sub of s.shapes ?? []) {
          if (sub.type === 'text') add(sub.x, sub.y);
          else if (sub.type === 'rect') { add(sub.x, sub.y); add(sub.x + sub.w, sub.y + sub.h); }
          else if (sub.type === 'ellipse') { add(sub.x - sub.rx, sub.y - sub.ry); add(sub.x + sub.rx, sub.y + sub.ry); }
          else if (sub.points) for (const [x, y] of sub.points) add(x, y);
        }
        for (const pin of s.pins ?? []) add(pin.x, pin.y);
        break;
      default: break;
    }
  }
  return { minX, minY, maxX, maxY };
}

function expandBBox(doc, json) {
  const e = contentExtent(doc);
  if (!Number.isFinite(e.minX)) return false;
  const bb = json.BBox ?? { x: 0, y: 0, width: 100, height: 100 };
  const x = Number(bb.x) || 0, y = Number(bb.y) || 0;
  const w = Number(bb.width) || 0, h = Number(bb.height) || 0;
  const right = x + w, bottom = y + h;
  const nx = Math.min(x, e.minX - 10);
  const ny = Math.min(y, e.minY - 10);
  const nr = Math.max(right, e.maxX + 10);
  const nb = Math.max(bottom, e.maxY + 10);
  if (nx === x && ny === y && nr === right && nb === bottom) return false;
  json.BBox = { x: fmt(nx), y: fmt(ny), width: fmt(nr - nx), height: fmt(nb - ny) };
  return true;
}

/**
 * Structural checks on a document: labels and flags that sit on neither a wire
 * nor a pin never take effect, and a wire end that touches nothing is dangling.
 *
 * Exported so the authoring path (buildFromSpec) runs exactly the same checks as
 * the editing path - it did not, and a label 6 units off its wire silently broke
 * a crystal net with no warning at all.
 */
export function validate(doc, beforeNetlist) {
  const warnings = [];
  const nl = extractNetlist(doc);
  const wires = doc.shapes.filter((s) => s.type === 'wire');
  const near = (p, list) => list.some((w) => w.points.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.75));
  const onAnyWire = (p) => wires.some((w) => w.points.slice(0, -1).some((a, i) => onSeg(p, a, w.points[i + 1])));
  // a label/flag placed exactly on a pin attaches to that pin — no wire needed
  const pinPoints = [];
  for (const c of doc.components) for (const p of c.pins) pinPoints.push([p.x, p.y]);
  const onAnyPin = (p) => pinPoints.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.75);

  for (const l of doc.shapes.filter((s) => s.type === 'netlabel')) {
    if (!onAnyWire([l.x, l.y]) && !onAnyPin([l.x, l.y])) {
      warnings.push(`网络标签 "${l.text}" @ (${l.x}, ${l.y}) 既不在导线上也不在引脚上,它不会生效`);
    }
  }
  for (const f of doc.shapes.filter((s) => s.type === 'netflag')) {
    if (!onAnyWire(f.anchor) && !onAnyPin(f.anchor)) {
      warnings.push(`电源标志 "${f.text}" @ (${f.anchor[0]}, ${f.anchor[1]}) 既不在导线上也不在引脚上,它不会生效`);
    }
  }
  for (const w of wires) {
    for (const end of [w.points[0], w.points[w.points.length - 1]]) {
      const attached = near(end, wires.filter((x) => x !== w))
        || pinPoints.some((p) => Math.hypot(p[0] - end[0], p[1] - end[1]) < 0.75)
        || doc.shapes.some((s) => (s.type === 'netlabel' || s.type === 'junction') && Math.hypot(s.x - end[0], s.y - end[1]) < 0.75)
        || doc.shapes.some((s) => s.type === 'netflag' && Math.hypot(s.anchor[0] - end[0], s.anchor[1] - end[1]) < 0.75);
      if (!attached) warnings.push(`导线 ${w.id} 的端点 (${end[0]}, ${end[1]}) 悬空`);
    }
  }
  const beforeConflicts = new Set((beforeNetlist?.nets ?? []).filter((n) => n.conflict).map((n) => n.name));
  for (const n of nl.nets.filter((x) => x.conflict && !beforeConflicts.has(x.name))) {
    warnings.push(`⚠️ 新增网络命名冲突:${[n.name, ...n.aliases].join(' / ')} —— 这通常是短路,请确认`);
  }
  const beforeDangling = new Set((beforeNetlist?.nets ?? []).filter((n) => n.pins.length <= 1).map((n) => `${n.name}:${n.pins.map((p) => p.ref + '.' + p.pin).join(',')}`));
  for (const n of nl.nets.filter((x) => x.pins.length <= 1 && x.named)) {
    const key = `${n.name}:${n.pins.map((p) => p.ref + '.' + p.pin).join(',')}`;
    if (!beforeDangling.has(key)) warnings.push(`网络 ${n.name} 只有 ${n.pins.length} 个引脚,可能是漏连`);
  }
  // a named net disappearing into another named net is almost always a short
  if (beforeNetlist) {
    const afterByName = new Map(nl.nets.map((n) => [n.name, n]));
    const afterPinNet = new Map();
    for (const n of nl.nets) for (const p of n.pins) afterPinNet.set(`${p.ref}.${p.pin}`, n.name);
    for (const old of beforeNetlist.nets) {
      if (!old.named || !old.pins.length || afterByName.has(old.name)) continue;
      const destinations = new Set();
      for (const p of old.pins) {
        const dest = afterPinNet.get(`${p.ref}.${p.pin}`);
        if (dest) destinations.add(dest);
      }
      if (destinations.size === 1) {
        warnings.push(`⚠️ 网络 "${old.name}" 的 ${old.pins.length} 个引脚被并入了 "${[...destinations][0]}" —— 如果是误连会造成短路`);
      }
    }
  }
  // designators must stay unique
  const seen = new Map();
  for (const c of nl.components) seen.set(c.ref, (seen.get(c.ref) ?? 0) + 1);
  for (const [ref, count] of seen) if (count > 1) warnings.push(`位号 ${ref} 重复出现 ${count} 次`);
  return warnings;
}

const netSignature = (net) => net.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(',');
const netIdentity = (net) => (net.named ? `name:${net.name}` : `sig:${netSignature(net)}`);

function pinIdentities(netlist) {
  const m = new Map();
  for (const net of netlist.nets) {
    const key = netIdentity(net);
    for (const p of net.pins) m.set(`${p.ref}.${p.pin}`, { key, net });
  }
  return m;
}

function diffNetlists(before, after) {
  const lines = [];
  const bComp = new Map(before.components.map((c) => [c.ref, c]));
  const aComp = new Map(after.components.map((c) => [c.ref, c]));
  for (const [ref, c] of aComp) if (!bComp.has(ref)) lines.push(`+ 器件 ${ref} ${c.value || c.name || ''} (${c.pins.length} 引脚)`);
  for (const [ref, c] of bComp) if (!aComp.has(ref)) lines.push(`- 器件 ${ref} ${c.value || ''}`);
  for (const [ref, c] of aComp) {
    const o = bComp.get(ref);
    if (!o) continue;
    if (o.value !== c.value) lines.push(`~ 器件 ${ref} 值 ${o.value} → ${c.value}`);
    if (o.package !== c.package) lines.push(`~ 器件 ${ref} 封装 ${o.package} → ${c.package}`);
  }
  const bPins = pinIdentities(before);
  const aPins = pinIdentities(after);
  // anonymous nets get per-netlist auto names (N$1, N$2 ...), so two different nets
  // can carry the same displayed name: disambiguate with the pin count.
  const showNet = (net, other) => (other && net.name === other.name ? `${net.name}[${net.pins.length}引脚]` : net.name);
  for (const [pin, info] of aPins) {
    const old = bPins.get(pin);
    if (!old) { lines.push(`+ 引脚 ${pin} → ${info.net.name}`); continue; }
    if (old.key !== info.key) {
      lines.push(`~ 引脚 ${pin}: ${showNet(old.net, info.net)} → ${showNet(info.net, old.net)}`);
    }
  }
  for (const [pin, info] of bPins) if (!aPins.has(pin)) lines.push(`- 引脚 ${pin} (原属 ${info.net.name})`);
  const bNets = new Map(before.nets.map((n) => [netIdentity(n), n]));
  const aNets = new Map(after.nets.map((n) => [netIdentity(n), n]));
  for (const [k, n] of aNets) if (!bNets.has(k)) lines.push(`+ 网络 ${n.name} (${n.pins.length} 引脚)`);
  for (const [k, n] of bNets) if (!aNets.has(k)) lines.push(`- 网络 ${n.name} (${n.pins.length} 引脚)`);
  if (!lines.length) lines.push('(电气网络无变化)');
  return lines;
}

// --------------------------------------------------------------- operations

function applyOp(editor, op) {
  const kind = op.op;
  switch (kind) {
    case 'describe': return editor.describe();
    case 'set_value': return editor.setValue(op.ref, op.value);
    case 'set_designator': return editor.setDesignator(op.ref, op.to);
    case 'set_attr': return editor.setAttr(op.ref, op.key, op.value);
    case 'move': return op.x !== undefined || op.y !== undefined
      ? editor.moveTo(op.ref, Number(op.x), Number(op.y))
      : editor.move(op.ref, Number(op.dx ?? 0), Number(op.dy ?? 0));
    case 'rotate': return editor.rotate(op.ref, Number(op.angle));
    case 'delete_component': return editor.deleteComponent(op.ref);
    case 'duplicate_component': return editor.duplicate(op.ref, op);
    case 'add_wire': return editor.addWire(op.points ?? []);
    case 'add_junction': return editor.addJunction(Number(op.x), Number(op.y));
    case 'add_net_label': return editor.addNetLabel(Number(op.x), Number(op.y), op.text, op.rot ?? 0);
    case 'add_net_flag': return editor.addNetFlag(Number(op.x), Number(op.y), op.text, op.kind);
    case 'delete_element': return editor.deleteElement(op.id);
    case 'delete_wires_at': return editor.deleteWiresAt(Number(op.x), Number(op.y));
    case 'move_element': return editor.moveElement(op.id, Number(op.dx ?? 0), Number(op.dy ?? 0));
    default: throw new Error(`unknown op "${kind}". Known ops: describe, set_value, set_designator, set_attr, move, rotate, delete_component, duplicate_component, add_wire, add_junction, add_net_label, add_net_flag, delete_element, delete_wires_at, move_element`);
  }
}

/**
 * Apply structured operations to a schematic file.
 * @returns {Promise<object>} change summary, netlist diff, warnings, preview paths
 */
export async function editSheet(file, ops, opts = {}) {
  const { dryRun = false, backup = true, out = null, preview = null, previewScale = 2 } = opts;
  const original = await fs.readFile(file, 'utf8');
  const json = JSON.parse(original);
  if (json.head?.docType !== '1') throw new Error(`${file} is not an LCEDA schematic (head.docType !== "1")`);
  const beforeDoc = parseDocument(JSON.parse(original));
  const before = extractNetlist(beforeDoc);
  const editor = new Editor(json);
  for (const op of ops) {
    if (op?.op === undefined) throw new Error('every operation needs an "op" field');
    applyOp(editor, op);
  }
  const afterDoc0 = parseDocument(JSON.parse(JSON.stringify(json)));
  const bboxChanged = editor.changes.length ? expandBBox(afterDoc0, json) : false;
  const afterJson = JSON.stringify(json);
  const afterDoc = parseDocument(JSON.parse(afterJson));
  const after = extractNetlist(afterDoc);
  const preExisting = new Set(validate(beforeDoc, null));
  const warnings = [...editor.warnings, ...validate(afterDoc, before).filter((w) => !preExisting.has(w))];
  const diff = diffNetlists(before, after);
  const changed = editor.changes.length > 0;

  const result = {
    file, changed, dryRun,
    changes: editor.changes,
    notes: editor.notes,
    diff,
    warnings,
    bboxChanged,
    statistics: after.statistics,
    summary: `器件 ${before.statistics.components}→${after.statistics.components} | 网络 ${before.statistics.nets}→${after.statistics.nets} | 引脚 ${before.statistics.pins}→${after.statistics.pins}`,
  };

  if (!changed) return result;

  const target = out ? path.resolve(out) : file;
  if (!dryRun) {
    if (backup && target === file) await fs.copyFile(file, `${file}.bak`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, afterJson, 'utf8');
    await fs.rename(tmp, target);
    result.outFile = target;
    result.backupFile = backup && target === file ? `${file}.bak` : undefined;
  }

  if (preview) {
    const { renderSVG } = await import('./svg.js');
    const { svgToPng } = await import('./export.js');
    const svg = renderSVG(afterDoc, { title: path.basename(file) });
    await fs.mkdir(path.dirname(path.resolve(preview)), { recursive: true });
    await fs.writeFile(path.resolve(preview), await svgToPng(svg, { scale: previewScale }));
    result.preview = path.resolve(preview);
  }
  return result;
}

/** Apply operations to an in-memory document text (no file writes). */
export function editText(text, ops) {
  const json = JSON.parse(text);
  if (json.head?.docType !== '1') throw new Error('not an LCEDA schematic (head.docType !== "1")');
  const beforeDoc = parseDocument(JSON.parse(text));
  const before = extractNetlist(beforeDoc);
  const editor = new Editor(json);
  for (const op of ops) applyOp(editor, op);
  const afterJson = JSON.stringify(json);
  const afterDoc = parseDocument(JSON.parse(afterJson));
  const after = extractNetlist(afterDoc);
  const preExisting = new Set(validate(beforeDoc, null));
  return {
    text: afterJson,
    changed: editor.changes.length > 0,
    changes: editor.changes,
    notes: editor.notes,
    diff: diffNetlists(before, after),
    warnings: [...editor.warnings, ...validate(afterDoc, before).filter((w) => !preExisting.has(w))],
    statistics: after.statistics,
  };
}
