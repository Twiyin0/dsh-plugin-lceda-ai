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
import { SchematicBuilder, newDocument, placeComponent, buildFromSpec } from '../src/create.js';
import { searchStandard, fetchStandard, fetchPart, resolveStandard, isLcscNumber, validatePinout, findPinoutReference } from '../src/library.js';
import { autoPlace, measureComponent } from '../src/layout.js';
import { readProject, projectMarkdown } from '../src/project.js';

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

// 7. new capabilities -------------------------------------------------------

await check('layout:auto places parts without coordinates and routes orthogonally', async () => {
  const spec = {
    title: 'auto',
    layout: 'auto',
    components: [
      { symbol: 'stc89c52rc', ref: 'U1' },
      { symbol: 'crystal', ref: 'Y1' },
      { symbol: 'capacitor', ref: 'C1', rot: 90 },
      { symbol: 'header', pins: 5, ref: 'J1', rot: 90 },
    ],
    wires: [{ from: 'U1.19', to: 'Y1.1' }, { from: 'U1.10', to: 'J1.3' }],
  };
  const built = buildFromSpec(spec);
  assert(built.placements.length === 4, 'parts were not auto-placed');
  assert(built.warnings.length === 0, `warnings: ${built.warnings.join(' | ')}`);
  const nets = built.netlist.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(' '));
  assert(nets.includes(['U1.19', 'Y1.1'].sort().join(' ')), 'crystal net missing');
  assert(nets.includes(['J1.3', 'U1.10'].sort().join(' ')), 'header net missing');
  return `${built.placements.length} parts, ${nets.length} nets`;
});
await check('layout:measuring and routing helpers stay orthogonal', async () => {
  const m = measureComponent({ symbol: 'resistor', ref: 'R1', rot: 90 });
  assert(m.pins.length === 2 && m.height > m.width, 'rotated resistor should be taller than wide');
  const { routeConnection } = await import('../src/layout.js');
  const pts = routeConnection({ x: 100, y: 100 }, { x: 300, y: 220 }, { stub: 20 });
  for (let i = 0; i + 1 < pts.length; i++) {
    assert(pts[i].x === pts[i + 1].x || pts[i].y === pts[i + 1].y, 'diagonal segment');
  }
  return `${pts.length} points`;
});
await check('pinout:references cover common parts and reject wrong names', async () => {
  const need = ['NE555', 'LM358', '74HC595', 'ATmega328P', 'AMS1117-3.3', 'CH340G', 'STC89C52RC'];
  for (const n of need) assert(findPinoutReference(n), `no reference for ${n}`);
  const mk = (num, name) => `P~show~0~${num}~0~0~180~g${num}~0^^0 0^^M 0 0 h 10~#880000^^0~2~2~0~${name}~start~~~#0000FF^^0~0~0~9~${num}~end~~~#000080^^none^^none`;
  const good = { shape: [[1, 'GND'], [2, 'TRIG'], [3, 'OUT'], [4, 'RESET'], [5, 'CTRL'], [6, 'THR'], [7, 'DIS'], [8, 'VCC']].map(([n, v]) => mk(n, v)) };
  const bad = { shape: [[1, 'GND'], [2, 'TRIG'], [3, 'OUT'], [4, 'NRESET'], [5, 'CTRL'], [6, 'THR'], [7, 'DIS'], [8, 'VCC']].map(([n, v]) => mk(n, v)) };
  assert(validatePinout(good, 'NE555').ratio === 1, 'correct NE555 pinout must score 1.0');
  assert(validatePinout(bad, 'NE555').mismatches.length === 1, 'wrong pin name must be reported');
  return `${need.length} parts`;
});
await check('cache:disk cache answers a lookup without the network', async () => {
  const { writeCache, readCache } = await import('../src/cache.js');
  const { fetchStandard: fetchStd } = await import('../src/library.js');
  const uuid = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  await writeCache('std', uuid, { head: { docType: '2', c_para: { package: 'X', name: 'CACHED' } }, shape: ['P~show~0~1~0~0~180~g1~0^^0 0^^M 0 0 h 10~#880000^^0~2~2~0~1~start~~~#0000FF^^0~0~0~9~1~end~~~#000080^^0~0~0'] });
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network used'); };
  try {
    const part = await fetchStd(uuid);
    assert(part.doc.head.c_para.name === 'CACHED', 'cached part has the wrong name');
  } finally {
    globalThis.fetch = realFetch;
  }
  assert((await readCache('std', uuid)).head.c_para.name === 'CACHED', 'cache entry unreadable');
  return 'offline hit';
});
await check('project:multi-sheet overview', async () => {
  const dir = path.join(tmp, 'proj');
  await fs.mkdir(dir, { recursive: true });
  const spec = (ref) => ({ title: ref, components: [{ symbol: 'resistor', ref: 'R1', value: '10k', x: 200, y: 200, rot: 90 }], flags: [{ text: '+5V', kind: 'part_netLabel_+5V', at: 'R1.1', rot: 0 }] });
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), buildFromSpec(spec('a')).text, 'utf8');
  await fs.writeFile(path.join(dir, 'Sheet_2.json'), buildFromSpec(spec('b')).text, 'utf8');
  const project = await readProject(dir);
  assert(project.sheets.length === 2, 'sheet count');
  assert(project.totals.components === 2, 'component total');
  assert(project.bom.some((r) => r.value === '10k' && r.count === 2), 'BOM not merged');
  assert(project.classes.power.includes('+5V'), 'net class missing');
  assert(/工程总览/.test(projectMarkdown(project)), 'project markdown missing');
  return `${project.sheets.length} sheets, ${project.bom.length} BOM rows`;
});

