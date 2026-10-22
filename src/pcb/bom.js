// BOM and pick-and-place export.
//
// The BOM joins the board's footprints back to the schematic through the
// `bind_sch_id` written into every LIB record, which is where the LCSC part
// number, supplier and manufacturer live. The placement file uses the same
// coordinate frame as the Gerber export (origin at the board's bottom-left
// corner, Y pointing up), because that is what assembly houses expect.
import { deflateRawSync } from 'node:zlib';
import { toMm, boardOutline } from './parser.js';
import { makeTransform } from './gerber.js';

/** Everything a BOM needs about one placed part. */
export function partInfo(model, footprint, schematicIndex = new Map()) {
  const cp = footprint.cPara ?? {};
  const designator = cp.name || footprint.name || '';
  const sch = schematicIndex.get(footprint.bindSchId) ?? schematicIndex.get(designator) ?? null;
  return {
    designator,
    value: cp.Value ?? sch?.value ?? '',
    package: cp.package ?? sch?.package ?? '',
    mfrPart: cp['Manufacturer Part'] || sch?.mfrPart || '',
    lcsc: cp['Supplier Part'] || sch?.lcscPart || '',
    supplier: sch?.supplier ?? '',
    manufacturer: sch?.manufacturer ?? cp.Manufacturer ?? '',
    description: sch?.description ?? '',
    inBom: footprint.addIntoBom !== false,
  };
}

/**
 * Group the parts into BOM lines.
 *
 * Two parts collapse into one line when value, package, LCSC number and
 * manufacturer part all match - the same rule a purchasing list uses.
 */
export function bomRows(model, { schematic = null } = {}) {
  const index = new Map();
  for (const c of schematic?.components ?? []) {
    if (c.id) index.set(c.id, c);
    if (c.designator) index.set(c.designator, c);
  }
  const groups = new Map();
  for (const fp of model.footprints) {
    const info = partInfo(model, fp, index);
    if (!info.inBom) continue;
    const key = [info.value, info.package, info.lcsc, info.mfrPart].join('|');
    if (!groups.has(key)) groups.set(key, { ...info, refs: [] });
    groups.get(key).refs.push(info.designator);
  }
  const rows = [...groups.values()].sort((a, b) => {
    const refA = a.refs[0] ?? '', refB = b.refs[0] ?? '';
    return refA.localeCompare(refB, undefined, { numeric: true });
  });
  return rows.map((r, i) => ({
    item: i + 1,
    qty: r.refs.length,
    references: [...r.refs].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(' '),
    value: r.value,
    package: r.package,
    lcsc: r.lcsc,
    manufacturerPart: r.mfrPart,
    manufacturer: r.manufacturer,
    supplier: r.supplier,
    description: r.description,
  }));
}

/**
 * Pick-and-place rows: designator, mid point, layer and rotation.
 *
 * Coordinates are millimetres in the assembly frame (bottom-left origin, Y up),
 * which is the same frame the Gerber files use.
 */
