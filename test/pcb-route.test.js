// Routing: grid building, A*, path-to-copper conversion, and the self check.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildGrid, routeCells, pathToCopper, mstOrder, autoroute, routeBoard, verifyRouting } from '../src/pcb/route.js';
import { readPcbFile, padBBox, parsePcb } from '../src/pcb/parser.js';
import { boardDocument, padRecord, trackRecord } from '../src/pcb/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

/** A tiny board: two 2-pad parts, one net each, on layer 1. */
function toyBoard() {
  const pad = (x, y, net, number) => padRecord({ shape: 'RECT', x, y, width: 6, height: 6, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  return boardDocument({
    shape: [
      lib('R1', 4100, 3000, [pad(4097, 3000, 'N1', '1'), pad(4103, 3000, 'N1', '2')]),
      lib('R2', 4200, 3000, [pad(4197, 3000, 'N1', '1'), pad(4203, 3000, 'N1', '2')]),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4050, y: 2960 }, { x: 4250, y: 2960 }, { x: 4250, y: 3040 }, { x: 4050, y: 3040 }, { x: 4050, y: 2960 }] }),
    ],
  });
}

test('padBBox uses the polygon when width/height are zero', () => {
  const poly = { x: 100, y: 100, width: 0, height: 0, points: [{ x: 90, y: 95 }, { x: 110, y: 95 }, { x: 110, y: 105 }, { x: 90, y: 105 }] };
  const b = padBBox(poly);
  assert.equal(b.fromPolygon, true);
  assert.equal(b.width, 20);
  assert.equal(b.height, 10);
  const rect = padBBox({ x: 0, y: 0, width: 4, height: 8, points: [] });
  assert.equal(rect.fromPolygon, false);
  assert.equal(rect.minX, -2);
  assert.equal(rect.maxY, 4);
});

test('buildGrid maps cells back and forth and blocks the board edge', () => {
  const model = parsePcb(toyBoard());
  const grid = buildGrid(model, { cell: 2, clearance: 1, width: 1 });
  const c = grid.toCell(4100, 3000);
  const back = grid.toBoard(c.i, c.j);
  assert.ok(Math.abs(back.x - 4100) <= 1, `round-trip x ${back.x}`);
  assert.ok(Math.abs(back.y - 3000) <= 1, `round-trip y ${back.y}`);
  // well outside the outline
  assert.equal(grid.isBlocked(1, -5, -5), true);
});

test('routeCells finds a path, respects walls and gives up when sealed', () => {
  const model = parsePcb(toyBoard());
  const grid = buildGrid(model, { cell: 2, clearance: 1, width: 1 });
  const a = grid.toCell(4080, 3020);
  const b = grid.toCell(4220, 3020);
  const path = routeCells(grid, { layer: 1, i: a.i, j: a.j }, { layer: 1, i: b.i, j: b.j }, {});
  assert.ok(path && path.length > 10, 'a path exists on an open row');
  assert.equal(path[0].layer, 1);

  // seal the goal in on BOTH layers (the router can otherwise reach it via a via)
  for (const layer of grid.layers) {
    for (let di = -3; di <= 3; di++) {
      for (let dj = -3; dj <= 3; dj++) {
        if (Math.abs(di) === 3 || Math.abs(dj) === 3) grid.setBlocked(layer, b.i + di, b.j + dj, 1);
      }
    }
  }
  const sealed = routeCells(grid, { layer: 1, i: a.i, j: a.j }, { layer: 1, i: b.i, j: b.j }, {});
  assert.equal(sealed, null, 'a fully walled goal is unreachable');
});

test('pathToCopper merges straight runs and emits a via on a layer change', () => {
  const model = parsePcb(toyBoard());
  const grid = buildGrid(model, { cell: 2, clearance: 1, width: 1 });
  const c = grid.toCell(4100, 3020);
  const path = [
    { layer: 1, i: c.i, j: c.j },
    { layer: 1, i: c.i + 1, j: c.j },
    { layer: 1, i: c.i + 2, j: c.j },
    { layer: 2, i: c.i + 2, j: c.j },
    { layer: 2, i: c.i + 2, j: c.j + 1 },
  ];
  const { tracks, vias } = pathToCopper(grid, path, { net: 'N1', width: 1 });
  assert.equal(vias.length, 1, 'one via for the layer change');
  assert.equal(vias[0].net, 'N1');
  assert.equal(tracks.length, 2, 'one run per layer');
  assert.equal(tracks[0].points.length, 3, 'the three collinear cells stay three points');
  assert.equal(tracks[1].layer, 2);
});

