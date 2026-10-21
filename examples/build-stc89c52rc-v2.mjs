// STC89C52RC minimal system — v2.
//
// Design points taken from the STC89C51RC/RD+ datasheet (datasheet/STC89C52RC.pdf):
//   1.4 Pin Descriptions  p.7   -> PDIP40 pin numbers, /EA, XTAL1/2, VCC/GND, P0/P3
//   2.2.1 Reset pin       p.16  -> RST high >= 2 machine cycles + 10us
//   2.2.2/2.2.5 POR       p.17/20 -> on-chip POR, optional MAX810 ~400ms delay
//   Ch.9 ISP/IAP          p.4/123 -> in-system programming over UART
//
// Extra circuits vs. the first draft: ISP/power headers, bulk + decoupling caps,
// power LED, and net labels instead of long wires wherever it stays readable.
import { SchematicBuilder, buildFromSpec, writeDocument } from '../src/create.js';
import { convert } from '../src/index.js';
import { buildReport } from '../src/report.js';
import { exportJson } from '../src/exportjson.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, 'stc89c52rc-minimal-v2');

const COMPONENTS = [
  { symbol: 'stc89c52rc', ref: 'U1', value: 'STC89C52RC-40I', x: 500, y: 400 },
  // reset
  { symbol: 'switch', ref: 'SW1', value: 'RESET', x: 150, y: 330, rot: 90 },
  { symbol: 'capacitor_pol', ref: 'C3', value: '10uF', x: 250, y: 330, rot: 90 },
  { symbol: 'resistor', ref: 'R1', value: '10k', x: 300, y: 430, rot: 90 },
  // clock
  { symbol: 'crystal', ref: 'Y1', value: '11.0592MHz', x: 230, y: 600 },
  { symbol: 'capacitor', ref: 'C1', value: '30pF', x: 170, y: 660, rot: 90, labelSide: 'mirror' },
  { symbol: 'capacitor', ref: 'C2', value: '30pF', x: 290, y: 660, rot: 90 },
  // power indicator + decoupling
  { symbol: 'resistor', ref: 'R2', value: '1k', x: 690, y: 170, rot: 90 },
  { symbol: 'led', ref: 'D1', value: 'RED', x: 690, y: 240, rot: 90 },
  { symbol: 'capacitor', ref: 'C4', value: '100nF', x: 690, y: 380, rot: 90 },
  { symbol: 'capacitor_pol', ref: 'C5', value: '10uF', x: 690, y: 500, rot: 90 },
  // connectors
  { symbol: 'header', pins: 2, ref: 'J1', value: 'PWR', x: 900, y: 330 },
  { symbol: 'header', pins: 5, ref: 'J2', value: 'ISP', x: 900, y: 480 },
];

const probe = new SchematicBuilder({ title: 'probe' });
for (const c of COMPONENTS) probe.place(c);
const P = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  return { x: p.x, y: p.y };
};

// ---- geometry -------------------------------------------------------------
const railY = P('R1.1').y;                 // reset rail
const xtalStub1 = P('U1.19').x - 30;
const xtalStub2 = P('U1.18').x - 30;
const rxdStub = P('U1.10').x - 30;
const vccStub = P('U1.40').x + 24;
const eaStub = P('U1.31').x + 24;