export function cplRows(model) {
  const tf = makeTransform(model);
  return model.footprints.map((fp) => {
    const cp = fp.cPara ?? {};
    return {
      designator: cp.name || fp.name || '',
      midX: +tf.x(fp.x).toFixed(3),
      midY: +tf.y(fp.y).toFixed(3),
      layer: fp.layer === 2 ? 'Bottom' : 'Top',
      rotation: ((fp.rotation ?? 0) % 360 + 360) % 360,
      package: cp.package ?? '',
      value: cp.Value ?? '',
    };
  }).sort((a, b) => a.designator.localeCompare(b.designator, undefined, { numeric: true }));
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with a header row, CRLF line endings (what spreadsheets expect). */
export function toCsv(rows, columns) {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const head = cols.map((c) => csvCell(c.label ?? c.key ?? c)).join(',');
  const body = rows.map((r) => cols.map((c) => csvCell(r[c.key ?? c])).join(','));
  return [head, ...body].join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- xlsx

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Minimal ZIP writer (deflate + central directory) - enough for an xlsx. */
export function zipFiles(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(8, 8);           // deflate
    local.writeUInt16LE(0, 10);          // time
    local.writeUInt16LE(0x2100, 12);     // date (1996-01-01, arbitrary but valid)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, deflated);
    central.push({ nameBuf, crc, compressed: deflated.length, raw: raw.length, offset });
    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralStart = offset;
  for (const e of central) {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(0, 12);
    head.writeUInt16LE(0x2100, 14);
    head.writeUInt32LE(e.crc, 16);
    head.writeUInt32LE(e.compressed, 20);
    head.writeUInt32LE(e.raw, 24);
    head.writeUInt16LE(e.nameBuf.length, 28);
    head.writeUInt32LE(e.offset, 42);
    chunks.push(head, e.nameBuf);
    offset += head.length + e.nameBuf.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

const xmlEscape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const columnName = (i) => {
  let name = '';
  let n = i;
  do { name = String.fromCharCode(65 + (n % 26)) + name; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return name;
};

/**
 * Write a real .xlsx from sheets of rows.
 *
 * Uses inline strings, so no shared string table is needed, and a hand written
 * ZIP container - which keeps the tool free of a spreadsheet dependency.
 *
 * @param {Array<{name: string, rows: any[][]}>} sheets
 */
export function toXlsx(sheets) {
  const sheetXml = (rows) => {
    const body = rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = `${columnName(c)}${r + 1}`;
        if (value === null || value === undefined || value === '') return '';
        if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
  };

  const entries = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEscape(s.name.slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows) })),
  ];
  return zipFiles(entries);
}

// ---------------------------------------------------------------- export

/** BOM and placement files for a board. */
export function exportBom(model, { name = 'board', schematic = null, xlsx = true } = {}) {
  const bom = bomRows(model, { schematic });
  const cpl = cplRows(model);
  const outline = boardOutline(model);
  const files = [];

  files.push({
    name: `${name}-bom.csv`,
    text: toCsv(bom, [
      { key: 'item', label: 'Item' },
      { key: 'qty', label: 'Qty' },
      { key: 'references', label: 'References' },
      { key: 'value', label: 'Value' },
      { key: 'package', label: 'Package' },
      { key: 'lcsc', label: 'LCSC Part' },
      { key: 'manufacturerPart', label: 'Manufacturer Part' },
      { key: 'manufacturer', label: 'Manufacturer' },
      { key: 'supplier', label: 'Supplier' },
      { key: 'description', label: 'Description' },
    ]),
  });
  files.push({
    name: `${name}-cpl.csv`,
    text: toCsv(cpl, [
      { key: 'designator', label: 'Designator' },
      { key: 'midX', label: 'Mid X' },
      { key: 'midY', label: 'Mid Y' },
      { key: 'layer', label: 'Layer' },
      { key: 'rotation', label: 'Rotation' },
      { key: 'package', label: 'Package' },
      { key: 'value', label: 'Value' },
    ]),
  });

  if (xlsx) {
    const bomSheet = [
      ['Item', 'Qty', 'References', 'Value', 'Package', 'LCSC Part', 'Manufacturer Part', 'Manufacturer', 'Supplier', 'Description'],
      ...bom.map((r) => [r.item, r.qty, r.references, r.value, r.package, r.lcsc, r.manufacturerPart, r.manufacturer, r.supplier, r.description]),
    ];
    const cplSheet = [
      ['Designator', 'Mid X', 'Mid Y', 'Layer', 'Rotation', 'Package', 'Value'],
      ...cpl.map((r) => [r.designator, r.midX, r.midY, r.layer, r.rotation, r.package, r.value]),
    ];
    files.push({ name: `${name}-bom.xlsx`, buffer: toXlsx([{ name: 'BOM', rows: bomSheet }, { name: 'CPL', rows: cplSheet }]) });
  }

  return {
    files,
    bom,
    cpl,
    stats: {
      lines: bom.length,
      parts: bom.reduce((n, r) => n + r.qty, 0),
      placements: cpl.length,
      top: cpl.filter((r) => r.layer === 'Top').length,
      bottom: cpl.filter((r) => r.layer === 'Bottom').length,
      withLcsc: bom.filter((r) => r.lcsc).length,
      boardMm: outline ? `${toMm(outline.maxX - outline.minX).toFixed(2)} x ${toMm(outline.maxY - outline.minY).toFixed(2)}` : '',
    },
  };
}

/**
 * Check the BOM against the board: every placed part appears exactly once across
 * the lines, and the placement file has one row per footprint.
 */
export function verifyBom(model, exported) {
  const problems = [];
  const seen = [];
  for (const row of exported.bom) seen.push(...row.references.split(/\s+/).filter(Boolean));
  const placed = model.footprints.filter((f) => f.addIntoBom !== false).map((f) => (f.cPara?.name || f.name || ''));
  const missing = placed.filter((d) => !seen.includes(d));
  const extra = seen.filter((d) => !placed.includes(d));
  if (missing.length) problems.push(`BOM 缺少器件:${missing.join(' ')}`);
  if (extra.length) problems.push(`BOM 多出器件:${extra.join(' ')}`);
  if (seen.length !== new Set(seen).size) problems.push('BOM 里有器件重复出现');
  if (exported.cpl.length !== model.footprints.length) {
    problems.push(`贴片坐标行数不符:${exported.cpl.length} != ${model.footprints.length}`);
  }
  const dupes = exported.cpl.map((r) => r.designator).filter((d, i, a) => a.indexOf(d) !== i);
  if (dupes.length) problems.push(`贴片坐标重复位号:${dupes.join(' ')}`);
  return { ok: problems.length === 0, problems, counts: { bomLines: exported.bom.length, placements: exported.cpl.length } };
}
