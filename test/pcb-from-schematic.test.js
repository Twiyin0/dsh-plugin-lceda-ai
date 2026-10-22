// Schematic -> PCB: pin/pad pairing, placement, and the record writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { pairPinsToPads, shelfPositions, netByPin } from '../src/pcb/fromSchematic.js';
import { readPcbFile, parsePcb } from '../src/pcb/parser.js';
import {
  boardDocument, libRecord, padRecord, trackRecord, textRecord, boardOutlineRecord,
  placementTransform, footprintAnchor, footprintExtent, cparaToText,
} from '../src/pcb/writer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

test('pins pair with pads by number when the numbers agree', () => {
  const r = pairPinsToPads([{ number: '1' }, { number: '2' }], ['1', '2']);
  assert.equal(r.byNumber, true);
  assert.deepEqual(r.pairs, [{ pin: '1', pad: '1' }, { pin: '2', pad: '2' }]);
  assert.deepEqual(r.missingPads, []);
});

test('pins fall back to document order when numbers differ (LED C/A pads)', () => {
  const r = pairPinsToPads([{ number: '1' }, { number: '2' }], ['C', 'A']);
  assert.equal(r.byNumber, false);
  assert.deepEqual(r.pairs, [{ pin: '1', pad: 'A' }, { pin: '2', pad: 'C' }]);
  assert.deepEqual(r.extraPads, []);
});

test('a pin without a pad is reported', () => {
  const r = pairPinsToPads([{ number: '1' }, { number: '2' }, { number: '3' }], ['1', '2']);
  assert.deepEqual(r.missingPads, ['3']);
});

test('shelf placement wraps rows and never overlaps', () => {
  const entries = [
    { ref: 'A', extent: { width: 100, height: 40 } },
    { ref: 'B', extent: { width: 100, height: 40 } },
    { ref: 'C', extent: { width: 100, height: 40 } },
  ];
  const pos = shelfPositions(entries, { originX: 0, originY: 0, maxWidthMm: 60 });  // 60mm = 236 units
  const a = pos.get('A'), b = pos.get('B'), c = pos.get('C');
  assert.ok(a.x < b.x, 'B is to the right of A');
  assert.equal(a.y, b.y, 'A and B share a row');
  assert.ok(c.y > a.y, 'C wrapped to a new row');
});

test('netByPin maps each schematic pin to its net name', () => {
  const map = netByPin({ nets: [
    { name: 'GND', pins: [{ ref: 'C1', pin: '2' }, { ref: 'U1', pin: '20' }] },
    { name: 'N$1', pins: [{ ref: 'U1', pin: '19' }] },
  ] });
  assert.equal(map.get('U1.20'), 'GND');
  assert.equal(map.get('C1.2'), 'GND');
  assert.equal(map.get('U1.19'), 'N$1');
  assert.equal(map.get('U1.1'), undefined);
});

test('writer keeps empty fields empty (a "0" there hides designators)', () => {
  const rec = textRecord({ kind: 'P', x: 100, y: 200, text: 'R1', layer: 3, fontSize: 4.5 }, {});
  const f = rec.split('~');
  assert.equal(f[0], 'TEXT');
  assert.equal(f[1], 'P');
  // fields: 0 type, 1 kind, 2 x, 3 y, 4 strokeWidth, 5 rotation, 6 mirror,
  //         7 layerid, 8 net, 9 fontSize, 10 text, 11 pathStr, 12 display,
  //         13 gId, 14 fontFamily
  assert.equal(f[7], '3', 'silk layer');
  assert.equal(f[8], '', 'net field must stay empty');
  assert.equal(f[10], 'R1');
  assert.equal(f[12], '', 'display field must stay empty');
  assert.equal(f[14], '', 'fontFamily field must stay empty');
  // no stroke data -> empty path so the editor regenerates the glyphs
  assert.equal(f[11], '');
});

test('writer round-trips a board through the parser', async () => {
  const fp = await readPcbFile(fixture('R0603.fp.json'));
  const netsByPad = { 1: 'GND', 2: 'N$1' };
  const lib = libRecord(fp, { x: 4000, y: 3000, cPara: { package: 'R0603', Value: '10k', name: 'R1' }, designator: 'R1', value: '10k', netsByPad });
  const track = trackRecord({ strokeWidth: 10, layer: 1, net: 'GND', points: [{ x: 3900, y: 3000 }, { x: 3990, y: 3000 }] });
  const outline = boardOutlineRecord({ minX: 3800, minY: 2900, maxX: 4200, maxY: 3100 });
  const doc = boardDocument({ title: 'round-trip', shape: [lib, track, outline] });

  const model = parsePcb(doc);
  assert.equal(model.isBoard, true);
  assert.equal(model.counts.footprints, 1);
  assert.equal(model.counts.pads, 2);
  // 2 silk tracks inside the footprint + 1 board track + the outline track
  assert.equal(model.counts.tracks, 4);

  const placed = model.footprints[0];
  assert.equal(placed.x, 4000);
  assert.equal(placed.y, 3000);
  assert.equal(placed.cPara.package, 'R0603');
  assert.equal(placed.cPara.Value, '10k');
  // nets land on the right pads
  const byNumber = Object.fromEntries(placed.pads.map((p) => [String(p.number), p.net]));
  assert.equal(byNumber['1'], 'GND');
  assert.equal(byNumber['2'], 'N$1');
  // designator + value texts survived
  assert.deepEqual(placed.texts.map((t) => t.text).sort(), ['10k', 'R1']);

  const outlineModel = model.elements.find((e) => e.layer === 10);
  assert.ok(outlineModel, 'board outline on layer 10');
  assert.equal(outlineModel.points.length, 5);
});

test('placing a footprint translates its geometry onto the board', async () => {
  const fp = await readPcbFile(fixture('R0603.fp.json'));
  const anchor = footprintAnchor(fp);
  const extent = footprintExtent(fp);
  assert.ok(Math.abs(extent.width) < 20, `the 0603 body is small (got ${extent.width})`);

  const lib = libRecord(fp, { x: 5000, y: 6000, cPara: { package: 'R0603' } });
  const model = parsePcb(boardDocument({ shape: [lib] }));
  const pads = model.footprints[0].pads;
  // the pad centre must now sit on the placement point, not on the library origin
  const cx = (Math.min(...pads.map((p) => p.x)) + Math.max(...pads.map((p) => p.x))) / 2;
  const cy = (Math.min(...pads.map((p) => p.y)) + Math.max(...pads.map((p) => p.y))) / 2;
  assert.ok(Math.abs(cx - 5000) < 1, `pad centre x ${cx}`);
  assert.ok(Math.abs(cy - 6000) < 1, `pad centre y ${cy}`);
  assert.equal(anchor.x, 4000, 'library anchor kept for reference');
});

test('cparaToText writes the backtick form the editor parses', () => {
  const text = cparaToText({ package: 'R0603', 'Supplier Part': 'C25804', Value: '10k' });
  assert.equal(text, 'package`R0603`Supplier Part`C25804`Value`10k');
  assert.equal(cparaToText({}), '');
});

test('placementTransform rotates around the placement point', async () => {
  const fp = await readPcbFile(fixture('R0603.fp.json'));
  const anchor = footprintAnchor(fp);
  const t = placementTransform(fp, { x: 0, y: 0, rotation: 90 });
  const a = t.map({ x: anchor.x, y: anchor.y - 5 });   // 5 units above the anchor, in footprint coordinates
  assert.ok(Math.abs(a.x - 5) < 1e-6, `rotated x ${a.x}`);
  assert.ok(Math.abs(a.y) < 1e-6, `rotated y ${a.y}`);
});
