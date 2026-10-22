import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseDocument, extractNetlist, renderSVG } from '../src/index.js';
import { newDocument, buildFromSpec, SchematicBuilder, placeComponent, symbolShapes, writeDocument } from '../src/create.js';
import { findBuiltin, isLcscNumber } from '../src/library.js';
import { BUILTIN_SYMBOLS } from '../src/symbol.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('newDocument creates a framed sheet with title block texts', () => {
  const doc = newDocument({ title: '测试图', company: 'ACME', rev: '2.0', date: '2026-01-01', drawnBy: 'bot' });
  assert.equal(doc.head.docType, '1');
  assert.ok(doc.BBox.width > 1000);
  const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok(parsed.components.some((c) => c.isFrame), 'frame component missing');
  const texts = doc.shape.filter((s) => s.startsWith('T~L~')).map((s) => s.split('~')[12]);
  for (const t of ['TITLE:', '测试图', 'REV:', '2.0', 'Company:', 'ACME', 'Drawn by' in {} ? '' : 'Drawn By:', 'bot']) {
    assert.ok(texts.includes(t), `missing text ${t} in ${JSON.stringify(texts)}`);
  }
});

test('every built-in symbol produces parseable pins', () => {
  for (const [key, entry] of Object.entries(BUILTIN_SYMBOLS)) {
    const shapes = symbolShapes(key);
    assert.ok(shapes.length > 0, `${key} produced no shapes`);
    const pinRecs = shapes.filter((s) => s.startsWith('P~'));
    assert.equal(pinRecs.length, entry.spec.pins.length, `${key} pin count`);
    for (const p of pinRecs) {
      const segs = p.split('^^');
      assert.ok(segs.length >= 5, `${key} pin record needs ^^ blocks`);
      const h = segs[0].split('~');
      assert.equal(h.length >= 8, true, `${key} pin header too short`);
      assert.ok(Number.isFinite(Number(h[4])) && Number.isFinite(Number(h[5])), `${key} bad pin point`);
    }
  }
});

test('buildFromSpec wires pins by reference and names nets', () => {
  const spec = {
    title: 'divider',
    components: [
      { symbol: 'resistor', ref: 'R1', value: '10k', x: 300, y: 300, rot: 90 },
      { symbol: 'resistor', ref: 'R2', value: '10k', x: 300, y: 400, rot: 90 },
    ],
    wires: [
      { points: [{ x: 300, y: 332 }, { x: 300, y: 368 }] },
    ],
    labels: [{ text: 'MID', at: [300, 350], anchor: 'end' }],
    flags: [
      { text: '+5V', kind: 'part_netLabel_+5V', at: 'R1.1', rot: 0 },
      { text: 'GND', kind: 'part_netLabel_gnD', at: 'R2.2', rot: 180 },
    ],
  };
  const { netlist, text } = buildFromSpec(spec);
  assert.ok(text.startsWith('{'));
  const mid = netlist.nets.find((n) => n.name === 'MID');
  assert.ok(mid, 'MID net missing');
  assert.equal(mid.pins.length, 2, JSON.stringify(mid.pins));
  assert.ok(netlist.nets.some((n) => n.name === '+5V'));
  assert.ok(netlist.nets.some((n) => n.name === 'GND'));
});

test('builder resolves pin references and rejects unknown ones', () => {
  const b = new SchematicBuilder({ title: 't' });
  b.place({ symbol: 'crystal', ref: 'Y1', value: '12MHz', x: 300, y: 300, rot: 90 });
  const pins = b.pins();
  assert.ok(pins.has('Y1.1') && pins.has('Y1.2'));
  assert.equal(typeof pins.get('Y1.1').x, 'number');
  assert.throws(() => b.pt('Y1.9'), /unknown pin reference/);
  b.label('X1', 'Y1.1');
  const { netlist } = b.build();
  const net = netlist.nets.find((n) => n.name === 'X1');
  assert.deepEqual(net.pins.map((p) => `${p.ref}.${p.pin}`), ['Y1.1']);
});

