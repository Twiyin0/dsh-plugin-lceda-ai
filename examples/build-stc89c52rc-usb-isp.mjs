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

const COMPONENTS = [
  // --- USB + power -------------------------------------------------------
  { part: parts.usb, ref: 'J1', value: 'USB-MICRO', x: 150, y: 250 },
  { part: parts.ldo, ref: 'U2', value: 'AMS1117-5.0', x: 170, y: 470 },
  { part: parts.cp, ref: 'C1', value: '10uF', x: 90, y: 560, rot: 90 },     // LDO input
  { part: parts.cp, ref: 'C2', value: '10uF', x: 250, y: 560, rot: 90 },    // LDO output bulk
  { part: parts.c, ref: 'C3', value: '100nF', x: 250, y: 640, rot: 90 },    // LDO output HF
  // --- USB to serial -----------------------------------------------------
  { part: parts.ch340, ref: 'U3', value: 'CH340G', x: 470, y: 330 },
  { part: parts.c, ref: 'C9', value: '100nF', x: 620, y: 250, rot: 90 },    // V3 regulator
  { part: parts.xtal, ref: 'Y2', value: '12MHz', x: 380, y: 600 },
  { part: parts.c, ref: 'C6', value: '22pF', x: 320, y: 660, rot: 90 },
  { part: parts.c, ref: 'C7', value: '22pF', x: 440, y: 660, rot: 90 },
  // --- MCU ---------------------------------------------------------------
  { part: parts.mcu, ref: 'U1', value: 'STC89C52RC-40I', x: 800, y: 380 },
  { part: parts.xtal, ref: 'Y1', value: '11.0592MHz', x: 120, y: 650 },
  { part: parts.c, ref: 'C4', value: '30pF', x: 70, y: 720, rot: 90 },
  { part: parts.c, ref: 'C5', value: '30pF', x: 190, y: 720, rot: 90 },
  { part: parts.c, ref: 'C10', value: '100nF', x: 900, y: 545, rot: 90 },   // MCU decoupling
  { part: parts.cp, ref: 'C11', value: '10uF', x: 960, y: 545, rot: 90 },
  // --- reset -------------------------------------------------------------
  { part: parts.sw, ref: 'SW1', value: 'RESET', x: 640, y: 150, rot: 90 },
  { part: parts.cp, ref: 'C8', value: '10uF', x: 750, y: 150, rot: 90 },
  { part: parts.r, ref: 'R1', value: '10k', x: 850, y: 205, rot: 90 },
  // --- indicator + download header ---------------------------------------
  { part: parts.r, ref: 'R2', value: '1k', x: 1020, y: 200, rot: 90 },
  { part: parts.led, ref: 'D1', value: 'RED', x: 1020, y: 280 },
  { part: parts.hdr5, ref: 'J2', value: 'ISP', x: 1060, y: 430, rot: 90 },
  // IO breakouts: P1 and P2 on 2.54 mm headers, so the board is usable as a dev board
  { part: parts.hdr8, ref: 'J3', value: 'P1.0-P1.7', x: 560, y: 210 },
  { part: parts.hdr8, ref: 'J4', value: 'P2.0-P2.7', x: 1050, y: 520 },
];

const probe = new SchematicBuilder({ title: 'probe' });
for (const c of COMPONENTS) probe.place(c);
const P = (ref) => {
  const p = probe.pins().get(ref);
  if (!p) throw new Error(`unknown pin ${ref}`);
  return { x: p.x, y: p.y };
};
const stub = (ref, dx = 26, dy = 0) => ({ x: P(ref).x + dx, y: P(ref).y + dy });
// CH340G pins 1-8 sit on the left edge and 9-16 on the right edge, so a stub has
// to leave the symbol on the correct side (an inward stub draws over the body).
const lStub = (ref) => stub(ref, -26);
const rStub = (ref) => stub(ref, 26);

// rails for the reset block (kept identical in style to the minimal-system sheet)
const railTop = 90;
const railRst = 190;
const mcuStub = P('U1.9').x - 46;

