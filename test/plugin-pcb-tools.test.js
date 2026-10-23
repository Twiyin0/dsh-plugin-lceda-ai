// The PCB tools as the harness calls them: real subprocesses, real files.
//
// This is the P-12 regression: it drives every lceda_pcb_* tool through its
// execute() the way ctx.tools.register() would, and checks the text it returns
// and the files it produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { tools } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const out = path.join('/tmp', `pcb-tools-${process.pid}`);
const byName = new Map(tools.map((t) => [t.name, t]));

const ctx = { workingDirectory: { ensure: async () => root } };
const exec = { agent: 'test', signal: undefined };

const run = async (name, args) => {
  const tool = byName.get(name);
  assert.ok(tool, `tool ${name} is not registered`);
  const res = await tool.execute(args, ctx, exec);
  assert.equal(typeof res.text, 'string', `${name} must return text`);
  assert.ok(Array.isArray(res.files ?? []), `${name} files must be an array`);
  return res;
};

test('the PCB tool family is registered with the expected names', () => {
  const names = [...byName.keys()].filter((n) => n.startsWith('lceda_pcb_'));
  assert.deepEqual(names.sort(), [
    'lceda_pcb_bom', 'lceda_pcb_build', 'lceda_pcb_drc', 'lceda_pcb_gerber',
    'lceda_pcb_legalize', 'lceda_pcb_pour', 'lceda_pcb_read', 'lceda_pcb_render',
    'lceda_pcb_route', 'lceda_pcb_via',
  ]);
});

test('build runs place → route → pour → stitch → gerber → bom in one call', async () => {
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  const board = path.join(out, 'board.json');
  const res = await run('lceda_pcb_build', {
    path: path.join(root, 'test', 'fixtures', 'minimal-v3.esch'),
    outPath: board,
    placement: 'rule',
    footprint: ['U1=STC89C52RC-DIP-40'],
    route: true,
    pourNet: 'GND',
    stitchVias: true,
    exportGerber: true,
    exportBom: true,
  });
  assert.match(res.text, /13 components, 71 pads, 40 nets/);
  assert.match(res.text, /route: \d+\/40 nets/);
  assert.match(res.text, /pour: GND \d+/);
  assert.match(res.text, /stitch: \d+ vias on GND/);
  assert.match(res.text, /gerber: 8 files/);
  assert.match(res.text, /bom: \d+ lines/);
  // every stage wrote its board
  for (const suffix of ['board.json', 'board-routed.json', 'board-poured.json', 'board-stitched.json']) {
    await fs.access(path.join(out, suffix));
  }
  assert.ok(res.files.length >= 8, `files: ${res.files.length}`);
});

test('read, drc and render work on the finished board', async () => {
  const board = path.join(out, 'board-stitched.json');
  const read = await run('lceda_pcb_read', { path: board, net: 'GND' });
  assert.match(read.text, /13 footprints/);
  assert.match(read.text, /copper areas/);

  const drc = await run('lceda_pcb_drc', { path: board, outPath: path.join(out, 'drc.md') });
  assert.match(drc.text, /PASS|FAIL/);
  assert.doesNotMatch(drc.text, /undefined/, 'the report row must be populated');
  await fs.access(path.join(out, 'drc.md'));

  const render = await run('lceda_pcb_render', { path: board, outDir: path.join(out, 'render'), formats: ['svg'], scale: 3, view: 'bottom' });
  assert.match(render.text, /bottom/);
  assert.ok(render.files.length >= 1);
  for (const f of render.files) await fs.access(f);
});

test('route, pour and via can be called on their own', async () => {
  const board = path.join(out, 'board.json');
  const routed = path.join(out, 'again-routed.json');
  const r = await run('lceda_pcb_route', { path: board, outPath: routed, cell: 2 });
  assert.match(r.text, /\d+\/40 nets/);
  assert.deepEqual(r.files, [routed]);
  await fs.access(routed);

  const poured = path.join(out, 'again-poured.json');
  const p = await run('lceda_pcb_pour', { path: routed, outPath: poured, net: 'GND' });
  assert.match(p.text, /net GND: \d+/);
  await fs.access(poured);

  const stitched = path.join(out, 'again-stitched.json');
  const v = await run('lceda_pcb_via', { path: poured, outPath: stitched, net: 'GND', spacingMm: 5 });
  assert.match(v.text, /vias on GND/);
  await fs.access(stitched);
});

test('gerber and bom write fabrication data with the expected files', async () => {
  const board = path.join(out, 'board-stitched.json');
  const gerberDir = path.join(out, 'fab');
  const g = await run('lceda_pcb_gerber', { path: board, outDir: gerberDir, manifest: true });
  assert.match(g.text, /exported 8 files/);
  assert.match(g.text, /self check: all consistent/);
  for (const name of ['-F_Cu.gbr', '-B_Cu.gbr', '-F_SilkS.gbr', '-F_Mask.gbr', '-Edge_Cuts.gbr', '.drl']) {
    assert.ok(g.files.some((f) => f.endsWith(name)), `missing ${name} in ${g.files.join(', ')}`);
  }

  const bomDir = path.join(out, 'bom');
  const b = await run('lceda_pcb_bom', {
    path: board, outDir: bomDir,
    schPath: path.join(root, 'test', 'fixtures', 'minimal-v3.esch'),
  });
  assert.match(b.text, /BOM lines covering 13 parts/);
  assert.match(b.text, /every part appears exactly once/);
  assert.ok(b.files.some((f) => f.endsWith('.xlsx')));
  assert.ok(b.files.some((f) => f.endsWith('-cpl.csv')));
});

test('a tool reports a real error instead of pretending to succeed', async () => {
  await assert.rejects(
    () => run('lceda_pcb_read', { path: path.join(root, 'examples', 'does-not-exist.json') }),
    /no such file|ENOENT/i,
  );
});
