---
name: lceda-schematic
description: Work with 嘉立创EDA (LCEDA standard edition) schematics on this machine — read and explain a sheet, extract its netlist/BOM, render SVG/PNG/PDF for visual review, author a new schematic, edit an existing one with validation, and export JSON the editor can open. Use whenever a task mentions 立创EDA/嘉立创EDA/.esch/Sheet_1.json, a schematic-to-PDF/report conversion, or building a circuit sheet (minimal system, breakout, module) that must land in LCEDA.
---

# 立创EDA 原理图工具链(本机)

仓库根目录:`/Volumes/UMIS1TB/Project/node/lcedaParser`。所有能力都走同一个 CLI,
Harness 里还注册了 7 个工具(前缀 `lceda_`)。**优先用工具**,批量/脚本化时才用 CLI。

## 决策表

| 目标 | 做法 |
|---|---|
| 看懂一张图 / 回答“这个引脚接哪” | `lceda_read_schematic`(`detail: summary`)再按需 `full` |
| 给人/AI 一份可看的图 | `lceda_render_schematic`(png+pdf+report) |
| 从零画一张 | `lceda_create_schematic` + 一份 spec(可一次画完) |
| 不想算坐标 | spec 加 `"layout":"auto"` 或传 `autoLayout:true`(自动摆放 + 正交避障走线) |
| 整个工程(多图纸) | `lceda_project_overview`(合并 BOM、跨图纸网络、网络分类) |
| 加一个器件 | `lceda_place_component`(标准库标题 / uuid / LCSC 编号) |
| 改已有图 | `lceda_edit_schematic`(先 `{"op":"describe"}`,再 `dryRun`) |
| 交给立创EDA 打开 | `lceda_export_json` |
| 找器件 | `lceda_find_component` |

## 取器件:标准库优先

1. **立创EDA 标准库**(编辑器“元件库”同一套接口)——默认就该用它,如 `R_0603_US`、`C_0603_US`、
   `HDR-M-2.54_1x5`、`TS-1187A-B-A-B`、`STC89C52`。
2. **立创商城**(LCSC 编号,如 `C25804`)——标准库没有时用。
3. **内置符号**——离线兜底(自制图形,和编辑器画法不完全一致,仅应急)。

同名器件是用户共建的,**质量参差**:工具会用数据手册引脚表打分(`PINOUT_REFERENCES`),
把 29/30/31 号脚写成 `P4.4/P4.5/P4.6` 的那批符号会被丢弃。选不到合格符号时再退回内置。

## 标准流程

```bash
cd /Volumes/UMIS1TB/Project/node/lcedaParser
node bin/lceda-ai.js read  <sheet> --json          # 结构 + 网络表
node bin/lceda-ai.js convert <sheet> -o out --formats svg,png,pdf,report
node bin/lceda-ai.js export <sheet> --project ./MyProject   # 可导入的 json
node bin/lceda-ai.js build  spec.json -o out.esch --export   # 声明式建图
node bin/lceda-ai.js edit   <sheet> --ops '[{"op":"set_value","ref":"C1","value":"22pF"}]' --dry-run
```

spec 里 `at`/`from`/`to` 可以写引脚引用(`"U1.9"`),坐标一定要**先探测引脚再算**:
`SchematicBuilder.pins()` 给出真实引脚位置,把结果写进 spec,这样换符号也不会错位。

## 取器件与缓存

- 器件优先走**立创EDA 标准库**(`lceda_find_component`),没有再走立创商城编号,最后才是内置符号。
- 搜索与器件文档会落盘缓存(`~/.cache/lceda-ai`);要强制刷新加 `--no-cache` / 设 `LCEDA_NO_CACHE=1`。
- 符号会按内置引脚表校验:标准库里同名器件常有错脚(例如把 29/30/31 写成 `P4.4/P4.5/P4.6`),
  校验会自动挑正确的那个;放 `NE555`/`74HC595`/`ATmega328P`/`AMS1117`/`CH340G` 也会校验。

## 自动布局

`"layout":"auto"` 时:引脚最多的器件居中作锚点,其余按**网表连到锚点哪一侧**分左右两列(沿网表传递),
摆放避开已占区域;`{from,to}` 连线沿引脚朝向外伸再折线,避开器件本体、其他引脚与已布导线。
构建后会有**短路自检**:自动走线若把两个网络并在了一起会告警,此时给这些 wire 显式写 `points`。
手写 `x/y` 永远优先,可以“关键器件手工放 + 其余自动”。

## 跨图纸连接(容易做错)

**同名网络 ≠ 连通**,取决于用哪种元素:

| 元素 | 写法 | 作用域 |
|---|---|---|
| 网络标签 Net Label | `labels: [{text, at}]` | **仅本图纸** |
| 电源/地标志 NetFlag | `flags: [{text, kind, at}]` | **全局** |
| **网络端口 Net Port** | `ports: [{text, at, rot}]` | **跨图纸** |

要跨图纸连接必须用 `ports`;用 `labels` 画多图纸会得到“看起来同名、其实没连上”的图,
`project` 会把它列进“⚠️ 同名但未跨图纸连通”并提示改用 Net Port。

## 必须遵守的规矩

- **先 `dryRun`** 再写盘;每次编辑都会返回网络表 diff 与告警(悬空导线、未生效标签、单引脚网络)。
- 写盘自动留 `.bak`;**不要**删除用户的 `.bak`。
- 编辑后重跑 `read` 复核网络表,别只看渲染图。
- 引脚号与名称以数据手册为准(本项目已有 STC89C52RC DIP-40 参照表),库符号不一定对。
- 电源/地标志的**文本才是网络名**;`GND` 和 `AGND` 是两个网络。

## 已知坑

- 环境里若有 `ELECTRON_RUN_AS_NODE=1`,启动立创EDA 会被当 Node 跑;需要
  `env -u ELECTRON_RUN_AS_NODE` 才会正常启动(仅在需要真机验证时用)。
- Harness 插件通过**子进程**调用 CLI,所以改了 `src/` 后不用重载插件;改了 `plugin/index.js` 才需要重载。
- 渲染是“忠实描边”:编辑器里画得丑的库符号,渲染出来一样丑,不是渲染 bug。
- 总线记录**只读不写**(没有真实样本);跨图纸连通性按 Net Port / NetFlag / NetLabel 的作用域判断,不靠同名猜。
- 版式(器件间距、标签避让)需要按符号尺寸微调;引脚坐标可从 `place` 的返回值直接读。
