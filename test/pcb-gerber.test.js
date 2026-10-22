// Gerber / Excellon export: format, self check and the stroke font.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { exportGerber, gerberForLayer, excellon, parseGerber, verifyGerber, makeTransform, gerberOrigin, GERBER_LAYERS } from '../src/pcb/gerber.js';
import { textStrokes, textWidth, FONT_BOX } from '../src/pcb/font.js';
import { readPcbFile, parsePcb, boardOutline, copperItems } from '../src/pcb/parser.js';
import { boardDocument, padRecord, trackRecord, viaRecord } from '../src/pcb/writer.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, 'fixtures', 'pcb-demo');

function toyBoard() {
  const pad = (x, y, net, number, shape = 'RECT') => padRecord({ shape, x, y, width: 6, height: 6, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, pads) => ['LIB', x, y, `package\`${name}\`name\`${name}`, 0, 0, `gge_${name}`, 1, '', 0, 0, name, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  return boardDocument({
    shape: [
      lib('U1', 4100, 3100, [pad(4100, 3100, 'N1', '1', 'OVAL'), pad(4120, 3100, 'N2', '2')]),
      trackRecord({ strokeWidth: 1, layer: 1, net: 'N1', points: [{ x: 4100, y: 3100 }, { x: 4120, y: 3100 }] }),
      viaRecord({ x: 4110, y: 3120, diameter: 4, holeR: 1, net: 'N1' }),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4050, y: 3050 }, { x: 4200, y: 3050 }, { x: 4200, y: 3150 }, { x: 4050, y: 3150 }, { x: 4050, y: 3050 }] }),
    ],
  });
}

test('the stroke font draws real polylines and reports its width', () => {
  const strokes = textStrokes('U1', { x: 0, y: 0, size: 6 });
  // U is one polyline, 1 is two (stem plus base)
  assert.equal(strokes.length, 3, `glyph strokes ${strokes.length}`);
  assert.equal(textStrokes('U', { x: 0, y: 0, size: 6 }).length, 1);
  assert.equal(textStrokes('', { x: 0, y: 0 }).length, 0);
  for (const s of strokes) for (const p of s) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  // the box is 4x6 font units: a glyph is 6 units tall, so size 6 -> 6 units tall
  const ys = strokes.flat().map((p) => p.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 6.001, 'height stays inside the glyph box');
  assert.ok(textWidth('U1', 6) > textWidth('U', 6), 'two characters are wider than one');
  assert.equal(FONT_BOX.height, 6);
});

test('gerberOrigin and the transform put the board bottom-left at the origin', () => {
  const model = parsePcb(toyBoard());
  const o = gerberOrigin(model);
  const outline = boardOutline(model);
  assert.equal(o.x, outline.minX);
  assert.equal(o.y, outline.maxY);
  const tf = makeTransform(model);
  assert.equal(tf.x(outline.minX), 0);
  assert.equal(tf.y(outline.maxY), 0);
  assert.ok(tf.y(outline.minY) > 0, 'the bottom edge maps to a positive Y (Gerber Y points up)');
});

test('a layer file carries a header, defined apertures and coordinates', () => {
  const model = parsePcb(toyBoard());
  const text = gerberForLayer(model, 1);
  assert.match(text, /%FSLAX46Y46\*%/);
  assert.match(text, /%MOMM\*%/);
  assert.match(text, /%TF\.FileFunction,Copper,L1,Top\*%/);
  assert.match(text, /G01\*/);
  assert.match(text, /M02\*$/m);
  const parsed = parseGerber(text);
  assert.equal(parsed.units, 'mm');
  assert.ok(parsed.format, 'coordinate format declared');
  assert.ok(parsed.apertures.length >= 2, `apertures ${parsed.apertures.length}`);
  // every aperture used must be defined (this is what gerbonara caught)
  const used = new Set((text.match(/^D(\d+)\*$/gm) ?? []).map((d) => d.replace('*', '')));
  const defined = new Set(parsed.apertures.map((a) => a.d));
  for (const d of used) assert.ok(defined.has(d), `aperture ${d} is used but never defined`);
});

test('shapes survive: an oval pad is not written as a rectangle', () => {
  const model = parsePcb(toyBoard());
  const parsed = parseGerber(gerberForLayer(model, 1));
  const shapes = new Set(parsed.apertures.map((a) => a.shape));
  assert.ok(shapes.has('O'), `expected an obround aperture, got ${[...shapes]}`);
});

