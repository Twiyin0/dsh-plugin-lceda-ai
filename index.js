// LCEDA Schematic AI — Host plugin exposing the lceda-ai toolset to agents.
//
//   lceda_find_component      search built-in symbols / LCSC parts / a sheet's inventory
//   lceda_create_schematic    new sheet (frame + title block), optionally from a spec
//   lceda_place_component     place one built-in symbol or a real LCSC part
//   lceda_read_schematic      BOM + pin tables + netlist
//   lceda_render_schematic    SVG / PNG / PDF / report
//   lceda_edit_schematic      structured edits with diff + validation
//
// Every tool shells out to the workspace CLI: a subprocess always runs the current
// code (the Harness module cache would otherwise pin an old module generation) and
// keeps native dependencies such as sharp out of the Electron host process.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const name = 'lceda-schematic-ai';
export const inject = ['tools', 'workingDirectory'];

const DEFAULT_SCALE = 4;
const DEFAULT_FORMATS = ['svg', 'png', 'pdf', 'report'];

let cachedNode;
const versionRank = (v) => {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  return m ? Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]) : 0;
};

/** Locate the newest Node.js (>= 20) usable for the CLI subprocess. */
async function resolveNode() {
  if (cachedNode) return cachedNode;
  const candidates = [];
  if (process.env.LCEDA_NODE) candidates.push(process.env.LCEDA_NODE);
  const home = process.env.HOME ?? '';
  try {
    const nvm = path.join(home, '.nvm/versions/node');
    const versions = (await fs.readdir(nvm)).sort((a, b) => versionRank(b) - versionRank(a));
    for (const v of versions) candidates.push(path.join(nvm, v, 'bin/node'));
  } catch { /* no nvm */ }
  candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', 'node');
  for (const c of candidates) {
    try {
      await fs.access(c);
      const major = await new Promise((resolve) => {
        execFile(c, ['-v'], { timeout: 5000 }, (err, out) => resolve(err ? 0 : Number(String(out).replace('v', '').split('.')[0]) || 0));
      });
      if (major >= 20) { cachedNode = c; return c; }
    } catch { /* next */ }
  }
  cachedNode = 'node';
  return cachedNode;
}

const cliPath = () => new URL('./bin/lceda-ai.js', import.meta.url).pathname;

/** Run the CLI with argv (no shell) and return parsed JSON output. */
async function runCli(args, { cwd, timeoutMs = 180000 } = {}) {
  const node = await resolveNode();
  return new Promise((resolve, reject) => {
    execFile(node, [cliPath(), ...args], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || '').trim().split('\n').slice(-8).join('\n');
        reject(new Error(`${error.message}${detail ? `\n${detail}` : ''}`));
        return;
      }
      const text = String(stdout).trim();
      if (!text) return resolve(null);
      const objAt = text.indexOf('{');
      const arrAt = text.indexOf('[');
      const from = objAt === -1 ? arrAt : (arrAt === -1 ? objAt : Math.min(objAt, arrAt));
      if (from === -1) return resolve({ raw: text });
      try { resolve(JSON.parse(text.slice(from))); } catch { resolve({ raw: text }); }
    });
  });
}

const asBool = (v, dflt) => (v === undefined || v === null ? dflt : v === true || v === 'true' || v === 1 || v === '1' || v === 'yes');
const asNum = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };
/** Accept an array, a JSON-encoded array, or a comma-separated string. */
const asArray = (v) => {
  if (Array.isArray(v)) return v;
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch { /* fall through to comma splitting */ }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
};
const str = (v) => (v === undefined || v === null ? '' : String(v));

async function resolvePath(ctx, exec, input) {
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  return path.isAbsolute(input) ? input : path.resolve(cwd, input);
}

function bomTable(components) {
  const lines = ['| 位号 | 值/型号 | 封装 | LCSC | 引脚数 |', '|---|---|---|---|---|'];
  for (const c of components) lines.push(`| ${c.ref} | ${str(c.value) || str(c.name)} | ${str(c.package)} | ${str(c.lcsc)} | ${(c.pins ?? []).length} |`);
  return lines;
}
const pinList = (c) => (c.pins ?? []).map((p) => `${p.number}=${p.name}`).join(' ');

function netLines(nets) {
  const lines = [];
  for (const n of nets) {
    const alias = n.aliases?.length ? ` (别名 ${n.aliases.join('/')})` : '';
    const warn = n.conflict ? ' ⚠️命名冲突' : '';
    lines.push(`- **${n.name}**${alias}${warn}: ${(n.pins ?? []).join(', ') || '(无引脚)'}`);
  }
  return lines;
}

