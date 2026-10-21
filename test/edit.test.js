import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument, extractNetlist } from '../src/index.js';
import { editSheet, editText } from '../src/edit.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'mini.json');

async function tmpCopy() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-edit-'));
  const file = path.join(dir, 'Sheet_1.json');
  await fs.copyFile(fixture, file);
  return file;
}

test('round-trip: no ops leaves the document unchanged and netlist identical', async () => {
  const file = await tmpCopy();
  const original = await fs.readFile(file, 'utf8');
  const res = await editSheet(file, [], { backup: false });
  assert.equal(res.changed, false);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.deepEqual(res.diff, ['(电气网络无变化)']);
});

test('set_value rewrites the value text only', async () => {
  const file = await tmpCopy();
  const res = await editSheet(file, [{ op: 'set_value', ref: 'R1', value: '2.2k' }], { backup: false });
  assert.equal(res.changed, true);
  assert.ok(res.changes[0].includes('1k'));
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  assert.equal(doc.components.find((c) => c.designator === 'R1').value, '2.2k');
  // netlist unaffected by a value change
  assert.ok(res.diff.some((l) => l.includes('R1 值 1k → 2.2k')));
});

test('set_designator and set_attr', async () => {
  const file = await tmpCopy();
  await editSheet(file, [
    { op: 'set_designator', ref: 'C1', to: 'C9' },
    { op: 'set_attr', ref: 'C9', key: 'Supplier Part', value: 'C1525' },
  ], { backup: false });
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  const c = doc.components.find((x) => x.designator === 'C9');
  assert.ok(c, 'C9 missing');
  assert.equal(c.lcscPart, 'C1525');
  assert.equal(doc.components.some((x) => x.designator === 'C1'), false);
});

test('move shifts the symbol origin and every embedded coordinate', async () => {
  const file = await tmpCopy();
  const before = parseDocument(await fs.readFile(file, 'utf8')).components.find((c) => c.designator === 'R1');
  const res = await editSheet(file, [{ op: 'move', ref: 'R1', dx: 100, dy: -50 }], { backup: false });
  const after = parseDocument(await fs.readFile(file, 'utf8')).components.find((c) => c.designator === 'R1');
  assert.equal(after.x, before.x + 100);
  assert.equal(after.y, before.y - 50);
  for (let i = 0; i < before.pins.length; i++) {
    assert.equal(after.pins[i].x, before.pins[i].x + 100);
    assert.equal(after.pins[i].y, before.pins[i].y - 50);
  }
  // moving away from the wire leaves VCC_TEST with no pins — reported as a warning
  assert.ok(res.warnings.some((w) => w.includes('VCC_TEST')), JSON.stringify(res.warnings));
  assert.ok(res.diff.some((l) => l.includes('引脚 R1.1')), JSON.stringify(res.diff));
});

test('rotate 90 moves pins around the symbol origin', async () => {
  const file = await tmpCopy();
  const before = parseDocument(await fs.readFile(file, 'utf8')).components.find((c) => c.designator === 'R1');
  await editSheet(file, [{ op: 'rotate', ref: 'R1', angle: 90 }], { backup: false });
  const after = parseDocument(await fs.readFile(file, 'utf8')).components.find((c) => c.designator === 'R1');
  // pin1 was 20 units left of the origin -> 20 units below it (clockwise in y-down space)
  const oldPin = before.pins[0];
  const dx = oldPin.x - before.x, dy = oldPin.y - before.y;
  const expX = before.x + dx * 0 - dy * 1;
  const expY = before.y + dx * 1 + dy * 0;
  assert.ok(Math.abs(after.pins[0].x - expX) < 1e-6, `${after.pins[0].x} vs ${expX}`);
  assert.ok(Math.abs(after.pins[0].y - expY) < 1e-6, `${after.pins[0].y} vs ${expY}`);
  // rotate by 180 twice must return to the original geometry
  await editSheet(file, [{ op: 'rotate', ref: 'R1', angle: 180 }], { backup: false });
  await editSheet(file, [{ op: 'rotate', ref: 'R1', angle: 180 }], { backup: false });
  const back = parseDocument(await fs.readFile(file, 'utf8')).components.find((c) => c.designator === 'R1');
  assert.ok(Math.abs(back.pins[0].x - after.pins[0].x) < 1e-6);
  assert.ok(Math.abs(back.pins[0].y - after.pins[0].y) < 1e-6);
});

test('add_wire joins two nets and the diff shows it', async () => {
  const file = await tmpCopy();
  // wire from R1 pin2 (140,-100) to C1 pin2 (340,-100) — currently VCC_TEST vs GND
  const res = await editSheet(file, [{ op: 'add_wire', points: [[140, -100], [340, -100]] }], { backup: false });
  assert.ok(res.changes[0].startsWith('add_wire'));
  // joining VCC_TEST to GND is a short and must be reported
  assert.ok(res.warnings.some((w) => w.includes('短路')), JSON.stringify(res.warnings));
  assert.ok(res.diff.some((l) => l.includes('引脚 R1.1') && l.includes('GND')), JSON.stringify(res.diff));
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  const nl = extractNetlist(doc);
  const nets = nl.nets.filter((n) => n.pins.some((p) => p.ref === 'R1'));
  assert.equal(nets.length, 1, 'R1 pins should now live on one net');
  const big = nets[0];
  assert.deepEqual(big.pins.map((p) => `${p.ref}.${p.pin}`).sort(), ['C1.1', 'C1.2', 'R1.1', 'R1.2']);
});

