// Rule-based placement: classification, clustering, packing and quality metrics.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, clusterOrder, packShelf, rulePlace, layoutQuality, neighboursOf } from '../src/pcb/place.js';
import { readPcbFile } from '../src/pcb/parser.js';
import { footprintExtent } from '../src/pcb/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

test('classify buckets connectors, ICs, decoupling caps and crystals', () => {
  assert.equal(classify({ ref: 'J1', package: 'HDR-M-2.54_1X2', pins: [1, 2] }), 'connector');
  assert.equal(classify({ ref: 'U1', package: 'STC89C52RC', pins: new Array(40).fill(0) }), 'ic');
  assert.equal(classify({ ref: 'C1', package: 'C0603', pins: [1, 2], netsByPad: { 1: '+5V', 2: 'GND' } }), 'decoupling');
  assert.equal(classify({ ref: 'R1', package: 'R0603', pins: [1, 2], netsByPad: { 1: 'N$1', 2: 'N$2' } }), 'passive');
  assert.equal(classify({ ref: 'Y1', package: '晶振HC-49S', pins: [1, 2], netsByPad: { 1: 'XTAL1', 2: 'XTAL2' } }), 'crystal');
});

test('neighboursOf links parts that share a net', () => {
  const { neighbours, netsOf } = neighboursOf({ nets: [
    { name: 'XTAL1', pins: [{ ref: 'U1', pin: '19' }, { ref: 'Y1', pin: '1' }, { ref: 'C1', pin: '1' }] },
    { name: 'GND', pins: [{ ref: 'C1', pin: '2' }] },
    { name: 'LED', pins: [{ ref: 'D1', pin: '1' }] },
  ] });
  assert.ok(neighbours.get('U1').has('Y1'));
  assert.ok(neighbours.get('Y1').has('C1'));
  assert.ok(neighbours.get('U1').has('C1'), 'C1.1 sits on XTAL1 too, so they share a net');
  assert.ok(!neighbours.get('U1').has('D1'), 'D1 is on an unrelated net');
  assert.ok(netsOf.get('C1').has('XTAL1') && netsOf.get('C1').has('GND'));
});

test('clusterOrder keeps electrically related parts adjacent', () => {
  const entries = [
    { ref: 'U1', package: 'MCU', pins: new Array(40).fill(0) },
    { ref: 'Y1', package: 'XTAL', pins: [1, 2] },
    { ref: 'C1', package: 'C0603', pins: [1, 2] },
    { ref: 'J1', package: 'HDR', pins: [1, 2] },
  ];
  const netlist = { nets: [
    { name: 'XTAL1', pins: [{ ref: 'U1', pin: '19' }, { ref: 'Y1', pin: '1' }] },
    { name: 'XTAL2', pins: [{ ref: 'U1', pin: '18' }, { ref: 'Y1', pin: '2' }] },
    { name: 'GND', pins: [{ ref: 'Y1', pin: '2' }, { ref: 'C1', pin: '2' }] },
  ] };
  const order = clusterOrder(entries, netlist).map((e) => e.ref);
  assert.equal(order[0], 'U1', 'the IC anchors the order');
  assert.ok(order.indexOf('Y1') < order.indexOf('J1'), 'the crystal comes before the connector');
  assert.ok(order.indexOf('C1') < order.indexOf('J1'), 'and so does its capacitor');
});

test('packShelf never overlaps and stays inside the row width', async () => {
  const fp = await readPcbFile(fixture('R0603.fp.json'));
  const extent = footprintExtent(fp);
  const items = ['R1', 'R2', 'R3', 'R4'].map((ref) => ({ ref, box: { ...extent, w: extent.width * 0.254, h: extent.height * 0.254, minX: extent.minX * 0.254, minY: extent.minY * 0.254, maxX: extent.maxX * 0.254, maxY: extent.maxY * 0.254 }, kind: 'passive' }));
  const packed = packShelf(items, { maxWidthMm: 10, gapMm: 1 });
  const boxes = [...packed.placed.values()].map((p) => p.box);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlap = !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
      assert.ok(!overlap, `${items[i].ref} overlaps ${items[j].ref}`);
    }
  }
  assert.ok(packed.board.widthMm <= 12, `row width respected (${packed.board.widthMm})`);
});

test('layoutQuality counts ratsnest, overlaps and parts outside', () => {
  const netlist = { nets: [{ name: 'N', pins: [{ ref: 'A', pin: '1' }, { ref: 'B', pin: '1' }] }] };
  const ext = { minX: -10, minY: -10, maxX: 10, maxY: 10 };
  const q = layoutQuality([{ ref: 'A', x: 0, y: 0, extent: ext }, { ref: 'B', x: 100, y: 0, extent: ext }], netlist, { minX: -100, minY: -100, maxX: 200, maxY: 100 });
  assert.equal(q.ratsnestMm, 25.4, '100 units = 25.4 mm');
  assert.equal(q.overlaps, 0);
  assert.equal(q.outside, 0);

  const overlapping = layoutQuality([{ ref: 'A', x: 0, y: 0, extent: ext }, { ref: 'B', x: 5, y: 0, extent: ext }], netlist, { minX: -100, minY: -100, maxX: 200, maxY: 100 });
  assert.equal(overlapping.overlaps, 1);

  const outside = layoutQuality([{ ref: 'A', x: 0, y: 0, extent: ext }], netlist, { minX: -5, minY: -5, maxX: 5, maxY: 5 });
  assert.equal(outside.outside, 1);
});

test('rulePlace beats plain shelf order on a real board', async () => {
  const { boardFromSchematic } = await import('../src/pcb/fromSchematic.js');
  const schematic = path.join(here, 'fixtures', 'minimal-v3.esch');
  const shelf = await boardFromSchematic(schematic, { placement: 'shelf' });
  const rule = await boardFromSchematic(schematic, { placement: 'rule' });
  assert.equal(rule.quality.overlaps, 0, 'no overlaps');
  assert.equal(rule.quality.outside, 0, 'nothing outside the outline');
  assert.ok(rule.quality.ratsnestMm < shelf.quality.ratsnestMm,
    `rule ratsnest ${rule.quality.ratsnestMm} should beat shelf ${shelf.quality.ratsnestMm}`);
  assert.ok(rule.board.widthMm * rule.board.heightMm < 6000, 'board stays compact');
});
