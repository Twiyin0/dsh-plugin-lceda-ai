// lceda-ai public API: convert LCEDA standard schematic files/directories.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from './parser.js';
import { extractNetlist } from './netlist.js';
import { renderSVG } from './svg.js';
import { svgToPng, svgToPdf } from './export.js';
import { buildReport } from './report.js';
import { editSheet, editText } from './edit.js';

export { parseDocument, extractNetlist, renderSVG, buildReport, editSheet, editText };

export async function findSheetFiles(input) {
  const st = await fs.stat(input);
  if (st.isFile()) return [input];
  const out = [];
  async function walk(dir, depth = 0) {
    if (depth > 6) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/^(Sheet.*|.*sch.*|.*schematic.*)\.(json|esch)$/i.test(e.name) || e.name.endsWith('.esch')) out.push(p);
    }
  }
  await walk(input);
  return out.sort();
}

export async function convert(input, opts = {}) {
  const {
    outDir, formats = ['svg', 'png', 'pdf', 'report'], scale = 4, title,
  } = opts;
  const files = await findSheetFiles(input);
  if (!files.length) throw new Error(`no schematic files found under ${input}`);
  const KNOWN = new Set(['svg', 'png', 'pdf', 'report']);
  const unknown = formats.filter((f) => !KNOWN.has(String(f).toLowerCase()));
  if (unknown.length) {
    // fail loudly: a typo used to produce an empty output directory
    throw new Error(`unknown format${unknown.length > 1 ? 's' : ''} ${unknown.map((f) => JSON.stringify(f)).join(', ')}; expected svg/png/pdf/report`);
  }
  const results = [];
  for (const file of files) {
    const sheetName = path.basename(file).replace(/\.(json|esch)$/i, '');
    const base = outDir ? path.join(outDir, sheetName) : path.join(path.dirname(file), `${sheetName}.ai`);
    await fs.mkdir(path.dirname(base), { recursive: true });
    const json = await fs.readFile(file, 'utf8');
    const doc = parseDocument(json);
    const netlist = extractNetlist(doc);
    const svg = renderSVG(doc, { title: title || sheetName });
    const r = { input: file, sheet: sheetName, outputs: {}, netlist };
    if (formats.includes('svg')) {
      const p = `${base}.svg`;
      await fs.writeFile(p, svg);
      r.outputs.svg = p;
    }
    if (formats.includes('png')) {
      const p = `${base}.png`;
      await fs.writeFile(p, await svgToPng(svg, { scale }));
      r.outputs.png = p;
    }
    if (formats.includes('pdf')) {
      const p = `${base}.pdf`;
      await fs.writeFile(p, await svgToPdf(svg, { scale, title: sheetName }));
      r.outputs.pdf = p;
    }
    if (formats.includes('report')) {
      const { json: rj, markdown } = buildReport(doc, netlist, { sheetName });
      r.outputs.reportJson = `${base}.report.json`;
      r.outputs.reportMd = `${base}.report.md`;
      await fs.writeFile(r.outputs.reportJson, JSON.stringify(rj, null, 2));
      await fs.writeFile(r.outputs.reportMd, markdown);
    }
    results.push(r);
  }
  return results;
}

// Text-mode summary (for AI agents that want a compact answer instead of files)
export function summarize(doc, netlist) {
  const lines = [];
  lines.push(`LCEDA schematic v${doc.editorVersion}, ${netlist.statistics.components} components, ${netlist.statistics.nets} nets`);
  for (const c of netlist.components) {
    lines.push(`${c.ref}: ${c.value || c.name} [${c.package}] ${c.lcsc ? `LCSC ${c.lcsc}` : ''} pins: ${c.pins.map((p) => `${p.number}=${p.name}`).join(' ')}`);
  }
  for (const n of netlist.nets) lines.push(`net ${n.name}: ${n.connections ? '' : ''}${n.pins.map((p) => `${p.ref}.${p.pin}`).join(' ')}`);
  return lines.join('\n');
}