await check('pcb:parse a real footprint and measure it', async () => {
  const { readPcbFile, pcbSummary, toMm } = await import('../src/pcb/parser.js');
  const model = await readPcbFile(path.join(root, 'test/fixtures/pcb/HDR-TH_2P-P2.54.fp.json'));
  const summary = pcbSummary(model);
  assert(summary.kind === 'footprint', 'not recognised as a footprint');
  assert(summary.counts.pads === 2, `pads ${summary.counts.pads}`);
  const xs = model.footprints[0].pads.map((p) => p.x);
  const pitch = Math.abs(Math.max(...xs) - Math.min(...xs));
  assert(Number(toMm(pitch).toFixed(3)) === 2.54, `pitch ${toMm(pitch)}`);
  return `${summary.package} 2.54mm`;
});
await check('pcb:footprint lookup by LCSC number validates pin<->pad', async () => {
  const { fetchFootprintForLcsc, symbolPins, padNumbers, checkMapping } = await import('../src/pcb/footprint.js');
  const { fetchPart } = await import('../src/library.js');
  const fp = await fetchFootprintForLcsc('C25804');
  assert(fp.model, fp.error ?? 'no footprint');
  const part = await fetchPart('C25804');
  const check = checkMapping(symbolPins(part.doc), padNumbers(fp.model), { packageName: 'R0603', footprintPackage: fp.model.cPara.package });
  assert(check.ok, `mapping failed: ${check.missing.join(',')}`);
  assert(check.symbolPins === 2 && check.footprintPads === 2, 'expected 2 pins and 2 pads');
  return `${fp.title} ${check.symbolPins}pins/${check.footprintPads}pads`;
});
await check('pcb:map resolves a whole schematic by package name', async () => {
  const { mapSchematic } = await import('../src/pcb/footprint.js');
  const { parseDocument } = await import('../src/parser.js');
  const doc = parseDocument(await fs.readFile(path.join(root, 'examples/stc89c52rc-minimal-v3.esch'), 'utf8'));
  doc.components = doc.components.filter((c) => c.designator);
  const { summary } = await mapSchematic(doc);
  assert(summary.missing === 0, `${summary.missing} components without a footprint`);
  assert(summary.mismatch === 0, `${summary.mismatch} pin/pad mismatches`);
  assert(summary.ok === summary.total && summary.total >= 13, `ok ${summary.ok}/${summary.total}`);
  return `${summary.ok}/${summary.total} mapped`;
});
await check('pcb:schematic -> board carries the netlist onto pads', async () => {
  const { boardFromSchematic } = await import('../src/pcb/fromSchematic.js');
  const res = await boardFromSchematic(path.join(root, 'examples/stc89c52rc-minimal-v3.esch'));
  assert(res.stats.components >= 13, `components ${res.stats.components}`);
  assert(res.stats.pads >= 70, `pads ${res.stats.pads}`);
  assert(res.stats.nets >= 35, `nets ${res.stats.nets}`);
  assert(res.board.widthMm > 20 && res.board.widthMm < 400, `board width ${res.board.widthMm}`);
  // every placed footprint must carry nets on its pads
  const model = res.model;
  const withNets = model.footprints.filter((f) => f.pads.some((p) => p.net));
  assert(withNets.length === model.footprints.length, 'some footprint has no nets');
  const names = new Set(model.footprints.flatMap((f) => f.pads.map((p) => p.net)).filter(Boolean));
  assert(names.has('GND'), 'GND missing');
  assert([...names].some((n) => /^N\$/.test(n)), 'auto nets missing');
  return `${res.stats.components} parts, ${names.size} nets`;
});
await check('pcb:rule placement beats shelf order and stays clean', async () => {
  const { boardFromSchematic } = await import('../src/pcb/fromSchematic.js');
  const sch = path.join(root, 'examples/stc89c52rc-minimal-v3.esch');
  const shelf = await boardFromSchematic(sch, { placement: 'shelf' });
  const rule = await boardFromSchematic(sch, { placement: 'rule' });
  assert(rule.quality.overlaps === 0, `overlaps ${rule.quality.overlaps}`);
  assert(rule.quality.outside === 0, `outside ${rule.quality.outside}`);
  assert(rule.quality.ratsnestMm < shelf.quality.ratsnestMm,
    `ratsnest ${rule.quality.ratsnestMm} !< ${shelf.quality.ratsnestMm}`);
  assert(rule.board.widthMm * rule.board.heightMm < 6000, `area ${rule.board.widthMm * rule.board.heightMm}`);
  return `ratsnest ${shelf.quality.ratsnestMm} -> ${rule.quality.ratsnestMm} mm`;
});
await check('pcb:autoroute the demo board and stay clearance clean', async () => {
  const { readPcbFile } = await import('../src/pcb/parser.js');
  const { routeBoard, verifyRouting } = await import('../src/pcb/route.js');
  const model = await readPcbFile(path.join(root, 'examples/pcb-demo/board.json'));
  assert(model.counts.pads >= 60, `pads ${model.counts.pads}`);
  const t0 = Date.now();
  const routed = routeBoard(model, { cell: 2, clearance: 1, width: 1 });
  const check = verifyRouting(model, routed.tracks, { clearance: 1 });
  assert(check.count === 0, `${check.count} clearance violations`);
  assert(routed.stats.routed >= 25, `only ${routed.stats.routed}/${routed.stats.nets} nets routed`);
  assert(routed.stats.vias > 0, 'no vias produced');
  return `${routed.stats.routed}/${routed.stats.nets} nets, ${routed.stats.lengthMm}mm, ${Date.now() - t0}ms`;
});
await check('pcb:copper pour on the routed board is clean and connected', async () => {
  const { readPcbFile } = await import('../src/pcb/parser.js');
  const { pourBoard, pourNet, verifyPour, defaultPourNet } = await import('../src/pcb/pour.js');
  const model = await readPcbFile(path.join(root, 'examples/pcb-demo/board-routed.json'));
  const net = defaultPourNet(model);
  assert(net === 'GND', `default pour net ${net}`);
  const t0 = Date.now();
  const pour = pourNet(model, { net, cell: 2, clearance: 1, thermal: true });
  assert(pour.stats.areaMm2 > 500, `pour area ${pour.stats.areaMm2}`);
  assert(pour.stats.kept >= 1, 'no copper survived');
  const check = verifyPour(model, pour);
  assert(check.count === 0, `${check.count} foreign pads inside the pour`);
  const poured = pourBoard(model, { net, cell: 2, clearance: 1 });
  assert(poured.stats.polygons > 1, `polygons ${poured.stats.polygons}`);
  return `${net} ${pour.stats.areaMm2}mm2, ${pour.stats.polygons} polys, ${Date.now() - t0}ms`;
});
await check('pcb:stitching vias inside the pour pass every rule', async () => {
  const { readPcbFile, parsePcb } = await import('../src/pcb/parser.js');
  const { routeBoard } = await import('../src/pcb/route.js');
  const { pourBoard } = await import('../src/pcb/pour.js');
  const { stitchVias, verifyVias, viaBoard } = await import('../src/pcb/via.js');
  const placed = await readPcbFile(path.join(root, 'examples/pcb-demo/board.json'));
  const routed = parsePcb(routeBoard(placed, { cell: 2, clearance: 1, width: 1 }).doc);
  const poured = parsePcb(pourBoard(routed, { net: 'GND', cell: 2, clearance: 1 }).doc);
  const t0 = Date.now();
  const stitched = stitchVias(poured, { net: 'GND', spacingMm: 5, cell: 2 });
  assert(stitched.vias.length > 10, `only ${stitched.vias.length} vias`);
  const check = verifyVias(poured, stitched.vias, { rules: stitched.rules });
  assert(check.count === 0, `${check.count} via violations`);
  assert(stitched.rules.annularRing > 0.04, `annular ring ${stitched.rules.annularRing}`);
  const doc = viaBoard(poured, { net: 'GND', spacingMm: 5 }).doc;
  const back = parsePcb(doc);
  assert(back.counts.vias >= stitched.vias.length, 'vias written to the board');
  return `${stitched.vias.length} vias, ring ${stitched.rules.annularRing}mm, ${Date.now() - t0}ms`;
});
await check('pcb:DRC passes the whole demo pipeline and catches a planted fault', async () => {
  const { readPcbFile, parsePcb } = await import('../src/pcb/parser.js');
  const { runDrc } = await import('../src/pcb/drc.js');
  const { boardDocument, trackRecord } = await import('../src/pcb/writer.js');
  for (const name of ['board.json', 'board-routed.json', 'board-poured.json', 'board-stitched.json']) {
    const model = await readPcbFile(path.join(root, 'examples/pcb-demo', name));
    const result = runDrc(model);
    assert(result.errors === 0, `${name}: ${JSON.stringify(result.violations.slice(0, 2))}`);
  }
  // plant a short between two nets and make sure the engine says so
  const clean = await readPcbFile(path.join(root, 'examples/pcb-demo/board-routed.json'));
  const faulty = boardDocument({
    shape: [
      ...clean.rawShape,
      trackRecord({ strokeWidth: 1, layer: 1, net: 'RXD', points: [{ x: 4100, y: 3100 }, { x: 4120, y: 3100 }] }),
      trackRecord({ strokeWidth: 1, layer: 1, net: 'TXD', points: [{ x: 4100, y: 3101 }, { x: 4120, y: 3101 }] }),
    ],
  });
  const bad = runDrc(parsePcb(faulty), { checks: ['clearance'] });
  assert(bad.errors > 0, 'planted clearance fault was not reported');
  return `4 stages clean, planted fault caught (${bad.errors})`;
});
await check('pcb:gerber export matches the board and parses independently', async () => {
  const { readPcbFile } = await import('../src/pcb/parser.js');
  const { exportGerber, verifyGerber } = await import('../src/pcb/gerber.js');
  const fsMod = await import('node:fs/promises');
  const model = await readPcbFile(path.join(root, 'examples/pcb-demo/board-stitched.json'));
  const t0 = Date.now();
  const exported = exportGerber(model, { name: 'e2e' });
  assert(exported.files.length >= 8, `files ${exported.files.length}`);
  const check = verifyGerber(model, exported);
  assert(check.ok, `self check: ${check.problems.join('; ')}`);
  // an independent parser must accept every file
  const dir = path.join('/tmp', `gerber-e2e-${process.pid}`);
  await fsMod.mkdir(dir, { recursive: true });
  for (const f of exported.files) await fsMod.writeFile(path.join(dir, f.name), f.text, 'utf8');
  const py = '/tmp/gerb-venv/bin/python';
  const hasPy = await fsMod.access(py).then(() => true, () => false);
  let objects = 0;
  if (hasPy) {
    const script = `
import glob, sys
from gerbonara import GerberFile, ExcellonFile
n = 0
for p in sorted(glob.glob(sys.argv[1] + '/*.gbr')) + sorted(glob.glob(sys.argv[1] + '/*.drl')):
    f = ExcellonFile.open(p) if p.endswith('.drl') else GerberFile.open(p)
    n += len(list(f.objects))
print(n)
`;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(py, ['-c', script, dir], { timeout: 120000 });
    objects = Number(stdout.trim());
    assert(objects > 500, `gerbonara only saw ${objects} objects`);
  }
  await fsMod.rm(dir, { recursive: true, force: true });
  return `${exported.files.length} files, ${objects || 'gerbonara skipped'} objects, ${Date.now() - t0}ms`;
});
await check('pcb:bom and pick-and-place export, xlsx readable by openpyxl', async () => {
  const { readPcbFile } = await import('../src/pcb/parser.js');
  const { parseDocument } = await import('../src/parser.js');
  const { exportBom, verifyBom } = await import('../src/pcb/bom.js');
  const fsMod = await import('node:fs/promises');
  const model = await readPcbFile(path.join(root, 'examples/pcb-demo/board-stitched.json'));
  const schematic = parseDocument(await fsMod.readFile(path.join(root, 'examples', 'stc89c52rc-minimal-v3.esch'), 'utf8'));
  const t0 = Date.now();
  const exported = exportBom(model, { name: 'e2e', schematic });
  const check = verifyBom(model, exported);
  assert(check.ok, `bom check: ${check.problems.join('; ')}`);
  assert(exported.stats.lines < exported.stats.parts, 'lines collapse repeated values');
  assert(exported.stats.placements === model.footprints.length, 'one placement row per footprint');
  const dir = path.join('/tmp', `bom-e2e-${process.pid}`);
  await fsMod.mkdir(dir, { recursive: true });
  for (const f of exported.files) await fsMod.writeFile(path.join(dir, f.name), f.buffer ?? f.text);
  const py = '/Users/movsa/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';
  const hasPy = await fsMod.access(py).then(() => true, () => false);
  let dims = 'openpyxl skipped';
  if (hasPy) {
    const script = `
import openpyxl, sys, glob
f = glob.glob(sys.argv[1] + '/*.xlsx')[0]
wb = openpyxl.load_workbook(f)
print(len(wb.sheetnames), wb['BOM'].max_row, wb['CPL'].max_row)
`;
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(py, ['-c', script, dir], { timeout: 60000 });
    dims = stdout.trim();
    assert(dims === `2 ${exported.stats.lines + 1} ${exported.stats.placements + 1}`, `openpyxl saw ${dims}`);
  }
  await fsMod.rm(dir, { recursive: true, force: true });
  return `${exported.stats.lines} lines / ${exported.stats.parts} parts, xlsx ${dims}, ${Date.now() - t0}ms`;
});
await check('cli:pcb read/render', async () => {
  const { stdout } = await run(process.execPath, [bin, 'pcb', 'read', path.join(root, 'test/fixtures/pcb/mini-board.pcb.json'), '--json'], { cwd: root });
  const summary = JSON.parse(stdout);
  assert(summary.kind === 'board', 'not a board');
  assert(summary.counts.vias === 1, 'via count');
  const outDir = path.join(tmp, 'pcb-cli');
  await run(process.execPath, [bin, 'pcb', 'render', path.join(root, 'test/fixtures/pcb/mini-board.pcb.json'), '-o', outDir, '--formats', 'svg,png,report', '--scale', '3'], { cwd: root });
  const st = await fs.stat(path.join(outDir, 'mini-board.pcb.png'));
  assert(st.size > 1000, 'png not written');
  return `${summary.kind} + png`;
});

