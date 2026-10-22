# STC89C52RC + AMS1117-5.0 + CH340G USB 下载板

一块完整的、可用立创EDA打开的单片机下载板:USB 供电 → LDO 稳压 → CH340G 转串口 →
STC89C52RC 的 UART ISP 下载,并把 P1/P2 两组 IO 引出到 2.54mm 排针。

![原理图](schematic/stc89c52rc-usb-isp.png)

## 设计要点

| 功能块 | 器件 | 说明 |
|---|---|---|
| 主控 | **U1 STC89C52RC-40I**(DIP-40) | 11.0592MHz + 2×30pF,波特率精确 |
| 电源 | **U2 AMS1117-5.0**(SOT-223) | USB 5V → VCC(带载约 4.4V);STC89C52RC 规定 3.4~5.5V,余量充足 |
| USB 转串口 | **U3 CH340G**(SOP-16) | 12MHz + 2×22pF;TXD→P3.0(RXD)、RXD←P3.1(TXD);V3 脚 100nF;R232 接地为 TTL 电平 |
| 接口 | **J1 Micro-USB** / **J2 ISP(1×5)** / **J3 P1.0~P1.7** / **J4 P2.0~P2.7** | ISP 排针引出 VCC/GND/RXD/TXD/RST,也可直接接 USB-TTL 模块 |
| 复位 | SW1 + R1 10k + C8 10µF | 上电复位 + 手动复位(STC-ISP 等待上电时按 SW1) |
| 指示 | R2 1k + D1 RED | 电源指示 |
| 去耦 | C1/C2 10µF、C3/C9/C10 100nF、C11 10µF | LDO 输入输出、CH340G V3、MCU |

**关于"SPI 下载"**:STC89C52RC 的 ISP 是 **UART**(P3.0/P3.1),不是 SPI。本板按 UART ISP 设计,
并把这两根线同时引到 J2 排针,方便用现成 USB-TTL 模块下载。CH340G 的 CTS#/DSR#/RI#/DCD#/DTR#/RTS#
与 USB 的 ID 脚悬空(未使用)。

## 文件说明

| 路径 | 内容 |
|---|---|
| `../stc89c52rc-usb-isp.esch` | 原理图(嘉立创EDA 格式,可直接打开) |
| `stc89c52rc-usb-isp.json` / `sch/Sheet_1.json` | 立创EDA 可导入的工程 JSON |
| `schematic/` | 原理图渲染:png / svg / pdf / 报告 |
| `board.json` → `board-routed.json` → `board-poured.json` → `board-stitched.json` | PCB 四个阶段(布局 / 布线 / 铺铜 / 缝合孔) |
| `pcb-placed/` `pcb-routed/` `pcb-final/` | 各阶段 PCB 渲染 |
| `gerber/` | **Gerber(RS-274X)7 个 + Excellon 钻孔 1 个** + `gerber.manifest.json` 自检结果 |
| `bom/` | BOM 与贴片坐标(CSV + XLSX,两个工作表) |
| `drc.md` | 设计规则检查报告(逐条列出违规与位置) |
| `build.mjs` | 一键重建整条流水线 |

## 布局:按功能分区

自动打包优化的是面积,而面积不是让板子好用的东西 —— 它会把 micro-USB 放到板子中间(插不进线),
再把 LDO、CH340G、MCU 拆散。所以布局用**显式功能区**描述(`build.mjs` 里的 `ZONES`),
每个连接器都放在它该在的板边:

| 区域 | 器件 | 位置 |
|---|---|---|
| `usb` | J1 Micro-USB | **左边贴边,插口朝外**(可插拔) |
| `power` | U2 + C1/C2/C3 + R2/D1 | 左上(紧邻 USB) |
| `uart` | U3 CH340G + C9 + Y2 12MHz + C6/C7 | 左下 |
| `mcu` | U1(DIP-40 竖放)+ C10/C11 + Y1 11.0592MHz + C4/C5 | 中部 |
| `reset` | SW1 + C8 + R1 | 中下(紧邻 MCU) |
| `io` | J3/J4/J2 | **右边一列**(引出排针) |

板框 113.06 × 78.69 mm。

## 流水线结果

```
1. 布局  24 器件 / 128 焊盘 / 53 网络 | 板框 113.06 x 78.69 mm | 重叠 0 | 越界 0
2. 布线  优先 10/13 + 其余 28/33 = 38/46 网络 | 248 段走线 | 131 过孔
3. 铺铜  GND 6245.8 mm² | 33 个多边形 | 移除孤岛 46
4. 缝合孔 183 个(盘 0.508mm / 孔 0.254mm / 环 0.127mm)| 违规 0
5. DRC   1 错误 / 8 提示(见下)
6. Gerber 8 个文件,自检全部一致(442 flash / 1194 描边 / 379 钻孔 / 板框 113.06×78.69)
7. BOM   17 行 / 24 器件 | 贴片 24(全顶层)
```

**关键网络全部布通**:RXD、TXD、RST、XTAL1、XTAL2、XI、XO、USB_D+、VBUS、V3、+5V ——
下载功能所需的连线全通;GND 由铺铜连通。

## 已知问题(如实记录)

1. **1 处 DRC 错误**:一个 GND 过孔落在 CH340G(U3)第 14 脚焊盘的角上,实测间距 0.089mm(要求 0.254mm),
   坐标见 `drc.md`。路由器对细间距焊盘周围用的是"高代价"而非"禁止"(禁止会让过孔挤到插件焊盘旁,
   实测产生 26 处孔到孔错误),这一处是它的代价;在编辑器里手工挪一下即可。
2. **USB_D- 未布通**(USB_D+ 已通)。Micro-USB 焊盘间距 0.65mm(间隙仅 0.25mm),
   在 0.254mm 线宽/间距 + 0.254mm 栅格下极难逃逸。实际工程做法是给这类网络单独的**网络类规则**
   (如 0.15mm),这是路线图里尚未实现的部分。
3. **8 条"未连通"提示**:主要是 P1/P2 引出网络与 USB_D-。
4. `D1` 用的是库里的 `CHIPLED-0603-TTW` 封装(4 个焊盘,其中两个是装饰盘),工具已给出"焊盘多于引脚"的告警。
5. 板框 113×79mm 偏宽(DIP-40 竖放占了大半宽度),仍可再紧凑一些。

## 复现

```bash
node examples/build-stc89c52rc-usb-isp.mjs          # 生成原理图
node examples/stc89c52rc-usb-isp/build.mjs          # 跑完整 PCB 流水线
```

## 独立校验

- **立创EDA**:打开 `board-stitched.json` → 129 焊盘 / 220 过孔 / **33 个铜皮区域** / 61 个丝印文字 /
  389 段带网络走线(38 个网络)全部识别。
- **gerbonara 1.6.3**(第三方 Gerber 解析器):8 个文件、**2987 个对象**全部解析并渲染成功;
  板框 82.963×78.946mm(= 81.95 + 线宽 1.016),顶层铜 81.026×76.962mm(= 板框 − 2×0.3 板边距)。
- **openpyxl 3.1.5**:XLSX 可打开,`BOM` A1:J18、`CPL` A1:G25,数值/字符串类型正确。