const spec = {
  title: 'STC89C52RC + AMS1117-5.0 + CH340G USB 下载板',
  company: 'lceda-ai',
  rev: '1.0',
  date: new Date().toISOString().slice(0, 10),
  drawnBy: 'AI Agent',
  components: COMPONENTS,
  wires: [
    // ---- USB connector to the LDO input ---------------------------------
    { points: [P('J1.1'), { x: P('J1.1').x - 30, y: P('J1.1').y }] },
    { points: [P('J1.2'), { x: P('J1.2').x - 30, y: P('J1.2').y }] },
    { points: [P('J1.3'), { x: P('J1.3').x - 30, y: P('J1.3').y }] },
    { points: [P('J1.5'), { x: P('J1.5').x - 30, y: P('J1.5').y }] },
    // ---- LDO in / out ----------------------------------------------------
    { points: [P('U2.3'), { x: P('U2.3').x + 30, y: P('U2.3').y }] },
    { points: [P('U2.2'), { x: P('U2.2').x + 30, y: P('U2.2').y }] },
    { points: [P('U2.1'), { x: P('U2.1').x - 30, y: P('U2.1').y }] },
    { points: [P('C1.1'), { x: P('C1.1').x, y: P('C1.1').y - 24 }] },
    { points: [P('C2.1'), { x: P('C2.1').x, y: P('C2.1').y - 24 }] },
    { points: [P('C3.1'), { x: P('C3.1').x, y: P('C3.1').y - 24 }] },
    // ---- CH340G: V3 regulator cap ---------------------------------------
    // A wire from V3 to C9 would run straight through the symbol body and touch
    // DTR# (same y on the right edge), so V3 is carried by a label instead.
    { points: [P('U3.4'), lStub('U3.4')] },
    { points: [P('C9.2'), { x: P('C9.2').x, y: P('C9.2').y + 26 }] },
    { points: [P('C9.1'), { x: P('C9.1').x, y: P('C9.1').y - 22 }] },
    // ---- CH340G: 12 MHz crystal + load caps ------------------------------
    // Crystal and its caps are wired locally; XI/XO reach the chip by label, so
    // the two nets cannot short against each other along the pin column.
    { points: [P('Y2.1'), { x: P('C6.1').x, y: P('Y2.1').y }, P('C6.1')] },
    { points: [P('Y2.2'), { x: P('C7.1').x, y: P('Y2.2').y }, P('C7.1')] },
    { points: [P('U3.7'), lStub('U3.7')] },
    { points: [P('U3.8'), lStub('U3.8')] },
    // ---- CH340G: serial + USB data + R232 --------------------------------
    { points: [P('U3.2'), lStub('U3.2')] },
    { points: [P('U3.3'), lStub('U3.3')] },
    { points: [P('U3.5'), lStub('U3.5')] },
    { points: [P('U3.6'), lStub('U3.6')] },
    { points: [P('U3.15'), rStub('U3.15')] },
    { points: [P('U3.16'), rStub('U3.16')] },
    { points: [P('U3.1'), lStub('U3.1')] },
    // ---- MCU clock -------------------------------------------------------
    { points: [P('U1.19'), { x: mcuStub, y: P('U1.19').y }] },
    { points: [P('U1.18'), { x: mcuStub, y: P('U1.18').y }] },
    { points: [P('U1.10'), { x: mcuStub, y: P('U1.10').y }] },
    { points: [P('U1.11'), { x: mcuStub, y: P('U1.11').y }] },
    { points: [P('Y1.1'), { x: P('Y1.1').x, y: P('C4.1').y }, P('C4.1')] },
    { points: [P('Y1.2'), { x: P('Y1.2').x, y: P('C5.1').y }, P('C5.1')] },
    // ---- MCU power pins ---------------------------------------------------
    { points: [P('U1.40'), { x: P('U1.40').x + 24, y: P('U1.40').y }] },
    { points: [P('U1.31'), { x: P('U1.31').x + 24, y: P('U1.31').y }] },
    { points: [P('U1.20'), { x: P('U1.20').x - 24, y: P('U1.20').y }] },
    { points: [P('C10.1'), { x: P('C10.1').x, y: P('C10.1').y - 22 }] },
    { points: [P('C11.1'), { x: P('C11.1').x, y: P('C11.1').y - 22 }] },
    // ---- reset network ----------------------------------------------------
    { points: [P('SW1.2'), P('SW1.1')] },
    { points: [P('SW1.2'), { x: P('SW1.2').x, y: railTop }, { x: P('C8.1').x, y: railTop }, P('C8.1')] },
    { points: [P('SW1.4'), P('SW1.3')] },
    { points: [P('SW1.4'), { x: P('SW1.4').x, y: railRst }, { x: P('R1.1').x, y: railRst }, P('R1.1')] },
    { points: [P('C8.2'), { x: P('C8.2').x, y: railRst }] },
    { points: [{ x: P('R1.1').x, y: railRst }, { x: mcuStub - 12, y: railRst }, { x: mcuStub - 12, y: P('U1.9').y }, P('U1.9')] },
    // ---- power indicator ---------------------------------------------------
    { points: [P('R2.2'), P('D1.A@1')] },
    { points: [P('R2.1'), { x: P('R2.1').x, y: P('R2.1').y - 22 }] },
    // ---- ISP header stubs --------------------------------------------------
    { points: [P('J2.1'), { x: P('J2.1').x - 24, y: P('J2.1').y }] },
    { points: [P('J2.2'), { x: P('J2.2').x - 24, y: P('J2.2').y }] },
    { points: [P('J2.3'), { x: P('J2.3').x - 24, y: P('J2.3').y }] },
    { points: [P('J2.4'), { x: P('J2.4').x - 24, y: P('J2.4').y }] },
    { points: [P('J2.5'), { x: P('J2.5').x - 24, y: P('J2.5').y }] },
    // IO breakout stubs: the MCU pin column and the header both get a short stub,
    // the net is carried by a P1.x / P2.x label
    ...Array.from({ length: 8 }, (_, i) => ({ points: [P(`U1.${i + 1}`), { x: mcuStub, y: P(`U1.${i + 1}`).y }] })),
    ...Array.from({ length: 8 }, (_, i) => ({ points: [P(`U1.${i + 21}`), { x: P(`U1.${i + 21}`).x + 24, y: P(`U1.${i + 21}`).y }] })),
    ...Array.from({ length: 8 }, (_, i) => ({ points: [P(`J3.${i + 1}`), { x: P(`J3.${i + 1}`).x - 22, y: P(`J3.${i + 1}`).y }] })),
    ...Array.from({ length: 8 }, (_, i) => ({ points: [P(`J4.${i + 1}`), { x: P(`J4.${i + 1}`).x + 22, y: P(`J4.${i + 1}`).y }] })),
  ],
  labels: [
    // USB side
    { text: 'VBUS', at: { x: P('J1.1').x - 30, y: P('J1.1').y }, anchor: 'end' },
    { text: 'USB_D-', at: { x: P('J1.2').x - 30, y: P('J1.2').y }, anchor: 'end' },
    { text: 'USB_D+', at: { x: P('J1.3').x - 30, y: P('J1.3').y }, anchor: 'end' },
    { text: 'VBUS', at: { x: P('U2.3').x + 30, y: P('U2.3').y }, anchor: 'start' },
    { text: 'VBUS', at: { x: P('C1.1').x, y: P('C1.1').y - 24 }, anchor: 'start' },
    // CH340G signals
    { text: 'TXD', at: lStub('U3.2'), anchor: 'end' },
    { text: 'RXD', at: lStub('U3.3'), anchor: 'end' },
    { text: 'USB_D+', at: lStub('U3.5'), anchor: 'end' },
    { text: 'USB_D-', at: lStub('U3.6'), anchor: 'end' },
    { text: 'V3', at: lStub('U3.4'), anchor: 'end' },
    { text: 'V3', at: { x: P('C9.2').x, y: P('C9.2').y + 26 }, anchor: 'start' },
    { text: 'XI', at: lStub('U3.7'), anchor: 'end' },
    { text: 'XO', at: lStub('U3.8'), anchor: 'end' },
    { text: 'XI', at: { x: (P('Y2.1').x + P('C6.1').x) / 2, y: P('Y2.1').y }, anchor: 'middle' },
    { text: 'XO', at: { x: (P('Y2.2').x + P('C7.1').x) / 2, y: P('Y2.2').y }, anchor: 'middle' },
    // MCU side
    { text: 'XTAL1', at: { x: mcuStub, y: P('U1.19').y }, anchor: 'end' },
    { text: 'XTAL2', at: { x: mcuStub, y: P('U1.18').y }, anchor: 'end' },
    { text: 'RXD', at: { x: mcuStub, y: P('U1.10').y }, anchor: 'end' },
    { text: 'TXD', at: { x: mcuStub, y: P('U1.11').y }, anchor: 'end' },
    { text: 'RST', at: { x: mcuStub, y: P('U1.9').y }, anchor: 'end' },
    // labels must sit exactly ON the wire, otherwise the net silently breaks
    { text: 'XTAL1', at: { x: P('Y1.1').x, y: (P('Y1.1').y + P('C4.1').y) / 2 }, anchor: 'end' },
    { text: 'XTAL2', at: { x: P('Y1.2').x, y: (P('Y1.2').y + P('C5.1').y) / 2 }, anchor: 'start' },
    { text: 'RST', at: { x: P('SW1.4').x + 22, y: railRst }, anchor: 'start' },
    { text: 'PWR_LED', at: { x: P('D1.A@1').x, y: (P('R2.2').y + P('D1.A@1').y) / 2 }, anchor: 'start' },
    // ISP header
    { text: 'RXD', at: { x: P('J2.3').x - 24, y: P('J2.3').y }, anchor: 'end' },
    { text: 'TXD', at: { x: P('J2.4').x - 24, y: P('J2.4').y }, anchor: 'end' },
    { text: 'RST', at: { x: P('J2.5').x - 24, y: P('J2.5').y }, anchor: 'end' },
    // P1.0-P1.7 and P2.0-P2.7 breakouts
    ...Array.from({ length: 8 }, (_, i) => ({ text: `P1.${i}`, at: { x: mcuStub, y: P(`U1.${i + 1}`).y }, anchor: 'end' })),
    ...Array.from({ length: 8 }, (_, i) => ({ text: `P2.${i}`, at: { x: P(`U1.${i + 21}`).x + 24, y: P(`U1.${i + 21}`).y }, anchor: 'start' })),
    ...Array.from({ length: 8 }, (_, i) => ({ text: `P1.${i}`, at: { x: P(`J3.${i + 1}`).x - 22, y: P(`J3.${i + 1}`).y }, anchor: 'end' })),
    ...Array.from({ length: 8 }, (_, i) => ({ text: `P2.${i}`, at: { x: P(`J4.${i + 1}`).x + 22, y: P(`J4.${i + 1}`).y }, anchor: 'start' })),
  ],
  flags: [
    // +5V rail
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('U2.2').x + 30, y: P('U2.2').y }, rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('C2.1').x, y: P('C2.1').y - 24 }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('C3.1').x, y: P('C3.1').y - 24 }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: rStub('U3.16'), rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('U1.40').x + 24, y: P('U1.40').y }, rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('U1.31').x + 24, y: P('U1.31').y }, rot: 90 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('SW1.2').x, y: railTop }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('R2.1').x, y: P('R2.1').y - 22 }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('C10.1').x, y: P('C10.1').y - 22 }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('C11.1').x, y: P('C11.1').y - 22 }, rot: 0 },
    { text: '+5V', kind: 'part_netLabel_+5V', at: { x: P('J2.1').x - 24, y: P('J2.1').y }, rot: 270 },
    // GND
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('J1.5').x - 30, y: P('J1.5').y }, rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('U2.1').x - 30, y: P('U2.1').y }, rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C2.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C3.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('C9.1').x, y: P('C9.1').y - 22 }, rot: 0 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C6.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C7.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: lStub('U3.1'), rot: 90 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: rStub('U3.15'), rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('U1.20').x - 24, y: P('U1.20').y }, rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C4.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C5.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C10.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('C11.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('R1.2'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: P('D1.C@1'), rot: 180 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: { x: P('J2.2').x - 24, y: P('J2.2').y }, rot: 270 },
  ],
  junctions: [
    { at: [P('R1.1').x, railRst] },
    { at: [P('C8.2').x, railRst] },
  ],
  texts: [
    { text: 'STC89C52RC + AMS1117-5.0 + CH340G USB 下载板', at: [40, 40], size: 13, color: '#000080' },
    { text: '符号全部取自立创EDA标准库;CH340G 引脚依据数据手册 16/16 校验通过', at: [40, 58], size: 7, color: '#000080' },
    { text: '设计要点:', at: [40, 84], size: 8, color: '#004080' },
    { text: '· 电源:USB 5V → AMS1117-5.0 → VCC(带载约 4.4V,STC89C52RC 规定 3.4~5.5V)', at: [40, 100], size: 7, color: '#404040' },
    { text: '· 下载:CH340G TXD→P3.0(RXD),RXD←P3.1(TXD);STC89C52RC 走 UART ISP,不是 SPI', at: [40, 114], size: 7, color: '#404040' },
    { text: '· 冷启动:按 SW1 复位或重新插拔 USB,配合 STC-ISP 等待上电', at: [40, 128], size: 7, color: '#404040' },
    { text: '· CH340G 的 CTS#/DSR#/RI#/DCD#/DTR#/RTS# 与 USB 的 ID 脚悬空', at: [40, 142], size: 7, color: '#404040' },
    { text: '· P1.0~P1.7 / P2.0~P2.7 引出到 J3 / J4;P0、P3 其余引脚本板未引出', at: [40, 156], size: 7, color: '#404040' },
    { text: '· 12MHz(CH340G)+2×22pF;11.0592MHz(MCU)+2×30pF,波特率精确', at: [40, 170], size: 7, color: '#404040' },
  ],
};

const { doc, text, netlist, warnings } = buildFromSpec(spec);
await writeDocument(`${base}.esch`, text);
const { markdown } = buildReport(doc, netlist, { sheetName: 'STC89C52RC USB 下载板' });
await fs.writeFile(`${base}.report.md`, markdown, 'utf8');
await exportJson(`${base}.esch`, { out: `${base}.json`, projectDir: path.join(here, 'STC89C52RC-USB-ISP') });
const results = await convert(`${base}.esch`, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });

console.log('--- warnings ---');
for (const w of warnings) console.log(' !', w);
console.log('--- nets ---');
for (const n of netlist.nets) console.log(n.name.padEnd(10), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
console.log('stats:', JSON.stringify(netlist.statistics));
for (const r of results) console.log('rendered:', r.input, Object.keys(r.outputs ?? {}).join(','));
