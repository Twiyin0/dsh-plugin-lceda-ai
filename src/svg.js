// Render a parsed LCEDA schematic document to SVG (viewBox in sheet units).
//
// Coordinate convention (verified against the editor): stored y grows downward on
// screen (frame top edge has the most negative y). So the SVG keeps raw model
// coordinates and simply translates the group by -minY; no axis flip.
import { num } from './format.js';
import { parseDocument } from './parser.js';

/** Accept either a parsed document or raw .esch JSON. */
export function asParsedDoc(doc) {
  if (typeof doc === 'string') {
    let parsed;
    try { parsed = JSON.parse(doc); } catch { throw new Error('renderSVG/report got a string that is not .esch JSON'); }
    return parseDocument(parsed);
  }
  if (doc && Array.isArray(doc.shapes) && Array.isArray(doc.components)) return doc;
  if (doc && Array.isArray(doc.shape)) return parseDocument(doc);
  throw new Error('renderSVG/report expects a parsed document or .esch JSON');
}

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function dashArray(dash) {
  if (!dash || dash === '0' || dash === 'none' || dash === 'solid') return '';
  if (dash === '6,6') return '6,6';
  if (dash === '3,10') return '3,10';
  return dash.replace(/[^0-9,.]/g, '');
}

function strokeAttrs(sh, colorOverride) {
  const color = colorOverride ?? sh.color ?? '';
  const w = Math.max(num(sh.width, 1), 0.1);
  const da = dashArray(sh.dash);
  return `stroke="${esc(color || '#000')}" stroke-width="${w}"${da ? ` stroke-dasharray="${da}"` : ''}`;
}

function textEl(t, colorOverride) {
  const content = esc(t.text ?? '');
  if (!content) return '';
  const anchor = t.anchor === 'end' ? 'end' : (t.anchor === 'middle' || t.anchor === 'center' ? 'middle' : 'start');
  const size = num(t.size, 7);
  const rot = num(t.rot);
  const transform = rot ? ` transform="rotate(${rot} ${t.x} ${t.y})"` : '';
  const weight = t.bold ? ' font-weight="bold"' : '';
  const italic = t.italic ? ' font-style="italic"' : '';
  return `<text x="${t.x}" y="${t.y}" font-family="${esc(t.font || 'Verdana')}" font-size="${size}"${weight}${italic} fill="${esc(colorOverride || t.color || '#000080')}" text-anchor="${anchor}"${transform}>${content}</text>`;
}

function renderShape(sh) {
  switch (sh.type) {
    case 'wire': case 'polyline': {
      if (!sh.points?.length) return '';
      const pts = sh.points.map(([x, y]) => `${x},${y}`).join(' ');
      return `<polyline points="${pts}" ${strokeAttrs(sh)} fill="none" />`;
    }
    case 'path': {
      if (!sh.d) return '';
      const fill = sh.fill && sh.fill !== 'none' ? ` fill="${esc(sh.fill)}" fill-opacity="0.5"` : ' fill="none"';
      return `<path d="${esc(sh.d)}" ${strokeAttrs(sh)}${fill} />`;
    }
    case 'rect': {
      const fill = sh.fill && sh.fill !== 'none' ? sh.fill : 'none';
      const r = sh.rx || sh.ry ? ` rx="${sh.rx || 0}" ry="${sh.ry || 0}"` : '';
      const da = dashArray(sh.dash);
      return `<rect x="${Math.min(sh.x, sh.x + sh.w)}" y="${Math.min(sh.y, sh.y + sh.h)}" width="${Math.abs(sh.w)}" height="${Math.abs(sh.h)}"${r} ${strokeAttrs(sh)} fill="${fill}"${da ? ` stroke-dasharray="${da}"` : ''} />`;
    }
    case 'ellipse': {
      const fill = sh.fill && sh.fill !== 'none' ? sh.fill : 'none';
      return `<ellipse cx="${sh.x}" cy="${sh.y}" rx="${sh.rx}" ry="${sh.ry}" ${strokeAttrs(sh)} fill="${fill}" />`;
    }
    case 'polygon': {
      const pts = sh.points.map(([x, y]) => `${x},${y}`).join(' ');
      const fill = sh.fill && sh.fill !== 'none' ? sh.fill : 'none';
      return `<polygon points="${pts}" ${strokeAttrs(sh)} fill="${fill}" fill-opacity="0.5" />`;
    }
    case 'junction':
      return `<circle cx="${sh.x}" cy="${sh.y}" r="${sh.r}" fill="${esc(sh.color || '#CC0000')}" stroke="none" />`;
    case 'image':
      if (!sh.data || !sh.w || !sh.h) return '';
      return `<image x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" href="${esc(sh.data)}" />`;
    case 'text': return textEl(sh);
    default: return '';
  }
}

