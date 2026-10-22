// Schematic -> PCB demo: the v3 minimal system, placed and net-transferred.
//
//   node examples/pcb-demo/build.mjs
//
// Produces board.json (open it in 嘉立创EDA with 文件 → 打开 → 嘉立创EDA) plus a
// layered render so the result can be reviewed without the editor.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardFromSchematic } from '../../src/pcb/fromSchematic.js';
import { renderPcbFiles } from '../../src/pcb/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schematic = path.join(here, '..', 'stc89c52rc-minimal-v3.esch');

const res = await boardFromSchematic(schematic, { title: 'STC89C52RC minimal — PCB' });
await fs.writeFile(path.join(here, 'board.json'), res.text, 'utf8');

const results = await renderPcbFiles([path.join(here, 'board.json')], {
  outDir: here, formats: ['png', 'svg', 'report'], scale: 8,
});

console.log(`board.json: ${res.stats.components} 器件 / ${res.stats.pads} 焊盘 / ${res.stats.nets} 网络 | 板框 ${res.board.widthMm} x ${res.board.heightMm} mm`);
for (const w of res.warnings) console.log('  !', w);
for (const r of results) for (const [k, v] of Object.entries(r.outputs)) console.log(`  ${k}: ${v}`);
