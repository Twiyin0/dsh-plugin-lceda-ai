// STC89C52RC minimal system — v3: every part is a real LCEDA standard-library symbol.
//
// Symbol uuids were resolved once from the editor's own library API
// (POST https://lceda.cn/api/components/search, GET /api/components/{uuid}) and are
// pinned here so rebuilds are byte-stable. Fallback order used by the tool:
// standard library -> LCSC product API -> built-in drawing.
//
// Datasheet basis (datasheet/STC89C52RC.pdf): pinout p.7, RST timing p.16,
// on-chip POR p.17/p.20, ISP p.4/p.123.
import { SchematicBuilder, buildFromSpec, writeDocument } from '../src/create.js';
import { convert } from '../src/index.js';
import { buildReport } from '../src/report.js';
import { exportJson } from '../src/exportjson.js';
import { fetchStandard } from '../src/library.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, 'stc89c52rc-minimal-v3');

const STD = {
  mcu: '3dbb121984d94b3eb880951da5f2cfd0',      // STC89C52RC (pinout 40/40 vs p.7, clean 20+20 pin columns)
  r: '96ab93705fad467397e1ee5fa4b8c4da',        // R_0603_US
  c: '8d671d429f5b42f8b56b5f0ebf60f568',        // C_0603_US
  cp: '5fc1fd1be5844ec4bb0947b2b6fcbbaf',       // C_Tan_SMD_A_US
  xtal: '2fb041f269694f8f992573205c6bd1b3',     // hc-49s
  sw: '9e4fc5625813450aa4631a3dcf08bd3f',       // TS-1187A-B-A-B (4 pin)
  led: '1a6ff3bd6d394843b45922df88924d32',      // LEDCHIPLED-0603-TTW
  hdr5: '796a7da953d64c9e844d135c1e602c95',     // HDR-M-2.54_1x5
  hdr2: '4fb98128b29644d8ac5e7f33d28cbb00',     // HDR-M-2.54_1x2
};

const parts = {};
for (const [k, uuid] of Object.entries(STD)) parts[k] = await fetchStandard(uuid);

// Sanity-check the MCU symbol against the datasheet pin table before drawing.
const { validatePinout } = await import('../src/library.js');
const check = validatePinout(parts.mcu.doc, 'stc89c52rc');
console.log(`MCU pinout: ${check.matched}/${check.total} vs ${check.source}`);
if (check.mismatches.length) console.log('  mismatches:', JSON.stringify(check.mismatches));

const COMPONENTS = [
  { part: parts.mcu, ref: 'U1', value: 'STC89C52RC-40I', x: 520, y: 400 },
  // reset: 4-pin tact switch rotated so pins 1/2 sit on top (+5V) and 3/4 below (RST)
  { part: parts.sw, ref: 'SW1', value: 'RESET', x: 240, y: 330, rot: 90 },
  { part: parts.cp, ref: 'C3', value: '10uF', x: 350, y: 330, rot: 90 },
  { part: parts.r, ref: 'R1', value: '10k', x: 400, y: 430, rot: 90 },
  // clock
  { part: parts.xtal, ref: 'Y1', value: '11.0592MHz', x: 300, y: 600 },
  { part: parts.c, ref: 'C1', value: '30pF', x: 260, y: 660, rot: 90 },
  { part: parts.c, ref: 'C2', value: '30pF', x: 340, y: 660, rot: 90 },
  // power indicator + decoupling
  { part: parts.r, ref: 'R2', value: '1k', x: 700, y: 200, rot: 90 },
  { part: parts.led, ref: 'D1', value: 'RED', x: 700, y: 270 },
  { part: parts.c, ref: 'C4', value: '100nF', x: 700, y: 380, rot: 90 },
  { part: parts.cp, ref: 'C5', value: '10uF', x: 700, y: 470, rot: 90 },
  // connectors
  { part: parts.hdr2, ref: 'J1', value: 'PWR', x: 950, y: 330 },
  { part: parts.hdr5, ref: 'J2', value: 'ISP', x: 950, y: 470, rot: 90 },
];

const probe = new SchematicBuilder({ title: 'probe' });
for (const c of COMPONENTS) probe.place(c);
const P = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  return { x: p.x, y: p.y };
};

const railTop = 290;      // +5V rail of the reset network
const railRst = 370;      // RST rail
const mcuStub = P('U1.9').x - 44;