function renderPin(pin, opts) {
  const out = [];
  if (pin.path) {
    const d = pin.path.trim().startsWith('M') ? pin.path : `M ${pin.path}`;
    out.push(`<path d="${esc(d)}" stroke="${esc(pin.color || '#800')}" stroke-width="1" fill="none" />`);
  }
  if (pin.dot) out.push(`<circle cx="${pin.x}" cy="${pin.y}" r="1.5" fill="${esc(pin.color || '#800')}" stroke="none" />`);
  if (opts.pinNumbers !== false && pin.numText?.visible !== false && pin.numText?.text) {
    out.push(textEl({ ...pin.numText, size: pin.numText.size || 7, font: pin.numText.font || 'Verdana' }));
  }
  if (opts.pinNames !== false && pin.nameText?.visible !== false && pin.nameText?.text) {
    out.push(textEl({ ...pin.nameText, size: pin.nameText.size || 7, font: pin.nameText.font || 'Verdana' }));
  }
  return out.join('\n');
}

function renderComponent(c, opts) {
  const parts = [];
  for (const sh of c.shapes) {
    const el = renderShape(sh);
    if (el) parts.push(el);
  }
  for (const pin of c.pins) parts.push(renderPin(pin, opts));
  return parts.join('\n');
}

export function renderSVG(input, opts = {}) {
  const doc = asParsedDoc(input);
  const margin = opts.margin ?? 10;
  const bb = doc.bbox;
  const vx = bb.x - margin;
  const vy = bb.y - margin;
  const vw = bb.w + margin * 2;
  const vh = bb.h + margin * 2;
  const bg = doc.canvas?.bg || '#FFFFFF';

  const frames = doc.components.filter((c) => c.isFrame);
  const comps = doc.components.filter((c) => !c.isFrame);
  const wires = doc.shapes.filter((s) => s.type === 'wire');
  const junctions = doc.shapes.filter((s) => s.type === 'junction');
  const netflags = doc.shapes.filter((s) => s.type === 'netflag');
  const netlabels = doc.shapes.filter((s) => s.type === 'netlabel');
  const others = doc.shapes.filter((s) => !['wire', 'junction', 'netflag', 'netlabel', 'component'].includes(s.type));

  const body = [
    ...others.map(renderShape),
    ...frames.map((c) => renderComponent(c, { pinNumbers: false, pinNames: false })),
    ...comps.map((c) => renderComponent(c, opts)),
    ...wires.map(renderShape),
    ...junctions.map(renderShape),
    ...netflags.map((f) => [
      ...f.graphics.map(renderShape),
      textEl({ x: f.tx, y: f.ty, rot: f.textRot, color: f.color, font: f.font, size: f.size, anchor: f.textAnchor, text: f.text }),
    ].join('\n')),
    ...netlabels.map((l) => textEl(l)),
  ].filter(Boolean).join('\n');

  const title = opts.title || 'LCEDA Schematic';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="${Math.round(vw)}px" height="${Math.round(vh)}px" viewBox="${vx} ${vy} ${vw} ${vh}">
<title>${esc(title)}</title>
<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${esc(bg)}" stroke="none"/>
<g id="sheet">
${body}
</g>
</svg>`;
}
