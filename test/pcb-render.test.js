// PCB rendering: layer palette, geometry in the SVG, and the raster/report outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPcbFile } from '../src/pcb/parser.js';
import { renderPcbSVG, renderPcbFiles, pcbReport, styleFor } from '../src/pcb/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', 'pcb', name);

test('layer palette covers copper, silk, mask, outline and inner layers', () => {
  assert.equal(styleFor(1).color, '#C83434');
  assert.equal(styleFor(2).color, '#4A7EBB');
  assert.equal(styleFor(10).color, '#F5D76E');
  assert.match(styleFor(21).label, /Inner1/);
  assert.match(styleFor(52).label, /Inner32/);
});

test('a board renders outline, copper, pads and vias into the SVG', async () => {
  const model = await readPcbFile(fixture('mini-board.pcb.json'));
  const svg = renderPcbSVG(model, { view: 'top' });
  assert.match(svg, /^<\?xml/);
  assert.match(svg, /<svg[^>]+viewBox=/);
  assert.match(svg, /#F5D76E/, 'board outline colour present');
  assert.match(svg, /#C83434/, 'top copper colour present');
  assert.match(svg, /<polyline/, 'tracks drawn as polylines');
  assert.match(svg, /<circle[^>]+fill="#0A0A0A"/, 'drill hole drawn');
  assert.match(svg, /fill="#D9A441"/, 'via/pad copper colour');
  assert.match(svg, /101\.6/, 'board size in the caption');
});

test('bottom view mirrors the drawing and keeps both copper colours', async () => {
  const model = await readPcbFile(fixture('mini-board.pcb.json'));
  const top = renderPcbSVG(model, { view: 'top' });
  const bottom = renderPcbSVG(model, { view: 'bottom' });
  assert.match(bottom, /scale\(-1 1\)/, 'bottom view mirrors');
  assert.match(bottom, /bottom view/);
  assert.notEqual(top, bottom);
});

test('a footprint renders its pads and silkscreen, not the whole library canvas', async () => {
  const model = await readPcbFile(fixture('HDR-TH_2P-P2.54.fp.json'));
  const svg = renderPcbSVG(model, { view: 'top' });
  // the viewBox must hug the footprint (pads at x 1590.5/1600.5, not the 1595.5 head)
  const vb = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
  assert.ok(vb, 'viewBox present');
  const [, , , w] = vb.map(Number);
  assert.ok(w < 90, `viewBox should hug the footprint, got width ${w}`);
  assert.match(svg, /<rect/, 'square pad drawn');
  assert.match(svg, /<ellipse/, 'round pad drawn');
});

test('renderPcbFiles writes the requested formats plus a report', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lceda-pcb-'));
  const results = await renderPcbFiles([fixture('mini-board.pcb.json')], { outDir, formats: ['svg', 'png', 'report'], scale: 3 });
  assert.equal(results.length, 1);
  const { outputs } = results[0];
  for (const key of ['svg', 'png', 'reportJson', 'reportMd']) {
    assert.ok(outputs[key], `${key} written`);
    const st = await fs.stat(outputs[key]);
    assert.ok(st.size > 200, `${key} is not empty`);
  }
  assert.equal(outputs.pdf, undefined, 'pdf not requested');

  const report = JSON.parse(await fs.readFile(outputs.reportJson, 'utf8'));
  assert.equal(report.counts.vias, 1);
  assert.equal(report.board.widthMm, 101.6);
  assert.equal(report.unit.mm, 0.254);
  assert.deepEqual(report.footprints.map((f) => f.name), ['R1']);

  const md = await fs.readFile(outputs.reportMd, 'utf8');
  assert.match(md, /# PCB 报告/);
  assert.match(md, /1 文件单位 = 0\.254 mm/);
  assert.match(md, /## 器件/);
});

test('pcbReport lists nets used by copper', async () => {
  const model = await readPcbFile(fixture('mini-board.pcb.json'));
  const { json } = pcbReport(model);
  assert.ok(json.nets.includes('GND'));
});
