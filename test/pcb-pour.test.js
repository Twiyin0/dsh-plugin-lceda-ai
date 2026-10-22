// Copper pour: raster fill, thermal spokes, island removal and the self check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPourGrid, fillPour, tracePolygons, simplifyLoop, signedArea, pourNet, pourBoard, verifyPour, defaultPourNet } from '../src/pcb/pour.js';
import { readPcbFile, parsePcb } from '../src/pcb/parser.js';
import { boardDocument, padRecord, trackRecord } from '../src/pcb/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

/** Board: outline 200x160 units, one GND pad in the middle, one N1 pad beside it. */
function toyBoard({ net = 'GND' } = {}) {
  const pad = (x, y, n, number) => padRecord({ shape: 'RECT', x, y, width: 8, height: 8, layer: 1, net: n, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  return boardDocument({
    shape: [
      lib('U1', 4100, 3060, [pad(4100, 3060, net, '1'), pad(4120, 3060, 'N1', '2')]),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4000, y: 3000 }, { x: 4200, y: 3000 }, { x: 4200, y: 3160 }, { x: 4000, y: 3160 }, { x: 4000, y: 3000 }] }),
    ],
  });
}

test('defaultPourNet prefers ground, then a rail', () => {
  const model = parsePcb(toyBoard({ net: 'GND' }));
  assert.equal(defaultPourNet(model), 'GND');
  const withRail = parsePcb(toyBoard({ net: '+5V' }));
  assert.equal(defaultPourNet(withRail), '+5V');
});

test('the fill covers the board area minus clearance', () => {
  const model = parsePcb(toyBoard());
  const grid = buildPourGrid(model, { net: 'GND', cell: 2, clearance: 2 });
  const fill = fillPour(grid);
  assert.ok(fill.stats.filledCells > 1000, `filled ${fill.stats.filledCells} cells`);
  // the foreign pad's clearance ring must be empty
  const c = grid.toCell(4120, 3060);
  assert.equal(grid.at(c.i, c.j), 0, 'foreign pad is not copper');
  // ... and so is the clearance ring just outside it (pad half width 4 + clearance 2)
  const ring = grid.toCell(4120 + 5, 3060);
  assert.equal(grid.at(ring.i, ring.j), 0, 'clearance ring is empty');
  const outside = grid.toCell(4120 + 9, 3060);
  assert.equal(grid.at(outside.i, outside.j), 1, 'beyond the ring is copper');
});

test('thermal spokes keep the pour connected to its own pad', () => {
  const model = parsePcb(toyBoard());
  const withThermal = fillPour(buildPourGrid(model, { net: 'GND', cell: 2, clearance: 2, thermal: true, spokeWidth: 2 }));
  const without = fillPour(buildPourGrid(model, { net: 'GND', cell: 2, clearance: 2, thermal: false }));
  assert.ok(withThermal.stats.filledCells > 0, 'thermal pour keeps its copper');
  assert.equal(without.stats.filledCells, 0, 'without spokes every island is dropped');
  assert.ok(withThermal.stats.kept >= 1);
});

test('islands that touch no pad of the net are removed', () => {
  const model = parsePcb(toyBoard());
  const grid = buildPourGrid(model, { net: 'N1', cell: 2, clearance: 2, thermal: true });
  const fill = fillPour(grid);
  // N1 has exactly one pad, so at most one component may survive
  assert.ok(fill.stats.kept <= 1, `kept ${fill.stats.kept} components for a one-pad net`);
  const keepIslands = fillPour(buildPourGrid(model, { net: 'N1', cell: 2, clearance: 2 }), { keepIslands: true });
  assert.ok(keepIslands.stats.kept >= 1, 'keepIslands keeps the biggest piece');
});

test('tracePolygons returns closed loops whose signed area is the copper', () => {
  const model = parsePcb(toyBoard());
  const grid = buildPourGrid(model, { net: 'GND', cell: 2, clearance: 2 });
  const fill = fillPour(grid);
  const polygons = tracePolygons(grid, fill);
  assert.ok(polygons.length >= 1, 'at least one loop');
  for (const poly of polygons) assert.ok(poly.length >= 4, `loop has ${poly.length} points`);
  const total = polygons.reduce((n, p) => n + signedArea(p), 0);
  assert.ok(total > 0, `outer contours wind clockwise (signed area ${total})`);
  const pour = pourNet(model, { net: 'GND', cell: 2, clearance: 2 });
  assert.ok(pour.stats.areaMm2 > 0);
  const boardArea = (200 * 0.254) * (160 * 0.254);
  assert.ok(pour.stats.areaMm2 < boardArea, `pour ${pour.stats.areaMm2} mm2 must fit in ${boardArea.toFixed(0)} mm2`);
});

test('simplifyLoop drops collinear midpoints', () => {
  const square = [
    { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 },
    { x: 10, y: 10 }, { x: 0, y: 10 },
  ];
  const out = simplifyLoop(square);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((p) => [p.x, p.y]), [[0, 0], [10, 0], [10, 10], [0, 10]]);
});

test('pourNet never covers a pad of another net', () => {
  const model = parsePcb(toyBoard());
  const pour = pourNet(model, { net: 'GND', cell: 2, clearance: 2 });
  const check = verifyPour(model, pour);
  assert.equal(check.count, 0, JSON.stringify(check.violations.slice(0, 3)));
});

test('pourBoard adds COPPERAREA records that parse back', () => {
  const model = parsePcb(toyBoard());
  const { doc, stats } = pourBoard(model, { net: 'GND', cell: 2, clearance: 2 });
  assert.ok(stats.polygons >= 1);
  const back = parsePcb(doc);
  assert.equal(back.counts.copperAreas, stats.polygons);
  const pour = back.elements.find((e) => e.type === 'COPPERAREA');
  assert.equal(pour.net, 'GND');
  assert.equal(pour.layer, 1);
  assert.ok(pour.path.length >= 4, 'outline survived the round trip');
});

test('a real routed board pours cleanly and stays clear of other nets', async () => {
  const demo = path.join(here, 'fixtures', 'pcb-demo', 'board-routed.json');
  const model = await readPcbFile(demo);
  const pour = pourNet(model, { net: 'GND', cell: 2 });
  assert.ok(pour.stats.areaMm2 > 500, `copper produced (${pour.stats.areaMm2} mm2)`);
  assert.ok(pour.stats.polygons > 1, 'a routed board breaks the pour into pieces');
  const check = verifyPour(model, pour);
  assert.equal(check.count, 0, `no foreign pad inside the pour: ${JSON.stringify(check.violations.slice(0, 2))}`);
});
