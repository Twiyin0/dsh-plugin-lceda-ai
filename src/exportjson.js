// Export a schematic as the JSON document the LCEDA desktop editor opens directly
// (文件 → 打开 → 嘉立创EDA → 选择 .json), plus an optional project folder layout
// that mirrors the editor's own backup (`<Project>/sch/Sheet_1.json`).
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseDocument } from './parser.js';

/** Canonicalise a schematic document into what LCEDA itself writes. */
export function toLcedaJson(input) {
  const doc = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input));
  if (!doc || !doc.head) throw new Error('not a schematic document (missing "head")');
  if (String(doc.head.docType) !== '1') throw new Error(`head.docType must be "1" (schematic), got ${doc.head.docType}`);

  const head = { ...doc.head };
  head.docType = '1';
  head.editorVersion = String(head.editorVersion ?? '6.5.51');
  head.hasIdFlag = head.hasIdFlag === undefined ? true : head.hasIdFlag;
  head.newgId = head.newgId === undefined ? true : head.newgId;
  if (!head.uuid) head.uuid = randomUuid();
  if (head.c_para === undefined) head.c_para = { 'Prefix Start': '1' };

  const shape = Array.isArray(doc.shape) ? doc.shape.map((s) => String(s)) : [];
  if (!shape.length) throw new Error('document has no shapes');
  if (!shape.some((s) => s.startsWith('LIB~0~'))) {
    // LCEDA always keeps a frame symbol first; a sheet without one still opens,
    // but warn so the caller can decide.
    // (handled by the caller via warnings)
  }

  const bb = doc.BBox ?? {};
  const BBox = {
    x: Number(bb.x ?? 0),
    y: Number(bb.y ?? 0),
    width: Number(bb.width ?? 1000),
    height: Number(bb.height ?? 800),
  };

  return JSON.stringify({
    head,
    canvas: doc.canvas ?? 'CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0',
    shape,
    BBox,
    colors: doc.colors ?? {},
  });
}

function randomUuid() {
  let s = '';
  for (let i = 0; i < 4; i++) s += Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  return s;
}

/**
 * Write the importable JSON next to (or instead of) the source file.
 * @param {string} input schematic .esch/.json path
 * @param {object} opts { out, projectDir, sheetName, title }
 */
export async function exportJson(input, opts = {}) {
  const raw = await fs.readFile(input, 'utf8');
  const json = toLcedaJson(raw);
  const doc = parseDocument(JSON.parse(json));
  const base = path.basename(input).replace(/\.(esch|json)$/i, '');
  const sheetName = opts.sheetName ?? (base === 'Sheet' ? 'Sheet_1' : `${base}`);
  const outFile = opts.out
    ? path.resolve(opts.out)
    : path.resolve(path.dirname(input), `${sheetName}.json`);

  const result = { input, outFile, sheetName, components: 0, records: 0, warnings: [] };
  result.records = doc.shapes.length;
  result.components = doc.components.filter((c) => !c.isFrame).length;
  if (!doc.components.some((c) => c.isFrame)) result.warnings.push('图纸没有图框(LIB frame),立创EDA 里会没有边框和标题栏');

  await fs.mkdir(path.dirname(outFile), { recursive: true });
  const tmp = `${outFile}.tmp-${process.pid}`;
  await fs.writeFile(tmp, json, 'utf8');
  await fs.rename(tmp, outFile);
  result.files = [outFile];

  if (opts.projectDir) {
    const root = path.resolve(opts.projectDir);
    const projectName = path.basename(root);
    const sheetPath = path.join(root, 'sch', 'Sheet_1.json');
    await fs.mkdir(path.join(root, 'sch'), { recursive: true });
    await fs.writeFile(sheetPath, json, 'utf8');
    // a tiny helper so the folder is self-explanatory when opened in Finder
    await fs.writeFile(path.join(root, '如何导入立创EDA.txt'), [
      `${projectName} — 由 lceda-ai 生成`,
      '',
      '在立创EDA(标准版)里:',
      '  1. 顶部菜单 → 打开 → 嘉立创EDA',
      '  2. 选择本文件夹里 sch/Sheet_1.json',
      '  3. 打开后即可另存到自己的工程',
      '',
      `原理图文件: sch/Sheet_1.json`,
      `生成时间: ${new Date().toISOString()}`,
      '',
    ].join('\n'), 'utf8');
    result.projectDir = root;
    result.files.push(sheetPath, path.join(root, '如何导入立创EDA.txt'));
  }
  return result;
}
