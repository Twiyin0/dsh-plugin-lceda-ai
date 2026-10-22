// BOM and pick-and-place export, including the hand written xlsx container.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { inflateRawSync } from 'node:zlib';
import { bomRows, cplRows, toCsv, toXlsx, zipFiles, exportBom, verifyBom, partInfo } from '../src/pcb/bom.js';

/** Read one entry out of the zip we wrote (names are stored, data is deflated). */
function readZipEntry(buf, name) {
  const nameBuf = Buffer.from(name, 'utf8');
  let offset = 0;
  while (offset + 30 <= buf.length && buf.readUInt32LE(offset) === 0x04034b50) {
    const compressed = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + nameLen + extraLen;
    if (buf.subarray(offset + 30, offset + 30 + nameLen).equals(nameBuf)) {
      return inflateRawSync(buf.subarray(start, start + compressed)).toString('utf8');
    }
    offset = start + compressed;
  }
  return null;
}
import { readPcbFile, parsePcb } from '../src/pcb/parser.js';
import { parseDocument } from '../src/parser.js';
import { boardDocument, padRecord, trackRecord } from '../src/pcb/writer.js';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const demo = path.join(here, 'fixtures', 'pcb-demo');
const BUNDLED_PY = '/Users/movsa/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3';

function toyBoard() {
  const pad = (x, y, net, number) => padRecord({ shape: 'RECT', x, y, width: 6, height: 6, layer: 1, net, number, holeR: 0, rotation: 0, points: [] }, {});
  const lib = (name, x, y, cpara, pads) => ['LIB', x, y, cpara, 0, 0, `gge_${name}`, 1, '', 0, 0, `sch-${name}`, 'yes', '', ''].join('~') + '#@$' + pads.join('#@$');
  return boardDocument({
    shape: [
      lib('R1', 4100, 3000, 'package`R0603`Value`10k`name`R1', [pad(4097, 3000, 'N1', '1'), pad(4103, 3000, 'N2', '2')]),
      lib('R2', 4120, 3000, 'package`R0603`Value`10k`name`R2', [pad(4117, 3000, 'N1', '1'), pad(4123, 3000, 'N2', '2')]),
      lib('R3', 4140, 3000, 'package`R0603`Value`4k7`name`R3', [pad(4137, 3000, 'N1', '1'), pad(4143, 3000, 'N2', '2')]),
      trackRecord({ strokeWidth: 4, layer: 10, net: '', points: [{ x: 4050, y: 2960 }, { x: 4250, y: 2960 }, { x: 4250, y: 3040 }, { x: 4050, y: 3040 }, { x: 4050, y: 2960 }] }),
    ],
  });
}

test('parts with the same value and package collapse into one BOM line', () => {
  const model = parsePcb(toyBoard());
  const rows = bomRows(model);
  assert.equal(rows.length, 2, `lines: ${JSON.stringify(rows.map((r) => r.value))}`);
  const tenK = rows.find((r) => r.value === '10k');
  assert.equal(tenK.qty, 2);
  assert.equal(tenK.references, 'R1 R2');
  assert.equal(tenK.package, 'R0603');
  assert.equal(rows.find((r) => r.value === '4k7').qty, 1);
});

test('the schematic enriches the BOM through bind_sch_id', () => {
  const model = parsePcb(toyBoard());
  const schematic = {
    components: [
      { id: 'sch-R1', designator: 'R1', lcscPart: 'C25804', mfrPart: 'RC0603FR-0710KL', supplier: 'LCSC', manufacturer: 'Yageo' },
      { id: 'sch-R2', designator: 'R2', lcscPart: 'C25804', mfrPart: 'RC0603FR-0710KL', supplier: 'LCSC', manufacturer: 'Yageo' },
      { id: 'sch-R3', designator: 'R3', lcscPart: 'C23162', mfrPart: 'RC0603FR-074K7L', supplier: 'LCSC', manufacturer: 'Yageo' },
    ],
  };
  const rows = bomRows(model, { schematic });
  assert.equal(rows.length, 2, 'still two lines');
  const tenK = rows.find((r) => r.value === '10k');
  assert.equal(tenK.lcsc, 'C25804', 'LCSC number came from the schematic');
  assert.equal(tenK.manufacturer, 'Yageo');
  assert.equal(tenK.manufacturerPart, 'RC0603FR-0710KL');
  // without the schematic there is nothing to join
  assert.equal(bomRows(model)[0].lcsc, '');
});

