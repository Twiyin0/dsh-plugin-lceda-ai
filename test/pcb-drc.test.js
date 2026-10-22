// DRC: rules, geometry helpers and the individual checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDrc, rulesFor, segmentDistance, segmentRectDistance, drcMarkdown } from '../src/pcb/drc.js';
import { readPcbFile, parsePcb, UNIT_MM } from '../src/pcb/parser.js';
import { boardDocument, padRecord, trackRecord, viaRecord } from '../src/pcb/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, 'fixtures', 'pcb-demo');

/** Board with two nets, a thin track, a fat via hole and a tight pair. */
function board(shape) {
  return boardDocument({
    shape: [
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4000, y: 3000 }, { x: 4300, y: 3000 }, { x: 4300, y: 3300 }, { x: 4000, y: 3300 }, { x: 4000, y: 3000 }] }),
      ...shape,
    ],
  });
}
const pad = (x, y, net, number) => padRecord({ shape: 'RECT', x, y, width: 8, height: 8, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');

test('rulesFor converts the DRC block from mm to units', () => {
  const model = parsePcb(board([lib('U1', 4100, 3100, [pad(4100, 3100, 'N1', '1')])]));
  const r = rulesFor(model);
  assert.equal(r.clearance, 1, '0.254 mm = 1 unit');
  assert.equal(r.trackWidth, 1);
  assert.ok(r.holeToHole >= 1);
  // a rule of 0 must stay 0 ("do not check")
  assert.equal(rulesFor(model, { overrides: { silkClearance: 0 } }).silkClearance, 0);
});

test('geometry helpers measure what the checks rely on', () => {
  assert.equal(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }), 0, 'crossing segments touch');
  assert.equal(segmentDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 }), 5);
  assert.equal(segmentRectDistance({ x: 0, y: 0 }, { x: 10, y: 0 }, { minX: 5, minY: 3, maxX: 8, maxY: 6 }), 3);
  assert.equal(segmentRectDistance({ x: 0, y: 4 }, { x: 10, y: 4 }, { minX: 5, minY: 3, maxX: 8, maxY: 6 }), 0, 'inside the rect');
});

test('a clean board passes every check', () => {
  const model = parsePcb(board([
    lib('U1', 4100, 3100, [pad(4100, 3100, 'N1', '1'), pad(4160, 3100, 'N1', '2')]),
  ]));
  const result = runDrc(model);
  assert.equal(result.ok, true, JSON.stringify(result.violations.slice(0, 3)));
});

test('clearance between two tracks of different nets is measured', () => {
  const model = parsePcb(board([
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4200, y: 3100 }] }),
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N2', points: [{ x: 4100, y: 3101 }, { x: 4200, y: 3101 }] }),
  ]));
  const result = runDrc(model, { checks: ['clearance'] });
  assert.ok(result.violations.some((v) => v.type === 'clearance' && v.otherNet), JSON.stringify(result.violations));
  // the same geometry on different layers is fine
  const otherLayer = parsePcb(board([
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4200, y: 3100 }] }),
    trackRecord({ strokeWidth: 1, layer: 2, net: 'N2', points: [{ x: 4100, y: 3101 }, { x: 4200, y: 3101 }] }),
  ]));
  assert.equal(runDrc(otherLayer, { checks: ['clearance'] }).violations.length, 0);
});

test('track width, via ring and hole-to-hole are checked', () => {
  const thin = parsePcb(board([
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4200, y: 3100 }] }),
  ]));
  assert.equal(runDrc(thin, { checks: ['track-width'] }).violations.length, 0, '0.254mm is the rule, so it passes');

  const noRing = parsePcb(board([viaRecord({ x: 4150, y: 3150, diameter: 2, holeR: 1, net: 'N1' })]));
  const ringResult = runDrc(noRing, { checks: ['via-ring'] });
  assert.ok(ringResult.violations.some((v) => v.type === 'via-ring'), JSON.stringify(ringResult.violations));

  const closeHoles = parsePcb(board([
    viaRecord({ x: 4150, y: 3150, diameter: 4, holeR: 1, net: 'N1' }),
    viaRecord({ x: 4151, y: 3150, diameter: 4, holeR: 1, net: 'N2' }),
  ]));
  assert.ok(runDrc(closeHoles, { checks: ['hole-to-hole'] }).violations.some((v) => v.type === 'hole-to-hole'));
});

test('connectivity reports a net whose pads are in separate copper groups', () => {
  const split = parsePcb(board([
    lib('U1', 4100, 3100, [pad(4100, 3100, 'N1', '1'), pad(4200, 3100, 'N1', '2')]),
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4096, y: 3100 }, { x: 4120, y: 3100 }] }),
  ]));
  const result = runDrc(split, { checks: ['unconnected'] });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0].detail, /分成 2 组铜/);

  const joined = parsePcb(board([
    lib('U1', 4100, 3100, [pad(4100, 3100, 'N1', '1'), pad(4200, 3100, 'N1', '2')]),
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4200, y: 3100 }] }),
  ]));
  assert.equal(runDrc(joined, { checks: ['unconnected'] }).violations.length, 0, 'a track between the pads connects them');
});

test('the demo pipeline passes DRC at every stage', async () => {
  for (const name of ['board.json', 'board-routed.json', 'board-poured.json', 'board-stitched.json']) {
    const model = await readPcbFile(path.join(demo, name));
    const result = runDrc(model);
    assert.equal(result.errors, 0, `${name}: ${JSON.stringify(result.violations.filter((v) => v.severity === 'error').slice(0, 3))}`);
  }
});

test('drcMarkdown renders a report with the rules and violations', () => {
  const model = parsePcb(board([
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4200, y: 3100 }] }),
    trackRecord({ strokeWidth: 1, layer: 1, net: 'N2', points: [{ x: 4100, y: 3101 }, { x: 4200, y: 3101 }] }),
  ]));
  const md = drcMarkdown(runDrc(model), { file: 'x.json' });
  assert.match(md, /# DRC 报告/);
  assert.match(md, /规则:/);
  assert.match(md, /\| clearance \|/);
});
