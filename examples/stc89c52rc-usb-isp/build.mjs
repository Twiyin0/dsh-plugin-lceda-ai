// STC89C52RC + AMS1117-5.0 + CH340G USB download board — full PCB pipeline.
//
//   node examples/stc89c52rc-usb-isp/build.mjs
//
// Runs: schematic (already authored) -> PCB placement -> autoroute -> copper pour
// -> stitching vias -> DRC -> Gerber/drill -> BOM/placement -> renders.
//
// Footprint overrides are needed because the standard library's search by package
// name does not know these parts:
//   U1 STC89C52RC -> DIP-40      U3 CH340G -> SOP-16
//   U2 AMS1117    -> SOT-223     J1 micro USB -> MICRO-USB-SMD_5P
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { boardFromSchematic } from '../../src/pcb/fromSchematic.js';
import { routeBoard, routeInOrder, verifyRouting } from '../../src/pcb/route.js';
import { pourBoard, pourNet, verifyPour, defaultPourNet } from '../../src/pcb/pour.js';
import { viaBoard, stitchVias, verifyVias } from '../../src/pcb/via.js';
import { runDrc, drcMarkdown } from '../../src/pcb/drc.js';
import { exportGerber, verifyGerber } from '../../src/pcb/gerber.js';
import { exportBom, verifyBom } from '../../src/pcb/bom.js';
import { renderPcbFiles } from '../../src/pcb/render.js';
import { readPcbFile, parsePcb, copperItems } from '../../src/pcb/parser.js';
import { parseDocument } from '../../src/parser.js';
import { convert } from '../../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const sch = path.join(root, 'examples', 'stc89c52rc-usb-isp.esch');
const out = here;

const FOOTPRINTS = {
  U1: 'STC89C52RC-DIP-40',
  U3: 'SOP-16',
  U2: 'SOT-223',
  J1: 'MICRO-USB-SMD_5P',
};

// Functional zones, in mm from the board's top-left corner. Automatic packing
// optimises area, which is not what makes a board usable: it put the micro-USB in
// the middle of the board (where nothing can be plugged into it) and scattered the
// regulator, the USB-serial chip and the MCU. Naming the zones keeps the blocks
// together and puts every connector on the edge it is used from.
const ZONES = [
  { name: 'usb',   refs: ['J1'],                                 at: [7, 26],  maxWidthMm: 14, rot: 90 },
  { name: 'power', refs: ['U2', 'C1', 'C2', 'C3', 'R2', 'D1'],    at: [20, 5],  maxWidthMm: 26 },
  { name: 'uart',  refs: ['U3', 'C9', 'Y2', 'C6', 'C7'],          at: [20, 40], maxWidthMm: 28 },
  { name: 'mcu',   refs: ['U1', 'C10', 'C11', 'Y1', 'C4', 'C5'],  at: [52, 5],  maxWidthMm: 26, rot: 90 },
  { name: 'reset', refs: ['SW1', 'C8', 'R1'],                     at: [52, 62], maxWidthMm: 30 },
  { name: 'io',    refs: ['J3', 'J4', 'J2'],                      at: [84, 5],  maxWidthMm: 14, rot: 270 },
];

const line = (s = '') => console.log(s);

// ---------------------------------------------------------------- 1. PCB
const placed = await boardFromSchematic(sch, {
  title: 'STC89C52RC USB download board',
  footprints: FOOTPRINTS,
  placement: 'zoned',
  zones: ZONES,
});
await fs.writeFile(path.join(out, 'board.json'), placed.text, 'utf8');
line(`1. 布局  ${placed.stats.components} 器件 / ${placed.stats.pads} 焊盘 / ${placed.stats.nets} 网络 | 板框 ${placed.board.widthMm} x ${placed.board.heightMm} mm`);
line(`   质量  飞线 ${placed.quality.ratsnestMm} mm | 重叠 ${placed.quality.overlaps} | 越界 ${placed.quality.outside}`);
for (const n of (placed.warnings ?? []).filter((w) => /分区|布局/.test(w))) line(`   · ${n}`);
for (const w of placed.warnings) line(`   ! ${w}`);

// ---------------------------------------------------------------- 2. route
//
// Two stages. The download interface, the clocks, reset and the rails are routed
// one net at a time in a chosen order: they route fine on their own but lose the
// race for space when the whole board is routed in one pass, because the micro
// USB (0.65 mm pitch) and the CH340G (1.27 mm) leave very little room. Everything
// else is then routed on top of that.
const placedModel = await readPcbFile(path.join(out, 'board.json'));
const PRIORITY = ['RXD', 'TXD', 'RST', 'XTAL1', 'XTAL2', 'XI', 'XO', 'USB_D+', 'USB_D-', 'VBUS', 'V3', '+5V', 'GND'];
const t0 = Date.now();
const stage1 = routeInOrder(placedModel, PRIORITY, { cell: 1, clearance: 1, width: 1 });
const allNets = [...new Set(copperItems(stage1.model).filter((i) => i.kind === 'pad' && i.net).map((i) => i.net))];
const restNets = allNets.filter((n) => !PRIORITY.includes(n));
const stage2 = routeBoard(stage1.model, { cell: 1, clearance: 1, width: 1, nets: restNets });
await fs.writeFile(path.join(out, 'board-routed.json'), JSON.stringify(stage2.doc), 'utf8');
const routedModelFile = await readPcbFile(path.join(out, 'board-routed.json'));
const routeCheck = verifyRouting(placedModel, copperItems(routedModelFile).filter((i) => i.kind === 'track'), { clearance: 1 });
line(`2. 布线  优先 ${stage1.stats.routed}/${stage1.stats.nets} + 其余 ${stage2.stats.routed}/${stage2.stats.nets} | 走线 ${copperItems(routedModelFile).filter((i) => i.kind === 'track').length} 段 | 过孔 ${copperItems(routedModelFile).filter((i) => i.kind === 'via').length} | ${Date.now() - t0} ms`);
for (const pass of stage1.passes) line(`   ${pass.ok ? '✓' : '✗'} ${String(pass.net).padEnd(9)} 走线 ${String(pass.tracks).padStart(3)} 过孔 ${String(pass.vias).padStart(3)}`);
line(`   自检  压盘 ${routeCheck.count} 处`);

