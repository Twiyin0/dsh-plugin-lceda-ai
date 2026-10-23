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
  cache [stats|clear]            Inspect or clear the component cache (also: --no-cache on any command)
  pcb read <file|dir>            Parse a PCB/footprint document: layers, footprints, pads, tracks, vias, pours, board size
  pcb render <file|dir> -o out   Render PCB layers to svg/png/pdf (+ report)
  pcb fp <LCSC|uuid|封装名>       Show the footprint behind a part (pads, size, layers)
  pcb map <sch|dir>              Map every component to a footprint and check pin<->pad numbers
  pcb from-sch <sch> -o board    Build a PCB from a schematic: place footprints + carry the netlist
        [--place rule|shelf] [--export]
  pcb route <board.json> -o out  Autoroute the board (grid maze router) and self-check the result
        [--cell 2] [--clearance 1] [--width 1] [--layers 2] [--export]
        [--priority "RXD,TXD,RST,..."] route these nets first, one at a time
        [--only-priority]               with --priority, skip the remaining nets
  pcb legalize <board.json> -o out  Force every track segment onto the 0/45/90/135 degree grid
  pcb pour <board.json> -o out   Copper pour (flood fill + thermal spokes + island removal) and self-check
        [--net GND] [--layer 1] [--cell 2] [--clearance 1] [--no-thermal] [--keep-island] [--export]
  pcb via <board.json> -o out    Stitching vias inside a pour (rule-checked) [--net GND] [--spacing 5] [--export]
  pcb drc <board.json>           Design rule check: width / clearance / via ring / hole-to-hole / edge / silk / connectivity
        [--checks a,b,c] [-o report.md] [--no-fail]
        [--net-rule "NET1,NET2:0.15"]  net class: judge those nets against 0.15mm
  pcb gerber <board.json> -o dir Export Gerber (RS-274X) + Excellon drill, then self-check [--name board] [--manifest]
  pcb bom <board.json> -o dir    Export BOM + pick-and-place (CSV, and XLSX unless --no-xlsx)
        [--sch sheet.esch] [--name board]
  project <dir>                  Multi-sheet project overview (merged BOM, net classes); [-o out] [--render]
  export <sch.esch|json>         Write the LCEDA-importable JSON (文件 → 打开 → 嘉立创EDA)
        [-o out.json] [--project Dir] [--sheet-name Sheet_1] [--json]
  build <spec.json> -o out.esch  Build a whole schematic from a declarative spec
        [--auto-layout] [--export]   (auto-place parts without x/y, route wires orthogonally)
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
    const pathMod = await import('node:path');
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
  if (cmd === 'pcb') {
    const sub = rest[0];
    const input = rest[1];
    if (!sub || !input) return usage();
    const { readPcbFile, pcbSummary, boardOutline } = await import('../src/pcb/parser.js');
    const fsMod = await import('node:fs/promises');
    const stat = await fsMod.stat(input).catch(() => null);
    const files = stat?.isDirectory()
      ? (await fsMod.readdir(input)).filter((f) => /\.(json|epcb)$/i.test(f)).map((f) => `${input}/${f}`)
      : [input];
    if (sub === 'read') {
      const rows = [];
      for (const f of files) {
        const model = await readPcbFile(f);
        const summary = pcbSummary(model);
        rows.push(summary);
        log(`## ${summary.file}`);
        log(`  ${summary.kind}${summary.package ? ` (${summary.package})` : ''} | 器件 ${summary.counts.footprints} | 焊盘 ${summary.counts.pads} | 走线 ${summary.counts.tracks} | 过孔 ${summary.counts.vias} | 铜皮 ${summary.counts.copperAreas}`);
        if (summary.board) log(`  板框 ${summary.board.widthMm} x ${summary.board.heightMm} mm`);
        for (const fp of summary.footprints) log(`  - ${fp.name || '(未命名)'} ${fp.package} @${fp.x},${fp.y} rot${fp.rotation} pads=${fp.pads}`);
        const drc = summary.drc ?? {};
        if (drc.trackWidth) log(`  DRC 线宽 ${drc.trackWidth} 间距 ${drc.clearance} 过孔 ${drc.viaHoleDiameter}/${drc.viaHoleD}`);
      }
      emit(files.length === 1 ? rows[0] : rows);
      return;
    }
    if (sub === 'fp') {
      const { fetchFootprint, fetchFootprintForLcsc, resolveFootprintByPackage } = await import('../src/pcb/footprint.js');
      const { pcbSummary } = await import('../src/pcb/parser.js');
      const arg = input;
      let fp;
      if (/^C\d{4,}$/i.test(arg)) fp = await fetchFootprintForLcsc(arg.toUpperCase());
      else if (/^[0-9a-f]{32}$/i.test(arg)) fp = await fetchFootprint(arg);
      else fp = await resolveFootprintByPackage(arg, {});
      if (!fp?.model) {
        logError(`no footprint for ${arg}: ${fp?.error ?? 'unknown'}`);
        process.exitCode = 1;
        return;
      }
      const summary = pcbSummary(fp.model);
      emit({ query: arg, uuid: fp.uuid, title: fp.title, tried: fp.tried, note: fp.note, summary });
      log(`## ${fp.title || fp.uuid}  (${arg})`);
      log(`  封装名 ${summary.package} | 焊盘 ${summary.counts.pads} | 走线 ${summary.counts.tracks} | 层 ${summary.layers.slice(0, 5).join(', ')}`);
      const pads = fp.model.footprints[0].pads;
      const xs = pads.map((p) => p.x), ys = pads.map((p) => p.y);
      if (pads.length > 1) {
        const pitch = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
        log(`  焊盘间距 ${(pitch * 0.254).toFixed(3)} mm | 尺寸 ${(pads[0].width * 0.254).toFixed(2)} x ${(pads[0].height * 0.254).toFixed(2)} mm`);
      }
      log(`  焊盘号: ${pads.map((p) => p.number).join(', ')}`);
      if (fp.note) log(`  ! ${fp.note}`);
      return;
    }
    if (sub === 'map') {
      const { mapSchematic } = await import('../src/pcb/footprint.js');
      const { parseDocument } = await import('../src/parser.js');
      const refresh = rest.includes('--refresh');
      const rows = [];
      let totals = { total: 0, ok: 0, mismatch: 0, missing: 0 };
      for (const f of files) {
        const doc = parseDocument(await fsMod.readFile(f, 'utf8'));
        doc.components = doc.components.filter((c) => c.designator);
        const { rows: r, summary } = await mapSchematic(doc, { refresh });
        rows.push({ file: f, rows: r, summary });
        totals = { total: totals.total + summary.total, ok: totals.ok + summary.ok, mismatch: totals.mismatch + summary.mismatch, missing: totals.missing + summary.missing };
        log(`## ${f}`);
        log(`   器件 ${summary.total} | 匹配 ${summary.ok} | 引脚不符 ${summary.mismatch} | 找不到封装 ${summary.missing}`);
        for (const row of r) {
          const mark = row.status.startsWith('ok') ? '✓' : '✗';
          log(`   ${mark} ${String(row.ref).padEnd(5)} ${String(row.pins).padStart(2)}脚 ${String(row.package || '-').padEnd(18)} ${String(row.footprint || '-').slice(0, 28).padEnd(29)} ${row.detail}`);
        }
      }
      emit({ files: rows, totals });
      if (totals.missing || totals.mismatch) process.exitCode = 1;
      return;
    }
    if (sub === 'bom') {
      const { readPcbFile: readPcb } = await import('../src/pcb/parser.js');
      const { exportBom, verifyBom } = await import('../src/pcb/bom.js');
      const fsMod = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const model = await readPcb(input);
      // enrich from the schematic when one is given (or when the board sits next
      // to the sheet it came from)
      const schFile = flag('--sch', null);
      let schematic = null;
      if (schFile) {
        const { parseDocument } = await import('../src/parser.js');
        schematic = parseDocument(await fsMod.readFile(schFile, 'utf8'));
      }
      const name = flag('--name', pathMod.basename(input).replace(/\.(json|epcb)$/i, '')) || 'board';
      const t0 = Date.now();
      const exported = exportBom(model, { name, schematic, xlsx: !rest.includes('--no-xlsx') });
      await fsMod.mkdir(out, { recursive: true });
      for (const f of exported.files) await fsMod.writeFile(pathMod.join(out, f.name), f.buffer ?? f.text);
      const check = verifyBom(model, exported);
      emit({ dir: out, stats: exported.stats, check, bom: exported.bom, cpl: exported.cpl, files: exported.files.map((f) => f.name), ms: Date.now() - t0 });
      log(`bom ${out}: ${exported.stats.lines} 行 / ${exported.stats.parts} 个器件 | 贴片 ${exported.stats.placements}(顶 ${exported.stats.top} / 底 ${exported.stats.bottom}) | 有 LCSC 号 ${exported.stats.withLcsc} 行 | ${Date.now() - t0} ms`);
      log(`  文件:${exported.files.map((f) => f.name).join(', ')}`);
      log(`  自检:${check.ok ? '器件不重不漏' : check.problems.join('; ')}`);
      for (const r of exported.bom.slice(0, 12)) log(`  ${String(r.item).padStart(2)} x${String(r.qty).padEnd(2)} ${r.references.slice(0, 18).padEnd(19)} ${String(r.value).slice(0, 12).padEnd(13)} ${String(r.package).slice(0, 18).padEnd(19)} ${r.lcsc || '-'}`);
      return;
    }
    if (sub === 'gerber') {
      const { readPcbFile: readPcb } = await import('../src/pcb/parser.js');
      const { exportGerber, verifyGerber } = await import('../src/pcb/gerber.js');
      const fsMod = await import('node:fs/promises');
      const pathMod = await import('node:path');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const model = await readPcb(input);
      const name = flag('--name', pathMod.basename(input).replace(/\.(json|epcb)$/i, '')) || 'board';
      const t0 = Date.now();
      const exported = exportGerber(model, { name });
      await fsMod.mkdir(out, { recursive: true });
      for (const f of exported.files) await fsMod.writeFile(pathMod.join(out, f.name), f.text, 'utf8');
      const check = verifyGerber(model, exported);
      const manifest = {
        generator: 'lceda-ai pcb gerber 1.0',
        source: input,
        created: new Date().toISOString(),
        files: exported.files.map((f) => ({ file: f.name, layer: String(f.layer), bytes: f.text.length })),
        check: { ok: check.ok, checks: check.checks, problems: check.problems },
      };
      if (rest.includes('--manifest')) await fsMod.writeFile(pathMod.join(out, 'gerber.manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      emit({ dir: out, name, files: exported.files.map((f) => f.name), check, ms: Date.now() - t0 });
      log(`gerber ${out}: ${exported.files.length} 个文件(${exported.files.map((f) => f.name).join(', ')}) | ${Date.now() - t0} ms`);
      for (const c of check.checks) log(`  ${String(c.name).padEnd(26)} ${String(c.expected).padStart(6)} -> ${c.actual}`);
      log(`  自检:${check.ok ? '全部一致' : check.problems.join('; ')}`);
      return;
    }
    if (sub === 'drc') {
      const { readPcbFile: readPcb } = await import('../src/pcb/parser.js');
      const { runDrc, drcMarkdown } = await import('../src/pcb/drc.js');
      const checkList = flag('--checks', null);
      // --net-rule "USB_D+,USB_D-:0.15" applies a net class: those nets are judged
      // against 0.15 mm instead of the board-wide 0.254 mm, which is what a
      // 0.65 mm pitch connector actually needs.
      const netRules = {};
      const ruleSpecs = [];
      const single = flag('--net-rule', null);
      if (single) ruleSpecs.push(single);
      for (let k = 0; k < rest.length; k++) if (rest[k] === '--net-rule' && rest[k + 1]) ruleSpecs.push(rest[k + 1]);
      for (const spec of [...new Set(ruleSpecs)]) {
        const [nets, clearance, width] = String(spec).split(':');
        for (const n of String(nets).split(',').map((x) => x.trim()).filter(Boolean)) {
          netRules[n] = { ...(netRules[n] ?? {}), ...(clearance ? { clearance: Number(clearance) } : {}), ...(width ? { trackWidth: Number(width) } : {}) };
        }
      }
      const rows = [];
      for (const f of files) {
        const model = await readPcb(f);
        if (Object.keys(netRules).length) {
          model.drc = model.drc ?? {};
          model.drc.perNet = { ...(model.drc.perNet ?? {}), ...netRules };
        }
        const t0 = Date.now();
        const result = runDrc(model, checkList ? { checks: String(checkList).split(',').map((x) => x.trim()) } : {});
        rows.push({
          file: f, ok: result.ok, summary: result.summary, counts: result.counts, rules: result.rules, ms: Date.now() - t0,
          // the violations themselves, so a tool call can report what is wrong
          // instead of only how many things are wrong
          violations: result.violations.map((v) => ({
            type: v.type, severity: v.severity, net: v.net || '', otherNet: v.otherNet || '',
            layer: v.layer ?? null, at: v.at ?? null, measuredMm: v.measuredMm, requiredMm: v.requiredMm,
            detail: v.detail ?? '',
          })),
        });
        log(`## ${f}`);
        log(`   ${result.ok ? 'PASS' : 'FAIL'} — ${result.summary}${Object.keys(result.counts).length ? ' | ' + Object.entries(result.counts).map(([k, v]) => `${k}:${v}`).join(' ') : ''}`);
        for (const v of result.violations.slice(0, 8)) {
          log(`   - [${v.severity === 'error' ? '错误' : '提示'}] ${v.type} ${v.net || ''} ${v.at ? `@${v.at.x},${v.at.y}` : ''} 实测 ${v.measuredMm}mm / 要求 ${v.requiredMm}mm${v.detail ? ' — ' + v.detail : ''}`);
        }
        const out = flag('-o', flag('--out', null));
        if (out) await fsMod.writeFile(files.length > 1 ? out.replace(/\.md$/, '') + '-' + f.replace(/[^\w.-]/g, '_') + '.md' : out, drcMarkdown(result, { file: f }), 'utf8');
      }
      emit({ files: rows });
      // A failing DRC is a result, not a broken command: --no-fail keeps the exit
      // code at 0 so a tool call can read the report instead of seeing a failure.
      if (rows.some((r) => !r.ok) && !rest.includes('--no-fail')) process.exitCode = 1;
      return;
    }
    if (sub === 'via') {
      const { readPcbFile: readPcb } = await import('../src/pcb/parser.js');
      const { viaBoard, stitchVias, verifyVias, viaRules } = await import('../src/pcb/via.js');
      const { defaultPourNet } = await import('../src/pcb/pour.js');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const board = await readPcb(input);
      const net = flag('--net', null) ?? defaultPourNet(board);
      const opts = { net, spacingMm: Number(flag('--spacing', 5)) || 5, edgeMm: Number(flag('--edge', 1)) || 1, cell: Number(flag('--cell', 2)) || 2 };
      const t0 = Date.now();
      const stitched = viaBoard(board, opts);
      await fsMod.writeFile(out, JSON.stringify(stitched.doc), 'utf8');
      const check = verifyVias(board, stitched.vias, { rules: stitched.rules });
      emit({ file: out, net, stats: stitched.stats, rules: stitched.rules, check, ms: Date.now() - t0 });
      log(`stitched ${out}: ${net} 网络 ${stitched.stats.placed} 个缝合孔 | 间距 ${opts.spacingMm}mm | 盘 ${stitched.stats.diameterMm}mm / 孔 ${stitched.stats.drillMm}mm / 环 ${stitched.stats.annularRingMm}mm | ${Date.now() - t0} ms`);
      log(`  自检:${check.ok ? '间距与孔到孔均合格' : check.count + ' 处违规'}`);
      for (const v of check.violations.slice(0, 5)) log(`    - ${v.kind} ${v.gapMm}mm`);
      if (rest.includes('--export')) {
        const { renderPcbFiles } = await import('../src/pcb/render.js');
        const dir = out.replace(/\.(json|epcb)$/i, '') + '.render';
        const results = await renderPcbFiles([out], { outDir: dir, formats: ['png', 'svg', 'report'], scale: 8 });
        for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      }
      return;
    }
    if (sub === 'pour') {
      const { readPcbFile: readPcb } = await import('../src/pcb/parser.js');
      const { pourBoard, pourNet, verifyPour, defaultPourNet } = await import('../src/pcb/pour.js');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const model = await readPcb(input);
      const net = flag('--net', null) ?? defaultPourNet(model);
      const opts = {
        net, layer: Number(flag('--layer', 1)) || 1,
        cell: Number(flag('--cell', 2)) || 2,
        clearance: Number(flag('--clearance', 1)) || 1,
        thermal: !rest.includes('--no-thermal'),
        keepIsland: rest.includes('--keep-island'),
      };
      const t0 = Date.now();
      const poured = pourBoard(model, opts);
      await fsMod.writeFile(out, JSON.stringify(poured.doc), 'utf8');
      const pour = pourNet(model, opts);
      const check = verifyPour(model, pour);
      emit({ file: out, net, stats: poured.stats, pour: pour.stats, check, ms: Date.now() - t0 });
      log(`poured ${out}: 网络 ${net} | 铜 ${pour.stats.areaMm2} mm² | 多边形 ${pour.stats.polygons} | 热焊盘 ${pour.stats.thermal ? '开' : '关'} | 移除孤岛 ${pour.stats.removedIslands} | ${Date.now() - t0} ms`);
      log(`  自检:${check.ok ? '无其他网络焊盘落在铜内' : check.count + ' 处越界'}`);
      for (const v of check.violations.slice(0, 5)) log(`    - ${v.net || '(无网络)'} 焊盘在铜内 @${v.at.x},${v.at.y}`);
      if (rest.includes('--export')) {
        const { renderPcbFiles } = await import('../src/pcb/render.js');
        const dir = out.replace(/\.(json|epcb)$/i, '') + '.render';
        const results = await renderPcbFiles([out], { outDir: dir, formats: ['png', 'svg', 'report'], scale: 8 });
        for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      }
      return;
    }
    if (sub === 'legalize') {
      // Force every segment onto the 0/45/90/135 degree grid real LCEDA boards use.
      const { parsePcb } = await import('../src/pcb/parser.js');
      const { legalizeAngles } = await import('../src/pcb/route.js');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const doc = JSON.parse(await fsMod.readFile(input, 'utf8'));
      const angleOf = (a, b) => {
        const d = Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI) % 180;
        return d < 0 ? d + 180 : d;
      };
      const before = {}, after = {};
      let fixed = 0;
      doc.shape = doc.shape.map((rec) => {
        const str = String(rec);
        if (!str.startsWith('TRACK~')) return rec;
        const f = str.split('~');
        const nums = f[4].split(/\s+/).map(Number);
        const pts = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
        for (let i = 0; i + 1 < pts.length; i++) { const a = angleOf(pts[i], pts[i + 1]); before[a] = (before[a] || 0) + 1; }
        const next = legalizeAngles(pts);
        if (next.length !== pts.length) fixed++;
        for (let i = 0; i + 1 < next.length; i++) { const a = angleOf(next[i], next[i + 1]); after[a] = (after[a] || 0) + 1; }
        f[4] = next.map((q) => `${q.x} ${q.y}`).join(' ');
        return f.join('~');
      });
      await fsMod.writeFile(out, JSON.stringify(doc), 'utf8');
      const illegal = Object.entries(after).filter(([a]) => ![0, 45, 90, 135].includes(Number(a)));
      emit({ file: out, fixed, before, after, illegal });
      log(`legalized ${out}: ${fixed} 条走线被拆成 45° 折线`);
      log(`  角度分布: ${Object.entries(after).sort((a, b) => Number(a[0]) - Number(b[0])).map(([a, n]) => `${a}°:${n}`).join('  ')}`);
      log(illegal.length ? `  ! 仍有非法角: ${illegal.map(([a, n]) => `${a}°x${n}`).join(' ')}` : '  ✓ 全部落在 0/45/90/135');
      return;
    }
    if (sub === 'route') {
      const { readPcbFile: readPcb, copperItems, parsePcb } = await import('../src/pcb/parser.js');
      const { routeBoard, verifyRouting } = await import('../src/pcb/route.js');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const model = await readPcb(input);
      const t0 = Date.now();
      const routeOpts = {
        cell: Number(flag('--cell', 2)) || 2,
        clearance: Number(flag('--clearance', 1)) || 1,
        width: Number(flag('--width', 1)) || 1,
        viaCost: Number(flag('--via-cost', 6)) || 6,
      };
      // --priority "RXD,TXD,RST,..." routes those nets one at a time, in that
      // order, then (unless --only-priority) the rest of the board.
      const priority = flag('--priority', null);
      if (priority) {
        const { routeInOrder } = await import('../src/pcb/route.js');
        const order = String(priority).split(',').map((x) => x.trim()).filter(Boolean);
        const seq = routeInOrder(model, order, routeOpts);
        let finalDoc = seq.doc;
        let restStats = null;
        if (!rest.includes('--only-priority')) {
          const allNets = [...new Set(copperItems(parsePcb(finalDoc)).filter((i) => i.kind === 'pad' && i.net).map((i) => i.net))];
          const restNets = allNets.filter((n) => !order.includes(n));
          if (restNets.length) {
            const rest = routeBoard(parsePcb(finalDoc), { ...routeOpts, nets: restNets });
            finalDoc = rest.doc;
            restStats = rest.stats;
          }
        }
        await fsMod.writeFile(out, JSON.stringify(finalDoc), 'utf8');
        const check = verifyRouting(model, copperItems(parsePcb(finalDoc)).filter((i) => i.kind === 'track'), { clearance: routeOpts.clearance });
        emit({ file: out, priority: order, passes: seq.passes, stats: seq.stats, rest: restStats, check, ms: Date.now() - t0 });
        log(`routed ${out}: 优先网络 ${seq.stats.routed}/${seq.stats.nets}${restStats ? ` | 其余 ${restStats.routed}/${restStats.nets}` : ''} | ${Date.now() - t0} ms`);
        for (const p of seq.passes) log(`  ${p.ok ? '✓' : '✗'} ${String(p.net).padEnd(9)} 走线 ${String(p.tracks).padStart(3)} 过孔 ${String(p.vias).padStart(3)}`);
        log(`  自检:压盘 ${check.count} 处`);
        return;
      }
      const routed = routeBoard(model, routeOpts);
      await fsMod.writeFile(out, JSON.stringify(routed.doc), 'utf8');
      const check = verifyRouting(model, routed.tracks);
      emit({ file: out, stats: routed.stats, routed: routed.routed, failed: routed.failed, check, ms: Date.now() - t0 });
      log(`routed ${out}: ${routed.stats.routed}/${routed.stats.nets} 网络 | 走线 ${routed.stats.tracks} 段 | 过孔 ${routed.stats.vias} | 长度 ${routed.stats.lengthMm} mm | ${Date.now() - t0} ms`);
      if (routed.failed.length) for (const f of routed.failed.slice(0, 8)) log(`  ! 未布通 ${f.net} ${f.from ?? ''}${f.to ? ' -> ' + f.to : ''}`);
      log(`  自检:${check.ok ? '未压到其他网络的焊盘' : check.count + ' 处压到其他网络焊盘'}`);
      for (const v of check.violations.slice(0, 5)) log(`    - ${v.net} 压到 ${v.pad}(${v.padNet}) 间距 ${v.gapMm}mm`);
      if (rest.includes('--export')) {
        const { renderPcbFiles } = await import('../src/pcb/render.js');
        const dir = out.replace(/\.(json|epcb)$/i, '') + '.render';
        const results = await renderPcbFiles([out], { outDir: dir, formats: ['png', 'svg', 'report'], scale: 8 });
        for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      }
      return;
    }
    if (sub === 'from-sch') {
      const { boardFromSchematic } = await import('../src/pcb/fromSchematic.js');
      const out = flag('-o', flag('--out', null));
      if (!out) return usage();
      const sch = input;
      // --footprint U1=DIP-40 (repeatable)
      const footprintOverrides = {};
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--footprint' && rest[i + 1]) {
          const [ref, query] = String(rest[i + 1]).split('=');
          if (ref && query) footprintOverrides[ref] = query;
        }
      }
      const res = await boardFromSchematic(sch, {
        refresh: rest.includes('--refresh'),
        pitchMm: Number(flag('--pitch', 12.7)) || 12.7,
        marginMm: Number(flag('--margin', 5)) || 5,
        title: flag('--title', '') || undefined,
        placement: flag('--place', 'rule'),
        boardWidthMm: Number(flag('--board-width', 0)) || undefined,
        title: flag('--title', undefined),
        footprints: footprintOverrides,
      });
      await fsMod.mkdir(await import('node:path').then((m) => m.dirname(out)), { recursive: true });
      await fsMod.writeFile(out, res.text, 'utf8');
      emit({
        file: out, board: res.board, stats: res.stats, warnings: res.warnings,
        failed: res.failed, placements: res.placements,
        nets: [...new Set(res.placements.flatMap((p) => Object.values(p.nets ?? {})))],
      });
      log(`built ${out}: ${res.stats.components} 器件 / ${res.stats.pads} 焊盘 / ${res.stats.nets} 网络 | 板框 ${res.board.widthMm} x ${res.board.heightMm} mm`);
      if (res.quality) log(`布局质量:飞线 ${res.quality.ratsnestMm} mm | 重叠 ${res.quality.overlaps} | 越界 ${res.quality.outside}`);
      for (const p of res.placements) log(`  ${String(p.ref).padEnd(5)} ${String(p.footprint).slice(0, 26).padEnd(27)} @${p.x},${p.y} ${String(p.pins).padStart(2)}脚/${String(p.pads).padStart(2)}盘 ${String(p.pitchMm ?? '-').padStart(5)}mm ${p.nets}网络${p.byNumber ? '' : ' (按顺序对应)'}`);
      for (const f of res.failed) log(`  ! ${f.ref}: ${f.reason}`);
      for (const w of res.warnings) log(`  ! ${w}`);
      if (rest.includes('--export')) {
        const { renderPcbFiles } = await import('../src/pcb/render.js');
        const dir = out.replace(/\.(json|epcb)$/i, '') + '.render';
        const results = await renderPcbFiles([out], { outDir: dir, formats: ['png', 'svg', 'report'], scale: 8 });
        for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      }
      return;
    }
    if (sub === 'render') {
      const { renderPcbFiles } = await import('../src/pcb/render.js');
      const outDir = flag('-o', flag('--out', null));
      if (!outDir) return usage();
      const formats = flag('--formats', 'svg,png,pdf,report').split(',').map((x) => x.trim()).filter(Boolean);
      const scale = Number(flag('--scale', 3)) || 3;
      const view = flag('--view', 'top');
      const results = await renderPcbFiles(files, { outDir, formats, scale, view });
      emit(results.map((r) => ({ file: r.input, input: r.input, view, outputs: r.outputs })));
      for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
      return;
    }
    return usage();
  }

  if (cmd === 'project') {
    const dir = rest[0];
    if (!dir) return usage();
    const { readProject, projectMarkdown } = await import('../src/project.js');
    const fsMod = await import('node:fs/promises');
    const project = await readProject(dir);
    const markdown = projectMarkdown(project);
    const outDir = flag('-o', flag('--out', null));
    if (outDir) {
      await fsMod.mkdir(outDir, { recursive: true });
      await fsMod.writeFile(`${outDir}/project.json`, JSON.stringify(project, null, 2));
      await fsMod.writeFile(`${outDir}/project.md`, markdown, 'utf8');
    }
    emit({ ...project, markdown });
    log(markdown);
    if (outDir) log(`\nwrote ${outDir}/project.json and ${outDir}/project.md`);
    if (rest.includes('--render')) {
      const convert = await lazyConvert();
      const results = await convert(dir, { outDir: outDir ?? undefined, formats: ['svg', 'png', 'pdf', 'report'], scale: 3 });
      for (const r of results) for (const [k, v] of Object.entries(r.outputs)) log(`  ${k}: ${v}`);
    }
    return;
  }

  if (cmd === 'cache') {
    const { cacheStats, clearCache } = await import('../src/cache.js');
    const action = rest[0] ?? 'stats';
    if (action === 'clear') {
      const removed = await clearCache();
      emit({ action: 'clear', removed });
      log(`cleared ${removed} cache file(s)`);
      return;
    }
    const stats = await cacheStats();
    emit(stats);
    log(`cache: ${stats.dir}`);
    for (const [kind, v] of Object.entries(stats.kinds)) log(`  ${kind.padEnd(6)} ${String(v.entries).padStart(4)} files  ${(v.bytes / 1024).toFixed(1)} KB`);
    log(`  total  ${(stats.totalBytes / 1024).toFixed(1)} KB${stats.disabled ? '  (disabled by LCEDA_NO_CACHE)' : ''}`);
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
    const autoLayout = rest.includes('--auto-layout');
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
    const built = buildFromSpec(spec, { autoLayout });
    const out = flag('-o', flag('--out', null));
    if (!out) return usage();
    await writeDocument(out, built.text);
    const { markdown } = buildReport(built.doc, built.netlist, { sheetName: spec.title ?? 'Sheet_1' });
    await fsMod.writeFile(out.replace(/\.(esch|json)$/, '') + '.report.md', markdown, 'utf8');
    emit({ file: out, statistics: built.netlist.statistics, warnings: built.warnings, placements: built.placements,
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
