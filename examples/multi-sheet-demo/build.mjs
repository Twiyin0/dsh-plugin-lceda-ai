// Two sheets of one project, linked by net *scope* (verified against the editor):
//   NetFlag (VCC/GND) -> global rails
//   Net Port (RX/TX)  -> connects across sheets
//   Net Label         -> would be local to its own sheet only
//
//   Sheet_1: J1 4-pin  VCC / RX / TX / GND
//   Sheet_2: J2 8-pin  VCC / TX / RX / GND / NC / NC / NC / GND
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFromSpec } from '../../src/create.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const sheet1 = buildFromSpec({
  title: 'Sheet_1 — UART 接口 (4P)',
  company: 'lceda-ai',
  components: [{ symbol: 'header', pins: 4, ref: 'J1', value: 'UART-4P', x: 420, y: 400 }],
  flags: [
    { text: 'VCC', kind: 'part_netLabel_+5V', at: 'J1.1', rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: 'J1.4', rot: 270 },
  ],
  ports: [
    { text: 'RX', at: 'J1.2', rot: 0 },
    { text: 'TX', at: 'J1.3', rot: 0 },
  ],
  texts: [{ text: '4P 排针:VCC / RX / TX / GND(RX/TX 用网络端口跨图纸)', at: [260, 470], size: 9, color: '#004080' }],
});

const sheet2 = buildFromSpec({
  title: 'Sheet_2 — UART + 电源 (8P)',
  company: 'lceda-ai',
  components: [{ symbol: 'header', pins: 8, ref: 'J2', value: 'UART-8P', x: 420, y: 400 }],
  flags: [
    { text: 'VCC', kind: 'part_netLabel_+5V', at: 'J2.1', rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: 'J2.4', rot: 270 },
    { text: 'GND', kind: 'part_netLabel_gnD', at: 'J2.8', rot: 270 },
  ],
  ports: [
    { text: 'TX', at: 'J2.2', rot: 0 },
    { text: 'RX', at: 'J2.3', rot: 0 },
  ],
  texts: [
    { text: '8P 排针:VCC / TX / RX / GND / NC×3 / GND(TX/RX 用网络端口跨图纸)', at: [220, 520], size: 9, color: '#004080' },
    { text: '5/6/7 脚 NC(不接)', at: [300, 536], size: 8, color: '#808080' },
  ],
});

await fs.writeFile(path.join(here, 'Sheet_1.json'), sheet1.text, 'utf8');
await fs.writeFile(path.join(here, 'Sheet_2.json'), sheet2.text, 'utf8');
for (const [name, built] of [['Sheet_1', sheet1], ['Sheet_2', sheet2]]) {
  console.log(`--- ${name}`);
  for (const n of built.netlist.nets.filter((n) => n.named)) {
    console.log('   ', n.name.padEnd(5), n.pins.map((p) => `${p.ref}.${p.pin}`).join(' '));
  }
  if (built.warnings.length) console.log('    warnings:', built.warnings);
}
