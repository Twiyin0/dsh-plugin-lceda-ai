// STC89C52RC + AMS1117-5.0 LDO + CH340G USB→TTL download board.
//
// Every part is a real LCEDA standard-library symbol, resolved once from the
// editor's own library API and pinned here so rebuilds are byte-stable.
//
// Design notes (what the wiring is supposed to be, and why):
//   power   USB VBUS (5 V) -> AMS1117-5.0 -> VCC rail (~4.4 V under load).
//           The STC89C52RC is specified 3.4-5.5 V, so the LDO's dropout is fine,
//           and it keeps the rail clean of USB transients.
//   uart    CH340G TXD -> MCU P3.0 (RXD), CH340G RXD <- MCU P3.1 (TXD).
//           STC89C52RC downloads over its UART ISP (P3.0/P3.1), not SPI; the
//           5-pin header also breaks those signals out for a bare USB-TTL cable.
//   clock   MCU 11.0592 MHz + 2x30 pF (exact baud rates), CH340G 12 MHz + 2x22 pF.
//   reset   10 k to GND, 10 uF to VCC, tact switch to VCC - power-on reset plus
//           the manual reset the STC ISP tool asks for when it waits for a cold
//           start.
//   V3      at 5 V operation the CH340G's V3 pin is the internal 3.3 V regulator
//           output and needs 100 nF to GND; R232 is tied low for TTL levels.
//   unused  CH340G modem pins (CTS#/DSR#/RI#/DCD#/DTR#/RTS#) and the USB ID pin
//           are left open.
import { SchematicBuilder, buildFromSpec, writeDocument } from '../src/create.js';
import { convert } from '../src/index.js';
import { buildReport } from '../src/report.js';
import { exportJson } from '../src/exportjson.js';
import { fetchStandard, validatePinout, symbolQuality } from '../src/library.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(here, 'stc89c52rc-usb-isp');

const STD = {
  mcu: '3dbb121984d94b3eb880951da5f2cfd0',      // STC89C52RC (DIP-40)
  ch340: 'ceee12c780eb4a9a91d6536d27a8dd8c',    // CH340G, 16/16 pins match the datasheet
  ldo: 'b6071be6db574825bc85413a4d91dfbe',      // AMS1117-5.0 (VIN/VOUT/GND)
  usb: '6ca6fa785a354d4ebdae7cdbbb4d177e',      // Micro_USB, 5 pins
  r: '96ab93705fad467397e1ee5fa4b8c4da',        // R_0603_US
  c: '8d671d429f5b42f8b56b5f0ebf60f568',        // C_0603_US
  cp: '5fc1fd1be5844ec4bb0947b2b6fcbbaf',       // C_Tan_SMD_A_US
  xtal: '2fb041f269694f8f992573205c6bd1b3',     // hc-49s
  sw: '9e4fc5625813450aa4631a3dcf08bd3f',       // TS-1187A-B-A-B (4 pin tact switch)
  led: '1a6ff3bd6d394843b45922df88924d32',      // LEDCHIPLED-0603-TTW
  hdr5: '796a7da953d64c9e844d135c1e602c95',     // HDR-M-2.54_1x5
  hdr8: '71169953917e4ab4a6df4f3297403343',     // HDR-M-2.54_1X8
};

const parts = {};
for (const [k, uuid] of Object.entries(STD)) parts[k] = await fetchStandard(uuid);

// sanity: the MCU symbol against the datasheet pin table
const pinCheck = validatePinout(parts.mcu.doc, 'stc89c52rc');
console.log(`MCU pinout: ${pinCheck.matched}/${pinCheck.total} vs ${pinCheck.source}`);
for (const [k, p] of Object.entries(parts)) {
  const pins = (p.doc.shape ?? []).filter((r) => String(r).startsWith('P~')).length;
  console.log(`  ${k.padEnd(6)} ${String(p.doc.head?.c_para?.name ?? '').padEnd(14)} ${String(p.doc.head?.c_para?.package ?? '').padEnd(22)} pins=${pins} quality=${symbolQuality(p.doc)}`);
}