test('through-hole pads end up in the drill file', () => {
  const pad = padRecord({ shape: 'ELLIPSE', x: 4100, y: 3100, width: 6, height: 6, layer: 11, net: 'N1', number: '1', holeR: 1, rotation: 0, points: [] }, {});
  const lib = ['LIB', 4100, 3100, 'package`U1`name`U1', 0, 0, 'gge_U1', 1, '', 0, 0, 'U1', 'yes', '', ''].join('~') + '#@$' + pad;
  const model = parsePcb(boardDocument({ shape: [lib, trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4050, y: 3050 }, { x: 4150, y: 3050 }, { x: 4150, y: 3150 }, { x: 4050, y: 3150 }, { x: 4050, y: 3050 }] })] }));
  const drill = excellon(model, { plated: true });
  assert.match(drill, /^M48/m);
  assert.match(drill, /METRIC/);
  assert.match(drill, /M30\s*$/);
  const hits = (drill.text ?? drill).match(/^X-?[\d.]+Y-?[\d.]+$/gm) ?? [];
  assert.equal(hits.length, 1, 'the through-hole pad produced one hit');
});

test('the export self check agrees with the board it came from', () => {
  const model = parsePcb(toyBoard());
  const exported = exportGerber(model, { name: 'toy' });
  assert.ok(exported.files.length >= 8, `files ${exported.files.length}`);
  const check = verifyGerber(model, exported);
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  // and it notices a missing layer
  const broken = { files: exported.files.filter((f) => f.layer !== 'drill') };
  const badCheck = verifyGerber(model, broken);
  assert.equal(badCheck.ok, false);
  assert.ok(badCheck.problems.some((p) => /钻孔/.test(p)));
});

test('the demo board exports every layer with matching geometry', async () => {
  const model = await readPcbFile(path.join(demo, 'board-stitched.json'));
  const exported = exportGerber(model, { name: 'demo' });
  const names = exported.files.map((f) => f.name);
  for (const meta of Object.values(GERBER_LAYERS)) assert.ok(names.some((n) => n.includes(meta.name)), `missing ${meta.name}`);
  const check = verifyGerber(model, exported);
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  const pads = copperItems(model).filter((i) => i.kind === 'pad');
  const holes = copperItems(model).filter((i) => (i.kind === 'via') || (i.kind === 'pad' && (i.holeR ?? 0) > 0)).length;
  const drill = exported.files.find((f) => f.layer === 'drill');
  assert.equal((drill.text.match(/^X-?[\d.]+Y-?[\d.]+$/gm) ?? []).length, holes, 'one drill hit per hole');
  assert.ok(pads.length > 60);
});

test('the silkscreen layer is not empty and uses the stroke font', async () => {
  const model = await readPcbFile(path.join(demo, 'board-stitched.json'));
  const silk = gerberForLayer(model, 3);
  const parsed = parseGerber(silk);
  assert.ok(parsed.draws.length > 100, `silk draws ${parsed.draws.length}`);
  assert.ok(silk.length > 2000, 'silk file has content');
});

test('an independent parser (gerbonara) accepts the files', async (t) => {
  const python = '/tmp/gerb-venv/bin/python';
  const available = await fs.access(python).then(() => true, () => false);
  if (!available) return t.skip('gerbonara venv not present (/tmp/gerb-venv)');
  const model = await readPcbFile(path.join(demo, 'board-stitched.json'));
  const exported = exportGerber(model, { name: 'indep' });
  const dir = path.join('/tmp', `gerber-test-${process.pid}`);
  await fs.mkdir(dir, { recursive: true });
  for (const f of exported.files) await fs.writeFile(path.join(dir, f.name), f.text, 'utf8');
  const script = `
import glob, sys
from gerbonara import GerberFile, ExcellonFile
files = sorted(glob.glob(sys.argv[1] + '/*.gbr')) + sorted(glob.glob(sys.argv[1] + '/*.drl'))
total = 0
for p in files:
    f = ExcellonFile.open(p) if p.endswith('.drl') else GerberFile.open(p)
    total += len(list(f.objects))
print(len(files), total)
`;
  const { stdout } = await execFileAsync(python, ['-c', script, dir], { timeout: 120000 });
  const [fileCount, objectCount] = stdout.trim().split(/\s+/).map(Number);
  assert.equal(fileCount, exported.files.length, 'every file parsed');
  assert.ok(objectCount > 500, `objects ${objectCount}`);
  await fs.rm(dir, { recursive: true, force: true });
});
