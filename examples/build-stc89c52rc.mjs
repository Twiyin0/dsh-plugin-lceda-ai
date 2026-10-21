// STC89C52RC minimal system.
//
// The drawing is described by a declarative spec whose connection points are
// derived from the placed pins, so the same spec can be replayed later with
// `lceda-ai build examples/stc89c52rc-minimal.spec.json -o out.esch`.
//
// Circuit: MCU + 11.0592MHz crystal with 2x30pF load caps + RC reset
// (10k / 10uF) with a push button + 100nF decoupling; EA tied high.
import { SchematicBuilder, buildFromSpec, writeDocument } from '../src/create.js';
import { convert } from '../src/index.js';
import { buildReport } from '../src/report.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, 'stc89c52rc-minimal.esch');
const specFile = path.join(here, 'stc89c52rc-minimal.spec.json');

const COMPONENTS = [
  { symbol: 'stc89c52rc', ref: 'U1', value: 'STC89C52RC-40I', x: 500, y: 380 },
  { symbol: 'crystal', ref: 'Y1', value: '11.0592MHz', x: 200, y: 560, rot: 90 },
  { symbol: 'capacitor', ref: 'C1', value: '30pF', x: 120, y: 610, rot: 90 },
  { symbol: 'capacitor', ref: 'C2', value: '30pF', x: 280, y: 610, rot: 90 },
  { symbol: 'capacitor_pol', ref: 'C3', value: '10uF', x: 278, y: 330, rot: 90 },
  { symbol: 'resistor', ref: 'R1', value: '10k', x: 330, y: 430, rot: 90 },
  { symbol: 'switch', ref: 'SW1', value: 'RESET', x: 175, y: 330, rot: 90 },
  { symbol: 'capacitor', ref: 'C4', value: '100nF', x: 690, y: 430, rot: 90 },
];

// ---- 1. place the parts to learn their exact pin coordinates ---------------
const probe = new SchematicBuilder({ title: 'probe' });
for (const c of COMPONENTS) probe.place(c);
const P = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  return { x: p.x, y: p.y };
};

const rstY = P('R1.1').y;
const xtal1Stub = P('U1.19').x - 40;
const xtal2Stub = P('U1.18').x - 40;
const vccStub = P('U1.40').x + 24;
const eaStub = P('U1.31').x + 24;
const topRailY = P('C3.1').y;

// ---- 2. the spec (all connection points are numbers derived above) --------
const spec = {
  title: 'STC89C52RC 最小系统',
  company: 'lceda-ai demo',
  rev: '1.0',
  date: new Date().toISOString().slice(0, 10),
  drawnBy: 'AI Agent',
  components: COMPONENTS,
  wires: [
    { points: [[P('SW1.2').x, P('SW1.2').y], [P('SW1.2').x, rstY], [P('R1.1').x, rstY]] },
    { points: [[P('C3.2').x, P('C3.2').y], [P('C3.2').x, rstY], [P('R1.1').x, rstY]] },
    { points: [P('U1.9'), [P('U1.9').x - 10, P('U1.9').y], [P('U1.9').x - 10, rstY], [P('R1.1').x, rstY]] },
    { points: [P('SW1.1'), [P('SW1.1').x, topRailY], [P('C3.1').x, topRailY]] },
    { points: [P('U1.19'), [xtal1Stub, P('U1.19').y]] },
    { points: [P('U1.18'), [xtal2Stub, P('U1.18').y]] },
    { points: [P('U1.40'), [vccStub, P('U1.40').y]] },
    { points: [P('U1.31'), [eaStub, P('U1.31').y]] },
  ],
  labels: [
    { text: 'XTAL1', at: [xtal1Stub, P('U1.19').y], anchor: 'end' },
    { text: 'XTAL2', at: [xtal2Stub, P('U1.18').y], anchor: 'end' },
    { text: 'XTAL1', at: P('Y1.1'), anchor: 'end' },
    { text: 'XTAL2', at: P('Y1.2'), anchor: 'end' },
    { text: 'XTAL1', at: P('C1.1'), anchor: 'end' },
    { text: 'XTAL2', at: P('C2.1'), anchor: 'end' },
    { text: 'RST', at: [P('SW1.2').x + 25, rstY], anchor: 'start' },
  ],
  flags: [
    { text: '+5V', kind: 'part_netLabel_+5V', at: [vccStub, P('U1.40').y], rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: [eaStub, P('U1.31').y], rot: 90 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('U1.20'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('SW1.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('R1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C2.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('C4.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C4.2'), rot: 180 },
  ],
  junctions: [{ at: [P('R1.1').x, rstY] }],
  texts: [
    { text: 'STC89C52RC 最小系统', at: [60, 60], size: 14, color: '#000080' },
    { text: '晶振 11.0592MHz + 30pF 负载电容;复位 RC = 10k / 10uF;EA 接 +5V;C4 去耦', at: [60, 78], size: 8, color: '#000080' },
  ],
};

// ---- 3. build, write, export ---------------------------------------------
await fs.writeFile(specFile, JSON.stringify(spec, null, 2), 'utf8');
const { doc, text, netlist, warnings } = buildFromSpec(spec);
await writeDocument(outFile, text);

const { markdown } = buildReport(doc, netlist, { sheetName: 'STC89C52RC 最小系统' });
await fs.writeFile(outFile.replace(/\.esch$/, '.report.md'), markdown, 'utf8');
const results = await convert(outFile, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });

console.log('wrote', outFile);
for (const r of results) for (const [k, v] of Object.entries(r.outputs)) console.log(' ', k, v);
console.log('--- nets ---');
for (const n of netlist.nets) {
  if (n.pins.length > 1) console.log(n.name.padEnd(8), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
}
if (warnings.length) console.log('warnings:', warnings);
console.log('stats:', JSON.stringify(netlist.statistics));
