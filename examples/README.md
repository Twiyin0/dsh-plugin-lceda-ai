# 示例

| 文件 | 内容 |
|---|---|
| `build-stc89c52rc-v3.mjs` | **推荐阅读**:STC89C52RC 最小系统,全部器件取自立创EDA 标准库,uuid 已锁定 |
| `stc89c52rc-minimal-v3.esch` | 生成的原型文件 |
| `stc89c52rc-minimal-v3.json` | 可直接导入立创EDA 的 JSON |
| `stc89c52rc-minimal-v3.ai.png/pdf` | 渲染结果 |
| `stc89c52rc-minimal-v3.report.md` | BOM + 引脚表 + 网络表 |
| `STC89C52RC-Minimal-v3/sch/Sheet_1.json` | 工程目录形式(含导入说明) |
| `build-stc89c52rc.mjs` / `build-stc89c52rc-v2.mjs` | 早期版本:内置符号 / 数据手册校对后的手工符号 |
| `pcb-demo/` | **原理图→PCB→布线→铺铜→缝合孔**:`board.json` → `board-routed.json` → `board-poured.json` → `board-stitched.json` + 各阶段渲染图 |
| `multi-sheet-demo/` | **单工程多图纸**:Sheet_1 4P 排针、Sheet_2 8P 排针;VCC/GND 用全局标志、RX/TX 用**网络端口**(跨图纸)。`node examples/multi-sheet-demo/build.mjs` 重建 |
| `auto-layout.spec.json` | **不写坐标的 spec**:`"layout":"auto"`,自动摆放 + 正交走线 |
| `auto-layout.{esch,ai.png,ai.pdf}` | 由它生成的图(`npm run example:auto`) |
| `stc89c52rc-minimal.spec.json` | v1 的声明式 spec(演示 spec 格式) |
| `stc89c52rc-minimal-v2.*` | v2 产物(手工符号,保留作对比) |

```bash
npm run example            # 重新生成 v3 全套产物
node bin/lceda-ai.js build examples/auto-layout.spec.json -o examples/auto-layout.esch --auto-layout --export
node bin/lceda-ai.js project examples/STC89C52RC-Minimal-v3 -o /tmp/proj --render
node bin/lceda-ai.js project examples/multi-sheet-demo -o /tmp/multi   # 跨图纸联动
```

## 电路

STC89C52RC-40I(DIP-40)+ 11.0592MHz 晶振 + 2×30pF 负载电容 + 10k/10uF 复位(带按键)
+ 100nF 去耦 + 10uF 储能 + 1k/LED 电源指示 + 2 脚电源输入 + 5 脚 ISP 下载口。

设计依据(STC89C51RC/RD+ 数据手册):

| 依据 | 页码 |
|---|---|
| DIP-40 引脚定义、/EA、XTAL1/2、VCC/GND、P0/P3 | 1.4 Pin Descriptions, p.7 |
| RST 需高电平 ≥ 2 个机器周期 + 10µs | 2.2.1 Reset pin, p.16 |
| 芯片内置 POR;可选 MAX810 ≈400ms 延时 | 2.2.2 / 2.2.5, p.17 / p.20 |
| ISP/IAP 走 P3.0(RxD)/P3.1(TxD) | Ch.9, p.4 / p.123 |

## 网表(v3,工具自检 0 冲突)

```
+5V     C3.1 C4.1 C5.1 J1.1 J2.1 R2.1 SW1.1 SW1.2 U1.31 U1.40
GND     C1.2 C2.2 C4.2 C5.2 D1.C@1 J1.2 J2.2 R1.2 U1.20
RST     C3.2 J2.5 R1.1 SW1.3 SW1.4 U1.9
XTAL1   C1.1 U1.19 Y1.1        XTAL2  C2.1 U1.18 Y1.2
RXD     J2.3 U1.10             TXD    J2.4 U1.11
PWR_LED D1.A@1 R2.2
```

`examples/_generated/`、`examples/private/` 不入库(旧版渲染、真实工程样本)。