test('placeComponent accepts a fetched-style part document', () => {
  // a minimal symbol document shaped like the LCSC API payload (no T records)
  const partDoc = {
    shape: [
      'R~-10~-10~~~20~20~#880000~1~0~none~ggeA~0',
      'P~show~0~1~-30~0~180~ggeB~0^^-30~0^^M -30 0 h 20~#880000^^1~-18~0~0~IN~start~~~#000080^^1~-26~-4~0~1~end~~~#0000FF^^0~0 0^^0~0',
      'P~show~0~2~30~0~0~ggeC~0^^30~0^^M 30 0 h -20~#880000^^1~18~0~0~OUT~end~~~#000080^^1~26~-4~0~2~start~~~#0000FF^^0~0 0^^0~0',
    ],
    package: 'SOT-23',
  };
  const doc = newDocument({ title: 'part' });
  placeComponent(doc, { part: { doc: partDoc, lcsc: 'C123' }, ref: 'U7', value: 'LDO', x: 400, y: 300 });
  const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
  const u7 = parsed.components.find((c) => c.designator === 'U7');
  assert.ok(u7, 'U7 missing');
  assert.equal(u7.value, 'LDO');
  assert.equal(u7.pins.length, 2);
  assert.equal(u7.pins[0].name, 'IN');
  assert.equal(u7.package, 'SOT-23');
});

test('built sheet renders to SVG with readable text', () => {
  const { doc } = buildFromSpec({
    title: 'render check',
    components: [{ symbol: 'stc89c52rc', ref: 'U1', value: 'STC89C52RC', x: 400, y: 350 }],
  });
  const svg = renderSVG(doc, { title: 'render check' });
  assert.match(svg, /render check/);
  assert.match(svg, /STC89C52RC/);
  assert.match(svg, /P3\.0\/RXD/);
  assert.match(svg, /<rect/);
});

test('written document round-trips through the file system', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-create-'));
  const file = path.join(dir, 'sheet.esch');
  const { text } = buildFromSpec({ title: 'file', components: [{ symbol: 'resistor', ref: 'R1', value: '1k', x: 200, y: 200, rot: 90 }] });
  await writeDocument(file, text);
  const back = parseDocument(await fs.readFile(file, 'utf8'));
  assert.equal(back.components.filter((c) => !c.isFrame).length, 1);
  assert.equal(back.components.find((c) => c.designator === 'R1').value, '1k');
});

test('builtin catalogue search and LCSC number detection', () => {
  assert.ok(findBuiltin('8051').some((p) => p.symbol === 'stc89c52rc'));
  assert.ok(findBuiltin('电容').length >= 1);
  assert.ok(findBuiltin('crystal').some((p) => p.symbol === 'crystal'));
  assert.equal(findBuiltin('zzz-nothing').length, 0);
  assert.equal(isLcscNumber('C9900042655'), true);
  assert.equal(isLcscNumber('STC89C52RC'), false);
});