// ---------------------------------------------------------------------------
// Placement, drawn the way a readable schematic is drawn:
//   * every net label sits OUTSIDE the symbol body, on the side the pin leaves
//   * power flags point away from the part (0 = up, 90 = right, 180 = down, 270 = left)
//   * blocks are wired locally; signals between blocks travel by label, so no wire
//     ever crosses another part or another pin
//   * decoupling pairs sit side by side on shared +5V / GND rails
// ---------------------------------------------------------------------------
const COMPONENTS = [
  // --- USB input ---------------------------------------------------------
  { part: parts.usb, ref: 'J1', value: 'USB-MICRO', x: 150, y: 250 },
  // --- LDO and its input/output capacitors -------------------------------
  { part: parts.ldo, ref: 'U2', value: 'AMS1117-5.0', x: 170, y: 470 },
  { part: parts.cp, ref: 'C1', value: '10uF', x: 90, y: 560, rot: 90 },       // VBUS bulk
  { part: parts.cp, ref: 'C2', value: '10uF', x: 250, y: 560, rot: 90 },      // +5V bulk  )
  { part: parts.c, ref: 'C3', value: '100nF', x: 330, y: 560, rot: 90 },      // +5V HF    ) parallel
  // --- USB to serial -----------------------------------------------------
  { part: parts.ch340, ref: 'U3', value: 'CH340G', x: 470, y: 330 },
  { part: parts.c, ref: 'C9', value: '100nF', x: 620, y: 250, rot: 90 },      // V3 regulator
  { part: parts.xtal, ref: 'Y2', value: '12MHz', x: 380, y: 600 },
  { part: parts.c, ref: 'C6', value: '22pF', x: 330, y: 660, rot: 90 },
  { part: parts.c, ref: 'C7', value: '22pF', x: 430, y: 660, rot: 90 },
  // --- MCU and its decoupling -------------------------------------------
  { part: parts.mcu, ref: 'U1', value: 'STC89C52RC-40I', x: 800, y: 380 },
  { part: parts.c, ref: 'C10', value: '100nF', x: 555, y: 545, rot: 90 },     // ) parallel
  { part: parts.cp, ref: 'C11', value: '10uF', x: 630, y: 545, rot: 90 },    // )
  // --- MCU clock (wired to the XTAL pins by label) -----------------------
  { part: parts.xtal, ref: 'Y1', value: '11.0592MHz', x: 170, y: 675 },
  { part: parts.c, ref: 'C4', value: '30pF', x: 120, y: 735, rot: 90 },
  { part: parts.c, ref: 'C5', value: '30pF', x: 220, y: 735, rot: 90 },
  // --- reset -------------------------------------------------------------
  { part: parts.sw, ref: 'SW1', value: 'RESET', x: 640, y: 150, rot: 90 },
  { part: parts.cp, ref: 'C8', value: '10uF', x: 750, y: 150, rot: 90 },
  { part: parts.r, ref: 'R1', value: '10k', x: 850, y: 205, rot: 90 },
  // --- power indicator ----------------------------------------------------
  { part: parts.r, ref: 'R2', value: '1k', x: 300, y: 262, rot: 90 },
  { part: parts.led, ref: 'D1', value: 'RED', x: 300, y: 332 },
  // --- headers on the right edge -----------------------------------------
  // headers are rotated so their pins stack VERTICALLY: side by side, the power
  // flag graphics of adjacent pins overlap and silently short the nets
  { part: parts.hdr8, ref: 'J3', value: 'P1', x: 1030, y: 240, rot: 90 },
  { part: parts.hdr8, ref: 'J4', value: 'P2', x: 1030, y: 360, rot: 90 },
  { part: parts.hdr5, ref: 'J2', value: 'ISP', x: 1030, y: 500, rot: 90 },
];

const probe = new SchematicBuilder({ title: 'probe' });
for (const c of COMPONENTS) probe.place(c);
const P = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  return { x: p.x, y: p.y };
};
/**
 * Which way a pin leaves its symbol: 0 up, 90 right, 180 down, 270 left.
 *
 * Read from the pin's own `path`, not from `orient`: the library is not
 * consistent about that field (a CH340G pin carries the outward direction, a
 * capacitor pin carries the stub direction), and trusting it put both crystal
 * pins on one net and hung the load capacitors off GND. The path is unambiguous -
 * it runs from the connection point into the symbol, so outward is the opposite.
 */