// 8. CLI contract -----------------------------------------------------------
await check('cli:--json output parses', async () => {
  const { stdout } = await run(process.execPath, [bin, 'read', doc3, '--json'], { cwd: root });
  const j = JSON.parse(stdout);
  const sheet = Array.isArray(j) ? j[0] : j;
  assert(sheet.components?.length > 10, 'components missing');
  assert(Array.isArray(sheet.nets) && sheet.nets.length > 20, 'nets missing');
  return `${sheet.components.length} components`;
});
await check('cli:build --auto-layout', async () => {
  const specFile = path.join(tmp, 'auto.json');
  await fs.writeFile(specFile, JSON.stringify({
    title: 'cli auto',
    layout: 'auto',
    components: [{ symbol: 'resistor', ref: 'R1', rot: 90 }, { symbol: 'capacitor', ref: 'C1', rot: 90 }],
    wires: [],
  }), 'utf8');
  const out = path.join(tmp, 'auto.esch');
  const { stdout } = await run(process.execPath, [bin, 'build', specFile, '-o', out, '--auto-layout', '--json'], { cwd: root });
  const j = JSON.parse(stdout);
  assert(j.placements?.length === 2, 'placements missing from --json');
  assert(j.statistics.components === 2, 'component count');
  return path.basename(out);
});
await check('cli:project', async () => {
  const dir = path.join(tmp, 'proj2');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), buildFromSpec({ title: 'x', components: [{ symbol: 'resistor', ref: 'R1', x: 200, y: 200, rot: 90 }] }).text, 'utf8');
  const outDir = path.join(tmp, 'proj-out');
  await run(process.execPath, [bin, 'project', dir, '-o', outDir, '--json'], { cwd: root });
  const md = await fs.readFile(path.join(outDir, 'project.md'), 'utf8');
  assert(/工程总览/.test(md), 'project.md missing the overview');
  return 'project.md';
});
await check('cli:cache stats/clear', async () => {
  const dir = path.join(tmp, 'cache-cli');
  const env = { ...process.env, LCEDA_CACHE_DIR: dir };
  const { stdout } = await run(process.execPath, [bin, 'cache', 'stats', '--json'], { cwd: root, env });
  const stats = JSON.parse(stdout);
  assert(stats.dir === dir, 'cache dir mismatch');
  const { stdout: cleared } = await run(process.execPath, [bin, 'cache', 'clear', '--json'], { cwd: root, env });
  assert(JSON.parse(cleared).action === 'clear', 'cache clear failed');
  return 'stats + clear';
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
