#!/usr/bin/env node
// lceda-ai CLI — convert 嘉立创EDA(标准版) schematics to SVG/PNG/PDF + AI reports.
// Usage:
//   lceda-ai convert <sch.json|projectDir> [-o outDir] [--formats svg,png,pdf,report] [--scale 4]
//   lceda-ai read <sch.json>            # print compact text summary to stdout
import { parseDocument } from '../src/parser.js';
import { extractNetlist } from '../src/netlist.js';
import { summarize } from '../src/index.js';
import { findSheetFiles } from '../src/index.js';
import { newDocument, buildFromSpec, placeComponent, writeDocument, SchematicBuilder } from '../src/create.js';
import { findBuiltin, fetchPart, fetchStandard, resolvePart, searchComponents } from '../src/library.js';
import { BUILTIN_SYMBOLS } from '../src/symbol.js';
import { buildReport } from '../src/report.js';
import { exportJson } from '../src/exportjson.js';

// Heavy modules (sharp / pdf-lib) are imported lazily so read/find/place/create/build
// work without them.
const lazyConvert = async (...a) => (await import('../src/index.js')).convert;
const lazyEdit = async (...a) => (await import('../src/edit.js')).editSheet;
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const cmd = args[0];
const wantsJson = args.includes('--json');
const emit = (obj) => { if (wantsJson) console.log(JSON.stringify(obj, null, 2)); };

function usage() {
  console.log(`lceda-ai — make LCEDA (嘉立创EDA standard) schematics understandable by AI agents

Commands:
  convert <sch.json|projectDir>  Convert sheets to svg/png/pdf + report.json/report.md
        [-o outDir] [--formats svg,png,pdf,report] [--scale 4 (raster px per unit)]
  read <sch.json>                Print compact component/netlist text summary
  create <out.esch>              Create a new sheet (frame + title block)
        [--title T] [--company C] [--rev R] [--date D] [--drawn-by N]
  find <query>                   Search parts: built-in catalogue, LCSC number (Cnnnn), or --file sheet
  place <sch.json> <symbol|Cnnn> Place one component [--ref R1] [--value 10k] [--at x,y] [--rot 90]
  export <sch.esch|json>         Write the LCEDA-importable JSON (文件 → 打开 → 嘉立创EDA)
        [-o out.json] [--project Dir] [--sheet-name Sheet_1] [--json]
  build <spec.json> -o out.esch  Build a whole schematic from a declarative spec
        [--spec '<json>'] (inline spec instead of a file)
        [--export] (also write svg/png/pdf/report)
  edit <sch.json> --ops '<json>' Structured edits (see below); validates, writes with .bak
        [--ops-file ops.json] [--out file] [--dry-run] [--no-backup]
        [--preview out.png] [--scale 2]

Edit ops (JSON array, each object has "op"):
  {"op":"describe"}
  {"op":"set_value","ref":"R9","value":"2k"}
  {"op":"set_designator","ref":"R2","to":"R20"}
  {"op":"set_attr","ref":"U1","key":"Supplier Part","value":"C9900042655"}
  {"op":"move","ref":"R9","dx":20,"dy":-10}          // or {"x":..,"y":..} absolute
  {"op":"rotate","ref":"R9","angle":90}              // ±90 / 180 / 270
  {"op":"duplicate_component","ref":"R9","dx":30,"dy":0,"to":"R15","value":"2k"}
  {"op":"delete_component","ref":"R9"}
  {"op":"add_wire","points":[[100,-100],[200,-100]]}
  {"op":"add_junction","x":200,"y":-100}
  {"op":"add_net_label","x":100,"y":-100,"text":"SIG_A"}
  {"op":"add_net_flag","x":300,"y":-100,"text":"GND","kind":"part_netLabel_gnD"}
  {"op":"delete_element","id":"gge1234"}
  {"op":"delete_wires_at","x":200,"y":-100}
  {"op":"move_element","id":"gge1234","dx":5,"dy":0}

Examples:
  lceda-ai convert "./MyProject/sch" -o ./out
  lceda-ai read "Sheet_1.json"`);
}