const OUT = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  const path = String(p.path ?? '');
  let dx = 0, dy = 0;
  const h = /h\s*(-?[\d.]+)/i.exec(path);
  const v = /v\s*(-?[\d.]+)/i.exec(path);
  const L = /L\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(path);
  const M = /M\s*(-?[\d.]+)\s+(-?[\d.]+)/i.exec(path);
  if (h) dx = Number(h[1]);
  else if (v) dy = Number(v[1]);
  else if (L && M) { dx = Number(L[1]) - Number(M[1]); dy = Number(L[2]) - Number(M[2]); }
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 270 : 90;   // stub right -> out left
  return dy > 0 ? 0 : 180;                                     // stub down  -> out up
};
// 0 up, 90 right, 180 down, 270 left - in screen coordinates (y grows downward)
const DIRV = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };
const step = (ref, dist = 10) => {
  const p = P(ref);
  const [dx, dy] = DIRV[OUT(ref)] ?? [0, 1];
  return { x: Math.round(p.x + dx * dist), y: Math.round(p.y + dy * dist) };
};
const wires = [];
/** Stub a pin outward and return the point where a label/flag should sit. */
const stubOut = (ref, dist = 22) => {
  const end = step(ref, dist);
  wires.push({ points: [P(ref), end] });
  return end;
};
const labels = [];
const flags = [];
const junctions = [];
/** Net label just outside the pin (never over the symbol body). */
const labelOut = (ref, text, dist = 22) => {
  const end = stubOut(ref, dist);
  const d = OUT(ref);
  labels.push({ text, at: end, anchor: d === 270 ? 'end' : d === 90 ? 'start' : 'start' });
};
/** Power flag outside the pin, graphic pointing away from the part. */
const flagOut = (ref, text, kind, dist = 22) => {
  const end = stubOut(ref, dist);
  flags.push({ text, kind, at: end, rot: OUT(ref) });
};
/** Flag placed directly on a pin that already has a wire (no extra stub). */
const flagAt = (point, text, kind, rot) => flags.push({ text, kind, at: point, rot });


// ---- USB input ------------------------------------------------------------
labelOut('J1.1', 'VBUS');
labelOut('J1.2', 'USB_D-');
labelOut('J1.3', 'USB_D+');
flagOut('J1.5', 'GND', 'part_netLabel_gnD');

// ---- LDO: VIN / VOUT / GND ------------------------------------------------
labelOut('U2.3', 'VBUS');
flagOut('U2.2', '+5V', 'part_netLabel_+5V');
flagOut('U2.1', 'GND', 'part_netLabel_gnD');

// ---- input bulk cap -------------------------------------------------------
{
  const top = step('C1.1', 26), bottom = step('C1.2', 26);
  wires.push({ points: [P('C1.1'), top] }, { points: [P('C1.2'), bottom] });
  labels.push({ text: 'VBUS', at: top, anchor: 'start' });
  flagAt(bottom, 'GND', 'part_netLabel_gnD', OUT('C1.2'));
}

// ---- output caps in parallel on shared rails ------------------------------
for (const [left, right] of [['C2', 'C3'], ['C10', 'C11']]) {
  const railTop = P(`${left}.1`).y - 30;
  const railBottom = P(`${left}.2`).y + 30;
  wires.push(
    { points: [P(`${left}.1`), { x: P(`${left}.1`).x, y: railTop }] },
    { points: [P(`${right}.1`), { x: P(`${right}.1`).x, y: railTop }] },
    { points: [{ x: P(`${left}.1`).x, y: railTop }, { x: P(`${right}.1`).x, y: railTop }] },
    { points: [P(`${left}.2`), { x: P(`${left}.2`).x, y: railBottom }] },
    { points: [P(`${right}.2`), { x: P(`${right}.2`).x, y: railBottom }] },
    { points: [{ x: P(`${left}.2`).x, y: railBottom }, { x: P(`${right}.2`).x, y: railBottom }] },
  );
  flagAt({ x: P(`${left}.1`).x, y: railTop }, '+5V', 'part_netLabel_+5V', 0);
  flagAt({ x: P(`${left}.2`).x, y: railBottom }, 'GND', 'part_netLabel_gnD', 180);
  junctions.push({ at: [P(`${left}.1`).x, railTop] }, { at: [P(`${left}.2`).x, railBottom] });
}