test('mstOrder connects every pad exactly once', () => {
  const pads = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 100, y: 0 }];
  const edges = mstOrder(pads);
  assert.equal(edges.length, 3, 'n-1 edges');
  const touched = new Set(edges.flat());
  assert.equal(touched.size, 4, 'every pad is reached');
});

test('autoroute routes a simple net and reports statistics', () => {
  const model = parsePcb(toyBoard());
  const result = autoroute(model, { cell: 2, clearance: 1, width: 1 });
  assert.equal(result.stats.nets, 1, 'one net with more than one pad');
  assert.equal(result.stats.routed, 1, 'the net is routed');
  assert.equal(result.stats.failed, 0);
  assert.ok(result.tracks.length > 0, 'tracks produced');
  assert.ok(result.stats.lengthMm > 0, 'length measured');
  const check = verifyRouting(model, result.tracks, { clearance: 1 });
  assert.equal(check.count, 0, `no clearance violations: ${JSON.stringify(check.violations.slice(0, 2))}`);
});

test('verifyRouting flags a track over a foreign pad, ignores same net and other layers', () => {
  const model = parsePcb(toyBoard());
  const pad = { x: 4100, y: 3000 };
  const over = [{ net: 'OTHER', layer: 1, width: 1, points: [{ x: 4090, y: 3000 }, { x: 4110, y: 3000 }] }];
  const bad = verifyRouting(model, over, { clearance: 1 });
  assert.ok(bad.count > 0, 'running across a pad is a violation');

  const sameNet = [{ net: 'N1', layer: 1, width: 1, points: [{ x: 4090, y: 3000 }, { x: 4110, y: 3000 }] }];
  assert.equal(verifyRouting(model, sameNet, { clearance: 1 }).count, 0, 'its own net is fine');

  const otherLayer = [{ net: 'OTHER', layer: 2, width: 1, points: [{ x: 4090, y: 3000 }, { x: 4110, y: 3000 }] }];
  assert.equal(verifyRouting(model, otherLayer, { clearance: 1 }).count, 0, 'an SMD pad on layer 1 does not clash with layer 2');
});

test('routeBoard returns a document that parses back with the new copper', () => {
  const model = parsePcb(toyBoard());
  const { doc, stats } = routeBoard(model, { cell: 2, clearance: 1, width: 1 });
  const back = parsePcb(doc);
  assert.equal(back.isBoard, true);
  assert.equal(back.counts.pads, 4, 'original footprints survive');
  assert.equal(back.counts.tracks, 1 + stats.tracks, 'board outline plus routed tracks');
  assert.equal(back.counts.vias, stats.vias);
});

test('a board with several nets routes them and stays clearance clean', () => {
  // three 2-pad parts, three nets - built inline so the test needs no network
  const pad = (x, y, net, number) => padRecord({ shape: 'RECT', x, y, width: 6, height: 6, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  const doc = boardDocument({
    shape: [
      lib('R1', 4100, 3000, [pad(4097, 3000, 'N1', '1'), pad(4103, 3000, 'N2', '2')]),
      lib('R2', 4200, 3000, [pad(4197, 3000, 'N1', '1'), pad(4203, 3000, 'N3', '2')]),
      lib('R3', 4200, 3060, [pad(4197, 3060, 'N2', '1'), pad(4203, 3060, 'N3', '2')]),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4050, y: 2960 }, { x: 4260, y: 2960 }, { x: 4260, y: 3110 }, { x: 4050, y: 3110 }, { x: 4050, y: 2960 }] }),
    ],
  });
  const model = parsePcb(doc);
  const result = autoroute(model, { cell: 2, clearance: 1, width: 1 });
  assert.equal(result.stats.nets, 3, `three nets, got ${result.stats.nets}`);
  assert.ok(result.stats.routed >= 2, `routed ${result.stats.routed}/3`);
  const check = verifyRouting(model, result.tracks, { clearance: 1 });
  assert.equal(check.count, 0, `self check clean: ${JSON.stringify(check.violations.slice(0, 2))}`);
});