const spec = {
  title: 'STC89C52RC 最小系统',
  company: 'lceda-ai demo',
  rev: '3.0',
  date: new Date().toISOString().slice(0, 10),
  drawnBy: 'AI Agent',
  components: COMPONENTS,
  wires: [
    // +5V side: tie the two top switch pins, then run up and across to the reset cap
    { points: [P('SW1.2'), P('SW1.1')] },
    { points: [P('SW1.2'), { x: P('SW1.2').x, y: railTop }, { x: P('C3.1').x, y: railTop }, P('C3.1')] },
    // RST side: tie the two bottom switch pins, drop to the rail, run right into R1 and the MCU
    { points: [P('SW1.4'), P('SW1.3')] },
    { points: [P('SW1.4'), { x: P('SW1.4').x, y: railRst }, { x: P('R1.1').x, y: railRst }, P('R1.1')] },
    { points: [P('C3.2'), { x: P('C3.2').x, y: railRst }] },
    { points: [{ x: P('R1.1').x, y: railRst }, { x: mcuStub - 12, y: railRst }, { x: mcuStub - 12, y: P('U1.9').y }, P('U1.9')] },
    // clock
    { points: [P('Y1.1'), { x: P('Y1.1').x, y: 620 }, { x: P('C1.1').x, y: 620 }, P('C1.1')] },
    { points: [P('Y1.2'), { x: P('Y1.2').x, y: 620 }, { x: P('C2.1').x, y: 620 }, P('C2.1')] },
    { points: [P('U1.19'), { x: mcuStub, y: P('U1.19').y }] },
    { points: [P('U1.18'), { x: mcuStub, y: P('U1.18').y }] },
    { points: [P('U1.10'), { x: mcuStub, y: P('U1.10').y }] },
    { points: [P('U1.11'), { x: mcuStub, y: P('U1.11').y }] },
    // MCU power pins
    { points: [P('U1.40'), { x: P('U1.40').x + 20, y: P('U1.40').y }] },
    { points: [P('U1.31'), { x: P('U1.31').x + 20, y: P('U1.31').y }] },
    // power LED
    { points: [P('R2.2'), P('D1.A@1')] },
    // header stubs: labels/flags must sit outside the connector body
    { points: [P('J1.1'), { x: P('J1.1').x - 22, y: P('J1.1').y }] },
    { points: [P('J1.2'), { x: P('J1.2').x - 22, y: P('J1.2').y }] },
    { points: [P('J2.1'), { x: P('J2.1').x - 22, y: P('J2.1').y }] },
    { points: [P('J2.2'), { x: P('J2.2').x - 22, y: P('J2.2').y }] },
    { points: [P('J2.3'), { x: P('J2.3').x - 22, y: P('J2.3').y }] },
    { points: [P('J2.4'), { x: P('J2.4').x - 22, y: P('J2.4').y }] },
    { points: [P('J2.5'), { x: P('J2.5').x - 22, y: P('J2.5').y }] },
  ],
  labels: [
    { text: 'XTAL1', at: P('Y1.1'), anchor: 'end' },
    { text: 'XTAL2', at: P('Y1.2'), anchor: 'start' },
    { text: 'XTAL1', at: { x: mcuStub, y: P('U1.19').y }, anchor: 'end' },
    { text: 'XTAL2', at: { x: mcuStub, y: P('U1.18').y }, anchor: 'end' },
    { text: 'RXD', at: { x: mcuStub, y: P('U1.10').y }, anchor: 'end' },
    { text: 'TXD', at: { x: mcuStub, y: P('U1.11').y }, anchor: 'end' },
    { text: 'RST', at: { x: mcuStub, y: P('U1.9').y }, anchor: 'end' },
    { text: 'RST', at: { x: P('SW1.4').x + 20, y: railRst }, anchor: 'start' },
    { text: 'PWR_LED', at: { x: P('D1.A@1').x, y: (P('R2.2').y + P('D1.A@1').y) / 2 }, anchor: 'start' },
    // ISP header pins
    { text: 'RXD', at: { x: P('J2.3').x - 22, y: P('J2.3').y }, anchor: 'end' },
    { text: 'TXD', at: { x: P('J2.4').x - 22, y: P('J2.4').y }, anchor: 'end' },
    { text: 'RST', at: { x: P('J2.5').x - 22, y: P('J2.5').y }, anchor: 'end' },
  ],
  flags: [
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('SW1.2').x, y: railTop }, rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('R1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C2.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('U1.40').x + 20, y: P('U1.40').y }, rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('U1.31').x + 20, y: P('U1.31').y }, rot: 90 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('U1.20'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('R2.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('D1.C@1'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('C4.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C4.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: P('C5.1'), rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C5.2'), rot: 180 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('J1.1').x - 22, y: P('J1.1').y }, rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('J1.2').x - 22, y: P('J1.2').y }, rot: 270 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('J2.1').x - 22, y: P('J2.1').y }, rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('J2.2').x - 22, y: P('J2.2').y }, rot: 270 },
  ],
  junctions: [
    { at: [P('R1.1').x, railRst] },
    { at: [P('C3.2').x, railRst] },
  ],
  texts: [
    { text: 'STC89C52RC 最小系统', at: [60, 52], size: 14, color: '#000080' },
    { text: '全部器件取自立创EDA标准库(符号名见 BOM);引脚依据数据手册 p.7,复位时序 p.16,内置 POR p.17/20,ISP p.4', at: [60, 70], size: 7, color: '#000080' },
    { text: '复位电路', at: [200, 266], size: 9, color: '#004080' },
    { text: '晶振电路', at: [262, 566], size: 9, color: '#004080' },
    { text: '去耦 与 电源指示', at: [640, 150], size: 9, color: '#004080' },
    { text: '电源 / 下载接口', at: [880, 296], size: 9, color: '#004080' },
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
const { markdown } = buildReport(doc, netlist, { sheetName: 'STC89C52RC 最小系统 v3' });
await fs.writeFile(`${base}.report.md`, markdown, 'utf8');
await exportJson(`${base}.esch`, { out: `${base}.json`, projectDir: path.join(here, 'STC89C52RC-Minimal-v3') });
const results = await convert(`${base}.esch`, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });

console.log('--- nets ---');
for (const n of netlist.nets.filter((x) => x.pins.length > 1)) console.log(n.name.padEnd(8), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
console.log('stats:', JSON.stringify(netlist.statistics));
if (warnings.length) console.log('warnings:', warnings);
for (const r of results) for (const [k, v] of Object.entries(r.outputs)) console.log(' ', k, v);
