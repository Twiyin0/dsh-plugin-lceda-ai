// Project-level view of a multi-sheet LCEDA project.
//
// The standard edition stores each schematic as its own `Sheet_*.json` document;
// a project folder therefore holds several flat sheets. This module reads them
// together: merged BOM, per-sheet statistics, nets that appear on more than one
// sheet, and a net-class breakdown (power / clock / reset / differential / bus)
// that is useful when reviewing a board.
//
// Deliberately NOT implemented: writing bus or hierarchical-port records into
// `.esch`. The record format for those has not been confirmed against a real
// file (the sample projects inspected contain only LIB/F/W/N/J records), and a
// guessed encoding would produce a sheet the editor may reject or misread.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from './parser.js';
import { extractNetlist } from './netlist.js';

const SHEET_RE = /\.(esch|json)$/i;
// project.json / package.json and friends sit next to the sheets
const NOT_A_SHEET = /^(project|package|package-lock|tsconfig|bom|report)\.json$/i;
const isSheetName = (name) => SHEET_RE.test(name) && !NOT_A_SHEET.test(name);

/** List schematic documents in a project folder (sorted, frame files skipped). */
export async function listSheets(dir) {
  const files = [];
  const visit = async (current) => {
    let items = [];
    try { items = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(current, item.name);
      if (item.isDirectory()) await visit(full);
      else if (isSheetName(item.name)) files.push(full);
    }
  };
  await visit(dir);
  return files.sort();
}

const POWER_RE = /^(\+?\d+V\d*|VCC|VDD|VIN|VBAT|VSYS|VUSB|AVCC|DVCC|VREF[+-]?|3V3|5V|12V)$/i;
const GROUND_RE = /^(GND|AGND|DGND|PGND|VSS|VEE|0V|GNDA|GNDD)$/i;
const CLOCK_RE = /(CLK|XTAL|OSC|MCLK|SCLK|SCK|HSE|LSE)/i;
const RESET_RE = /(^|[^A-Z])(RST|RESET|NRST)([^A-Z]|$)/i;

/**
 * Bucket nets by role. Heuristic on purpose: it is a review aid, not an
 * electrical rule, and never changes the schematic.
 */
export function classifyNet(name) {
  const n = String(name ?? '');
  if (GROUND_RE.test(n)) return 'ground';
  if (POWER_RE.test(n)) return 'power';
  if (RESET_RE.test(n)) return 'reset';
  if (CLOCK_RE.test(n)) return 'clock';
  // USB_D+/USB_D- and RS485_A/B style pairs; V+/V- are rails, not pairs
  if (/[_-][PN]$/i.test(n)) return 'differential';
  if (/[+-]$/.test(n) && n.length > 1 && !/^V[+-]$/i.test(n) && !/^[+-]?\d/.test(n)) return 'differential';
  if (/[_-][AB]$/.test(n) && /(RS|CAN|LIN|D)/i.test(n)) return 'differential';
  if (/(^|[A-Z_])(D|A|P|Q|IO|GPIO)\d{1,2}$/i.test(n)) return 'bus';
  return 'signal';
}

