// PCB rendering: a board or footprint document -> SVG / PNG / PDF (+ report).
//
// Drawn with the usual EDA palette so a reviewer can tell layers apart at a
// glance: top copper red, bottom copper blue, silk white, solder mask purple,
// board outline yellow, drill holes black.
//
// Coordinates in the file grow downward (same convention as the schematic), so
// the SVG uses them as-is; `view: 'bottom'` mirrors the drawing instead of
// flipping individual items.
import fs from 'node:fs/promises';
import path from 'node:path';
import { svgToPng, svgToPdf } from '../export.js';
import { parsePcb, readPcbFile, boardOutline, isCopper, layerName, toMm, UNIT_MM } from './parser.js';

/** Layer palette, keyed by layer id. */
export const PCB_LAYER_STYLE = {
  1: { color: '#C83434', label: '顶层铜 Top' },
  2: { color: '#4A7EBB', label: '底层铜 Bottom' },
  3: { color: '#EDEDED', label: '顶层丝印 Top Silk' },
  4: { color: '#9AA0A6', label: '底层丝印 Bottom Silk' },
  5: { color: '#B0B0B0', label: '顶层锡膏 Top Paste' },
  6: { color: '#8A6D3B', label: '底层锡膏 Bottom Paste' },
  7: { color: '#7B4FA0', label: '顶层阻焊 Top Mask' },
  8: { color: '#9B59B6', label: '底层阻焊 Bottom Mask' },
  10: { color: '#F5D76E', label: '板框 Outline' },
  11: { color: '#D9A441', label: '多层 Multi' },
  12: { color: '#888888', label: '文档 Document' },
  13: { color: '#7F8C8D', label: '顶层装配' },
  14: { color: '#95A5A6', label: '底层装配' },
  15: { color: '#6C7A89', label: '机械 Mechanical' },
  99: { color: '#FF8A65', label: '器件外形' },
  100: { color: '#BCAAA4', label: '引脚 Lead' },
  101: { color: '#FFB6C1', label: '器件标记' },
};
for (let i = 21; i <= 52; i++) {
  const hue = 120 + (i - 21) * 3;
  PCB_LAYER_STYLE[i] = { color: `hsl(${hue % 360} 55% 55%)`, label: `内层 Inner${i - 20}` };
}
export const styleFor = (layer) => PCB_LAYER_STYLE[Number(layer)] ?? { color: '#BBBBBB', label: layerName(layer) };

const DEFAULT_HIDDEN = new Set([5, 6, 9, 12, 13, 14, 15, 99, 100]);
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const n = (v) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(3)) : 0);
const pointsToStr = (pts) => pts.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');

/** Rotate a point around a centre (degrees, screen coordinates). */
function rotatePt(p, cx, cy, deg) {
  if (!deg) return p;
  const r = (deg * Math.PI) / 180;
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * Math.cos(r) - dy * Math.sin(r), y: cy + dx * Math.sin(r) + dy * Math.cos(r) };
}

/** Pad outline as an SVG fragment, in board coordinates. */
function padShape(pad, dx, dy) {
  const x = pad.x + dx, y = pad.y + dy;
  const w = Number(pad.width) || 0, h = Number(pad.height) || 0;
  const rot = Number(pad.rotation) || 0;
  const transform = rot ? ` transform="rotate(${n(rot)} ${n(x)} ${n(y)})"` : '';
  const shape = String(pad.shape || 'RECT').toUpperCase();
  if (shape === 'ELLIPSE' || shape === 'OVAL') {
    return { body: `<ellipse cx="${n(x)}" cy="${n(y)}" rx="${n(w / 2)}" ry="${n(h / 2)}"${transform}/>`, x, y, w, h, rot };
  }
  if (shape === 'CIRCLE') {
    const r = w / 2;
    return { body: `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}"${transform}/>`, x, y, w: w, h: h, rot };
  }
  if (shape === 'POLYGON' && pad.points?.length) {
    const pts = pad.points.map((p) => rotatePt(p, pad.x, pad.y, rot)).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    return { body: `<polygon points="${pointsToStr(pts)}"${transform}/>`, x, y, w, h, rot };
  }
  return {
    body: `<rect x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}"${transform}/>`,
    x, y, w, h, rot,
  };
}