/**
 * Compile the author-facing parameter table into a real JSON Schema.
 *
 * `ctx.tools.register()` stores `parameters` verbatim (only `defineTool`, which
 * is not importable from a bundle, would compile it), and the provider expects
 * an object-rooted JSON Schema. Passing the shorthand table straight through
 * makes the API reject the whole function
 * (`schema must be a JSON Schema of 'type: "object"'`).
 */
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export function compileParameters(spec = {}) {
  const properties = {};
  const required = [];
  for (const [name, def] of Object.entries(spec)) {
    const source = typeof def === 'string' ? { type: def } : (def ?? {});
    const type = source.type;
    if (type !== undefined && !PARAM_TYPES.has(type)) {
      throw new TypeError(`parameter "${name}" has unsupported type ${JSON.stringify(type)}`);
    }
    const prop = {};
    if (type !== undefined) prop.type = type;
    if (source.description !== undefined) prop.description = String(source.description);
    if (Array.isArray(source.enum)) prop.enum = source.enum.map((v) => String(v));
    if (source.items !== undefined) {
      const itemType = source.items?.type;
      if (!PARAM_TYPES.has(itemType)) throw new TypeError(`parameter "${name}" has unsupported items type ${JSON.stringify(itemType)}`);
      prop.items = { type: itemType, ...(source.items.description ? { description: String(source.items.description) } : {}) };
    }
    properties[name] = prop;
    if (source.required === true) required.push(name);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

const TOOLS = [
  {
    name: 'lceda_find_component',
    description: 'Search parts for a 嘉立创EDA schematic. Sources, in the order the editor itself uses: (1) the LCEDA standard library (the 元件库 panel — returns uuid, title, package; this is what you should normally place), (2) the LCSC/EasyEDA product library by part number (e.g. C9900042655), (3) the small built-in offline catalogue (stc89c52rc/resistor/capacitor/capacitor_pol/crystal/switch/led/header), and (4) parts already used in a sheet you pass as files. Use the returned uuid (or title, or LCSC number) with lceda_place_component.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keyword (e.g. "crystal", "晶振", "8051") or an LCSC part number (e.g. C9900042655).' },
      files: { type: 'array', items: { type: 'string' }, description: 'Optional schematic files whose existing parts should also be listed.' },
    },
    async execute(args, ctx, exec) {
      const files = [];
      for (const f of asArray(args.files)) files.push(await resolvePath(ctx, exec, String(f)));
      const argv = ['find', str(args.query), '--json'];
      for (const f of files) argv.push('--file', f);
      const res = await runCli(argv, { cwd: await ctx.workingDirectory.ensure(exec.agent, exec.signal) });
      const lines = [];
      if (res?.builtin?.length) {
        lines.push(`内置符号 ${res.builtin.length} 个:`);
        for (const b of res.builtin) lines.push(`  symbol=${b.symbol} | ${b.title} | ${b.package} | ${b.pins} pins | 默认 ${b.defaultValue ?? '-'}`);
      } else lines.push('内置库无匹配。');
      if (res?.standard?.length) {
        lines.push(`标准库 ${res.standard.length} 个(优先使用):`);
        for (const h of res.standard) lines.push(`  ${h.title} | 封装 ${h.package || '-'} | uuid ${h.uuid}${h.lcsc ? ' | ' + h.lcsc : ''}${h.pins ? ' | ' + h.pins + ' pins' : ''}`);
      }
      if (res?.online) lines.push(`商城器件 ${res.online.lcsc}: ${res.online.title} | ${res.online.package} | ${res.online.pins} pins`);
      if (res?.inventory?.length) {
        lines.push(`工程内器件 ${res.inventory.length} 个:`);
        for (const p of res.inventory.slice(0, 40)) lines.push(`  ${p.ref} ${str(p.value)} ${str(p.package)} ${str(p.lcsc)}`);
      }
      for (const n of res?.notes ?? []) lines.push(`note: ${n}`);
      return { text: lines.join('\n'), files: [] };
    },
  },
  {
    name: 'lceda_create_schematic',
    description: 'Create a new 嘉立创EDA schematic sheet (A4 frame + title block), optionally building the whole circuit in one call from a declarative spec. The spec is { components:[{std|lcsc|symbol,ref,value,x,y,rot}], wires:[{from:"U1.19",to:"Y1.1"}|{points:[[x,y],...]}], labels:[{text,at,anchor}], flags:[{text,kind,at,rot}], junctions:[{at}], texts:[{text,at,size,color}] } where any "at"/"from"/"to" can be a pin reference like "U1.9" or a coordinate [x,y]. Net labels and power flags placed on pins connect them, and the call returns the netlist it built so mistakes are visible immediately. Part source priority is mandatory: std (LCEDA standard library uuid) first, then lcsc (LCSC mall library), then symbol (built-in drawn) only as a fallback — never hand-draw a part that exists in either library. Optionally exports svg/png/pdf/report.',
    parameters: {
      path: { type: 'string', required: true, description: 'Output .esch path (relative to the session workspace).' },
      sheetTitle: { type: 'string', description: 'Sheet title shown in the title block (previously named title; "title" is still accepted).' },
      company: { type: 'string', description: 'Company line of the title block.' },
      rev: { type: 'string', description: 'Revision, default 1.0.' },
      date: { type: 'string', description: 'Date string, default today.' },
      drawnBy: { type: 'string', description: 'Author line.' },
      spec: { type: 'string', description: 'Optional JSON spec of components/wires/labels/flags/junctions/texts (a JSON string is accepted).' },
      export: { type: 'boolean', description: 'Also write svg/png/pdf/report next to the .esch (default false).' },
      autoLayout: { type: 'boolean', description: 'Auto-place every component that has no x/y and route {from,to} wires orthogonally (same as setting "layout":"auto" in the spec).' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const cwd0 = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      let spec = args.spec;
      let specFile = null;
      if (typeof spec === 'string' && spec.trim()) {
        const t = spec.trim();
        if (t.startsWith('{') || t.startsWith('[')) {
          try { spec = JSON.parse(t); } catch { throw new Error('spec JSON is invalid'); }
        } else {
          // a path to a spec file is also accepted
          specFile = path.isAbsolute(t) ? t : path.resolve(cwd0, t);
          spec = JSON.parse(await fs.readFile(specFile, 'utf8'));
        }
      }
      const hasSpec = spec && typeof spec === 'object'
        && (spec.components?.length || spec.wires?.length || spec.labels?.length || spec.flags?.length || spec.texts?.length);
      const files = [];
      const lines = [];
      if (hasSpec) {
        const merged = {
          title: args.sheetTitle ?? args.title ?? 'Sheet_1',
          company: args.company ?? '',
          rev: args.rev ?? '1.0',
          date: args.date ?? new Date().toISOString().slice(0, 10),
          drawnBy: args.drawnBy ?? '',
          ...spec,
        };
        merged.title = spec.title ?? merged.title;
        if (asBool(args.autoLayout)) merged.layout = 'auto';
        const argv = specFile
          ? ['build', specFile, '-o', target, '--json']
          : ['build', '-o', target, '--spec', JSON.stringify(merged), '--json'];
        if (asBool(args.autoLayout)) argv.push('--auto-layout');
        const wantExport = asBool(args.export, false);
        if (wantExport) argv.push('--export');
        const res = await runCli(argv, { cwd });
        files.push(target);
        lines.push(`created ${target}: ${res.statistics.components} components, ${res.statistics.pins} pins, ${res.statistics.nets} nets`);
        for (const n of (res.nets ?? []).filter((x) => (x.pins ?? []).length > 1)) lines.push(`  ${n.name}: ${n.pins.join(' ')}`);
        for (const w of res.warnings ?? []) lines.push(`  ! ${w}`);
        if (wantExport) {
          const base = path.basename(target).replace(/\.(esch|json)$/i, '');
          for (const ext of ['svg', 'png', 'pdf']) files.push(path.join(path.dirname(target), `${base}.ai.${ext}`));
          files.push(path.join(path.dirname(target), `${base}.report.md`));
        }
      } else {
        const argv = ['create', target, '--title', args.title ?? 'Sheet_1', '--json'];
        if (args.company) argv.push('--company', String(args.company));
        if (args.rev) argv.push('--rev', String(args.rev));
        if (args.date) argv.push('--date', String(args.date));
        if (args.drawnBy) argv.push('--drawn-by', String(args.drawnBy));
        const res = await runCli(argv, { cwd });
        files.push(target);
        lines.push(`created empty sheet ${target} (frame + title block), ${res?.records ?? '?'} records`);
      }
      return { text: lines.join('\n'), files: [...new Set(files)] };
    },
  },
  {
    name: 'lceda_place_component',
    description: 'Place one component into an existing 嘉立创EDA schematic. PART SOURCE ORDER IS MANDATORY: (1) LCEDA standard library — pass std=<uuid> from lceda_find_component (or symbol=<standard title>); (2) LCSC/EasyEDA product library — pass lcsc=<C-number>; (3) built-in drawn symbols (resistor/capacitor/led/...) ONLY as a last resort when neither library has the part. Do not hand-draw a symbol when a standard-library or LCSC part exists; mixing hand-drawn flags with library parts breaks sheet consistency. Coordinates are sheet units (y grows downward; a fresh A4 sheet is 1160x820). Returns the placed pins so the next call can wire them with lceda_edit_schematic.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic file to modify (.esch/.json).' },
      std: { type: 'string', description: 'LCEDA standard-library uuid from lceda_find_component — preferred source for every part.' },
      symbol: { type: 'string', description: 'Built-in symbol key (resistor/capacitor/led/crystal/header/...) — fallback only; or a standard-library title which is resolved automatically.' },
      lcsc: { type: 'string', description: 'LCSC part number from the LCSC mall library, e.g. C9900042655 — use when the standard library has no suitable part.' },
      ref: { type: 'string', required: true, description: 'Designator, e.g. R1 or U1.' },
      value: { type: 'string', description: 'Value/name shown on the schematic (e.g. 10k, 11.0592MHz).' },
      x: { type: 'number', required: true, description: 'Sheet x of the symbol centre.' },
      y: { type: 'number', required: true, description: 'Sheet y of the symbol centre.' },
      rot: { type: 'number', description: 'Rotation in degrees (multiples of 90). Default 0.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const what = args.std ? String(args.std) : (args.lcsc ? String(args.lcsc) : (args.symbol ? String(args.symbol) : ''));
      if (!what) throw new Error('pass one of: std (uuid), lcsc (part number), or symbol (built-in key or standard title)');
      const argv = ['place', target, what, '--ref', str(args.ref), '--at', `${asNum(args.x, 400)},${asNum(args.y, 400)}`, '--rot', String(asNum(args.rot, 0)), '--json'];
      if (args.value !== undefined) argv.push('--value', String(args.value));
      const res = await runCli(argv, { cwd });
      const pins = (res?.pins ?? []).map((p) => `${p.pin}=${p.name}@${p.x},${p.y}`);
      return {
        text: [
          `placed ${res?.ref ?? args.ref} ${str(res?.value) || str(args.value)} (${what}) at ${asNum(args.x, 400)},${asNum(args.y, 400)} rot ${asNum(args.rot, 0)}`,
          `components in sheet: ${res?.components ?? '?'}`,
          `pins: ${pins.join(', ')}`,
        ].join('\n'),
        files: [],
      };
    },
  },
  {
    name: 'lceda_export_json',
    description: 'Write the LCEDA-importable JSON of a schematic: the exact document format the editor itself saves, so it can be opened with 文件 → 打开 → 嘉立创EDA and then saved into a real project. Use it after building/editing a sheet. With projectDir it also lays out <Dir>/sch/Sheet_1.json (mirroring a real LCEDA project backup) plus a short import note.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic .esch/.json to export.' },
      out: { type: 'string', description: 'Write the JSON to this path (default: <sheet>.json next to the input).' },
      projectDir: { type: 'string', description: 'Also create a project folder with sch/Sheet_1.json inside it.' },
      sheetName: { type: 'string', description: 'Base name for the default output file (e.g. "Sheet_1").' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const argv = ['export', target, '--json'];
      if (args.out) argv.push('-o', await resolvePath(ctx, exec, args.out));
      if (args.projectDir) argv.push('--project', await resolvePath(ctx, exec, args.projectDir));
      if (args.sheetName) argv.push('--sheet-name', String(args.sheetName));
      const res = await runCli(argv, { cwd });
      const lines = [
        `exported ${res.outFile} (${res.components} components, ${res.records} records)`,
      ];
      if (res.projectDir) lines.push(`project folder: ${res.projectDir}/sch/Sheet_1.json`);
      lines.push('立创EDA: 文件 → 打开 → 嘉立创EDA → 选择该 json');
      for (const w of res.warnings ?? []) lines.push(`! ${w}`);
      return { text: lines.join('\n'), files: res.files ?? [] };
    },
  },

  {
    name: 'lceda_read_schematic',
    description: 'Read a 嘉立创EDA (LCEDA standard edition) schematic file or project folder and return its machine-readable content: component/BOM table, per-component pin names and numbers, and the full netlist (which pins are connected to which net, including power/ground names and labelling conflicts). Use this to answer questions about a schematic, or before editing one.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic .esch/.json file, or a project directory containing Sheet_*.json files. Relative paths use the session working directory.' },
      sheet: { type: 'string', description: 'When path is a directory, only read the sheet whose file name contains this text (e.g. "Sheet_1").' },
      detail: { type: 'string', enum: ['summary', 'full'], description: 'summary = BOM + netlist; full (default) also lists every component pin.' },
      ref: { type: 'string', description: 'Only report components whose designator matches this text (e.g. "U1").' },
      net: { type: 'string', description: 'Only report nets whose name matches this text (e.g. "VBUS").' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const res = await runCli(['read', target, '--json'], { cwd });
      const sheets = Array.isArray(res) ? res : [res];
      const wantSheet = args.sheet ? String(args.sheet).toLowerCase() : '';
      const blocks = [];
      for (const s of sheets) {
        if (!s || !s.file) continue;
        if (wantSheet && !path.basename(s.file).toLowerCase().includes(wantSheet)) continue;
        let comps = s.components ?? [];
        let nets = s.nets ?? [];
        if (args.ref) {
          const q = String(args.ref).toLowerCase();
          comps = comps.filter((c) => String(c.ref).toLowerCase().includes(q));
          const keep = new Set(comps.map((c) => c.ref));
          nets = nets.map((n) => ({ ...n, pins: n.pins.filter((p) => keep.has(String(p).split('.')[0])) })).filter((n) => n.pins.length);
        }
        if (args.net) {
          const q = String(args.net).toLowerCase();
          nets = nets.filter((n) => String(n.name).toLowerCase().includes(q) || (n.aliases ?? []).some((a) => String(a).toLowerCase().includes(q)));
          const refs = new Set(nets.flatMap((n) => n.pins.map((p) => String(p).split('.')[0])));
          if (!args.ref) comps = comps.filter((c) => refs.has(c.ref));
        }
        const st = s.statistics ?? {};
        const lines = [
          `# ${path.basename(s.file)}`,
          `器件 ${st.components} | 引脚 ${st.pins} | 网络 ${st.nets}(命名 ${st.namedNets}, 冲突 ${st.conflicts ?? 0}) | 导线 ${st.wires} | 结点 ${st.junctions}`,
          '',
          '## 器件清单',
          ...bomTable(comps),
          '',
        ];
        if ((args.detail ?? 'full') === 'full') {
          lines.push('## 器件引脚');
          for (const c of comps) lines.push(`- **${c.ref}** ${str(c.value)} (${str(c.package)}): ${pinList(c)}`);
          lines.push('');
        }
        lines.push('## 网络表', ...netLines(nets));
        blocks.push(lines.join('\n'));
      }
      if (!blocks.length) throw new Error(`no sheet matched (${args.sheet ?? args.path})`);
      return { text: blocks.join('\n\n---\n\n'), files: [] };
    },
  },
  {
    name: 'lceda_render_schematic',
    description: 'Render a 嘉立创EDA (LCEDA standard edition) schematic to files an AI agent or human can look at: SVG (vector, text-searchable), PNG (raster), PDF (one page per sheet) and a Markdown/JSON report. Returns the written file paths.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic .esch/.json file, or a project directory containing Sheet_*.json files.' },
      outDir: { type: 'string', description: 'Output directory. Defaults to "<sheet>.ai" next to each input file.' },
      formats: { type: 'array', items: { type: 'string', enum: ['svg', 'png', 'pdf', 'report'] }, description: 'Output formats to write. Defaults to all four.' },
      scale: { type: 'number', description: 'PNG/PDF raster scale in pixels per schematic unit (default 4 ≈ 288 DPI on an A4 sheet).' },
      sheet: { type: 'string', description: 'When path is a directory, only convert sheets whose file name contains this text.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const formats = asArray(args.formats);
      const argv = ['convert', target, '--formats', (formats.length ? formats : DEFAULT_FORMATS).join(','), '--scale', String(asNum(args.scale, DEFAULT_SCALE)), '--json'];
      if (args.outDir) argv.push('-o', await resolvePath(ctx, exec, args.outDir));
      const res = await runCli(argv, { cwd });
      const rows = Array.isArray(res) ? res : [];
      const files = [];
      const lines = [];
      for (const r of rows) {
        if (args.sheet && !String(r.sheet).includes(String(args.sheet))) continue;
        const st = r.statistics ?? {};
        lines.push(`## ${r.sheet}`);
        lines.push(`${st.components} components, ${st.pins} pins, ${st.nets} nets${st.conflicts ? `, ${st.conflicts} conflicting` : ''}`);
        for (const [k, p] of Object.entries(r.outputs ?? {})) { files.push(p); lines.push(`- ${k}: ${p}`); }
      }
      if (!lines.length) throw new Error('no sheet converted');
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_project_overview',
    description: 'Summarise a multi-sheet 嘉立创EDA project folder: per-sheet component/pin/net counts, a merged BOM (the same value+package across sheets collapses into one row; duplicate designators are qualified with @Sheet), nets that appear on more than one sheet, and a net-class breakdown (power / ground / reset / clock / differential / bus). Analysis only: it never writes to the sheets.',
    parameters: {
      path: { type: 'string', required: true, description: 'Project folder containing Sheet_*.json (or .esch) files.' },
      outDir: { type: 'string', description: 'Write project.json + project.md into this directory.' },
      render: { type: 'boolean', description: 'Also render every sheet to svg/png/pdf/report (default false).' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const argv = ['project', target, '--json'];
      if (args.outDir) argv.push('-o', await resolvePath(ctx, exec, args.outDir));
      const res = await runCli(argv, { cwd });
      const lines = [`${res.sheets?.length ?? 0} 张图纸, ${res.totals?.components ?? 0} 器件, ${res.totals?.pins ?? 0} 引脚, ${res.totals?.nets ?? 0} 网络`];
      for (const s of res.sheets ?? []) lines.push(`- ${s.title || s.name}: ${s.statistics.components} 器件 / ${s.statistics.nets} 网络 (${String(s.file).split('/').pop()})`);
      if (res.crossSheet?.length) lines.push(`跨图纸同名网络: ${res.crossSheet.map((n) => n.name).slice(0, 15).join(', ')}${res.crossSheet.length > 15 ? ' …' : ''}`);
      const files = [];
      if (args.outDir) {
        const dir = await resolvePath(ctx, exec, args.outDir);
        files.push(`${dir}/project.json`, `${dir}/project.md`);
        lines.push(`写入 ${dir}/project.json 与 project.md`);
      }
      if (asBool(args.render)) {
        const out = args.outDir ? await resolvePath(ctx, exec, args.outDir) : undefined;
        const conv = ['convert', target, '--formats', 'svg,png,pdf,report', '--scale', String(DEFAULT_SCALE), '--json'];
        if (out) conv.push('-o', out);
        const rows = await runCli(conv, { cwd });
        for (const r of Array.isArray(rows) ? rows : []) for (const [k, p] of Object.entries(r.outputs ?? {})) files.push(p);
        lines.push(`已渲染 ${(Array.isArray(rows) ? rows : []).length} 张图纸`);
      }
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_edit_schematic',
    description: 'Edit a 嘉立创EDA (LCEDA standard edition) schematic with structured operations, then validate the result. Every call returns what changed, a netlist diff (which pins moved between nets), and warnings for newly created shorts, dangling wires, unattached labels or duplicate designators. Writes are atomic and keep a .bak copy. Read the sheet first with lceda_read_schematic; use {"op":"describe"} to list editable ids (wires, labels, flags, junctions). Ops: describe | set_value{ref,value} | set_designator{ref,to} | set_attr{ref,key,value} | move{ref,dx,dy}|{ref,x,y} | rotate{ref,angle} (multiples of 90) | duplicate_component{ref,to?,dx?,dy?,value?} | delete_component{ref} | add_wire{points:[[x,y],..]} | add_junction{x,y} | add_net_label{x,y,text,rot?} | add_net_flag{x,y,text,kind?} | delete_element{id} | delete_wires_at{x,y} | move_element{id,dx,dy}. Always dryRun first on destructive edits, and pass preview to eyeball the result as a PNG.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic .esch/.json file to edit.' },
      operations: {
        type: 'array',
        required: true,
        description: 'Ordered list of operation objects; each has an "op" field. A JSON string encoding the array is also accepted.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            op: { type: 'string' }, ref: { type: 'string' }, id: { type: 'string' }, to: { type: 'string' },
            key: { type: 'string' }, value: { type: 'string' }, dx: { type: 'number' }, dy: { type: 'number' },
            x: { type: 'number' }, y: { type: 'number' }, rot: { type: 'number' }, angle: { type: 'number' },
            text: { type: 'string' }, kind: { type: 'string' },
            points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          },
        },
      },
      dryRun: { type: 'boolean', description: 'Validate and report without writing anything (default false).' },
      backup: { type: 'boolean', description: 'Keep a .bak copy of the original when writing in place (default true).' },
      out: { type: 'string', description: 'Write the edited document to this path instead of overwriting the input.' },
      preview: { type: 'string', description: 'Optional PNG path: render the edited sheet there so the result can be inspected.' },
      scale: { type: 'number', description: 'Preview raster scale in pixels per schematic unit (default 2).' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      let ops = args.operations;
      if (typeof ops === 'string') {
        try { ops = JSON.parse(ops); } catch { throw new Error('operations must be a JSON array (or a JSON string that encodes one)'); }
      }
      if (!Array.isArray(ops) || !ops.length) throw new Error('operations must be a non-empty array');
      const argv = ['edit', target, '--ops', JSON.stringify(ops), '--json'];
      if (asBool(args.dryRun, false)) argv.push('--dry-run');
      if (!asBool(args.backup, true)) argv.push('--no-backup');
      if (args.out) argv.push('--out', await resolvePath(ctx, exec, args.out));
      if (args.preview) argv.push('--preview', await resolvePath(ctx, exec, args.preview));
      argv.push('--scale', String(asNum(args.scale, 2)));
      const res = await runCli(argv, { cwd });
      const lines = [
        `${res.file}${res.outFile ? ` -> ${res.outFile}` : ''}${res.dryRun ? ' (dry run)' : ''}`,
        `changed: ${res.changed}`,
        ...(res.changes ?? []).map((c) => `* ${c}`),
        `stats: ${res.summary}`,
        'diff:',
        ...(res.diff ?? []).map((d) => `  ${d}`),
      ];
      if (res.warnings?.length) {
        lines.push('warnings:');
        for (const w of res.warnings) lines.push(`  ! ${w}`);
      }
      if (res.backupFile) lines.push(`backup: ${res.backupFile}`);
      if (res.preview) lines.push(`preview: ${res.preview}`);
      const files = [res.outFile, res.backupFile, res.preview].filter(Boolean);
      return { text: lines.join('\n'), files, changed: res.changed === true };
    },
  },
  {
    name: 'lceda_pcb_read',
    description: 'Read a 嘉立创EDA PCB board or footprint document (.json/.epcb saved from the standard edition) and report what is on it: layers, footprints with package and position, pad/track/via/copper-area counts, board outline size, nets and the DRC rules stored in the file. Use this before editing or routing a board.',
    parameters: {
      path: { type: 'string', required: true, description: 'PCB .json/.epcb file, or a directory of them.' },
      ref: { type: 'string', description: 'Only report the footprint whose designator matches this text (e.g. "U1").' },
      net: { type: 'string', description: 'Only report nets whose name matches this text (e.g. "GND").' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const res = await runCli(['pcb', 'read', target, '--json'], { cwd });
      const rows = Array.isArray(res) ? res : [res];
      const lines = [];
      const files = [];
      for (const r of rows) {
        const c = r.counts ?? {};
        lines.push(`## ${r.file}`);
        lines.push(`${r.kind}${r.package ? ` (${r.package})` : ''}: ${c.footprints ?? 0} footprints, ${c.pads ?? 0} pads, ${c.tracks ?? 0} tracks, ${c.vias ?? 0} vias, ${c.copperAreas ?? 0} copper areas`);
        if (r.board) lines.push(`board ${r.board.widthMm} x ${r.board.heightMm} mm`);
        const netRows = r.nets ?? [];
        if (netRows.length) lines.push(`nets: ${netRows.map((n) => (typeof n === 'string' ? n : n.name)).slice(0, 40).join(', ')}`);
        let fps = r.footprints ?? [];
        if (args.ref) fps = fps.filter((f) => String(f.name).includes(String(args.ref)));
        for (const fp of fps) lines.push(`- ${fp.name || '(unnamed)'} ${fp.package ?? ''} @${fp.x},${fp.y} rot${fp.rotation ?? 0} pads=${fp.pads ?? 0}`);
        const drc = r.drc ?? {};
        if (drc.trackWidth) lines.push(`DRC: width ${drc.trackWidth}mm clearance ${drc.clearance}mm via ${drc.viaHoleDiameter}/${drc.viaHoleD}mm`);
      }
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_pcb_render',
    description: 'Render a 嘉立创EDA PCB to files a human or agent can look at: SVG (vector), PNG (raster), PDF and a Markdown/JSON report, with copper, pads, vias, silkscreen and drill drawn per layer. Use --view bottom for the bottom side. Returns the written file paths.',
    parameters: {
      path: { type: 'string', required: true, description: 'PCB .json/.epcb file, or a directory of them.' },
      outDir: { type: 'string', description: 'Output directory. Defaults to "<board>.ai" next to the input.' },
      formats: { type: 'array', items: { type: 'string', enum: ['svg', 'png', 'pdf', 'report'] }, description: 'Formats to write. Defaults to all four.' },
      scale: { type: 'number', description: 'PNG/PDF pixels per board unit (1 unit = 0.254 mm); default 4.' },
      view: { type: 'string', enum: ['top', 'bottom'], description: 'Which side to draw. Defaults to top.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const target = await resolvePath(ctx, exec, args.path);
      const argv = ['pcb', 'render', target, '--formats', (asArray(args.formats).length ? asArray(args.formats) : ['svg', 'png', 'pdf', 'report']).join(','), '--scale', String(asNum(args.scale, 4)), '--json'];
      if (args.view) argv.push('--view', String(args.view));
      if (args.outDir) argv.push('-o', await resolvePath(ctx, exec, args.outDir));
      const res = await runCli(argv, { cwd });
      const rows = Array.isArray(res) ? res : [res];
      const files = [];
      const lines = [];
      for (const r of rows) {
        lines.push(`## ${r.file ?? r.input}${r.view ? ` (${r.view})` : ''}`);
        for (const [k, v] of Object.entries(r.outputs ?? {})) { files.push(v); lines.push(`- ${k}: ${v}`); }
      }
      return { text: lines.join('\n') || 'nothing rendered', files };
    },
  },
  {
    name: 'lceda_pcb_build',
    description: 'Build a PCB from a 嘉立创EDA schematic: fetch a footprint for every component from the standard library, place them (rule-based clustering by default), carry the netlist onto the pads and write a board document the editor can open. Optionally continue the whole pipeline in one call: autoroute, pour a net, stitch vias and export Gerber/BOM. Returns the board path, the placement quality (ratsnest length, overlaps) and per-stage results.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic .esch/.json to build from.' },
      outPath: { type: 'string', required: true, description: 'Where to write the board .json.' },
      placement: { type: 'string', enum: ['rule', 'shelf'], description: 'Placement strategy: "rule" (cluster + search, default) or "shelf" (simple rows).' },
      footprint: { type: 'array', items: { type: 'string' }, description: 'Footprint overrides as "REF=name", e.g. "U1=STC89C52RC-DIP-40". Use it when the library search picks a package you do not want.' },
      boardWidthMm: { type: 'number', description: 'Target board width in mm (drives the placement search).' },
      route: { type: 'boolean', description: 'After placing, autoroute the board.' },
      pourNet: { type: 'string', description: 'After routing, pour this net (e.g. "GND"). Empty string skips pouring.' },
      stitchVias: { type: 'boolean', description: 'After pouring, add stitching vias to the poured net.' },
      exportGerber: { type: 'boolean', description: 'Also export Gerber + drill into "<outPath>.gerber/".' },
      exportBom: { type: 'boolean', description: 'Also export BOM + pick-and-place into "<outPath>.bom/".' },
      sheetTitle: { type: 'string', description: 'Board title stored in the document.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const sch = await resolvePath(ctx, exec, args.path);
      const out = await resolvePath(ctx, exec, args.outPath);
      const lines = [];
      const files = [];
      const argv = ['pcb', 'from-sch', sch, '-o', out, '--place', String(args.placement ?? 'rule'), '--json'];
      if (args.sheetTitle) argv.push('--title', String(args.sheetTitle));
      if (asNum(args.boardWidthMm, 0) > 0) argv.push('--board-width', String(asNum(args.boardWidthMm, 0)));
      for (const f of asArray(args.footprint)) argv.push('--footprint', String(f));
      const built = await runCli(argv, { cwd });
      files.push(out);
      lines.push(`board: ${out}`);
      lines.push(`${built.stats?.components ?? '?'} components, ${built.stats?.pads ?? '?'} pads, ${built.stats?.nets ?? '?'} nets, board ${built.board?.widthMm} x ${built.board?.heightMm} mm`);
      if (built.quality) lines.push(`placement: ratsnest ${built.quality.ratsnestMm} mm, overlaps ${built.quality.overlaps}, outside ${built.quality.outside}`);
      for (const w of built.warnings ?? []) lines.push(`! ${w}`);

      let current = out;
      if (args.route) {
        const routed = `${out.replace(/\.json$/i, '')}-routed.json`;
        const r = await runCli(['pcb', 'route', current, '-o', routed, '--json'], { cwd });
        current = routed;
        files.push(routed);
        lines.push(`route: ${r.stats?.routed}/${r.stats?.nets} nets, ${r.stats?.tracks} tracks, ${r.stats?.vias} vias, ${r.stats?.lengthMm} mm, ${r.check?.count ?? 0} clearance issues`);
      }
      if (args.pourNet) {
        const poured = `${out.replace(/\.json$/i, '')}-poured.json`;
        const r = await runCli(['pcb', 'pour', current, '-o', poured, '--net', String(args.pourNet), '--json'], { cwd });
        current = poured;
        files.push(poured);
        lines.push(`pour: ${args.pourNet} ${r.pour?.areaMm2} mm2 in ${r.pour?.polygons} polygons, ${r.check?.count ?? 0} violations`);
      }
      if (args.stitchVias) {
        const stitched = `${out.replace(/\.json$/i, '')}-stitched.json`;
        const net = String(args.pourNet || 'GND');
        const r = await runCli(['pcb', 'via', current, '-o', stitched, '--net', net, '--json'], { cwd });
        current = stitched;
        files.push(stitched);
        lines.push(`stitch: ${r.stats?.placed} vias on ${net}, ${r.check?.count ?? 0} violations`);
      }
      if (args.exportGerber) {
        const dir = `${out.replace(/\.json$/i, '')}.gerber`;
        const r = await runCli(['pcb', 'gerber', current, '-o', dir, '--manifest', '--json'], { cwd });
        lines.push(`gerber: ${(r.files ?? []).length} files in ${dir} (self check ${r.check?.ok ? 'ok' : 'failed'})`);
        for (const f of r.files ?? []) files.push(`${dir}/${f}`);
      }
      if (args.exportBom) {
        const dir = `${out.replace(/\.json$/i, '')}.bom`;
        const r = await runCli(['pcb', 'bom', current, '-o', dir, '--sch', sch, '--json'], { cwd });
        lines.push(`bom: ${r.stats?.lines} lines / ${r.stats?.parts} parts, placement ${r.stats?.placements} in ${dir}`);
        for (const f of r.files ?? []) files.push(`${dir}/${f}`);
      }
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_pcb_route',
    description: 'Autoroute a 嘉立创EDA PCB with a two-layer grid maze router: it builds a raster of the board, blocks foreign copper, the board edge and anything already routed, connects each net pad-to-pad in MST order with A*, and drops a via where a track changes layer. ROUTING RULES (check the result against them and fix by hand where the grid router cannot comply): signal tracks 10 mil (0.254 mm), power tracks 20-30 mil (0.5-0.762 mm, wider for higher current); no 90-degree corners — chamfer every bend to 45 degrees; USB D+/D- routed as a tight pair of equal length on one layer; never run two tracks directly on top of each other on opposite layers (capacitive coupling); route the hardest nets first (clock, USB, high-speed, power) and the simple GPIO fan-out last. Returns routed/failed nets, track and via counts and the copper length.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json to route.' },
      outPath: { type: 'string', required: true, description: 'Where to write the routed board.' },
      cell: { type: 'number', description: 'Routing grid cell in board units (1 unit = 0.254 mm); default 2 (0.508 mm). Smaller finds more paths, slower.' },
      clearance: { type: 'number', description: 'Clearance in board units; defaults to the board DRC value.' },
      width: { type: 'number', description: 'Track width in board units; defaults to the board DRC value.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const out = await resolvePath(ctx, exec, args.outPath);
      const argv = ['pcb', 'route', board, '-o', out, '--json'];
      for (const [flag, value] of [['--cell', args.cell], ['--clearance', args.clearance], ['--width', args.width]]) {
        if (asNum(value, 0) > 0) argv.push(flag, String(asNum(value, 0)));
      }
      const r = await runCli(argv, { cwd });
      const lines = [
        `routed: ${out}`,
        `${r.stats?.routed}/${r.stats?.nets} nets, ${r.stats?.tracks} tracks, ${r.stats?.vias} vias, ${r.stats?.lengthMm} mm`,
        `self check: ${r.check?.count ? `${r.check.count} clearance issues` : 'clean'}`,
      ];
      for (const f of r.failed ?? []) lines.push(`! unrouted ${f.net} ${f.from ?? ''}${f.to ? ` -> ${f.to}` : ''}`);
      return { text: lines.join('\n'), files: [out] };
    },
  },
  {
    name: 'lceda_pcb_legalize',
    description: 'Force every track segment of a 嘉立创EDA PCB onto the 0/45/90/135 degree grid that real LCEDA boards are drawn on. A grid router lands tracks on pad centres that sit off the routing grid, which leaves short segments at arbitrary angles (8 deg, 153 deg, ...); a real board never shows those, it uses a 1-2 mm 45-degree chamfer at every bend (measured median 1.19 mm on a reference production board). Any illegal segment is split into an orthogonal run plus a 45-degree run. Run this after lceda_pcb_route and after any hand-added copper, then confirm the reported angle histogram contains only 0/45/90/135.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json to legalize.' },
      outPath: { type: 'string', required: true, description: 'Where to write the legalized board.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const out = await resolvePath(ctx, exec, args.outPath);
      const r = await runCli(['pcb', 'legalize', board, '-o', out, '--json'], { cwd });
      const dist = Object.entries(r?.after ?? {}).sort((a, b) => Number(a[0]) - Number(b[0])).map(([a, n]) => `${a}°:${n}`).join('  ');
      const illegal = r?.illegal ?? [];
      return {
        text: [
          `legalized: ${out}`,
          `${r?.fixed ?? 0} tracks split into 45-degree polylines`,
          `angles: ${dist}`,
          illegal.length ? `! still illegal: ${illegal.map(([a, n]) => `${a}deg x${n}`).join(' ')}` : 'all segments on the 0/45/90/135 grid',
        ].join('\n'),
        files: [out],
      };
    },
  },
  {
    name: 'lceda_pcb_pour',
    description: 'Pour copper on a 嘉立创EDA PCB: rasterise the board area, clear everything the net may not touch plus the clearance ring, keep four thermal spokes through a same-net pad so it stays connected without becoming a heat sink, drop copper islands that touch no pad of the net, then trace the result into polygon outlines and write COPPERAREA records. Self-checks that no pad of another net ends up inside the copper.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json to pour.' },
      outPath: { type: 'string', required: true, description: 'Where to write the poured board.' },
      net: { type: 'string', description: 'Net to pour. Defaults to ground if the board has one, else the widest rail.' },
      layer: { type: 'number', description: 'Layer id to pour on: 1 top (default), 2 bottom.' },
      cell: { type: 'number', description: 'Raster cell in board units; default 2 (0.508 mm).' },
      clearance: { type: 'number', description: 'Clearance in board units; defaults to the board DRC value.' },
      thermal: { type: 'boolean', description: 'Thermal spokes on same-net pads. Default true.' },
      keepIsland: { type: 'boolean', description: 'Keep the largest copper island even when it touches no pad. Default false.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const out = await resolvePath(ctx, exec, args.outPath);
      const argv = ['pcb', 'pour', board, '-o', out, '--json'];
      if (args.net) argv.push('--net', String(args.net));
      if (asNum(args.layer, 0) > 0) argv.push('--layer', String(asNum(args.layer, 0)));
      if (asNum(args.cell, 0) > 0) argv.push('--cell', String(asNum(args.cell, 0)));
      if (asNum(args.clearance, 0) > 0) argv.push('--clearance', String(asNum(args.clearance, 0)));
      if (args.thermal === false) argv.push('--no-thermal');
      if (args.keepIsland === true) argv.push('--keep-island');
      const r = await runCli(argv, { cwd });
      return {
        text: [
          `poured: ${out}`,
          `net ${r.net}: ${r.pour?.areaMm2} mm2, ${r.pour?.polygons} polygons, thermal ${r.pour?.thermal ? 'on' : 'off'}, islands removed ${r.pour?.removedIslands}`,
          `self check: ${r.check?.count ? `${r.check.count} foreign pads inside the copper` : 'clean'}`,
        ].join('\n'),
        files: [out],
      };
    },
  },
  {
    name: 'lceda_pcb_via',
    description: 'Place stitching vias inside a copper pour on a 嘉立创EDA PCB: a lattice of through vias ties the poured net to the other layer, skipping cells without solid copper around them and keeping the clearance measured from the via edge against copper on every layer. Reports the via geometry (pad, drill, annular ring) and checks clearance and hole-to-hole spacing.',
    parameters: {
      path: { type: 'string', required: true, description: 'Poured board .json.' },
      outPath: { type: 'string', required: true, description: 'Where to write the board with stitching vias.' },
      net: { type: 'string', description: 'Net to stitch (defaults to the pour net, ground if present).' },
      spacingMm: { type: 'number', description: 'Lattice pitch in mm; default 5.' },
      edgeMm: { type: 'number', description: 'How far a via must stay inside solid copper, in mm; default 1.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const out = await resolvePath(ctx, exec, args.outPath);
      const argv = ['pcb', 'via', board, '-o', out, '--json'];
      if (args.net) argv.push('--net', String(args.net));
      if (asNum(args.spacingMm, 0) > 0) argv.push('--spacing', String(asNum(args.spacingMm, 0)));
      if (asNum(args.edgeMm, 0) > 0) argv.push('--edge', String(asNum(args.edgeMm, 0)));
      const r = await runCli(argv, { cwd });
      return {
        text: [
          `stitched: ${out}`,
          `${r.stats?.placed} vias on ${r.net}, pad ${r.stats?.diameterMm} mm / drill ${r.stats?.drillMm} mm / ring ${r.stats?.annularRingMm} mm`,
          `self check: ${r.check?.count ? `${r.check.count} violations` : 'clearance and hole-to-hole clean'}`,
        ].join('\n'),
        files: [out],
      };
    },
  },
  {
    name: 'lceda_pcb_drc',
    description: 'Run a design rule check on a 嘉立创EDA PCB: track width, clearance (track/track, track/pad, pad/pad, via) on the same layer for different nets, via annular ring, hole-to-hole spacing (vias, through-hole pads and mounting holes together), copper-to-board-edge distance, silkscreen over a pad, and connectivity (each net\'s copper is grouped and a net whose pads end up in separate groups is reported). Rules come from the board file with per-net overrides. Returns the violations and can write a Markdown report.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json to check.' },
      checks: { type: 'array', items: { type: 'string', enum: ['track-width', 'clearance', 'via-ring', 'hole-to-hole', 'edge-clearance', 'silk-over-pad', 'unconnected'] }, description: 'Only run these checks. Defaults to all of them.' },
      outPath: { type: 'string', description: 'Also write a Markdown report here.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      // --no-fail: a board with violations must still come back as a report
      const argv = ['pcb', 'drc', board, '--json', '--no-fail'];
      const checks = asArray(args.checks);
      if (checks.length) argv.push('--checks', checks.join(','));
      const files = [];
      if (args.outPath) {
        const report = await resolvePath(ctx, exec, args.outPath);
        argv.push('-o', report);
        files.push(report);
      }
      const r = await runCli(argv, { cwd });
      const rows = Array.isArray(r.files) ? r.files : [r];
      const lines = [];
      for (const row of rows) {
        lines.push(`## ${row.file}`);
        lines.push(`${row.ok ? 'PASS' : 'FAIL'} — ${row.summary}${Object.keys(row.counts ?? {}).length ? ` (${Object.entries(row.counts).map(([k, v]) => `${k}:${v}`).join(', ')})` : ''}`);
      }
      if (args.outPath) lines.push(`report: ${files[0]}`);
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_pcb_gerber',
    description: 'Export fabrication data for a 嘉立创EDA PCB: Gerber (RS-274X) for top/bottom copper, silkscreen, solder mask and the board outline, plus an Excellon drill file (plated holes; a separate NPTH file when mounting holes exist). Silkscreen text is drawn from a built-in stroke font because the editor stores text without strokes. Coordinates use the Gerber convention (origin at the board bottom-left corner, Y up, millimetres). Self-checks flash counts and positions, stroke counts, aperture definitions, drill hits and outline size.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json to export.' },
      outDir: { type: 'string', required: true, description: 'Directory to write the files into.' },
      name: { type: 'string', description: 'Base file name; defaults to the board file name.' },
      manifest: { type: 'boolean', description: 'Also write gerber.manifest.json listing the files and the self-check result.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const dir = await resolvePath(ctx, exec, args.outDir);
      const argv = ['pcb', 'gerber', board, '-o', dir, '--json'];
      if (args.name) argv.push('--name', String(args.name));
      if (args.manifest) argv.push('--manifest');
      const r = await runCli(argv, { cwd });
      const files = (r.files ?? []).map((f) => `${dir}/${f}`);
      const lines = [`exported ${files.length} files to ${dir}`, ...(r.files ?? [])];
      for (const c of r.check?.checks ?? []) lines.push(`${c.name}: ${c.expected} -> ${c.actual}`);
      lines.push(`self check: ${r.check?.ok ? 'all consistent' : r.check?.problems?.join('; ')}`);
      return { text: lines.join('\n'), files };
    },
  },
  {
    name: 'lceda_pcb_bom',
    description: 'Export a bill of materials and a pick-and-place file for a 嘉立创EDA PCB. Parts collapse into one BOM line when value, package, LCSC number and manufacturer part match. Passing the schematic fills the LCSC part number, supplier, manufacturer and description through the bind_sch_id link the board carries. The placement file uses the same assembly frame as the Gerber export. Writes CSV, and an XLSX workbook with BOM and CPL sheets.',
    parameters: {
      path: { type: 'string', required: true, description: 'Board .json.' },
      outDir: { type: 'string', required: true, description: 'Directory to write the files into.' },
      schPath: { type: 'string', description: 'Schematic the board was built from, to enrich LCSC/supplier data.' },
      name: { type: 'string', description: 'Base file name; defaults to the board file name.' },
      xlsx: { type: 'boolean', description: 'Write the XLSX workbook as well. Default true.' },
    },
    async execute(args, ctx, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const board = await resolvePath(ctx, exec, args.path);
      const dir = await resolvePath(ctx, exec, args.outDir);
      const argv = ['pcb', 'bom', board, '-o', dir, '--json'];
      if (args.schPath) argv.push('--sch', await resolvePath(ctx, exec, args.schPath));
      if (args.name) argv.push('--name', String(args.name));
      if (args.xlsx === false) argv.push('--no-xlsx');
      const r = await runCli(argv, { cwd });
      const files = (r.files ?? []).map((f) => `${dir}/${f}`);
      const lines = [
        `${r.stats?.lines} BOM lines covering ${r.stats?.parts} parts, ${r.stats?.placements} placements (top ${r.stats?.top} / bottom ${r.stats?.bottom})`,
        `${r.stats?.withLcsc} lines carry an LCSC part number`,
        `files: ${(r.files ?? []).join(', ')}`,
        `self check: ${r.check?.ok ? 'every part appears exactly once' : r.check?.problems?.join('; ')}`,
      ];
      for (const row of (r.bom ?? []).slice(0, 15)) lines.push(`${row.item}. x${row.qty} ${row.references} — ${row.value} ${row.package}${row.lcsc ? ` (${row.lcsc})` : ''}`);
      return { text: lines.join('\n'), files };
    },
  },
];

/** Exposed for schema tests: the tool definitions registered by apply(). */
export const tools = TOOLS;

export function apply(ctx) {
  for (const tool of TOOLS) {
    ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: compileParameters(tool.parameters),
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'files'],
          properties: {
            text: { type: 'string' },
            files: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const value = await tool.execute(args, ctx, exec);
        return { text: value.text, files: value.files ?? [] };
      },
    });
  }
}
