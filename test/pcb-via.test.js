// Vias: rules, stitching inside a pour, and the clearance / hole-to-hole checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { viaRules, stitchVias, verifyVias, viaBoard, copperObstacles, VIA_TYPES } from '../src/pcb/via.js';
import { readPcbFile, parsePcb } from '../src/pcb/parser.js';
import { boardDocument, padRecord, trackRecord, viaRecord } from '../src/pcb/writer.js';
import { routeBoard } from '../src/pcb/route.js';
import { pourBoard } from '../src/pcb/pour.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, 'fixtures', 'pcb-demo');

function toyBoard() {
  const pad = (x, y, net, number) => padRecord({ shape: 'RECT', x, y, width: 8, height: 8, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  return boardDocument({
    shape: [
      lib('U1', 4100, 3060, [pad(4100, 3060, 'GND', '1'), pad(4120, 3060, 'N1', '2')]),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4000, y: 3000 }, { x: 4200, y: 3000 }, { x: 4200, y: 3160 }, { x: 4000, y: 3160 }, { x: 4000, y: 3000 }] }),
    ],
  });
}

test('via rules come from the DRC block and stay manufacturable', () => {
  const model = parsePcb(toyBoard());
  const r = viaRules(model, { net: 'GND' });
  assert.equal(r.type, 'through');
  assert.ok(r.diameter >= 2 && r.drill >= 1);
  assert.ok(r.annularRing > 0, `annular ring ${r.annularRing}`);
  assert.equal(r.ok, true);
  assert.ok(VIA_TYPES.through && VIA_TYPES.blind && VIA_TYPES.buried, 'via types are modelled');
});

test('copperObstacles sees every layer (a through via spans them all)', () => {
  const model = parsePcb(toyBoard());
  const obstacles = copperObstacles(model);
  assert.ok(obstacles.some((o) => o.kind === 'pad' && o.net === 'GND'));
  assert.ok(obstacles.some((o) => o.kind === 'pad' && o.net === 'N1'));
});

test('stitching puts vias only where the pour has copper', () => {
  const model = parsePcb(toyBoard());
  const { vias, stats } = stitchVias(model, { net: 'GND', spacingMm: 5, cell: 2 });
  assert.ok(stats.placed > 0, 'vias placed');
  assert.equal(stats.net, 'GND');
  // every via must sit inside the pour: sample the point against the pour grid
  const check = verifyVias(model, vias, { rules: viaRules(model, { net: 'GND' }) });
  assert.equal(check.count, 0, JSON.stringify(check.violations.slice(0, 3)));
});

test('stitching refuses to run without a net', () => {
  const model = parsePcb(toyBoard());
  const { vias, stats } = stitchVias(model, { net: '' });
  assert.equal(vias.length, 0);
  assert.match(stats.reason, /no net/);
});

test('verifyVias flags a via dropped on foreign copper', () => {
  const model = parsePcb(toyBoard());
  const bad = [{ x: 4120, y: 3060, net: 'GND', diameter: 2, holeR: 0.5 }];   // right on the N1 pad
  const check = verifyVias(model, bad, { rules: viaRules(model) });
  assert.ok(check.count > 0, 'a via on another net is a violation');
  assert.equal(check.violations[0].kind, 'clearance');
});

test('verifyVias flags holes that are too close together', () => {
  const model = parsePcb(toyBoard());
  const close = [
    { x: 4050, y: 3050, net: 'GND', diameter: 2, holeR: 0.5 },
    { x: 4051, y: 3050, net: 'GND', diameter: 2, holeR: 0.5 },
  ];
  const check = verifyVias(model, close, { rules: viaRules(model) });
  assert.ok(check.violations.some((v) => v.kind === 'hole-to-hole'), JSON.stringify(check.violations));
});

test('viaBoard adds VIA records that parse back with their net', () => {
  const model = parsePcb(toyBoard());
  const { doc, vias } = viaBoard(model, { net: 'GND', spacingMm: 5, cell: 2 });
  const back = parsePcb(doc);
  assert.equal(back.counts.vias, vias.length);
  const via = back.elements.find((e) => e.type === 'VIA');
  assert.equal(via.net, 'GND');
  assert.ok(via.diameter > 0 && via.holeR > 0);
});

test('the demo board stitches cleanly at several spacings', async () => {
  const placed = await readPcbFile(path.join(demo, 'board.json'));
  const routed = parsePcb(routeBoard(placed, { cell: 2, clearance: 1, width: 1 }).doc);
  const poured = parsePcb(pourBoard(routed, { net: 'GND', cell: 2, clearance: 1 }).doc);
  for (const spacingMm of [3, 5, 8]) {
    const { vias, rules } = stitchVias(poured, { net: 'GND', spacingMm });
    const check = verifyVias(poured, vias, { rules });
    assert.equal(check.count, 0, `spacing ${spacingMm}: ${JSON.stringify(check.violations.slice(0, 2))}`);
    assert.ok(vias.length > 0, `spacing ${spacingMm}: no vias`);
  }
});