test('the placement file has one row per footprint in the assembly frame', () => {
  const model = parsePcb(toyBoard());
  const rows = cplRows(model);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.designator), ['R1', 'R2', 'R3']);
  for (const r of rows) {
    assert.equal(r.layer, 'Top');
    assert.ok(r.midX >= 0 && r.midY >= 0, 'coordinates are positive in the bottom-left frame');
  }
  // R1 is left of R2 which is left of R3, and the Y axis points up
  assert.ok(rows[0].midX < rows[1].midX && rows[1].midX < rows[2].midX);
});

test('csv quoting survives commas and quotes', () => {
  const csv = toCsv([{ a: 'x,y', b: 'say "hi"' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
  assert.match(csv, /"x,y"/);
  assert.match(csv, /"say ""hi"""/);
  assert.match(csv, /\r\n/, 'CRLF line endings');
});

test('the xlsx container has the parts Excel expects', () => {
  const buf = toXlsx([{ name: 'BOM', rows: [['Item', 'Qty'], [1, 2]] }]);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  const text = buf.toString('latin1');
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(text.includes(part), `missing ${part}`);
    assert.ok(readZipEntry(buf, part), `cannot read ${part}`);
  }
  const sheet = readZipEntry(buf, 'xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('inlineStr'), 'strings are inline');
  assert.ok(sheet.includes('<v>2</v>'), 'numbers stay numbers');
  assert.ok(readZipEntry(buf, 'xl/workbook.xml').includes('name="BOM"'));
});

test('the xlsx opens in openpyxl', async (t) => {
  const available = await fs.access(BUNDLED_PY).then(() => true, () => false);
  if (!available) return t.skip('bundled python with openpyxl not found');
  const buf = toXlsx([
    { name: 'BOM', rows: [['Item', 'Qty', 'Value'], [1, 2, '10k'], [2, 1, '4k7']] },
    { name: 'CPL', rows: [['Designator', 'Mid X'], ['R1', 12.5]] },
  ]);
  const file = path.join('/tmp', `bom-test-${process.pid}.xlsx`);
  await fs.writeFile(file, buf);
  const script = `
import openpyxl, sys
wb = openpyxl.load_workbook(sys.argv[1])
print(wb.sheetnames)
ws = wb['BOM']
print(ws.max_row, ws.max_column, ws['A2'].value, ws['C2'].value)
`;
  const { stdout } = await execFileAsync(BUNDLED_PY, ['-c', script, file], { timeout: 60000 });
  const [sheets, dims] = stdout.trim().split('\n');
  assert.match(sheets, /BOM/);
  assert.match(sheets, /CPL/);
  assert.equal(dims, '3 3 1 10k', `openpyxl read: ${dims}`);
  await fs.rm(file, { force: true });
});

test('the demo board produces a consistent BOM and placement file', async () => {
  const model = await readPcbFile(path.join(demo, 'board-stitched.json'));
  const schematic = parseDocument(await fs.readFile(path.join(here, 'fixtures', 'minimal-v3.esch'), 'utf8'));
  const exported = exportBom(model, { name: 'demo', schematic });
  const check = verifyBom(model, exported);
  assert.equal(check.ok, true, JSON.stringify(check.problems));
  assert.equal(exported.stats.placements, model.footprints.length);
  assert.ok(exported.stats.lines < exported.stats.parts, 'some parts share a line');
  assert.equal(exported.stats.bottom, 0, 'the demo is single sided');
  assert.ok(exported.files.some((f) => f.name.endsWith('.xlsx')));
  assert.ok(exported.files.some((f) => f.name.endsWith('-cpl.csv')));
});

test('verifyBom notices a part that fell out of the BOM', () => {
  const model = parsePcb(toyBoard());
  const exported = exportBom(model, { name: 'x', xlsx: false });
  const broken = { ...exported, bom: exported.bom.filter((r) => r.value !== '4k7') };
  const check = verifyBom(model, broken);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /缺少器件/.test(p)));
});
