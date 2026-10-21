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

test('merged netlist links same-named nets across sheets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-link-'));
  // sheet 1: 4-pin header VCC / RX / TX / GND
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), buildFromSpec({
    title: 's1',
    components: [{ symbol: 'header', pins: 4, ref: 'J1', x: 400, y: 400 }],
    flags: [
      { text: 'VCC', kind: 'part_netLabel_+5V', at: 'J1.1', rot: 270 },
      { text: 'GND', kind: 'part_netLabel_gnD', at: 'J1.4', rot: 270 },
    ],
    ports: [{ text: 'RX', at: 'J1.2', rot: 0 }, { text: 'TX', at: 'J1.3', rot: 0 }],
  }).text, 'utf8');
  // sheet 2: 8-pin header VCC / TX / RX / GND / NC NC NC / GND
  await fs.writeFile(path.join(dir, 'Sheet_2.json'), buildFromSpec({
    title: 's2',
    components: [{ symbol: 'header', pins: 8, ref: 'J2', x: 400, y: 400 }],
    flags: [
      { text: 'VCC', kind: 'part_netLabel_+5V', at: 'J2.1', rot: 270 },
      { text: 'GND', kind: 'part_netLabel_gnD', at: 'J2.4', rot: 270 },
      { text: 'GND', kind: 'part_netLabel_gnD', at: 'J2.8', rot: 270 },
    ],
    ports: [{ text: 'TX', at: 'J2.2', rot: 0 }, { text: 'RX', at: 'J2.3', rot: 0 }],
  }).text, 'utf8');

  const project = await readProject(dir);
  assert.equal(project.sheets.length, 2);
  assert.equal(project.totals.components, 2);
  assert.equal(project.totals.pins, 12);

  const byName = new Map(project.mergedNets.map((n) => [n.name, n]));
  // VCC and GND ride on power/ground flags: global in the editor
  assert.equal(byName.get('VCC').global, true);
  assert.deepEqual(byName.get('VCC').pins, ['Sheet_1:J1.1', 'Sheet_2:J2.1']);
  assert.equal(byName.get('GND').global, true);
  assert.deepEqual(byName.get('GND').pins, ['Sheet_1:J1.4', 'Sheet_2:J2.4', 'Sheet_2:J2.8']);
  // RX/TX are Net Ports: those DO connect across sheets
  assert.equal(byName.get('RX').crossSheet, true);
  assert.equal(byName.get('RX').connected, true);
  assert.equal(byName.get('RX').global, false);
  assert.deepEqual(byName.get('RX').pins, ['Sheet_1:J1.2', 'Sheet_2:J2.3']);
  assert.deepEqual(byName.get('TX').pins, ['Sheet_1:J1.3', 'Sheet_2:J2.2']);

  // the three NC pins stay unconnected
  const sheet2 = project.sheets.find((s) => s.name === 'Sheet_2');
  const connected = new Set(sheet2.nets.flatMap((n) => n.pins));
  for (const nc of ['J2.5', 'J2.6', 'J2.7']) assert.ok(!connected.has(nc), `${nc} must stay unconnected`);

  assert.deepEqual(project.misleading, [], 'nothing should look connected but be local-only');

  const md = projectMarkdown(project);
  assert(/工程合并网表/.test(md), 'merged netlist section missing');
  assert(/\*\*VCC\*\* \| 全局标志/.test(md), 'VCC should be reported as a global flag');
  assert(/\*\*RX\*\* \| 网络端口\(跨图纸\)/.test(md), 'RX should be reported as a Net Port');
});

test('a plain net label does NOT join sheets, and the report says so', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-labelonly-'));
  const sheet = (title, ref) => buildFromSpec({
    title,
    components: [{ symbol: 'header', pins: 4, ref, x: 400, y: 400 }],
    labels: [{ text: 'RX', at: `${ref}.2`, anchor: 'end' }],
  }).text;
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), sheet('a', 'J1'), 'utf8');
  await fs.writeFile(path.join(dir, 'Sheet_2.json'), sheet('b', 'J2'), 'utf8');

  const project = await readProject(dir);
  const rx = project.mergedNets.find((n) => n.name === 'RX');
  assert.equal(rx.crossSheet, false);
  assert.equal(rx.connected, false, 'two sheets using a Net Label are not joined');
  assert.deepEqual(rx.localOnlySheets, ['Sheet_1', 'Sheet_2']);
  assert.equal(project.misleading.length, 1);
  assert.equal(project.misleading[0].name, 'RX');

  const md = projectMarkdown(project);
  assert(/同名但未跨图纸连通/.test(md), 'the report must warn about label-only same-name nets');
  assert(/网络端口 Net Port/.test(md), 'the warning should say how to fix it');
});

test('mixed sources: a port on one sheet does not join a label on another', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-mixed-'));
  await fs.writeFile(path.join(dir, 'Sheet_1.json'), buildFromSpec({
    title: 'a',
    components: [{ symbol: 'header', pins: 4, ref: 'J1', x: 400, y: 400 }],
    ports: [{ text: 'RX', at: 'J1.2', rot: 0 }],
  }).text, 'utf8');
  await fs.writeFile(path.join(dir, 'Sheet_2.json'), buildFromSpec({
    title: 'b',
    components: [{ symbol: 'header', pins: 4, ref: 'J2', x: 400, y: 400 }],
    labels: [{ text: 'RX', at: 'J2.2', anchor: 'end' }],
  }).text, 'utf8');

  const project = await readProject(dir);
  const rx = project.mergedNets.find((n) => n.name === 'RX');
  assert.deepEqual(rx.localOnlySheets, ['Sheet_2'], 'only Sheet_2 used a local label');
  assert.deepEqual(rx.connectedSheets, ['Sheet_1']);
  assert.equal(project.misleading.length, 1);
});

test('readProject rejects a folder without sheets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-empty-'));
  await assert.rejects(() => readProject(dir), /no schematic sheets/);
});
