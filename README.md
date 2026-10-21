# dsh-plugin-lceda-ai

DeepSeek Harness 插件 + 命令行工具链,版本 `0.0.1-beta`,协议 GPL-3.0。

让 AI Agent(以及命令行脚本)**看懂、渲染、创作、编辑、导出**嘉立创EDA(标准版)原理图,并且使用编辑器自己的器件库。

- 输入:立创EDA 标准版原理图(`.esch` / `Sheet_1.json`,都是同一份 JSON)
- 输出:SVG / PNG / PDF(文本可搜索的矢量 + 位图)、BOM 与网络表报告(Markdown/JSON)、**可直接被立创EDA 打开的 JSON**
- 也能反向:从零创建图纸、放置真实库器件、按引脚引用连线、结构化编辑并校验

> 非官方工具:解析规则来自对标准版文件格式的实测与比对,与立创EDA 官方无关。

![STC89C52RC 最小系统](examples/stc89c52rc-minimal-v3.ai.png)

## 为什么需要它

原理图 `.esch` 是“记录串”的集合(`LIB~...#@$P~...^^...`),人和 AI 都很难直接读。这个工具把它变成
**结构化模型 → 网络表 → 可读图/报告**,并且能反向往回写,还能把写出的文件交给真实编辑器打开验证。

## 特性

| 能力 | 说明 |
|---|---|
| 查看/理解 | 器件清单、逐引脚表、网络表(含命名冲突检测)、导线/结点/标签统计 |
| 渲染 | SVG(文本可搜索)、PNG、PDF;忠实描边,颜色/线宽/字体按记录还原 |
| 创作 | 新建 A4 图框+标题栏、放器件、按引脚引用连线、加标签/电源地/结点/文字 |
| 编辑 | 改值/位号/属性、移动、旋转、复制、删除、增删导线/结点/标签/标志;带网络表 diff 与告警、`.bak` 备份 |
| 导出 | 立创EDA 可直接打开的 JSON(与编辑器落盘逐键一致)、工程目录形式 |
| 器件库 | **立创EDA 标准库 → 立创商城 → 内置符号** 三级择优,并用手册引脚表校验符号 |
| Agent 集成 | Harness 插件注册 7 个 `lceda_*` 工具;子进程调用 CLI,改代码即生效 |

## 安装

```bash
npm install          # Node.js >= 20
npm test             # 36 个单元测试
npm run verify       # 端到端自检(含标准库/商城联网检查,可加 --offline)
```

## 快速开始

```bash
# 1. 看懂一张图
npx lceda-ai read  examples/stc89c52rc-minimal-v3.esch
npx lceda-ai read  examples/stc89c52rc-minimal-v3.esch --json

# 2. 出图 / 出报告
npx lceda-ai convert examples/stc89c52rc-minimal-v3.esch -o ./out --formats svg,png,pdf,report

# 3. 导出给立创EDA(文件 → 打开 → 嘉立创EDA)
npx lceda-ai export examples/stc89c52rc-minimal-v3.esch --project ./MyProject
```

## 命令

| 命令 | 作用 |
|---|---|
| `convert <sch> -o <dir> [--formats ...] [--scale 4]` | 批量转 svg/png/pdf/report |
| `read <sch> [--json]` | 结构 + 网络表摘要 |
| `create <out.esch> [--title --company --rev --date --drawn-by]` | 新建图纸 |
| `find <query> [--file <sheet>] [--json]` | 标准库 / 商城编号 / 内置库 / 工程内器件 |
| `place <sch> <符号或uuid或C编号> [--ref --value --at x,y --rot --std --standard --pins]` | 放一个器件,返回引脚坐标 |
| `build <spec.json> -o <out.esch> [--export]` | 按声明式 spec 画整图 |
| `edit <sch> --ops '<json>' [--dry-run] [--out] [--preview]` | 结构化编辑 |
| `export <sch> [-o out.json] [--project <dir>]` | 导出可导入立创EDA 的 JSON |

### 声明式建图(spec)

