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
    description: 'Create a new 嘉立创EDA schematic sheet (A4 frame + title block), optionally building the whole circuit in one call from a declarative spec. The spec is { components:[{symbol|lcsc,ref,value,x,y,rot}], wires:[{from:"U1.19",to:"Y1.1"}|{points:[[x,y],...]}], labels:[{text,at,anchor}], flags:[{text,kind,at,rot}], junctions:[{at}], texts:[{text,at,size,color}] } where any "at"/"from"/"to" can be a pin reference like "U1.9" or a coordinate [x,y]. Net labels and power flags placed on pins connect them, and the call returns the netlist it built so mistakes are visible immediately. Optionally exports svg/png/pdf/report.',
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
    description: 'Place one component into an existing 嘉立创EDA schematic: a built-in symbol key from lceda_find_component, or a real LCSC part number (e.g. C9900042655) whose symbol is fetched from the online library. Coordinates are sheet units (y grows downward; a fresh A4 sheet is 1160x820). Returns the placed pins so the next call can wire them with lceda_edit_schematic.',
    parameters: {
      path: { type: 'string', required: true, description: 'Schematic file to modify (.esch/.json).' },
      symbol: { type: 'string', description: 'Built-in symbol key, e.g. stc89c52rc, resistor, capacitor, crystal, switch, led, header.' },
      lcsc: { type: 'string', description: 'LCSC part number to fetch instead of a built-in symbol, e.g. C9900042655.' },
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
