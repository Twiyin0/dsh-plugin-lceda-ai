// PCB/footprint parsing: the field order and the coordinate unit were measured
// against real library footprints, so these tests pin both down.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPcbFile, pcbSummary, boardOutline, copperItems, layerName, isCopper, toMm, parsePath } from '../src/pcb/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

test('layer ids follow the editor table', () => {
  assert.equal(layerName(1), 'TopLayer');
  assert.equal(layerName(2), 'BottomLayer');
  assert.equal(layerName(3), 'TopSilkLayer');
  assert.equal(layerName(10), 'BoardOutLine');
  assert.equal(layerName(11), 'Multi-Layer');
  assert.equal(layerName(21), 'Inner1');
  assert.equal(layerName(52), 'Inner32');
  assert.equal(isCopper(1), true);
  assert.equal(isCopper(2), true);
  assert.equal(isCopper(11), true);
  assert.equal(isCopper(21), true);
  assert.equal(isCopper(3), false);
});

test('1 file unit is 0.254 mm (10 mil)', () => {
  assert.equal(toMm(10), 2.54);
  assert.equal(toMm(400), 101.6);
});

test('a real 0603 footprint parses with the right pad geometry', async () => {
  const model = await readPcbFile(fixture('R0603.fp.json'));
  assert.equal(model.isFootprint, true);
  assert.equal(model.cPara.package, 'R0603');
  const fp = model.footprints[0];
  assert.equal(fp.pads.length, 2);
  // pads are 0.81 x 0.86 mm and 1.507 mm apart - both measured, not assumed
  for (const pad of fp.pads) {
    assert.ok(Math.abs(toMm(pad.width) - 0.81) < 0.02, `pad width ${toMm(pad.width)}`);
    assert.ok(Math.abs(toMm(pad.height) - 0.86) < 0.02, `pad height ${toMm(pad.height)}`);
    assert.equal(pad.shape, 'RECT');
    assert.equal(pad.layer, 1);
  }
  const xs = fp.pads.map((p) => p.x);
  const pitch = Math.abs(Math.max(...xs) - Math.min(...xs));
  assert.ok(Math.abs(toMm(pitch) - 1.507) < 0.01, `pitch ${toMm(pitch)} mm`);
  assert.deepEqual(fp.pads.map((p) => p.number).sort(), ['1', '2']);
});

test('a real 2.54 mm header footprint measures exactly 2.54 mm pitch', async () => {
  const model = await readPcbFile(fixture('HDR-TH_2P-P2.54.fp.json'));
  const fp = model.footprints[0];
  assert.equal(fp.pads.length, 2);
  const xs = fp.pads.map((p) => p.x);
  const pitch = Math.abs(Math.max(...xs) - Math.min(...xs));
  assert.equal(Number(toMm(pitch).toFixed(3)), 2.54);
  // through-hole pads live on Multi-Layer, pin 1 square and the rest round
  for (const pad of fp.pads) assert.equal(pad.layer, 11);
  assert.deepEqual(fp.pads.map((p) => p.shape).sort(), ['ELLIPSE', 'RECT']);
});

test('a board document yields footprints, routing, pours and its outline', async () => {
  const model = await readPcbFile(fixture('mini-board.pcb.json'));
  assert.equal(model.isBoard, true);
  assert.equal(model.counts.footprints, 1);
  assert.equal(model.counts.pads, 2);
  assert.equal(model.counts.vias, 1);
  assert.equal(model.counts.copperAreas, 1);
  assert.equal(model.footprints[0].cPara.package, 'R0603');

  const outline = boardOutline(model);
  assert.ok(outline, 'board outline found on layer 10');
  assert.equal(Number(outline.widthMm.toFixed(1)), 101.6);
  assert.equal(Number(outline.heightMm.toFixed(1)), 101.6);

  const copper = copperItems(model);
  const kinds = copper.map((c) => c.kind).sort();
  assert.ok(kinds.includes('via') && kinds.includes('pour') && kinds.includes('track') && kinds.includes('pad'));
  assert.ok(copper.filter((c) => c.kind === 'track').every((c) => isCopper(c.layer)));
  // design rules come straight from the document
  assert.equal(model.drc.default.trackWidth, 0.6);
  assert.equal(model.drc.default.clearance, 0.6);
});

test('a footprint keeps its own pads out of the board element list', async () => {
  const model = await readPcbFile(fixture('mini-board.pcb.json'));
  // the LIB footprint's PAD/TRACK records must not leak into board elements
  assert.equal(model.elements.filter((e) => e.type === 'PAD').length, 0);
  assert.equal(model.elements.filter((e) => e.type === 'TRACK').length, 3);
});

test('path strings turn into points (absolute, relative, H/V)', () => {
  assert.deepEqual(parsePath('M 0 0 L 10 0 L 10 10'), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
  assert.deepEqual(parsePath('M 5 5 h 10 v 10'), [{ x: 5, y: 5 }, { x: 15, y: 5 }, { x: 15, y: 15 }]);
});

test('summary is machine readable', async () => {
  const s = pcbSummary(await readPcbFile(fixture('mini-board.pcb.json')));
  assert.equal(s.kind, 'board');
  assert.equal(s.counts.vias, 1);
  assert.deepEqual(s.footprints.map((f) => f.name), ['R1']);
  assert.ok(s.layers.includes('TopLayer'));
});