// ---- CH340G ---------------------------------------------------------------
flagOut('U3.1', 'GND', 'part_netLabel_gnD');
labelOut('U3.2', 'TXD');
labelOut('U3.3', 'RXD');
labelOut('U3.4', 'V3');
labelOut('U3.5', 'USB_D+');
labelOut('U3.6', 'USB_D-');
labelOut('U3.7', 'XI');
labelOut('U3.8', 'XO');
flagOut('U3.15', 'GND', 'part_netLabel_gnD');   // R232 low = TTL levels
flagOut('U3.16', '+5V', 'part_netLabel_+5V');

// ---- CH340G V3 regulator cap ---------------------------------------------
{
  const top = step('C9.1', 24), bottom = step('C9.2', 24);
  wires.push({ points: [P('C9.1'), top] }, { points: [P('C9.2'), bottom] });
  flagAt(top, 'GND', 'part_netLabel_gnD', OUT('C9.1'));
  labels.push({ text: 'V3', at: bottom, anchor: 'start' });
}

// ---- crystals + their load capacitors ------------------------------------
// The capacitor is wired straight to its crystal pin (a small jog keeps the two
// value texts apart) instead of being tied by a second label with the same name:
// two labels on one net look like two nets and mislead whoever reads the sheet.
function crystalBlock(crystal, capA, capB, nameA, nameB) {
  const [pinA, pinB] = [`${crystal}.1`, `${crystal}.2`];
  const jogA = P(pinA).y + 28, jogB = P(pinB).y + 28;
  wires.push({ points: [P(pinA), { x: P(pinA).x, y: jogA }, { x: P(`${capA}.1`).x, y: jogA }, P(`${capA}.1`)] });
  wires.push({ points: [P(pinB), { x: P(pinB).x, y: jogB }, { x: P(`${capB}.1`).x, y: jogB }, P(`${capB}.1`)] });
  labelOut(pinA, nameA, 34);
  labelOut(pinB, nameB, 34);
  flagOut(`${capA}.2`, 'GND', 'part_netLabel_gnD', 24);
  flagOut(`${capB}.2`, 'GND', 'part_netLabel_gnD', 24);
}
crystalBlock('Y2', 'C6', 'C7', 'XI', 'XO');
crystalBlock('Y1', 'C4', 'C5', 'XTAL1', 'XTAL2');

// ---- MCU ------------------------------------------------------------------
for (let i = 0; i < 8; i++) labelOut(`U1.${i + 1}`, `P1.${i}`);          // P1.0-P1.7
labelOut('U1.9', 'RST');
labelOut('U1.10', 'RXD');
labelOut('U1.11', 'TXD');
labelOut('U1.18', 'XTAL2');
labelOut('U1.19', 'XTAL1');
flagOut('U1.20', 'GND', 'part_netLabel_gnD', 12);  // short: C10's +5V flag sits nearby
for (let i = 0; i < 8; i++) labelOut(`U1.${i + 21}`, `P2.${i}`);         // P2.0-P2.7
flagOut('U1.31', '+5V', 'part_netLabel_+5V');                            // /EA high = internal ROM
flagOut('U1.40', '+5V', 'part_netLabel_+5V');

// ---- reset: local wiring, RST reaches the MCU by label --------------------
{
  const railTop = 90;
  const railRst = 190;
  wires.push(
    { points: [P('SW1.2'), P('SW1.1')] },
    { points: [P('SW1.2'), { x: P('SW1.2').x, y: railTop }, { x: P('C8.1').x, y: railTop }, P('C8.1')] },
    { points: [P('SW1.4'), P('SW1.3')] },
    { points: [P('SW1.4'), { x: P('SW1.4').x, y: railRst }, { x: P('R1.1').x, y: railRst }, P('R1.1')] },
    { points: [P('C8.2'), { x: P('C8.2').x, y: railRst }] },
  );
  junctions.push({ at: [P('R1.1').x, railRst] }, { at: [P('C8.2').x, railRst] });
  flagAt({ x: P('SW1.2').x, y: railTop }, '+5V', 'part_netLabel_+5V', 0);
  labels.push({ text: 'RST', at: { x: P('C8.2').x, y: railRst }, anchor: 'start' });
  flagOut('R1.2', 'GND', 'part_netLabel_gnD');
}

