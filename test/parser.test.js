import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, extractNetlist, renderSVG, buildReport } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mini.json');

async function loadDoc() {
  return parseDocument(await fs.readFile(fixture, 'utf8'));
}

test('parses all primitive shape kinds', async () => {
  const doc = await loadDoc();
  const kinds = new Set(doc.shapes.map((s) => s.type));
  for (const k of ['text', 'path', 'polyline', 'rect', 'ellipse', 'wire', 'junction', 'netflag', 'netlabel', 'component']) {
    assert.ok(kinds.has(k), `missing shape type ${k}`);
  }
  assert.equal(doc.warnings.length, 0, `unexpected warnings: ${doc.warnings}`);
  assert.equal(doc.components.length, 3);
});

test('parses component metadata, pins, names and numbers', async () => {
  const doc = await loadDoc();
  const r1 = doc.components.find((c) => c.designator === 'R1');
  assert.ok(r1, 'R1 not found');
  assert.equal(r1.value, '1k');
  assert.equal(r1.package, 'R0603');
  assert.equal(r1.pins.length, 2);
  assert.deepEqual([r1.pins[0].number, r1.pins[0].name, r1.pins[0].x, r1.pins[0].y], ['1', 'A', 100, -100]);
  assert.deepEqual([r1.pins[1].number, r1.pins[1].name, r1.pins[1].x, r1.pins[1].y], ['2', 'B', 140, -100]);
  const c1 = doc.components.find((c) => c.designator === 'C1');
  assert.equal(c1.pins[0].name, 'P1');
  assert.equal(c1.pins[1].name, 'P2');
});

test('netflag nets carry the flag text and graphics', async () => {
  const doc = await loadDoc();
  const flags = doc.shapes.filter((s) => s.type === 'netflag');
  assert.equal(flags.length, 3);
  const gnd = flags.find((f) => f.text === 'GND');
  assert.deepEqual(gnd.anchor, [400, -100]);
  assert.ok(gnd.graphics.length >= 1);
});

test('netlist: label-named net joins pins touching the wire', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  const vcc = nl.nets.find((n) => n.name === 'VCC_TEST');
  assert.ok(vcc, 'VCC_TEST net missing');
  const refs = vcc.pins.map((p) => `${p.ref}.${p.pin}`).sort();
  assert.deepEqual(refs, ['R1.1', 'R1.2']);
  assert.equal(vcc.conflict, false);
});

test('netlist: netflag names the net, junction does not leak across nets', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  const gnd = nl.nets.find((n) => n.name === 'GND');
  assert.ok(gnd, 'GND net missing');
  assert.deepEqual(gnd.pins.map((p) => `${p.ref}.${p.pin}`).sort(), ['C1.1', 'C1.2']);
  // the VCC_TEST net must not have been merged into GND
  assert.ok(!gnd.pins.some((p) => p.ref === 'R1'));
});

test('netlist: conflicting power flags on one net are reported, not merged away', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  const conflicting = nl.nets.filter((n) => n.conflict);
  assert.equal(conflicting.length, 1);
  assert.equal(conflicting[0].name, 'GND');
  assert.deepEqual(conflicting[0].aliases, ['+5V']);
  assert.equal(nl.statistics.conflicts, 1);
});

test('netlist: dangling pin forms its own single-pin net', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  const j1net = nl.nets.find((n) => n.pins.some((p) => p.ref === 'J1'));
  assert.equal(j1net.pins.length, 1);
  assert.equal(j1net.named, false);
  assert.match(j1net.name, /^N\$/);
});

test('netlist: pin->net index is complete', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  assert.equal(nl.pinNets.get('R1.1'), 'VCC_TEST');
  assert.equal(nl.pinNets.get('C1.2'), 'GND');
  const totalPins = nl.components.reduce((a, c) => a + c.pins.length, 0);
  assert.equal(nl.pinNets.size, totalPins);
});

test('svg render contains frame, wires, labels and is valid XML-ish', async () => {
  const doc = await loadDoc();
  const svg = renderSVG(doc, { title: 'mini' });
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<svg /);
  assert.match(svg, /viewBox="-10 -270 620 280"/);
  assert.match(svg, /VCC_TEST/);
  assert.match(svg, /<polyline/);
  assert.match(svg, /<rect/);
  assert.match(svg, /<ellipse/);
  assert.match(svg, /<polygon/);
  assert.match(svg, /<path/);
  assert.ok(!/fill="none"[^>]*fill=/.test(svg), 'duplicate fill attribute');
});

test('report contains BOM, pin tables, netlist and conflict section', async () => {
  const doc = await loadDoc();
  const nl = extractNetlist(doc);
  const { json, markdown } = buildReport(doc, nl, { sheetName: 'mini' });
  assert.equal(json.components.length, 3);
  assert.match(markdown, /器件清单/);
  assert.match(markdown, /网络表/);
  assert.match(markdown, /网络命名冲突/);
  assert.match(markdown, /VCC_TEST/);
});
