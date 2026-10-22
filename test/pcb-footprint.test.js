// Footprint management: symbol -> footprint resolution, pad/pin checking, index.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkMapping, symbolPins, padNumbers, footprintRefOf, packageOf, lcscOf, footprintIndex,
} from '../src/pcb/footprint.js';
import { readPcbFile } from '../src/pcb/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

test('checkMapping flags a pin with no pad, and tolerates extra pads', () => {
  const pins = [{ number: '1' }, { number: '2' }];
  assert.equal(checkMapping(pins, ['1', '2']).ok, true);

  const extra = checkMapping(pins, ['1', '2', 'MP1', 'MP2']);
  assert.equal(extra.ok, true, 'mechanical pads must not fail the check');
  assert.deepEqual(extra.extra, ['MP1', 'MP2']);
  assert.deepEqual(extra.missing, []);

  const missing = checkMapping([{ number: '1' }, { number: '2' }, { number: '3' }], ['1', '2']);
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.missing, ['3'], 'a pin with no pad is a real error');

  const dup = checkMapping([{ number: '1' }], ['1', '1']);
  assert.deepEqual(dup.duplicatePads, ['1']);

  assert.equal(checkMapping([], ['1']).ok, false, 'a symbol with no pins cannot be verified');
});

test('package names are compared when both sides have one', () => {
  const c = checkMapping([{ number: '1' }], ['1'], { packageName: 'R0603', footprintPackage: 'R0805' });
  assert.equal(c.packageMatches, false);
  assert.equal(checkMapping([{ number: '1' }], ['1'], { packageName: 'R0603', footprintPackage: '' }).packageMatches, true);
});

test('symbolPins reads pin numbers and names, also from LIB-wrapped records', () => {
  const doc = { shape: [
    'P~show~0~1~400~300~180~g1~0^^400 300^^M 400 300 h -10~#880000^^1~390~303~0~VCC~start~~~#0000FF^^1~395~301~0~1~end~~~#000080^^0~398~300^^0~M 4~0',
    'R~400~300~10~10~#880000~1~0~none~g2~0',
    'LIB~0~0~package`X`~0~g3~1~u~0~0~~yes~~#@$P~show~0~2~400~320~180~g4~0^^400 320^^M 400 320 h -10~#880000^^1~390~323~0~GND~start~~~#0000FF^^1~395~321~0~2~end~~~#000080^^0~398~320^^0~M 4~0',
  ] };
  const pins = symbolPins(doc);
  assert.deepEqual(pins.map((p) => p.number).sort(), ['1', '2']);
  assert.equal(pins.find((p) => p.number === '1').name, 'VCC');
});

test('a real symbol document and its footprint line up', async () => {
  const symbol = JSON.parse(await fs.readFile(fixture('C25804.symbol.json'), 'utf8'));
  const footprint = await readPcbFile(fixture('R0603.fp.json'));
  const pins = symbolPins(symbol);
  const pads = padNumbers(footprint);
  assert.equal(pins.length, 2);
  assert.equal(pads.length, 2);
  const check = checkMapping(pins, pads, {
    packageName: symbol.head.c_para.package,
    footprintPackage: footprint.cPara.package,
  });
  assert.equal(check.ok, true);
  assert.equal(check.packageMatches, true);
});

test('part metadata helpers read c_para and packageDetail', () => {
  const part = {
    doc: {
      head: { c_para: { package: 'R0603', 'Supplier Part': 'C25804' } },
      packageDetail: { uuid: '398691f1f785460098bbe5ee6590333c', title: 'R0603', docType: 4 },
      package: 'R0603',
    },
  };
  assert.deepEqual(footprintRefOf(part), { uuid: '398691f1f785460098bbe5ee6590333c', title: 'R0603', docType: 4 });
  assert.equal(packageOf(part), 'R0603');
  assert.equal(lcscOf(part), 'C25804');
  assert.equal(footprintRefOf({ doc: {} }), null, 'no packageDetail -> no footprint');
});

test('footprintIndex indexes a folder by package name and uuid', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-fpidx-'));
  for (const name of ['R0603.fp.json', 'HDR-TH_2P-P2.54.fp.json']) {
    await fs.copyFile(fixture(name), path.join(dir, name));
  }
  await fs.writeFile(path.join(dir, 'not-a-footprint.json'), JSON.stringify({ hello: 1 }), 'utf8');
  const index = await footprintIndex(dir);
  assert.equal(index.files, 3);
  assert.ok(index.byPackage.has('R0603'));
  assert.ok(index.byPackage.has('HDR-TH_2P-P2.54-V-M'));
  assert.equal(index.byPackage.get('R0603').pads, 2);
  assert.equal(index.byPackage.size, 2, 'a non-footprint file is skipped');
});

test('footprintIndex on a missing folder is empty, not an error', async () => {
  const index = await footprintIndex(path.join(os.tmpdir(), 'lceda-does-not-exist-xyz'));
  assert.equal(index.files, 0);
  assert.equal(index.byPackage.size, 0);
});
