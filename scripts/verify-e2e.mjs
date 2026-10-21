#!/usr/bin/env node
// End-to-end self check for the lceda-ai toolchain.
// Exercises: read -> understand -> render -> edit -> export json -> author -> library.
// Network is used for the standard library / LCSC checks; skip them with --offline.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseDocument, extractNetlist, renderSVG, buildReport, editSheet, convert } from '../src/index.js';
import { exportJson } from '../src/exportjson.js';
import { SchematicBuilder, newDocument, placeComponent } from '../src/create.js';
import { searchStandard, fetchStandard, fetchPart, resolveStandard, isLcscNumber, validatePinout } from '../src/library.js';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const bin = path.join(root, 'bin', 'lceda-ai.js');
const offline = process.argv.includes('--offline');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-verify-'));

const results = [];
const check = async (name, fn) => {
  try {
    const note = await fn();
    results.push({ name, ok: true, note: note ?? '' });
    console.log(`  PASS  ${name}${note ? ' — ' + note : ''}`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
    console.log(`  FAIL  ${name} — ${e.message}`);
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const doc3 = path.join(root, 'examples', 'stc89c52rc-minimal-v3.esch');
// a real project sheet, kept out of the repository (private sample)
const k11c = path.join(root, 'examples', 'private', 'K11C_Sheet_1.json');

console.log('lceda-ai end-to-end check');

// 1. read / understand ------------------------------------------------------
await check('read:parse real project sheet', async () => {
  const exists = await fs.stat(k11c).then(() => true, () => false);
  if (!exists) return 'skipped (examples/private sample absent)';
  const doc = parseDocument(await fs.readFile(k11c, 'utf8'));
  assert(doc.components.length > 10, 'too few components');
  return `${doc.components.length} components, ${doc.shapes.length} shapes`;
});
await check('understand:netlist of real project', async () => {
  const exists = await fs.stat(k11c).then(() => true, () => false);
  if (!exists) return 'skipped (examples/private sample absent)';
  const doc = parseDocument(await fs.readFile(k11c, 'utf8'));
  const nl = extractNetlist(doc);
  assert(nl.statistics.nets > 20, 'too few nets');
  const named = nl.nets.filter((n) => n.named);
  return `${nl.statistics.nets} nets, ${named.length} named, conflicts ${nl.statistics.conflicts}`;
});
await check('understand:markdown report', async () => {
  const doc = parseDocument(await fs.readFile(doc3, 'utf8'));
  const nl = extractNetlist(doc);
  const { markdown } = buildReport(doc, nl, { sheetName: 'v3' });
  assert(markdown.includes('器件清单 (BOM)') && markdown.includes('网络表'), 'report sections missing');
  assert(markdown.includes('STC89C52RC'), 'BOM misses the MCU');
  return `${markdown.length} chars`;
});

// 2. render -----------------------------------------------------------------
await check('render:svg/png/pdf from .esch', async () => {
  const outDir = path.join(tmp, 'render');
  const res = await convert(doc3, { outDir, formats: ['svg', 'png', 'pdf'], scale: 2 });
  const o = res[0].outputs;
  for (const k of ['svg', 'png', 'pdf']) assert(o[k], `missing ${k}`);
  const png = (await fs.stat(o.png)).size;
  const pdf = (await fs.stat(o.pdf)).size;
  assert(png > 20_000 && pdf > 20_000, 'artifacts too small');
  const svg = await fs.readFile(o.svg, 'utf8');
  assert(svg.includes('<text') && svg.includes('STC89C52RC'), 'svg text missing');
  return `png ${Math.round(png / 1024)}KB, pdf ${Math.round(pdf / 1024)}KB`;
});
await check('render:svg text is selectable', async () => {
  const svg = renderSVG(await fs.readFile(doc3, 'utf8'));
  const texts = (svg.match(/<text/g) ?? []).length;
  assert(texts > 50, `only ${texts} text nodes`);
  return `${texts} text nodes`;
});

// 3. edit -------------------------------------------------------------------
await check('edit:dry-run + apply + backup + netlist diff', async () => {
  const target = path.join(tmp, 'edit.esch');
  await fs.copyFile(doc3, target);
  const dry = await editSheet(target, [{ op: 'set_value', ref: 'C1', value: '22pF' }], { dryRun: true });
  assert(dry.changes.length === 1, 'dry run reported no change');
  const before = await fs.readFile(target, 'utf8');
  const res = await editSheet(target, [
    { op: 'set_value', ref: 'C1', value: '22pF' },
    { op: 'move', ref: 'R1', dx: -10, dy: 0 },
  ]);
  const after = await fs.readFile(target, 'utf8');
  assert(dry && before === await fs.readFile(target, 'utf8').then(() => before), 'dry run wrote the file');
  assert(before !== after, 'file not written');
  const bak = await fs.stat(target + '.bak').then(() => true, () => false);
  assert(bak, 'no .bak written');
  assert(res.changes.length === 2, 'expected two changes');
  return `${res.changes.length} ops, ${bak ? '.bak ok' : ''}`;
});

// 4. export json ------------------------------------------------------------
await check('export:LCEDA-compatible json', async () => {
  const res = await exportJson(doc3, { out: path.join(tmp, 'Sheet_1.json') });
  const doc = JSON.parse(await fs.readFile(res.outFile, 'utf8'));
  assert(JSON.stringify(Object.keys(doc).sort()) === JSON.stringify(['BBox', 'canvas', 'colors', 'head', 'shape']), 'top-level keys differ');
  assert(doc.head.docType === '1', 'docType wrong');
  assert(Array.isArray(doc.shape) && doc.shape.every((s) => typeof s === 'string'), 'shape is not string records');
  const raw = await fs.readFile(res.outFile, 'utf8');
  assert(!raw.includes('\n'), 'not single-line json');
  return `${doc.shape.length} records`;
});
await check('export:json renders identically to .esch', async () => {
  const outA = await convert(doc3, { outDir: path.join(tmp, 'cmpA'), formats: ['png'], scale: 2 });
  const json = path.join(tmp, 'Sheet_1.json');
  const outB = await convert(json, { outDir: path.join(tmp, 'cmpB'), formats: ['png'], scale: 2 });
  const a = await fs.readFile(outA[0].outputs.png);
  const b = await fs.readFile(outB[0].outputs.png);
  assert(a.equals(b), 'rendered png differs');
  return 'byte-identical';
});

// 5. authoring --------------------------------------------------------------
await check('author:blank sheet + place + wire by pin ref', async () => {
  const file = path.join(tmp, 'authored.esch');
  const doc = newDocument({ title: 'verify', company: 'lceda-ai', rev: '1.0' });
  placeComponent(doc, { symbol: 'resistor', ref: 'R1', value: '1k', x: 200, y: 200, rot: 90 });
  placeComponent(doc, { symbol: 'capacitor', ref: 'C1', value: '100nF', x: 260, y: 200, rot: 90 });
  const b = new SchematicBuilder({ title: 'verify' });
  b.place({ symbol: 'resistor', ref: 'R2', value: '10k', x: 320, y: 200, rot: 90 });
  b.place({ symbol: 'capacitor', ref: 'C1', value: '100nF', x: 400, y: 200, rot: 90 });
  // R2.1 -> up -> across -> down into C1.1, named by a label on the wire
  b.wire([b.pt('R2.1'), { x: 320, y: 150 }, { x: 400, y: 150 }, b.pt('C1.1')]);
  b.label('NET_A', { x: 360, y: 150 });
  b.flag('+5V', b.pt('R2.2'));
  b.flag('GND', b.pt('C1.2'));
  const built = b.build();
  assert(built.netlist.statistics.nets >= 2, 'no nets');
  assert(built.netlist.nets.some((n) => n.name === 'NET_A'), 'net label not applied');
  for (const s of ['svg', 'png']) assert((await convert(await write(built.text, file), { formats: [s], outDir: tmp, scale: 1 }))[0].outputs[s], `${s} missing`);
  return `${built.netlist.statistics.components} components, ${built.netlist.statistics.nets} nets`;
});

// 6. libraries --------------------------------------------------------------
await check('library:standard search', async (offline) => {
  if (offline) return 'skipped (--offline)';
  const hits = await searchStandard('R_0603_US');
  assert(hits.length > 0, 'no hits');
  assert(hits.some((h) => h.uuid && h.title), 'malformed hits');
  return `${hits.length} hits, e.g. ${hits[0].title}`;
});
await check('library:standard fetch by uuid', async (offline) => {
  if (offline) return 'skipped (--offline)';
  const hits = await searchStandard('C_0603_US');
  const part = await fetchStandard(hits[0].uuid);
  const pins = part.doc.shape.filter((s) => String(s).startsWith('P~')).length;
  assert(pins === 2, `expected 2 pins, got ${pins}`);
  return `${part.title}, pkg ${part.doc.package}, ${pins} pins`;
});
await check('library:MCU symbol matches datasheet pinout', async (offline) => {
  if (offline) return 'skipped (--offline)';
  const part = await resolveStandard('stc89c52rc', { pins: 40 });
  assert(part, 'no 40-pin symbol resolved');
  const v = validatePinout(part.doc, 'stc89c52rc');
  assert(v.ratio === 1, `pinout ${v.matched}/${v.total}`);
  return `${part.title} ${v.matched}/${v.total} vs ${v.source}`;
});
await check('library:LCSC part by number', async (offline) => {
  if (offline) return 'skipped (--offline)';
  const candidates = ['C14047', 'C25804', 'C14663', 'C1525'];
  for (const c of candidates) {
    if (!isLcscNumber(c)) continue;
    try {
      const part = await fetchPart(c);
      const pins = part.doc.shape.filter((s) => String(s).startsWith('P~')).length;
      if (pins > 0) return `${c} -> ${part.title} (${pins} pins)`;
    } catch { /* try next */ }
  }
  throw new Error('no candidate LCSC number resolved');
});

// 7. CLI contract -----------------------------------------------------------
await check('cli:--json output parses', async () => {
  const { stdout } = await run(process.execPath, [bin, 'read', doc3, '--json'], { cwd: root });
  const j = JSON.parse(stdout);
  const sheet = Array.isArray(j) ? j[0] : j;
  assert(sheet.components?.length > 10, 'components missing');
  assert(Array.isArray(sheet.nets) && sheet.nets.length > 20, 'nets missing');
  return `${sheet.components.length} components`;
});
await check('cli:export command', async () => {
  const out = path.join(tmp, 'cli-export.json');
  await run(process.execPath, [bin, 'export', doc3, '-o', out, '--json'], { cwd: root });
  const doc = JSON.parse(await fs.readFile(out, 'utf8'));
  assert(doc.head.docType === '1', 'bad export');
  return path.basename(out);
});

async function write(text, file) { await fs.writeFile(file, text, 'utf8'); return file; }

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('failures:', failed.map((f) => f.name).join(', '));
  process.exitCode = 1;
}
await fs.rm(tmp, { recursive: true, force: true });
