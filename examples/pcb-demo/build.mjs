// Schematic -> PCB demo: place, then route the v3 minimal system.
//
//   node examples/pcb-demo/build.mjs
//
// U1 is pinned to a DIP-40 footprint explicitly: the standard library's
// footprint search for "STC89C52RC" only finds an LQFP-44 (0.8 mm pitch), which
// is the wrong package for a DIP part and cannot be routed at 0.254 mm rules.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardFromSchematic } from '../../src/pcb/fromSchematic.js';
import { routeBoard, verifyRouting } from '../../src/pcb/route.js';
import { pourBoard, pourNet, verifyPour, defaultPourNet } from '../../src/pcb/pour.js';
import { viaBoard, stitchVias, verifyVias } from '../../src/pcb/via.js';
import { runDrc, drcMarkdown } from '../../src/pcb/drc.js';
import { exportGerber, verifyGerber } from '../../src/pcb/gerber.js';
import { renderPcbFiles } from '../../src/pcb/render.js';
import { readPcbFile } from '../../src/pcb/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schematic = path.join(here, '..', 'stc89c52rc-minimal-v3.esch');

const placed = await boardFromSchematic(schematic, {
  title: 'STC89C52RC minimal — PCB',
  footprints: { U1: 'STC89C52RC-DIP-40' },
});
await fs.writeFile(path.join(here, 'board.json'), placed.text, 'utf8');

const model = await readPcbFile(path.join(here, 'board.json'));
const routed = routeBoard(model, { cell: 2, clearance: 1, width: 1 });
const check = verifyRouting(model, routed.tracks, { clearance: 1 });
await fs.writeFile(path.join(here, 'board-routed.json'), JSON.stringify(routed.doc), 'utf8');

// copper pour on the routed board
const routedModel = await readPcbFile(path.join(here, 'board-routed.json'));
const pourOpts = { net: defaultPourNet(routedModel), cell: 2, clearance: 1, thermal: true };
const poured = pourBoard(routedModel, pourOpts);
const pourCheck = verifyPour(routedModel, pourNet(routedModel, pourOpts));
await fs.writeFile(path.join(here, 'board-poured.json'), JSON.stringify(poured.doc), 'utf8');

// stitching vias: tie the poured ground to the other layer
const pouredModel = await readPcbFile(path.join(here, 'board-poured.json'));
const stitched = viaBoard(pouredModel, { net: pourOpts.net, spacingMm: 5, cell: 2 });
const viaCheck = verifyVias(pouredModel, stitched.vias, { rules: stitched.rules });
await fs.writeFile(path.join(here, 'board-stitched.json'), JSON.stringify(stitched.doc), 'utf8');

await renderPcbFiles([path.join(here, 'board.json')], { outDir: here, formats: ['png', 'svg', 'report'], scale: 8 });
await renderPcbFiles([path.join(here, 'board-routed.json')], { outDir: path.join(here, 'routed'), formats: ['png', 'svg'], scale: 8, view: 'top' });
await renderPcbFiles([path.join(here, 'board-poured.json')], { outDir: path.join(here, 'poured'), formats: ['png', 'svg'], scale: 8, view: 'top' });
await renderPcbFiles([path.join(here, 'board-stitched.json')], { outDir: path.join(here, 'stitched'), formats: ['png', 'svg'], scale: 8, view: 'top' });

console.log(`board.json: ${placed.stats.components} 器件 / ${placed.stats.pads} 焊盘 / ${placed.stats.nets} 网络 | 板框 ${placed.board.widthMm} x ${placed.board.heightMm} mm`);
console.log(`  布局:飞线 ${placed.quality.ratsnestMm} mm | 重叠 ${placed.quality.overlaps} | 越界 ${placed.quality.outside}`);
console.log(`  布线:${routed.stats.routed}/${routed.stats.nets} 网络 | 走线 ${routed.stats.tracks} 段 | 过孔 ${routed.stats.vias} | 长度 ${routed.stats.lengthMm} mm | 违规 ${check.count}`);
console.log(`  铺铜:${pourOpts.net} ${pourNet(routedModel, pourOpts).stats.areaMm2} mm² | 多边形 ${poured.stats.polygons} | 越界 ${pourCheck.count}`);
console.log(`  缝合孔:${stitched.stats.placed} 个 | 盘 ${stitched.stats.diameterMm}mm/孔 ${stitched.stats.drillMm}mm | 违规 ${viaCheck.count}`);

// fabrication data: Gerber + Excellon, then the export self check
const finalModel0 = await readPcbFile(path.join(here, 'board-stitched.json'));
const gerberDir = path.join(here, 'gerber');
const exported = exportGerber(finalModel0, { name: 'stc89c52rc-minimal' });
await fs.mkdir(gerberDir, { recursive: true });
for (const f of exported.files) await fs.writeFile(path.join(gerberDir, f.name), f.text, 'utf8');
const gerberCheck = verifyGerber(finalModel0, exported);
await fs.writeFile(path.join(gerberDir, 'gerber.manifest.json'), JSON.stringify({
  generator: 'lceda-ai pcb gerber 1.0',
  source: 'board-stitched.json',
  files: exported.files.map((f) => ({ file: f.name, layer: String(f.layer), bytes: f.text.length })),
  check: { ok: gerberCheck.ok, checks: gerberCheck.checks, problems: gerberCheck.problems },
}, null, 2), 'utf8');

// final design rule check on the finished board
const finalModel = await readPcbFile(path.join(here, 'board-stitched.json'));
const drc = runDrc(finalModel);
await fs.writeFile(path.join(here, 'drc.md'), drcMarkdown(drc, { file: 'board-stitched.json' }), 'utf8');
console.log(`  Gerber:${exported.files.length} 个文件(${exported.files.map((f) => f.name).join(', ')}) | 自检 ${gerberCheck.ok ? 'PASS' : 'FAIL'}`);
console.log(`  DRC:${drc.ok ? 'PASS' : 'FAIL'} — ${drc.summary}${Object.keys(drc.counts).length ? ' | ' + Object.entries(drc.counts).map(([k, v]) => `${k}:${v}`).join(' ') : ''}`);
for (const w of placed.warnings) console.log('  !', w);