test('exportJson writes a document structurally identical to LCEDA own files', async () => {
  const { exportJson, toLcedaJson } = await import('../src/exportjson.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-export-'));
  const src = path.join(dir, 'built.esch');
  const { text } = buildFromSpec({ title: 'export check', components: [{ symbol: 'resistor', ref: 'R1', value: '1k', x: 200, y: 200, rot: 90 }] });
  await fs.writeFile(src, text, 'utf8');

  const res = await exportJson(src, { out: path.join(dir, 'Sheet_1.json'), projectDir: path.join(dir, 'MyProject') });
  const doc = JSON.parse(await fs.readFile(res.outFile, 'utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['BBox', 'canvas', 'colors', 'head', 'shape']);
  assert.deepEqual(Object.keys(doc.head).sort(), ['c_para', 'c_spiceCmd', 'docType', 'editorVersion', 'hasIdFlag', 'importFlag', 'newgId', 'portOfADImportHack', 'transformList', 'uuid', 'x', 'y']);
  assert.equal(doc.head.docType, '1');
  assert.equal(typeof doc.canvas, 'string');
  assert.ok(Array.isArray(doc.shape) && doc.shape.every((s) => typeof s === 'string'));
  assert.equal(Number.isFinite(doc.BBox.width), true);
  // single-line JSON, like the editor writes it
  const raw = await fs.readFile(res.outFile, 'utf8');
  assert.equal(raw.includes('\n'), false);
  // project folder mirrors a real backup
  const sheet = await fs.readFile(path.join(dir, 'MyProject', 'sch', 'Sheet_1.json'), 'utf8');
  assert.equal(sheet, raw);
  assert.ok(res.files.length >= 2);
});

test('toLcedaJson rejects non-schematic documents', async () => {
  const { toLcedaJson } = await import('../src/exportjson.js');
  assert.throws(() => toLcedaJson({ head: { docType: '3' }, shape: ['W~1 2 3 4'] }), /docType/);
});

test('validatePinout matches datasheet pin names and tolerates aliases', async () => {
  const { validatePinout, PINOUT_REFERENCES, symbolQuality } = await import('../src/library.js');
  const mk = (num, name) => `P~show~0~${num}~0~0~180~g${num}~0^^0 0^^M 0 0 h 10~#880000^^0~2~2~0~${name}~start~~~#0000FF^^0~0~0~9~${num}~end~~~#000080^^none^^none`;
  const ref = PINOUT_REFERENCES.stc89c52rc;
  assert.equal(Object.keys(ref.pins).length, 40);
  const good = ref.pins;
  const doc = (overrides = {}) => ({
    shape: Object.entries(good).map(([n, name]) => mk(n, overrides[n] ?? name)),
  });
  const perfect = validatePinout(doc(), 'stc89c52rc');
  assert.equal(perfect.matched, 40);
  assert.deepEqual(perfect.mismatches, []);
  // alternate names on the same pin must not count as errors
  const aliased = validatePinout(doc({ 10: 'RXD', 11: 'TXD', 31: 'EA/VPP' }), 'stc89c52rc');
  assert.equal(aliased.matched, 40);
  // a real error (the classic "P4.6 on pin 31" mistake) is reported
  const bad = validatePinout(doc({ 31: 'P4.6', 29: 'P4.4' }), 'stc89c52rc');
  assert.equal(bad.mismatches.length, 2);
  assert.deepEqual(bad.mismatches.map((m) => m.pin).sort(), ['29', '31']);
  // geometry heuristic: a box-only document scores 0
  assert.equal(symbolQuality({ shape: ['R~0~0~~~~100~100'] }), 0);
});

test('buildFromSpec warns when a label sits off its wire', () => {
  // A label that is not on a wire or a pin does nothing. The editing path always
  // checked this; the authoring path did not, so a label six units off a wire
  // silently broke a net with no warning at all.
  // built-in symbols are addressed by key, like the other authoring tests
  const spec = {
    title: 'label check',
    components: [
      { symbol: 'resistor', ref: 'R1', value: '1k', x: 300, y: 300, rot: 90 },
      { symbol: 'resistor', ref: 'R2', value: '1k', x: 300, y: 400, rot: 90 },
    ],
    wires: [{ points: [{ x: 300, y: 332 }, { x: 300, y: 368 }] }],
    labels: [{ text: 'MID', at: [300, 350], anchor: 'end' }],
  };
  const onWire = buildFromSpec(spec);
  assert.equal(onWire.warnings.filter((w) => /不在导线上/.test(w)).length, 0, 'a label on the wire is fine');

  const offWire = buildFromSpec({ ...spec, labels: [{ text: 'MID', at: { x: 306, y: 350 }, anchor: 'start' }] });
  assert.ok(offWire.warnings.some((w) => /不在导线上/.test(w)), `expected an off-wire warning, got ${JSON.stringify(offWire.warnings)}`);

  // and the dangling wire end check runs too: this wire runs past R2's pin
  const dangling = buildFromSpec({
    ...spec,
    wires: [{ points: [{ x: 300, y: 332 }, { x: 300, y: 368 }, { x: 300, y: 420 }] }],
    labels: [],
  });
  assert.ok(dangling.warnings.some((w) => /悬空/.test(w)), `an unconnected wire end is reported: ${JSON.stringify(dangling.warnings)}`);
});