/** Drill hole for a pad (round hole, or a slot when holeLength > 0). */
function padDrill(pad, dx, dy) {
  const holeR = Number(pad.holeR) || 0;
  if (!holeR) return '';
  const x = pad.x + dx, y = pad.y + dy;
  const len = Number(pad.holeLength) || 0;
  if (len > 0) {
    const w = Math.max(len, holeR * 2);
    const rot = Number(pad.rotation) || 0;
    return `<rect x="${n(x - w / 2)}" y="${n(y - holeR)}" width="${n(w)}" height="${n(holeR * 2)}" rx="${n(holeR)}" fill="#0A0A0A"${rot ? ` transform="rotate(${n(rot)} ${n(x)} ${n(y)})"` : ''}/>`;
  }
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(holeR)}" fill="#0A0A0A"/>`;
}

function tracksPath(tracks, dx = 0, dy = 0) {
  let out = '';
  for (const t of tracks) {
    const pts = (t.points ?? []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    if (pts.length < 2) continue;
    out += `<polyline points="${pointsToStr(pts)}" fill="none" stroke-width="${n(t.strokeWidth || 1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return out;
}

/**
 * Render a parsed PCB model to SVG.
 *
 * @param {object} model parsed document (parsePcb / readPcbFile)
 * @param {{view?: 'top'|'bottom', layers?: number[], margin?: number, dark?: boolean, title?: string, showLegend?: boolean}} opts
 */
export function renderPcbSVG(model, opts = {}) {
  const view = opts.view === 'bottom' ? 'bottom' : 'top';
  const dark = opts.dark !== false;
  const hidden = new Set(DEFAULT_HIDDEN);
  for (const id of opts.layers ?? []) hidden.delete(Number(id));
  const only = opts.layers?.length ? new Set(opts.layers.map(Number)) : null;
  const visible = (layer) => (only ? only.has(Number(layer)) : !hidden.has(Number(layer)));

  const outline = boardOutline(model);
  let minX, minY, maxX, maxY;
  if (outline) ({ minX, minY, maxX, maxY } = outline);
  else {
    const xs = [], ys = [];
    const push = (p) => { if (Number.isFinite(p.x)) xs.push(p.x); if (Number.isFinite(p.y)) ys.push(p.y); };
    for (const fp of model.footprints) {
      for (const p of fp.pads) push(p);
      for (const t of fp.tracks) (t.points ?? []).forEach(push);
      for (const c of fp.circles ?? []) push({ x: c.cx, y: c.cy });
      for (const t of fp.texts ?? []) push({ x: t.x, y: t.y });
    }
    for (const e of model.elements) { if (e.points) e.points.forEach(push); else push(e); }
    if (!xs.length) { xs.push(0, 1000); ys.push(0, 1000); }
    minX = Math.min(...xs); maxX = Math.max(...xs); minY = Math.min(...ys); maxY = Math.max(...ys);
  }
  // a fixed margin would swamp a small footprint and crowd a large board
  const pad = opts.margin ?? Math.max((maxX - minX) * 0.06, (maxY - minY) * 0.06, 10);
  // reserve a band above the drawing for the legend, so it never covers parts
  const legendItems = opts.legendItems ?? 6;
  const bandH = opts.showLegend === false ? pad : Math.max(pad, ((maxX - minX) + pad * 2) * 0.055 * (legendItems + 1.4));
  const vx = minX - pad, vy = minY - bandH, vw = (maxX - minX) + pad * 2, vh = (maxY - minY) + bandH + pad;

  const bg = dark ? '#11161B' : '#FFFFFF';
  const copperTop = styleFor(1).color, copperBottom = styleFor(2).color;
  const primary = view === 'bottom' ? copperBottom : copperTop;
  const secondary = view === 'bottom' ? copperTop : copperBottom;
  const mirror = view === 'bottom' ? ` transform="translate(${n(vx * 2 + vw)} 0) scale(-1 1)"` : '';

  const parts = [];
  const legend = [];

  // ---- board outline -------------------------------------------------------
  if (outline && visible(10)) {
    const items = outline.items.filter((e) => e.type === 'TRACK' || e.type === 'RECT' || e.type === 'CIRCLE');
    const outlineTracks = items.filter((e) => e.type === 'TRACK');
    parts.push(`<g stroke="${styleFor(10).color}" fill="none" stroke-width="3" opacity="0.95">${tracksPath(outlineTracks)}</g>`);
    legend.push(['#F5D76E', '板框 Board outline']);
  }

  // ---- copper pours --------------------------------------------------------
  const pours = model.elements.filter((e) => e.type === 'COPPERAREA' && visible(e.layer));
  if (pours.length) {
    let s = '';
    for (const p of pours) {
      const d = (p.path ?? []).map((pt, i) => `${i ? 'L' : 'M'} ${n(pt.x)} ${n(pt.y)}`).join(' ') + ' Z';
      const col = Number(p.layer) === 2 ? copperBottom : copperTop;
      s += `<path d="${d}" fill="${col}" fill-opacity="0.35" stroke="${col}" stroke-width="1"/>`;
    }
    parts.push(`<g>${s}</g>`);
    legend.push([copperTop, '铺铜 Copper pour']);
  }

  // ---- solid regions / rects / circles / arcs ------------------------------
  const regions = model.elements.filter((e) => e.type === 'SOLIDREGION' && visible(e.layer));
  if (regions.length) {
    let s = '';
    for (const r of regions) {
      const d = (r.path ?? []).map((pt, i) => `${i ? 'L' : 'M'} ${n(pt.x)} ${n(pt.y)}`).join(' ') + ' Z';
      s += `<path d="${d}" fill="${styleFor(r.layer).color}" fill-opacity="0.85"/>`;
    }
    parts.push(`<g>${s}</g>`);
  }

  // ---- board tracks (per layer) -------------------------------------------
  const byLayer = new Map();
  for (const e of model.elements) {
    if (e.type !== 'TRACK' || !e.points?.length) continue;
    if (!byLayer.has(e.layer)) byLayer.set(e.layer, []);
    byLayer.get(e.layer).push(e);
  }
  for (const [layer, tracks] of [...byLayer.entries()].sort((a, b) => a[0] - b[0])) {
    if (!visible(layer)) continue;
    const col = isCopper(layer) ? (Number(layer) === 2 ? copperBottom : copperTop) : styleFor(layer).color;
    const opacity = isCopper(layer) ? (Number(layer) === 2 && view === 'top' ? 0.75 : 1) : 1;
    parts.push(`<g stroke="${col}" fill="none" opacity="${opacity}">${tracksPath(tracks)}</g>`);
  }

  // ---- footprints ----------------------------------------------------------
  for (const fp of model.footprints) {
    // silk / mechanical artwork of the footprint
    const art = [...(fp.tracks ?? []), ...(fp.rects ?? []), ...(fp.circles ?? []), ...(fp.arcs ?? [])];
    for (const item of art) {
      const layer = Number(item.layer);
      if (!visible(layer)) continue;
      const col = isCopper(layer) ? (layer === 2 ? copperBottom : copperTop) : styleFor(layer).color;
      if (item.type === 'TRACK') {
        parts.push(`<g stroke="${col}" fill="none" opacity="0.95">${tracksPath([item])}</g>`);
      } else if (item.type === 'RECT') {
        parts.push(`<rect x="${n(item.x - item.width / 2)}" y="${n(item.y - item.height / 2)}" width="${n(item.width)}" height="${n(item.height)}" fill="none" stroke="${col}" stroke-width="${n(item.strokeWidth || 1)}"/>`);
      } else if (item.type === 'CIRCLE') {
        parts.push(`<circle cx="${n(item.cx)}" cy="${n(item.cy)}" r="${n(item.r)}" fill="none" stroke="${col}" stroke-width="${n(item.strokeWidth || 1)}"/>`);
      } else if (item.type === 'ARC' && item.points?.length) {
        parts.push(`<polyline points="${pointsToStr(item.points)}" fill="none" stroke="${col}" stroke-width="${n(item.strokeWidth || 1)}"/>`);
      }
    }
    // pads
    for (const p of fp.pads) {
      if (!visible(p.layer)) continue;
      const col = isCopper(p.layer) ? (Number(p.layer) === 2 ? copperBottom : (Number(p.layer) === 11 ? '#D9A441' : copperTop)) : styleFor(p.layer).color;
      const { body } = padShape(p, 0, 0);
      parts.push(`<g fill="${col}" fill-opacity="0.92" stroke="${col}" stroke-width="0.6">${body}</g>`);
      const drill = padDrill(p, 0, 0);
      if (drill) parts.push(drill);
    }
    // reference designator / value text
    for (const t of fp.texts ?? []) {
      const layer = Number(t.layer);
      if (!visible(layer) || t.display === 'none') continue;
      const size = Number(t.fontSize) || 4;
      const col = layer === 4 ? styleFor(4).color : styleFor(3).color;
      parts.push(`<text x="${n(t.x)}" y="${n(t.y)}" font-size="${n(size)}" fill="${col}" font-family="${esc(t.fontFamily || 'monospace')}" text-anchor="middle">${esc(t.text)}</text>`);
    }
  }

  // ---- vias / holes --------------------------------------------------------
  for (const e of model.elements) {
    if (e.type === 'VIA' && visible(11)) {
      parts.push(`<circle cx="${n(e.x)}" cy="${n(e.y)}" r="${n((Number(e.diameter) || 24) / 2)}" fill="#D9A441" stroke="${primary}" stroke-width="0.8"/>`);
      if (e.holeR) parts.push(`<circle cx="${n(e.x)}" cy="${n(e.y)}" r="${n(e.holeR)}" fill="#0A0A0A"/>`);
    } else if (e.type === 'HOLE') {
      parts.push(`<circle cx="${n(e.x)}" cy="${n(e.y)}" r="${n(e.holeR)}" fill="#0A0A0A"/>`);
    }
  }

  // ---- free texts ----------------------------------------------------------
  for (const e of model.elements) {
    if (e.type !== 'TEXT' || !visible(e.layer)) continue;
    const size = Number(e.fontSize) || 4;
    parts.push(`<text x="${n(e.x)}" y="${n(e.y)}" font-size="${n(size)}" fill="${styleFor(e.layer).color}" font-family="${esc(e.fontFamily || 'monospace')}">${esc(e.text)}</text>`);
  }

  // ---- legend --------------------------------------------------------------
  let legendSvg = '';
  if (opts.showLegend !== false) {
    const items = [
      ...legend,
      [copperTop, '顶层铜 Top copper'],
      [copperBottom, '底层铜 Bottom copper'],
      ['#D9A441', '焊盘/过孔 Pad & via'],
      [styleFor(3).color, '丝印 Silk'],
      ['#0A0A0A', '钻孔 Drill'],
    ].filter((v, i, a) => a.findIndex((x) => x[1] === v[1]) === i);
    // the legend is UI, not geometry: size it against the viewport, not the board
    const u = vw / 100;
    const lh = u * 3.4;
    const boxW = u * 34;
    const pad2 = u * 1.6;
    const titleSize = u * 2.3;
    const itemSize = u * 2.1;
    legendSvg = `<g transform="translate(${n(vx + u * 2)} ${n(vy + u * 2)})">`
      + `<rect x="0" y="0" width="${n(boxW)}" height="${n(items.length * lh + u * 5)}" fill="${dark ? '#000000' : '#FFFFFF'}" fill-opacity="0.78" stroke="#888" stroke-width="${n(u * 0.14)}" rx="${n(u * 0.6)}"/>`
      + `<text x="${n(pad2)}" y="${n(u * 3.2)}" font-size="${n(titleSize)}" fill="${dark ? '#FFFFFF' : '#000000'}" font-family="sans-serif">图层 Layers — ${esc(model.title || model.cPara.package || path.basename(model.file ?? 'PCB'))}</text>`
      + items.map(([c, label], i) => `<rect x="${n(pad2)}" y="${n(u * 4.4 + i * lh)}" width="${n(u * 1.8)}" height="${n(u * 1.8)}" fill="${c}"/><text x="${n(pad2 + u * 2.6)}" y="${n(u * 5.9 + i * lh)}" font-size="${n(itemSize)}" fill="${dark ? '#E6E6E6' : '#111'}" font-family="sans-serif">${esc(label)}</text>`).join('')
      + '</g>';
  }

  const sizeMm = outline ? ` | ${outline.widthMm.toFixed(1)} x ${outline.heightMm.toFixed(1)} mm` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" width="${n(vw)}" height="${n(vh)}">
<rect x="${n(vx)}" y="${n(vy)}" width="${n(vw)}" height="${n(vh)}" fill="${bg}"/>
<g${mirror}>${parts.join('')}</g>
${legendSvg}
<text x="${n(vx + vw - vw * 0.02)}" y="${n(vy + vh - vh * 0.015)}" font-size="${n((vw / 100) * 1.9)}" fill="${dark ? '#9AA0A6' : '#555'}" text-anchor="end" font-family="sans-serif">${esc(model.file ? path.basename(model.file) : 'PCB')}${esc(sizeMm)} — ${esc(view)} view</text>
</svg>`;
}

/** Layer/geometry report (markdown + json) for a PCB document. */
export function pcbReport(model) {
  const outline = boardOutline(model);
  const json = {
    file: model.file,
    docType: model.docType,
    package: model.cPara.package ?? '',
    name: model.cPara.name ?? '',
    counts: model.counts,
    board: outline ? { widthMm: +outline.widthMm.toFixed(3), heightMm: +outline.heightMm.toFixed(3) } : null,
    unit: model.unit,
    drc: model.drc.default,
    layers: [...model.layers.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, visible: l.visible })),
    footprints: model.footprints.map((f) => ({
      name: f.name, package: f.cPara.package ?? '', x: f.x, y: f.y, rotation: f.rotation,
      pads: f.pads.length, uuid: f.uuid, xMm: +toMm(f.x).toFixed(3), yMm: +toMm(f.y).toFixed(3),
    })),
    nets: [...new Set([...model.elements, ...model.footprints.flatMap((f) => f.pads)].map((e) => e.net).filter(Boolean))].sort(),
  };
  const L = [];
  L.push(`# PCB 报告 — ${path.basename(model.file ?? 'document')}`);
  L.push('');
  L.push(`- 类型:${model.isFootprint ? '封装 footprint' : model.isBoard ? '板 board' : `docType ${model.docType}`}${json.package ? ` | 封装 ${json.package}` : ''}`);
  L.push(`- 器件 ${model.counts.footprints} | 焊盘 ${model.counts.pads} | 走线 ${model.counts.tracks} | 过孔 ${model.counts.vias} | 钻孔 ${model.counts.holes} | 铺铜 ${model.counts.copperAreas} | 文字 ${model.counts.texts}`);
  if (json.board) L.push(`- 板框:${json.board.widthMm} × ${json.board.heightMm} mm`);
  L.push(`- 单位:1 文件单位 = ${UNIT_MM} mm(10 mil)`);
  const drc = json.drc ?? {};
  if (drc.trackWidth) L.push(`- 规则:线宽 ${drc.trackWidth} mm | 间距 ${drc.clearance} mm | 过孔盘 ${drc.viaHoleDiameter} mm / 孔 ${drc.viaHoleD} mm`);
  L.push('');
  if (json.footprints.length) {
    L.push('## 器件');
    L.push('| 位号 | 封装 | 位置 (mm) | 旋转 | 焊盘 |');
    L.push('|---|---|---|---|---|');
    for (const f of json.footprints) L.push(`| ${f.name || '-'} | ${f.package || '-'} | ${f.xMm}, ${f.yMm} | ${f.rotation}° | ${f.pads} |`);
    L.push('');
  }
  if (json.nets.length) {
    L.push('## 网络');
    L.push(json.nets.map((x) => `\`${x}\``).join(' '));
    L.push('');
  }
  return { json, markdown: L.join('\n') };
}

