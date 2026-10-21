// Multi-sheet project view: merged BOM, per-sheet statistics, net classes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { classifyNet, readProject, projectMarkdown } from '../src/project.js';
import { buildFromSpec } from '../src/create.js';

const mkSheet = (title, extra = []) => buildFromSpec({
  title,
  components: [
    { symbol: 'resistor', ref: 'R1', value: '10k', x: 200, y: 200, rot: 90 },
    { symbol: 'capacitor', ref: 'C1', value: '100nF', x: 260, y: 200, rot: 90 },
    ...extra,
  ],
  flags: [
    { text: '+5V', kind: 'part_netLabel_+5V', at: 'R1.1', rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: 'C1.2', rot: 180 },
  ],
  wires: [{ from: 'R1.2', to: 'C1.1' }],
}).text;

test('classifyNet buckets the usual rail and signal names', () => {
  assert.equal(classifyNet('+5V'), 'power');
  assert.equal(classifyNet('3V3'), 'power');
  assert.equal(classifyNet('GND'), 'ground');
  assert.equal(classifyNet('AGND'), 'ground');
  assert.equal(classifyNet('RST'), 'reset');
  assert.equal(classifyNet('NRST'), 'reset');
  assert.equal(classifyNet('XTAL1'), 'clock');
  assert.equal(classifyNet('USB_D+'), 'differential');
  assert.equal(classifyNet('USB_D-'), 'differential');
  assert.equal(classifyNet('LED_1'), 'signal');
  assert.equal(classifyNet('DATA7'), 'bus');
});

test('readProject merges sheets, BOM and cross-sheet nets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-proj-'));
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), mkSheet('one'), 'utf8');
  await fs.writeFile(path.join(dir, 'Sheet_2.json'), mkSheet('two'), 'utf8');
  // a stray json next to the sheets must be ignored
  await fs.writeFile(path.join(dir, 'project.json'), JSON.stringify({ hello: 'world' }), 'utf8');

  const project = await readProject(dir);
  assert.equal(project.sheets.length, 2, 'stray project.json must not count as a sheet');
  assert.equal(project.totals.components, 4);
  assert.equal(project.totals.pins, 8);

  const resistors = project.bom.find((r) => r.value === '10k');
  assert.ok(resistors, 'merged BOM has the resistor row');
  assert.equal(resistors.count, 2);
  assert.deepEqual(resistors.refs.sort(), ['R1@Sheet_1', 'R1@Sheet_2']);

  const names = project.crossSheet.map((n) => n.name).sort();
  assert.deepEqual(names, ['+5V', 'GND']);

  const md = projectMarkdown(project);
  assert.match(md, /工程总览/);
  assert.match(md, /合并 BOM/);
  assert.match(md, /网络分类/);
  assert.match(md, /\*\*电源\*\*/);
  assert.match(md, /\*\*地\*\*/);
});

test('readProject rejects a folder without sheets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-empty-'));
  await assert.rejects(() => readProject(dir), /no schematic sheets/);
});