const spec = {
  title: 'STC89C52RC 最小系统',
  company: 'lceda-ai demo',
  rev: '2.0',
  date: new Date().toISOString().slice(0, 10),
  drawnBy: 'AI Agent',
  components: COMPONENTS,
  wires: [
    // +5V rail of the reset network (button and cap are level)
    { points: [P('SW1.1'), P('C3.1')] },
    // reset node: SW1.2 and C3.2 down to the rail, into R1.1
    { points: [P('SW1.2'), { x: P('SW1.2').x, y: railY }, P('R1.1')] },
    { points: [P('C3.2'), { x: P('C3.2').x, y: railY }, P('R1.1')] },
    // clock: crystal pins down into the load caps
    { points: [P('Y1.1'), { x: P('Y1.1').x, y: 616 }, { x: P('C1.1').x, y: 616 }, P('C1.1')] },
    { points: [P('Y1.2'), { x: P('Y1.2').x, y: 616 }, { x: P('C2.1').x, y: 616 }, P('C2.1')] },
    // label stubs on the MCU side (keeps the drawing free of long wires)
    { points: [P('U1.19'), { x: xtalStub1, y: P('U1.19').y }] },
    { points: [P('U1.18'), { x: xtalStub2, y: P('U1.18').y }] },
    { points: [P('U1.10'), { x: rxdStub, y: P('U1.10').y }] },
    { points: [P('U1.11'), { x: rxdStub, y: P('U1.11').y }] },
    { points: [P('U1.9'), { x: rxdStub, y: P('U1.9').y }] },
    // MCU power pins out to flags
    { points: [P('U1.40'), { x: vccStub, y: P('U1.40').y }] },
    { points: [P('U1.31'), { x: eaStub, y: P('U1.31').y }] },
    // power LED chain
    { points: [P('R2.2'), P('D1.1')] },
  ],
  labels: [
    { text: 'XTAL1', at: [P('Y1.1').x, P('Y1.1').y], anchor: 'end' },
    { text: 'XTAL2', at: [P('Y1.2').x, P('Y1.2').y], anchor: 'start' },
    { text: 'XTAL1', at: [xtalStub1, P('U1.19').y], anchor: 'end' },
    { text: 'XTAL2', at: [xtalStub2, P('U1.18').y], anchor: 'end' },
    { text: 'RXD', at: [rxdStub, P('U1.10').y], anchor: 'end' },
    { text: 'TXD', at: [rxdStub, P('U1.11').y], anchor: 'end' },
    { text: 'RST', at: [rxdStub, P('U1.9').y], anchor: 'end' },
    { text: 'RST', at: [270, railY], anchor: 'middle' },
    // ISP / power header pins
    { text: 'RXD', at: P('J2.3'), anchor: 'end' },
    { text: 'TXD', at: P('J2.4'), anchor: 'end' },
    { text: 'RST', at: P('J2.5'), anchor: 'end' },
    { text: 'PWR_LED', at: [P('R2.2').x, P('R2.2').y + 5], anchor: 'start' },
  ],
  flags: [
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('SW1.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('R1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C2.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: [vccStub, P('U1.40').y], rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: [eaStub, P('U1.31').y], rot: 90 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('U1.20'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('R2.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('D1.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('C4.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C4.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('C5.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C5.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('J1.1'), rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('J1.2'), rot: 270 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('J2.1'), rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('J2.2'), rot: 270 },
  ],
  junctions: [{ at: [P('R1.1').x, railY] }],
  texts: [
    { text: 'STC89C52RC 最小系统', at: [60, 52], size: 14, color: '#000080' },
    { text: '引脚与电气特性依据 STC89C51RC/RD+ 数据手册:p.7 引脚定义 / p.16 复位时序 / p.17,20 内部 POR / p.4 ISP', at: [60, 70], size: 7, color: '#000080' },
    { text: '复位电路', at: [128, 266], size: 9, color: '#004080' },
    { text: '晶振电路', at: [190, 566], size: 9, color: '#004080' },
    { text: '去耦 与 电源指示', at: [640, 112], size: 9, color: '#004080' },
    { text: '电源 / 下载接口', at: [812, 288], size: 9, color: '#004080' },
    { text: '· P0 口内部已含上拉,无需外部排阻 (p.7)', at: [612, 604], size: 7, color: '#404040' },
    { text: '· /EA 内部上拉;接 +5V 时从内部 Flash 取指 (p.7)', at: [612, 620], size: 7, color: '#404040' },
    { text: '· RST 需保持高电平 ≥ 2 个机器周期 + 10µs (p.16);内置 POR (p.17)', at: [612, 636], size: 7, color: '#404040' },
    { text: '· 慢上电场合可启用 MAX810 上电延时,约 400ms (p.20)', at: [612, 652], size: 7, color: '#404040' },
    { text: '· 晶振 11.0592MHz + 2×30pF(常规负载电容;手册未规定)', at: [612, 668], size: 7, color: '#404040' },
    { text: '· ISP/IAP 经 P3.0(RxD)/P3.1(TxD) 在系统下载 (p.4, 第9章)', at: [612, 684], size: 7, color: '#404040' },
  ],
};

const { doc, text, netlist, warnings } = buildFromSpec(spec);
await writeDocument(`${base}.esch`, text);
const { markdown } = buildReport(doc, netlist, { sheetName: 'STC89C52RC 最小系统 v2' });
await fs.writeFile(`${base}.report.md`, markdown, 'utf8');
await exportJson(`${base}.esch`, { out: `${base}.json`, projectDir: path.join(here, 'STC89C52RC-Minimal-v2') });
const results = await convert(`${base}.esch`, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });

const multi = netlist.nets.filter((n) => n.pins.length > 1);
console.log('--- nets ---');
for (const n of multi) console.log(n.name.padEnd(8), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
console.log('stats:', JSON.stringify(netlist.statistics));
const lone = netlist.nets.filter((n) => n.pins.length === 1 && /^U1\./.test(`${n.pins[0].ref}.${n.pins[0].pin}`));
console.log('unconnected MCU pins:', lone.length);
if (warnings.length) console.log('warnings:', warnings);
for (const r of results) for (const [k, v] of Object.entries(r.outputs)) console.log(' ', k, v);