/** Render one or more PCB documents to files. */
export async function renderPcbFiles(files, { outDir, formats = ['svg', 'png', 'pdf', 'report'], scale = 4, view = 'top' } = {}) {
  const results = [];
  for (const file of files) {
    const model = await readPcbFile(file);
    const base = path.join(outDir, path.basename(file).replace(/\.(json|epcb)$/i, ''));
    await fs.mkdir(outDir, { recursive: true });
    const svg = renderPcbSVG(model, { view, title: model.title || model.cPara.package });
    const outputs = {};
    if (formats.includes('svg')) { outputs.svg = `${base}.svg`; await fs.writeFile(outputs.svg, svg); }
    if (formats.includes('png')) { outputs.png = `${base}.png`; await fs.writeFile(outputs.png, await svgToPng(svg, { scale })); }
    if (formats.includes('pdf')) { outputs.pdf = `${base}.pdf`; await fs.writeFile(outputs.pdf, await svgToPdf(svg, { scale, title: path.basename(base) })); }
    if (formats.includes('report')) {
      const { json, markdown } = pcbReport(model);
      outputs.reportJson = `${base}.report.json`;
      outputs.reportMd = `${base}.report.md`;
      await fs.writeFile(outputs.reportJson, JSON.stringify(json, null, 2));
      await fs.writeFile(outputs.reportMd, markdown);
    }
    results.push({ input: file, outputs, model, summary: pcbSummaryOf(model) });
  }
  return results;
}

function pcbSummaryOf(model) {
  return { counts: model.counts, docType: model.docType };
}

export { parsePcb };
