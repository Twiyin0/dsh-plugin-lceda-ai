// AI-friendly structured report: Markdown + JSON with BOM, pin tables and netlist.
import { parseDocument } from './parser.js';
export function buildReport(input, netlist, { sheetName = 'Sheet_1' } = {}) {
  const doc = input && Array.isArray(input.shape) && !Array.isArray(input.components)
    ? parseDocument(input)
    : input;
  const { components, nets, statistics } = netlist;
  const conns = (n) => n.pins.map((p) => `${p.ref}.${p.pin}${p.pinName && p.pinName !== p.pin ? `(${p.pinName})` : ''}`);
  const meta = {
    sheet: sheetName,
    editorVersion: doc.editorVersion,
    uuid: doc.uuid,
    warnings: doc.warnings,
    statistics,
  };

  const json = {
    meta,
    components: components.map((c) => ({
      ref: c.ref, name: c.name, value: c.value, package: c.package,
      mfrPart: c.mfrPart, lcsc: c.lcsc, manufacturer: c.manufacturer,
      pins: c.pins.map((p) => ({ number: p.number, name: p.name, type: p.elec })),
    })),
    nets: nets.map((n) => ({
      name: n.name,
      named: n.named,
      aliases: n.aliases,
      conflict: n.conflict,
      connections: conns(n),
      wireCount: n.wireCount,
    })),
  };

  const md = [];
  md.push(`# 原理图 AI 报告 — ${sheetName}`);
  md.push('');
  md.push(`> 由 lceda-ai 从嘉立创EDA标准版原理图解析生成 (编辑器版本 ${doc.editorVersion})。`);
  md.push('');
  md.push('## 概览');
  md.push('');
  md.push(`- 器件: **${statistics.components}** | 引脚: ${statistics.pins} | 网络: **${statistics.nets}** (命名 ${statistics.namedNets})`);
  md.push(`- 导线: ${statistics.wires} | 结点: ${statistics.junctions} | 网络标签: ${statistics.netLabels} | 网络标志: ${statistics.netFlags}`);
  md.push('');
  md.push('## 器件清单 (BOM)');
  md.push('');
  md.push('| 位号 | 名称/值 | 封装 | 制造商型号 | LCSC 编号 | 引脚数 |');
  md.push('|---|---|---|---|---|---|');
  for (const c of components) {
    md.push(`| ${c.ref} | ${c.value || c.name || ''} | ${c.package || ''} | ${c.mfrPart || ''} | ${c.lcsc || ''} | ${c.pinCount} |`);
  }
  md.push('');
  md.push('## 器件引脚');
  md.push('');
  for (const c of components) {
    md.push(`### ${c.ref} — ${c.value || c.name || ''}${c.package ? ` (${c.package})` : ''}`);
    md.push('');
    md.push('| 引脚号 | 引脚名 | 电气类型 | 坐标 (x, y) |');
    md.push('|---|---|---|---|');
    for (const p of c.pins) md.push(`| ${p.number} | ${p.name} | ${p.elec} | ${p.x}, ${p.y} |`);
    md.push('');
  }
  md.push('## 网络表 (Netlist)');
  md.push('');
  md.push('每个网络列出所有连接的器件引脚。格式: `器件位号.引脚号(引脚名)`。');
  md.push('');
  md.push('| 网络 | 连接 |');
  md.push('|---|---|');
  for (const n of nets) {
    const alias = n.aliases?.length ? ` ⚠️别名: ${n.aliases.join(', ')}` : '';
    md.push(`| **${n.name}**${alias} | ${conns(n).join(', ') || '(无引脚)'} |`);
  }
  md.push('');
  const conflicts = nets.filter((n) => n.conflict);
  if (conflicts.length) {
    md.push('## ⚠️ 网络命名冲突 (同一网络上有多个不同名称，通常为原理图错误)');
    md.push('');
    for (const n of conflicts) md.push(`- **${n.name}** 同时被命名为: ${[n.name, ...n.aliases].join(' / ')} → 连接: ${conns(n).join(', ')}`);
    md.push('');
  }
  const dangling = nets.filter((n) => n.pins.length <= 1);
  if (dangling.length) {
    md.push('## ⚠ 疑似未连接/单引脚网络');
    md.push('');
    for (const n of dangling) md.push(`- ${n.name}: ${conns(n).join(', ') || '(孤立导线)'}`);
    md.push('');
  }
  if (doc.warnings?.length) {
    md.push('## 解析警告');
    md.push('');
    for (const w of doc.warnings) md.push(`- ${w}`);
    md.push('');
  }
  return { json, markdown: md.join('\n') };
}