```jsonc
{
  "title": "STC89C52RC 最小系统", "rev": "3.0", "company": "…",
  "components": [
    { "symbol": "resistor", "ref": "R1", "value": "10k", "x": 300, "y": 430, "rot": 90 },
    { "part": { }, "ref": "U1", "x": 520, "y": 400 }
  ],
  "wires":  [ { "from": "U1.9", "to": "Y1.1" }, { "points": [[340,465],[300,465]] } ],
  "labels": [ { "text": "XTAL1", "at": "U1.19", "anchor": "end" } ],
  "flags":  [ { "text": "+5V", "kind": "part_netLabel_+5V", "at": "U1.40", "rot": 90 } ],
  "junctions": [ { "at": [300, 368] } ],
  "texts":  [ { "text": "说明", "at": [60, 60], "size": 10 } ]
}
```

`at`/`from`/`to` 可以是引脚引用(`"U1.9"`)或坐标。**接线坐标请先从引脚探测出来**
(`place` 的返回、或 `SchematicBuilder#pins()`),再写进 spec —— 换符号也不会错位。

### 结构化编辑

```bash
npx lceda-ai edit sheet.esch --ops '[
  {"op":"set_value","ref":"C1","value":"22pF"},
  {"op":"move","ref":"R2","dy":-10},
  {"op":"add_wire","points":[[100,100],[200,100]]},
  {"op":"add_net_label","x":150,"y":100,"text":"NODE_A"}
]' --dry-run
```

可用操作:`describe` `set_value` `set_designator` `set_attr` `move` `rotate` `delete_component`
`duplicate_component` `add_wire` `add_junction` `add_net_label` `add_net_flag`
`delete_element` `delete_wires_at` `move_element`。

每次编辑都会返回:改动清单、**网络表 diff**(哪些引脚换了网络)、告警(悬空导线、
未生效标签、单引脚网络、重复位号)。`--dry-run` 不落盘,写盘自动留 `.bak`。

## 器件库:标准库优先

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | **立创EDA 标准库** | 编辑器“元件库”同一套接口(`lceda.cn/api/components`);按标题或 uuid 取,返回真实符号 |
| 2 | **立创商城** | `easyeda.com/api/products/{LCSC}/components`;标准库没有时按编号取 |
| 3 | 内置符号 | 离线兜底(自制画法,仅应急) |

```bash
npx lceda-ai find R_0603_US        # 标准库搜索:uuid / 封装
npx lceda-ai find C25804           # 商城器件
npx lceda-ai place out.esch R_0603_US --ref R1 --value 10k --at 300,400 --rot 90
npx lceda-ai place out.esch --std 96ab93705fad467397e1ee5fa4b8c4da --ref R2 --at 400,400
```

**符号质量校验**:同名器件是用户共建的,引脚名可能写错。工具内置数据手册引脚参照表
(`src/library.js` 的 `PINOUT_REFERENCES`),按“引脚名匹配率 + 图形规整度”挑符号;
把 `29/30/31` 号脚写成 `P4.4/P4.5/P4.6` 的那批 STC89C52 符号会被自动淘汰。

## 导出到立创EDA

```bash
npx lceda-ai export sheet.esch -o Sheet_1.json          # 单文件
npx lceda-ai export sheet.esch --project ./MyProject    # 工程目录 + 导入说明
```

导入:立创EDA 标准版 **顶部菜单 → 打开 → 嘉立创EDA → 选择 json**。
导出的 json 与编辑器自己保存的文件**逐键一致**(顶层 5 键、`head` 12 键、单行紧凑格式)。

![真实编辑器打开导出的 json](docs/images/editor-import-json.png)

## Harness 插件(7 个工具)

本包本身就是 Harness bundle(`dsh-plugin-lceda-ai`,patch 见 `cordis.patch.yml`,row id `lceda-schematic-ai`),注册:

| 工具 | 作用 |
|---|---|
| `lceda_read_schematic` | BOM + 引脚表 + 网络表 |
| `lceda_render_schematic` | SVG/PNG/PDF/报告 |
| `lceda_create_schematic` | 新建图纸(可带 spec 一次画完,可顺带出图) |
| `lceda_place_component` | 放器件(标准库标题/uuid/LCSC/内置) |
| `lceda_find_component` | 找器件(标准库优先) |
| `lceda_edit_schematic` | 结构化编辑 + 校验 + 预览 |
| `lceda_export_json` | 导出可导入 JSON / 工程目录 |