// ---- power indicator ------------------------------------------------------
flagOut('R2.1', '+5V', 'part_netLabel_+5V');
wires.push({ points: [P('R2.2'), P('D1.A@1')] });
flagOut('D1.C@1', 'GND', 'part_netLabel_gnD');

// ---- ISP header -----------------------------------------------------------
// the two power flags get different stub lengths so their symbols do not touch
flagOut('J2.1', '+5V', 'part_netLabel_+5V', 44);
flagOut('J2.2', 'GND', 'part_netLabel_gnD', 62);
labelOut('J2.3', 'RXD', 26);
labelOut('J2.4', 'TXD', 44);
labelOut('J2.5', 'RST', 62);

// ---- IO breakouts ---------------------------------------------------------
// A 1xN header's pins are always in one row 10 units apart, so neighbouring
// label texts would overlap (and overlapping labels merge nets). Fan them out:
// alternate short and long stubs, which puts adjacent labels 18 units apart.
// four stub lengths, so labels sharing a row are 40 units apart (wider than the
// text) and neighbouring rows are 18 apart - two levels still ran together
for (let i = 0; i < 8; i++) labelOut(`J3.${i + 1}`, `P1.${i}`, 26 + (i % 4) * 18);
for (let i = 0; i < 8; i++) labelOut(`J4.${i + 1}`, `P2.${i}`, 26 + (i % 4) * 18);

const spec = {
  title: 'STC89C52RC + AMS1117-5.0 + CH340G USB 下载板',
  company: 'lceda-ai',
  rev: '1.1',
  date: new Date().toISOString().slice(0, 10),
  drawnBy: 'AI Agent',
  components: COMPONENTS,
  wires,
  labels,
  flags,
  junctions,
  texts: [
    { text: 'STC89C52RC + AMS1117-5.0 + CH340G USB 下载板', at: [70, 60], size: 13, color: '#000080' },
    { text: '符号全部取自立创EDA标准库,CH340G 引脚依据数据手册 16/16 校验通过', at: [70, 78], size: 7, color: '#000080' },
    { text: '设计要点:', at: [70, 104], size: 8, color: '#004080' },
    { text: '· 电源:USB 5V → AMS1117-5.0 → VCC ≈4.4V(STC89C52RC 允许 3.4-5.5V)', at: [70, 120], size: 7, color: '#404040' },
    { text: '· 下载:CH340G ↔ P3.0/P3.1;STC89C52RC 走 UART ISP,不是 SPI', at: [70, 134], size: 7, color: '#404040' },
    { text: '· 冷启动:按 SW1 复位或重插 USB,配合 STC-ISP 等待上电', at: [70, 148], size: 7, color: '#404040' },
    { text: '· CH340G 未用调制解调器引脚与 USB 的 ID 脚悬空', at: [70, 162], size: 7, color: '#404040' },
    { text: '· 去耦电容成对并联:C2/C3 在 LDO 输出,C10/C11 在 MCU', at: [70, 176], size: 7, color: '#404040' },
    { text: '· P1.0-P1.7 引出到 J3;P2.0-P2.7 引出到 J4;ISP 下载口引出到 J2', at: [70, 190], size: 7, color: '#404040' },
  ],
};

const { doc, text, netlist, warnings } = buildFromSpec(spec);
await writeDocument(`${base}.esch`, text);
const { markdown } = buildReport(doc, netlist, { sheetName: 'STC89C52RC USB 下载板' });
await fs.writeFile(`${base}.report.md`, markdown, 'utf8');
await exportJson(`${base}.esch`, { out: `${base}.json`, projectDir: path.join(here, 'stc89c52rc-usb-isp') });
const results = await convert(`${base}.esch`, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });

console.log('--- warnings ---');
for (const w of warnings) console.log(' !', w);
console.log('--- nets ---');
for (const n of netlist.nets.filter((x) => x.pins.length > 1)) console.log(n.name.padEnd(10), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
console.log('stats:', JSON.stringify(netlist.statistics));
for (const r of results) console.log('rendered:', r.input, Object.keys(r.outputs ?? {}).join(','));
