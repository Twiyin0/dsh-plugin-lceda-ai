# 原理图文件格式笔记(`.esch` / `Sheet_1.json`)

嘉立创EDA 标准版(6.5.x)把原理图存成一个 JSON 文档,扩展名可以是 `.esch` 或 `.json`,
两者内容完全一样。本文是解析/生成这份格式时踩过的坑,读代码前先看这里。

## 顶层结构

```json
{
  "head":   { "docType": "1", "editorVersion": "6.5.51", ... },
  "canvas": "CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0",
  "shape":  [ "LIB~...", "W~...", "F~..." ],
  "BBox":   { "x": 0, "y": 0, "width": 1160, "height": 820 },
  "colors": {}
}
```

- `head.docType` 必须是字符串 `"1"`(原理图);`"2"` 是符号,`"4"` 是封装。
- `head.c_para` 里带 `package` / `prefix` 等器件参数;导出时要补齐 `uuid/hasIdFlag/newgId`。
- `BBox` 是图纸范围,**y 轴向下**;`BBox.y` 是**最负**的那个值,也就是图纸上边缘。

## 记录格式

`shape` 里每条都是 `类型~字段~字段...` 的字符串,`~` 分段。

| 类型 | 含义 | 关键字段 |
|---|---|---|
| `LIB` | 器件(含图框) | 见下 |
| `W~x1~y1~x2~y2~color~width~style~id~...` | 导线 | 端点 |
| `N~x~y~rot~color~font~size~...~text~...` | 网络标签 | 位置 + 文本 |
| `F~kind~x~y~rot~id~...^^anchor^^text^^PL...` | 电源/地标志 | kind 决定图形,文本才是网络名 |
| `J~x~y~...` | 结点 | 交叉处连接 |
| `T~kind~x~y~rot~color~font~size~bold~italic~vis~...~text~...~anchor~id~locked` | 文本 | **字段 10 是可见性**,漏了会让所有文本渲染成下一字段的值 |
| `R` / `E` / `PL` / `PT` / `PG` / `Pimage` | 矩形/椭圆/折线/路径/多边形/图片 | 图形 |

### `LIB`(器件)

```
LIB~<x>~<y>~<rot>~<?...>~<ref>~<name>~<package>~...
#@$R~...            ← 器件内的子图形
#@$P~show~elec~num~x~y~orient~id~locked^^point^^path~color^^nameBlock^^numBlock^^dot^^clock
```

- 子记录用 `#@$`(3 个字符)分隔。
- 子图形坐标是**已旋转、已平移的绝对图纸坐标**;外层的 `rot` 只是元数据。
- 引脚连通点是第 2 段里的两个数(`^^x y^^`),不是 `"x y"` 字符串。

### 引脚朝向

| 朝向 | orient | `path` 形状 |
|---|---|---|
| 左 | 180 | `h +len` |
| 右 | 0 | `h -len` |
| 上 | 270 | `v +len` |
| 下 | 90 | `v -len` |

### 电源/地标志

```
F~part_netLabel_gnD~x~y~rot~id~~0^^x~y^^GND~#000000~tx~ty~0~start~1~Times New Roman~9pt~flag_x^^PL~...^^PL~...
```

- `rot` 0/90/180/270 = 上/右/下/左(箭头指向)。
- GND 图形 = 竖线 + 三条递减横杠;+5V/VCC = 竖线 + 顶端横杠。
- **网络名来自文本块**,不是 `kind`。所以 `kind=part_netLabel_gnD` 配文本 `AGND` 就是 AGND。
- 锚点用 `~` 分隔(`^^x~y^^`),写成空格会解析失败。

## 网络提取规则

1. 导线是导体;端点相接、或端点落在另一条导线**中间**(T 接)都算连通。
2. 导线**内部交叉**不算连通,必须有 `J` 结点。
3. 网络标签 / 电源标志落在引脚点或导线上才生效(判定用四舍五入后的坐标)。
4. 命名优先级:电源标志 > 网络标签;两个不同的标志名 = 冲突,必须报出来(典型事故:VBUS 被并进 GND)。
5. 同名网络跨图纸合并,但**只按主名合并**;标签别名不应把无关网络拖进来。

## 渲染注意

- **不要翻转 Y 轴**:直接用记录里的坐标,`viewBox` 取 `BBox ± margin`。
- 引脚线长度 = `pinLen`,连接点 = `inset + pinLen`(无源器件用 `pinInset` 让引脚线画到极板上)。
- `<polyline>` 想要“只描边”必须显式 `fill="none"`,否则会出现整片黑三角。
- 图片记录(`Pimage`)的 x/y/w/h 是 `data:` URI 之前最后 4 个数。

## 总线 / 层次图:为什么只读不写

检查过的真实工程里,顶层记录只有 `LIB / F / W / N / J` 五类:

- `BUS` 只出现在网络名里(`VBUS`),不是记录类型;
- `B~` 出现在图框文字记录(`T~L~…~comment~B~1~…`)和图片 base64 数据里。

也就是说,标准版的总线(bus)与层次端口(hierarchical port)记录格式**没有可验证的样本**。
凭猜测写入 `B~`/端口记录,可能产出编辑器拒绝或误读的文件,因此本工具:

- **读**:`project` 聚合多图纸,统计跨图纸同名网络与网络分类;
- **不写**:不生成总线/端口记录;需要层次化设计时请在编辑器里手动加端口。

如果以后拿到含总线/端口的真实文件,补上记录格式与双向支持即可,`src/parser.js` 的
`parseShape` 已经对未知记录做了 `unknown` 兜底,不会崩。

## 兼容性验证

导出的 json 与编辑器自己保存的文件做逐键对比(顶层 5 键、`head` 12 键)一致;
`test/authoring.test.js` 里有断言锁住这一点。真实编辑器打开流程:
**文件 → 打开 → 嘉立创EDA → 选择 json**。
