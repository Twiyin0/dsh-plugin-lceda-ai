// Auto layout: parts get coordinates, never overlap, and auto-routed wires stay
// orthogonal, keep their endpoints on the pins and never short two nets.
import test from 'node:test';
import assert from 'node:assert/strict';

import { measureComponent, autoPlace, routeConnection } from '../src/layout.js';
import { buildFromSpec } from '../src/create.js';

const overlaps = (a, b) => !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);

test('measureComponent reports artwork size and pin offsets', () => {
  const r = measureComponent({ symbol: 'resistor', ref: 'R1', rot: 90 });
  assert.ok(r.width >= 10 && r.height >= 60, `resistor box ${r.width}x${r.height}`);
  assert.equal(r.pins.length, 2);
  assert.ok(r.pins.every((p) => p.y !== 0), 'rotated resistor pins sit above/below the centre');

  const cap = measureComponent({ symbol: 'capacitor', ref: 'C1', rot: 90 });
  assert.ok(cap.width >= 20, 'capacitor plates count towards the width');

  const hdr = measureComponent({ symbol: 'header', pins: 5, ref: 'J1' });
  assert.equal(hdr.pins.length, 5);
  assert.ok(hdr.height >= 60, `header should be tall enough for 5 pins, got ${hdr.height}`);
});

test('autoPlace puts every part inside the sheet without overlaps', () => {
  const comps = [
    { symbol: 'stc89c52rc', ref: 'U1' },
    { symbol: 'crystal', ref: 'Y1' },
    { symbol: 'capacitor', ref: 'C1', rot: 90 },
    { symbol: 'capacitor', ref: 'C2', rot: 90 },
    { symbol: 'resistor', ref: 'R1', rot: 90 },
    { symbol: 'switch', ref: 'SW1', rot: 90 },
    { symbol: 'header', pins: 5, ref: 'J1', rot: 90 },
  ];
  const { components, placements, warnings } = autoPlace(comps, { width: 1160, height: 820 });
  assert.equal(placements.length, comps.length);
  assert.deepEqual(warnings, []);
  for (const c of components) assert.ok(Number.isFinite(c.x) && Number.isFinite(c.y), `${c.ref} unplaced`);
  for (let i = 0; i < placements.length; i++) {
    for (let j = i + 1; j < placements.length; j++) {
      assert.ok(!overlaps(placements[i].box, placements[j].box),
        `${placements[i].ref} overlaps ${placements[j].ref}`);
    }
  }
});

test('autoPlace keeps hand-placed coordinates', () => {
  const { components } = autoPlace([
    { symbol: 'resistor', ref: 'R1', x: 111, y: 222 },
    { symbol: 'capacitor', ref: 'C1', rot: 90 },
  ]);
  const r1 = components.find((c) => c.ref === 'R1');
  assert.equal(r1.x, 111);
  assert.equal(r1.y, 222);
  assert.ok(Number.isFinite(components.find((c) => c.ref === 'C1').x));
});

test('routeConnection is orthogonal, keeps its endpoints and avoids a blocking part', () => {
  const from = { x: 100, y: 300 };
  const to = { x: 500, y: 300 };
  const blocker = { minX: 250, maxX: 350, minY: 250, maxY: 350 };
  const pts = routeConnection(from, to, { stub: 20, obstacles: [blocker] });
  assert.deepEqual(pts[0], from);
  assert.deepEqual(pts[pts.length - 1], to);
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i], pts[i + 1]];
    assert.ok(p.x === q.x || p.y === q.y, `segment ${i} is diagonal: ${JSON.stringify(p)} -> ${JSON.stringify(q)}`);
  }
  const crosses = (p, q) => (p.y === q.y
    ? p.y > blocker.minY && p.y < blocker.maxY && Math.max(p.x, q.x) > blocker.minX && Math.min(p.x, q.x) < blocker.maxX
    : p.x > blocker.minX && p.x < blocker.maxX && Math.max(p.y, q.y) > blocker.minY && Math.min(p.y, q.y) < blocker.maxY);
  for (let i = 0; i + 1 < pts.length; i++) {
    assert.ok(!crosses(pts[i], pts[i + 1]), `segment ${i} cuts through the blocker`);
  }
});

test('buildFromSpec with layout:auto connects exactly what the spec asked for', () => {
  const spec = {
    title: 'auto',
    layout: 'auto',
    components: [
      { symbol: 'stc89c52rc', ref: 'U1' },
      { symbol: 'crystal', ref: 'Y1' },
      { symbol: 'capacitor', ref: 'C1', rot: 90 },
      { symbol: 'capacitor', ref: 'C2', rot: 90 },
      { symbol: 'header', pins: 5, ref: 'J1', rot: 90 },
    ],
    wires: [
      { from: 'U1.19', to: 'Y1.1' },
      { from: 'U1.18', to: 'Y1.2' },
      { from: 'Y1.1', to: 'C1.1' },
      { from: 'Y1.2', to: 'C2.1' },
      { from: 'U1.10', to: 'J1.3' },
      { from: 'U1.11', to: 'J1.4' },
    ],
  };
  const { netlist, placements, warnings } = buildFromSpec(spec);
  assert.equal(placements.length, 5);
  assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join(' | ')}`);

  const named = netlist.nets.filter((n) => n.pins.length > 1).map((n) => n.pins.map((p) => `${p.ref}.${p.pin}`).sort().join(' '));
  const expected = [
    ['C1.1', 'U1.19', 'Y1.1'],
    ['C2.1', 'U1.18', 'Y1.2'],
    ['J1.3', 'U1.10'],
    ['J1.4', 'U1.11'],
  ].map((g) => g.sort().join(' '));
  for (const group of expected) assert.ok(named.includes(group), `missing net ${group} (got ${named.join(' | ')})`);
  // nothing merged: 4 nets of interest and no others
  assert.equal(named.filter((n) => n.includes('Y1') || n.includes('J1')).length, 4);
});