async function main() {
  // In --json mode the machine-readable payload is the only thing on stdout.
  const log = (...a) => { if (!wantsJson) console.log(...a); };
  const logError = (...a) => { console.error(...a); };
  if (!cmd || cmd === '-h' || cmd === '--help') return usage();
  const rest = args.slice(1);
  const flag = (name, dflt) => {
    const i = rest.indexOf(name);
    if (i === -1) return dflt;
    return rest[i + 1];
  };
  if (cmd === 'convert') {
    const input = rest[0];
    if (!input) return usage();
    const outDir = flag('-o', undefined);
    const formats = (flag('--formats', 'svg,png,pdf,report')).split(',').map((s) => s.trim());
    const scale = parseFloat(flag('--scale', '4')) || 4;
    const convert = await lazyConvert();
    const results = await convert(input, { outDir, formats, scale });
    emit(results.map((r) => ({ input: r.input, sheet: r.sheet, outputs: r.outputs, statistics: r.netlist.statistics })));
    for (const r of results) {
      log(`sheet ${r.sheet}:`);
      for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      const s = r.netlist.statistics;
      log(`  stats: ${s.components} components, ${s.pins} pins, ${s.nets} nets`);
    }
    return;
  }
  if (cmd === 'create') {
    const out = rest[0];
    if (!out) return usage();
    const doc = newDocument({
      title: flag('--title', 'Sheet_1'),
      company: flag('--company', ''),
      rev: flag('--rev', '1.0'),
      date: flag('--date', new Date().toISOString().slice(0, 10)),
      drawnBy: flag('--drawn-by', ''),
    });
    await writeDocument(out, doc);
    emit({ file: out, records: doc.shape.length, bbox: doc.BBox });
    log(`created ${out} (${doc.shape.length} records)`);
    return;
  }
  if (cmd === 'find') {
    const query = rest[0] ?? '';
    const file = flag('--file', null);
    const res = await searchComponents({ query, files: file ? [file] : [], parseDocument });
    emit(res);
    if (res.builtin.length) {
      log(`内置符号 (${res.builtin.length}):`);
      for (const b of res.builtin) log(`  ${b.symbol.padEnd(14)} ${b.title}  [${b.package}] ${b.pins} pins${b.defaultValue ? `  默认值 ${b.defaultValue}` : ''}`);
    }
    if (res.online) {
      log(`在线器件 ${res.online.lcsc}: ${res.online.title}  [${res.online.package}] ${res.online.pins} pins`);
    }
    if (res.inventory.length) {
      log(`工程内器件 (${res.inventory.length}):`);
      for (const p of res.inventory.slice(0, 40)) log(`  ${String(p.ref).padEnd(6)} ${String(p.value).padEnd(18)} ${p.package ?? ''} ${p.lcsc ?? ''}`);
    }
    for (const n of res.notes) log(`note: ${n}`);
    return;
  }
  if (cmd === 'place') {
    const file = rest[0];
    let what = rest[1];
    if (!what) what = flag('--std', null) ?? flag('--lcsc', null);
    if (!file || !what) return usage();
    const fsMod = await import('node:fs/promises');
    const doc = JSON.parse(await fsMod.readFile(file, 'utf8'));
    const at = (flag('--at', '400,400') || '').split(',').map(Number);
    const entry = { ref: flag('--ref', undefined), value: flag('--value', undefined), x: at[0], y: at[1], rot: parseFloat(flag('--rot', '0')) || 0 };
    const stdUuid = flag('--std', null) ?? flag('--standard-uuid', null);
    const forceStandard = Boolean(flag('--standard', false));
    const pinsWanted = flag('--pins', null) ? Number(flag('--pins', null)) : undefined;
    const isBuiltin = Boolean(BUILTIN_SYMBOLS[what]);
    if (stdUuid) {
      entry.part = await fetchStandard(stdUuid);
    } else if (/^C\d{3,}$/i.test(what)) {
      entry.part = await fetchPart(what);
    } else if (isBuiltin && !forceStandard) {
      entry.symbol = what;
    } else {
      // standard-library title or uuid; fall back to the built-in catalogue
      const part = await resolvePart(what, { pins: pinsWanted }).catch(() => null);
      if (part) entry.part = part;
      else if (isBuiltin) entry.symbol = what;
      else throw new Error(`unknown part "${what}": not a built-in symbol, LCSC number, or standard-library title`);
    }
    placeComponent(doc, entry);
    await writeDocument(file, doc);
    const parsed = parseDocument(JSON.parse(JSON.stringify(doc)));
    const comp = parsed.components.find((c) => c.designator === entry.ref);
    const pins = (comp?.pins ?? []).map((p) => ({ pin: `${entry.ref}.${p.number}`, name: p.name, x: p.x, y: p.y }));
    emit({ file, ref: entry.ref, value: entry.value ?? '', components: parsed.components.filter((c) => !c.isFrame).length, pins });
    log(`placed ${entry.ref ?? '(auto)'} ${entry.value ?? ''} into ${file}; components: ${parsed.components.filter((c) => !c.isFrame).length}`);
    for (const p of pins) log(`  ${p.pin} ${p.name} @ ${p.x},${p.y}`);
    return;
  }
  if (cmd === 'export') {
    const input = rest[0];
    if (!input) return usage();
    const res = await exportJson(input, {
      out: flag('-o', flag('--out', null)),
      projectDir: flag('--project', null),
      sheetName: flag('--sheet-name', null),
    });
    emit(res);
    log(`exported ${res.outFile} (${res.components} components, ${res.records} records)`);
    if (res.projectDir) log(`project folder: ${res.projectDir}  (用 文件 → 打开 → 嘉立创EDA 选 sch/Sheet_1.json)`);
    for (const w of res.warnings) log(`  ! ${w}`);
    return;
  }
  if (cmd === 'build') {
    const fsMod = await import('node:fs/promises');
    const inline = flag('--spec', null);
    const specFile = inline ? null : rest[0];
    if (!inline && !specFile) return usage();
    const spec = inline ? JSON.parse(inline) : JSON.parse(await fsMod.readFile(specFile, 'utf8'));
    // allow LCSC part numbers inside components
    for (const c of spec.components ?? []) {
      if (c.lcsc && !c.part) {
        try { c.part = await fetchPart(c.lcsc); } catch (e) { console.warn(`warn: ${e.message}`); }
      }
    }
    const built = buildFromSpec(spec);
    const out = flag('-o', flag('--out', null));
    if (!out) return usage();
    await writeDocument(out, built.text);
    const { markdown } = buildReport(built.doc, built.netlist, { sheetName: spec.title ?? 'Sheet_1' });
    await fsMod.writeFile(out.replace(/\.(esch|json)$/, '') + '.report.md', markdown, 'utf8');
    emit({ file: out, statistics: built.netlist.statistics, warnings: built.warnings,
      components: built.netlist.components.map((c) => ({ ref: c.ref, value: c.value, package: c.package, pins: c.pins.length })),
      nets: built.netlist.nets.map((n) => ({ name: n.name, aliases: n.aliases, pins: n.pins.map((p) => `${p.ref}.${p.pin}`) })) });
    log(`built ${out}: ${built.netlist.statistics.components} components, ${built.netlist.statistics.pins} pins, ${built.netlist.statistics.nets} nets`);
    for (const n of built.netlist.nets) {
      if (n.pins.length > 1) log(`  ${n.name}: ${n.pins.map((p) => `${p.ref}.${p.pin}`).join(' ')}`);
    }
    if (built.warnings.length) for (const w of built.warnings) log(`  ! ${w}`);
    if (rest.includes('--export')) {
      const convert = await lazyConvert();
      const results = await convert(out, { formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });
      for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
    }
    return;
  }
  if (cmd === 'edit') {
    const input = rest[0];
    if (!input) return usage();
    const opsJson = flag('--ops', null);
    const opsFile = flag('--ops-file', null);
    if (!opsJson && !opsFile) return usage();
    const ops = JSON.parse(opsFile ? await fs.readFile(opsFile, 'utf8') : opsJson);
    const editSheet = await lazyEdit();
    const res = await editSheet(input, ops, {
      dryRun: rest.includes('--dry-run'),
      backup: !rest.includes('--no-backup'),
      out: flag('--out', null),
      preview: flag('--preview', null),
      previewScale: parseFloat(flag('--scale', '2')) || 2,
    });
    emit({ file: res.file, outFile: res.outFile, dryRun: res.dryRun, changed: res.changed, changes: res.changes,
      diff: res.diff, warnings: res.warnings, summary: res.summary, backupFile: res.backupFile, preview: res.preview,
      statistics: res.statistics });
    log(`file: ${res.file}${res.outFile ? ` -> ${res.outFile}` : ''}${res.dryRun ? ' (dry run)' : ''}`);
    log(`changed: ${res.changed}`);
    for (const c of res.changes) log(`  * ${c}`);
    if (res.notes?.length) { log('notes:'); for (const n of res.notes) log(`  ${n}`); }
    log(`stats: ${res.summary}`);
    log('diff:');
    for (const d of res.diff) log(`  ${d}`);
    if (res.warnings.length) {
      log('warnings:');
      for (const w of res.warnings) log(`  ! ${w}`);
    }
    if (res.backupFile) log(`backup: ${res.backupFile}`);
    if (res.preview) log(`preview: ${res.preview}`);
    return;
  }
  if (cmd === 'read') {
    const input = rest[0];
    if (!input) return usage();
    const files = await findSheetFiles(input);
    const items = [];
    for (const f of files) {
      const doc = parseDocument(await fs.readFile(f, 'utf8'));
      const nl = extractNetlist(doc);
      items.push({ file: f, summary: summarize(doc, nl), statistics: nl.statistics,
        components: nl.components.map((c) => ({ ref: c.ref, value: c.value, package: c.package, lcsc: c.lcsc, pins: c.pins })),
        nets: nl.nets.map((n) => ({ name: n.name, aliases: n.aliases, conflict: n.conflict, pins: n.pins.map((p) => `${p.ref}.${p.pin}`) })) });
      if (!wantsJson) { log(`# ${f}`); log(summarize(doc, nl)); log(); }
    }
    emit(items);
    return;
  }
  usage();
}

main().catch((e) => {
  // keep failures readable: no stack unless DEBUG is set
  if (process.env.DEBUG) console.error(e);
  else console.error(`error: ${e.message}`);
  process.exit(1);
});