test('delete_element removes a wire and splits the net', async () => {
  const file = await tmpCopy();
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  const wire = doc.shapes.find((s) => s.type === 'wire');
  const res = await editSheet(file, [{ op: 'delete_element', id: wire.id }], { backup: false });
  assert.ok(res.changes[0].includes(wire.id));
  const after = extractNetlist(parseDocument(await fs.readFile(file, 'utf8')));
  assert.ok(after.nets.some((n) => n.name === 'GND'));
  assert.ok(res.diff.length > 1);
});

test('add_net_label names an existing anonymous net', async () => {
  const file = await tmpCopy();
  // J1 pin at (500,-100) is dangling; drop a wire + label on it
  await editSheet(file, [
    { op: 'add_wire', points: [[500, -100], [560, -100]] },
    { op: 'add_net_label', x: 560, y: -100, text: 'J1_SIG' },
  ], { backup: false });
  const nl = extractNetlist(parseDocument(await fs.readFile(file, 'utf8')));
  const net = nl.nets.find((n) => n.name === 'J1_SIG');
  assert.ok(net, 'J1_SIG net missing');
  assert.deepEqual(net.pins.map((p) => `${p.ref}.${p.pin}`), ['J1.1']);
});

test('add_net_flag clones an existing flag of the same kind', async () => {
  const file = await tmpCopy();
  await editSheet(file, [
    { op: 'add_wire', points: [[140, -140], [200, -140]] },
    { op: 'add_net_flag', x: 200, y: -140, text: 'GND2', kind: 'part_netLabel_gnD' },
  ], { backup: false });
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  const flags = doc.shapes.filter((s) => s.type === 'netflag' && s.text === 'GND2');
  assert.equal(flags.length, 1);
  assert.deepEqual(flags[0].anchor, [200, -140]);
  assert.ok(flags[0].graphics.length >= 1, 'flag graphics should be cloned');
});

test('duplicate_component creates a fresh designator with unique ids', async () => {
  const file = await tmpCopy();
  const res = await editSheet(file, [{ op: 'duplicate_component', ref: 'R1', dx: 60, dy: 60, value: '4.7k' }], { backup: false });
  assert.ok(res.changes[0].includes('R1 → R2'));
  const doc = parseDocument(await fs.readFile(file, 'utf8'));
  const r2 = doc.components.find((c) => c.designator === 'R2');
  assert.ok(r2, 'R2 missing');
  assert.equal(r2.value, '4.7k');
  assert.equal(r2.pins.length, 2);
  const ids = doc.components.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'instance ids must be unique');
});

test('dry_run reports the diff without touching the file', async () => {
  const file = await tmpCopy();
  const original = await fs.readFile(file, 'utf8');
  const res = await editSheet(file, [{ op: 'set_value', ref: 'R1', value: '9k9' }], { dryRun: true, backup: false });
  assert.equal(res.changed, true);
  assert.equal(res.dryRun, true);
  assert.equal(res.outFile, undefined);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('write creates a .bak and keeps valid JSON', async () => {
  const file = await tmpCopy();
  const original = await fs.readFile(file, 'utf8');
  const res = await editSheet(file, [{ op: 'set_value', ref: 'R1', value: '3k3' }]);
  assert.equal(res.backupFile, `${file}.bak`);
  assert.equal(await fs.readFile(`${file}.bak`, 'utf8'), original);
  const text = await fs.readFile(file, 'utf8');
  assert.equal(text.includes('\n'), false, 'file stays single-line like LCEDA writes it');
  JSON.parse(text);
});

test('unknown op and unknown component produce clear errors', async () => {
  const file = await tmpCopy();
  await assert.rejects(() => editSheet(file, [{ op: 'nonsense' }], { dryRun: true }), /unknown op/);
  await assert.rejects(() => editSheet(file, [{ op: 'set_value', ref: 'R404', value: '1k' }], { dryRun: true }), /not found/);
});

test('editText works in memory (used by tooling)', async () => {
  const text = await fs.readFile(fixture, 'utf8');
  const res = editText(text, [{ op: 'set_value', ref: 'C1', value: '4u7' }]);
  assert.equal(res.changed, true);
  assert.match(res.text, /4u7/);
  assert.doesNotMatch(text, /4u7/);
});

test('describe lists editable element ids', async () => {
  const text = await fs.readFile(fixture, 'utf8');
  const res = editText(text, [{ op: 'describe' }]);
  const dump = res.notes.join('\n');
  assert.match(dump, /导线/);
  assert.match(dump, /网络标签/);
  assert.match(dump, /电源标志/);
  assert.match(dump, /VCC_TEST/);
});