安装:

```bash
# 在 Harness 里(plugin_manager),target 指向本目录
plugin_manager install_bundle  target: /absolute/path/to/dsh-plugin-lceda-ai
# 或者直接启用已安装的 bundle
plugin_manager set_bundle      target: dsh-plugin-lceda-ai  enabled: true
```

> 插件默认**不自动启用**;安装后再 `set_bundle enabled:true` 才会注册工具。
> 工具 schema 有回归测试(`test/plugin-schema.test.js`):参数名不能撞 JSON Schema 保留字
> (例如早期用 `title` 会导致整个函数 schema 非法)。

所有工具都通过**子进程**调用 `bin/lceda-ai.js`:改 `src/` 无需重载插件,也不会把
`sharp` 这类原生依赖带进宿主进程。

## 项目 Skill

`skills/lceda-schematic/SKILL.md` 是给 Agent 的工作手册(决策表、标准流程、必须遵守的规矩、已知坑),
通过 `.dsh/skills/lceda-schematic` 软链被 Harness 自动发现。

## 架构

```
bin/lceda-ai.js      CLI(懒加载重模块;--json 输出纯 JSON)
src/parser.js        .esch → 结构化模型(器件/引脚/导线/标签/标志/图形)
src/netlist.js       并查集网络提取 + 命名/别名/冲突判定
src/svg.js           渲染器(矢量、文本可搜索)
src/export.js        SVG → PNG(sharp)/ PDF(pdf-lib)
src/report.js        Markdown / JSON 报告
src/edit.js          编辑引擎:操作、网络表 diff、校验、原子写入 + .bak
src/symbol.js        符号生成(内置库)、器件构造、电源/地标志
src/create.js        新建图纸、放器件、spec 构建器、SchematicBuilder
src/library.js       标准库 / 商城 / 内置库、引脚校验、符号择优
src/exportjson.js    导出立创EDA 可打开的 JSON
src/path.js          路径解析/变换(旋转、平移)
docs/format.md       .esch 文件格式笔记(踩坑记录)
```

## 示例

`examples/` 是 **STC89C52RC 最小系统**:全部器件取自立创EDA 标准库(符号 uuid 已锁定),
并依据 STC89C51RC/RD+ 数据手册标注了引脚、复位时序、POR、ISP 的出处。
详见 [`examples/README.md`](examples/README.md)。

## 开发

```bash
npm test                 # 单元测试(解析/网络表/编辑/建图/导出/引脚校验)
npm run verify           # 端到端 15 项自检
npm run example          # 重新生成 v3 示例全套产物
```

## 已知限制

- 只支持**标准版**(`docType` 1);专业版格式不同。
- 渲染是忠实描边:编辑器里画得难看的库符号,渲染出来一样难看。
- 不做自动布局:spec 里的坐标需按符号尺寸微调(引脚坐标由工具探测)。
- 内置符号只有 8 类(8051/R/C/极性C/晶振/按键/LED/排针),其余请用标准库/商城。
- 商城按编号取件可用;关键词搜索接口有 WAF,关键词检索请走标准库。
- `.esch` 里若含编辑器私有插件对象,编辑时原样保留但不理解其语义。

## 目录结构

```
index.js             Harness 插件入口(注册 7 个 lceda_* 工具)
cordis.patch.yml     bundle patch(id: lceda-schematic-ai)
locale/ icon.svg     插件显示资源
bin/ src/ test/ scripts/ docs/ skills/ examples/
├── docs/format.md            .esch 文件格式笔记
├── docs/images/              编辑器实机验证截图
├── examples/                 示例工程与生成脚本
└── skills/lceda-schematic/   项目 Skill
```

`node_modules/`、`.venv/`、`datasheet/`、`out/`、`examples/_generated/`、`examples/private/`
不纳入版本管理(见 `.gitignore`)。