// ---------------------------------------------------------------- 3. pour
const routedModel = routedModelFile;
const net = defaultPourNet(routedModel);
const pourOpts = { net, cell: 1, clearance: 1, thermal: true };
const poured = pourBoard(routedModel, pourOpts);
const pouredModel = parsePcb(poured.doc);
await fs.writeFile(path.join(out, 'board-poured.json'), JSON.stringify(poured.doc), 'utf8');
const pourCheck = verifyPour(routedModel, pourNet(routedModel, pourOpts));
line(`3. 铺铜  ${net} ${pourNet(routedModel, pourOpts).stats.areaMm2} mm² | 多边形 ${poured.stats.polygons} | 孤岛移除 ${pourNet(routedModel, pourOpts).stats.removedIslands} | 越界 ${pourCheck.count}`);

// ---------------------------------------------------------------- 4. stitching vias
const stitched = viaBoard(pouredModel, { net, spacingMm: 5, cell: 1 });
const stitchedModel = parsePcb(stitched.doc);
await fs.writeFile(path.join(out, 'board-stitched.json'), JSON.stringify(stitched.doc), 'utf8');
const viaCheck = verifyVias(pouredModel, stitched.vias, { rules: stitched.rules });
line(`4. 缝合孔 ${stitched.stats.placed} 个 | 盘 ${stitched.stats.diameterMm} mm / 孔 ${stitched.stats.drillMm} mm / 环 ${stitched.stats.annularRingMm} mm | 违规 ${viaCheck.count}`);

// ---------------------------------------------------------------- 5. DRC
const finalModel = await readPcbFile(path.join(out, 'board-stitched.json'));
const drc = runDrc(finalModel);
await fs.writeFile(path.join(out, 'drc.md'), drcMarkdown(drc, { file: 'board-stitched.json' }), 'utf8');
line(`5. DRC   ${drc.ok ? 'PASS' : 'FAIL'} — ${drc.summary}${Object.keys(drc.counts).length ? ' | ' + Object.entries(drc.counts).map(([k, v]) => `${k}:${v}`).join(' ') : ''}`);
for (const v of drc.violations.filter((x) => x.severity === 'error').slice(0, 6)) {
  line(`   ! ${v.type} ${v.net} ↔ ${v.otherNet ?? ''} 实测 ${v.measuredMm}mm / 要求 ${v.requiredMm}mm @${v.at?.x},${v.at?.y}`);
}

// ---------------------------------------------------------------- 6. Gerber + drill
const gerberDir = path.join(out, 'gerber');
const exported = exportGerber(finalModel, { name: 'stc89c52rc-usb-isp' });
await fs.mkdir(gerberDir, { recursive: true });
for (const f of exported.files) await fs.writeFile(path.join(gerberDir, f.name), f.text, 'utf8');
const gerberCheck = verifyGerber(finalModel, exported);
await fs.writeFile(path.join(gerberDir, 'gerber.manifest.json'), JSON.stringify({
  generator: 'lceda-ai pcb gerber 1.0',
  source: 'board-stitched.json',
  files: exported.files.map((f) => ({ file: f.name, layer: String(f.layer), bytes: f.text.length })),
  check: { ok: gerberCheck.ok, checks: gerberCheck.checks, problems: gerberCheck.problems },
}, null, 2), 'utf8');
line(`6. Gerber  ${exported.files.length} 个文件 | 自检 ${gerberCheck.ok ? 'PASS' : 'FAIL'}`);
for (const c of gerberCheck.checks) line(`   ${String(c.name).padEnd(26)} ${String(c.expected).padStart(7)} -> ${c.actual}`);

// ---------------------------------------------------------------- 7. BOM + placement
const schematicDoc = parseDocument(await fs.readFile(sch, 'utf8'));
const bom = exportBom(finalModel, { name: 'stc89c52rc-usb-isp', schematic: schematicDoc });
const bomDir = path.join(out, 'bom');
await fs.mkdir(bomDir, { recursive: true });
for (const f of bom.files) await fs.writeFile(path.join(bomDir, f.name), f.buffer ?? f.text);
const bomCheck = verifyBom(finalModel, bom);
line(`7. BOM     ${bom.stats.lines} 行 / ${bom.stats.parts} 器件 | 贴片 ${bom.stats.placements}(顶 ${bom.stats.top} / 底 ${bom.stats.bottom}) | 自检 ${bomCheck.ok ? 'PASS' : 'FAIL'}`);

// ---------------------------------------------------------------- 8. renders
await convert(sch, { outDir: path.join(out, 'schematic'), formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });
await renderPcbFiles([path.join(out, 'board.json')], { outDir: path.join(out, 'pcb-placed'), formats: ['svg', 'png', 'report'], scale: 4 });
await renderPcbFiles([path.join(out, 'board-routed.json')], { outDir: path.join(out, 'pcb-routed'), formats: ['png', 'svg'], scale: 4, view: 'top' });
await renderPcbFiles([path.join(out, 'board-stitched.json')], { outDir: path.join(out, 'pcb-final'), formats: ['png', 'svg'], scale: 4, view: 'top' });
line('8. 渲染  原理图 svg/png/pdf + PCB 三阶段渲染');