/** Read every sheet in a project folder and merge the views. */
export async function readProject(dir) {
  const files = await listSheets(dir);
  if (!files.length) throw new Error(`no schematic sheets found under ${dir}`);
  const sheets = [];
  const bom = new Map();
  const netSheets = new Map();

  for (const file of files) {
    const doc = parseDocument(await fs.readFile(file, 'utf8'));
    // a stray .json that is not a schematic has no drawable records: skip it
    if (!doc.shapes.length && !doc.components.length) continue;
    const netlist = extractNetlist(doc);
    const name = path.basename(file).replace(SHEET_RE, '');
    const stats = netlist.statistics;
    sheets.push({
      file, name, statistics: stats,
      title: doc.head?.title ?? '',
      components: netlist.components.map((c) => ({ ref: c.ref, value: c.value, package: c.package, pins: c.pins.length })),
      nets: netlist.nets.filter((n) => n.named).map((n) => ({ name: n.name, pins: n.pins.map((p) => `${p.ref}.${p.pin}`), conflict: n.conflict })),
    });
    for (const c of netlist.components) {
      const key = `${c.value ?? ''}|${c.package ?? ''}`;
      const row = bom.get(key) ?? { value: c.value ?? '', package: c.package ?? '', refs: [], sheets: new Set() };
      row.refs.push({ ref: c.ref, sheet: name });
      row.sheets.add(name);
      bom.set(key, row);
    }
    for (const n of netlist.nets) {
      if (!n.named) continue;
      const row = netSheets.get(n.name) ?? { name: n.name, sheets: new Set(), classes: new Set() };
      row.sheets.add(name);
      row.classes.add(classifyNet(n.name));
      netSheets.set(n.name, row);
    }
  }

  if (!sheets.length) throw new Error(`no readable schematic sheets under ${dir}`);
  const totals = sheets.reduce((acc, s) => ({
    components: acc.components + s.statistics.components,
    pins: acc.pins + s.statistics.pins,
    nets: acc.nets + s.statistics.nets,
    conflicts: acc.conflicts + (s.statistics.conflicts ?? 0),
  }), { components: 0, pins: 0, nets: 0, conflicts: 0 });

  const classes = {};
  for (const row of netSheets.values()) {
    for (const c of row.classes) {
      classes[c] = classes[c] ?? [];
      classes[c].push(row.name);
    }
  }
  for (const k of Object.keys(classes)) classes[k].sort();

  return {
    dir, sheets, totals,
    bom: [...bom.values()].map((r) => {
      // the same designator may exist on several sheets: qualify only those
      const counts = new Map();
      for (const { ref } of r.refs) counts.set(ref, (counts.get(ref) ?? 0) + 1);
      const refs = r.refs
        .map(({ ref, sheet }) => (counts.get(ref) > 1 ? `${ref}@${sheet}` : ref))
        .sort();
      const merged = r.refs.map(({ ref }) => ref);
      return { value: r.value, package: r.package, count: merged.length, refs, sheets: [...r.sheets].sort() };
    })
      .sort((a, b) => a.value.localeCompare(b.value)),
    crossSheet: [...netSheets.values()].filter((r) => r.sheets.size > 1)
      .map((r) => ({ name: r.name, sheets: [...r.sheets].sort(), classes: [...r.classes] })),
    classes,
    notes: [
      '跨图纸同名网络只做提示:标准版里网络标志/端口是全局的,普通网络标签是否跨图纸连通取决于标签类型,本工具不臆断。',
      '总线与层次端口记录的写入格式未经真实文件确认,当前只做读取侧聚合,不生成这类记录。',
    ],
  };
}

/** Markdown summary of a project. */
export function projectMarkdown(project) {
  const lines = [];
  lines.push(`# 工程总览 — ${path.basename(project.dir)}`);
  lines.push('');
  lines.push(`- 图纸: **${project.sheets.length}** | 器件: **${project.totals.components}** | 引脚: ${project.totals.pins} | 网络: ${project.totals.nets}`);
  if (project.totals.conflicts) lines.push(`- ⚠️ 命名冲突: ${project.totals.conflicts}`);
  lines.push('');
  lines.push('## 图纸');
  lines.push('| 图纸 | 器件 | 引脚 | 网络 | 命名 | 文件 |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of project.sheets) {
    lines.push(`| ${s.title || s.name} | ${s.statistics.components} | ${s.statistics.pins} | ${s.statistics.nets} | ${s.statistics.namedNets ?? '-'} | ${path.basename(s.file)} |`);
  }
  lines.push('');
  lines.push('## 合并 BOM');
  lines.push('| 值/型号 | 封装 | 数量 | 位号 | 图纸 |');
  lines.push('|---|---|---|---|---|');
  for (const row of project.bom) {
    lines.push(`| ${row.value || '-'} | ${row.package || '-'} | ${row.count} | ${row.refs.join(' ')} | ${row.sheets.join(', ')} |`);
  }
  lines.push('');
  lines.push('## 网络分类');
  const order = ['power', 'ground', 'reset', 'clock', 'differential', 'bus', 'signal'];
  const zh = { power: '电源', ground: '地', reset: '复位', clock: '时钟', differential: '差分', bus: '总线风格', signal: '信号' };
  for (const k of order) {
    if (!project.classes[k]?.length) continue;
    lines.push(`- **${zh[k]}** (${project.classes[k].length}): ${project.classes[k].slice(0, 30).join(', ')}`);
  }
  if (project.crossSheet.length) {
    lines.push('');
    lines.push('## 跨图纸同名网络(提示)');
    for (const n of project.crossSheet.slice(0, 40)) lines.push(`- **${n.name}** → ${n.sheets.join(', ')}`);
  }
  lines.push('');
  lines.push('## 说明');
  for (const n of project.notes) lines.push(`- ${n}`);
  lines.push('');
  return lines.join('\n');
}
