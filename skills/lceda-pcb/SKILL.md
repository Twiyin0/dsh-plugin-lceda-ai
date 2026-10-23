---
name: lceda-pcb
description: Lay out and route a 嘉立创EDA (LCEDA standard edition) PCB with this repository's tools — schematic to board, placement, two-layer routing, copper pour, stitching vias, DRC, Gerber and BOM. Use whenever a task mentions PCB/板/布线/走线/布局/铺铜/过孔/DRC/Gerber for LCEDA. Also applies when reviewing an existing board for manufacturability or routing quality.
---

# 立创EDA PCB 技能(本机)

仓库根目录:`/Volumes/980Pro2T/Project/node/dsh-plugin-lceda-ai`。
工具:`lceda_pcb_build` / `lceda_pcb_read` / `lceda_pcb_render` / `lceda_pcb_route` /
`lceda_pcb_pour` / `lceda_pcb_via` / `lceda_pcb_drc` / `lceda_pcb_gerber` / `lceda_pcb_bom`。
命令行等价:`node bin/lceda-ai.js pcb {read|render|from-sch|route|pour|via|drc|gerber|bom}`。

## 一、器件来源(与原理图同一原则)

1. **立创EDA 标准库**(uuid)——首选,原理图和 PCB 用同一套符号/封装。
2. **立创商城库**(LCSC 编号,如 `C25804`)——标准库没有时用,封装由 `packageDetail` 带出。
3. **内置符号**(`resistor`/`capacitor`/`led`/`crystal`/`header` 等)是自绘兜底,**只在两处都找不到时**用,
   且必须在交付说明里写明为什么用兜底。

绝不要为了省事自绘一个标准库里已经有的器件:同一张图里混用“库符号 + 自绘符号”会破坏一致性,
位号、引脚号、封装对应关系都容易出错。

## 二、布线规则(硬性,交付前逐条核对)

| # | 规则 | 量化 |
|---|---|---|
| 1 | 信号线宽 | **10 mil = 0.254 mm** |
| 2 | 电源线宽 | **20–30 mil = 0.5–0.762 mm**,电流越大越粗(VBUS/主电源取上限) |
| 3 | 拐角 | **禁止 90° 直角**,拐角用 1–2 mm 的 45° 斜段倒角(参考板实测中位数 1.19 mm);整板线段角度必须只落在 0/45/90/135 |
| 4 | 差分线 | USB D+/D− 同层、等长、等间距、尽量短、少过孔;不允许一条走顶层一条走底层 |
| 5 | 层间重叠 | 上下两层**不得在同一坐标平行走线**(耦合电容),必须错开 ≥ 3 倍线宽 |
| 6 | 布线顺序 | 从繁至简:先时钟/晶振、USB 差分、复位、关键电源,再一般信号,最后 GPIO 扇出 |
| 7 | 参考地 | 双层铺地,关键信号下方地平面连续;晶振下方禁走其他线 |
| 8 | 过孔 | 信号过孔 0.3/0.6 mm;电源多打过孔;过孔不要放在焊盘上(除非盘中孔工艺) |


## 二·补、真实立创板的走线规律(取自参考板 `PCB_PCB_IPS5306_UPS_2026-10-22.json`)

对这块真实四层以下量产板做过统计,结论直接作为本项目的布线标准:

| 观测项 | 实测结果 | 结论 |
|---|---|---|
| 线段角度 | 只出现 **0°/45°/90°/135°** 四种,合计 103 段,无任何其他角度 | 走线必须落在这四个角度上,禁止任意斜角 |
| 45° 斜段占比 | 32/103 ≈ **31%** | 拐角不是直角,而是用斜段过渡 |
| 斜段长度 | 中位数 **1.19 mm**,最小 0.04 mm,最大 4.5 mm | 拐角用 **1–2 mm 短斜段倒角**,不是长斜线 |
| 一条走线的点数 | 55 条 TRACK 里 25 条是 3 点以上的折线(最多 8 点) | 一条网络存成**一条折线**,不是一堆独立线段 |
| 线宽 | 1.9685 unit = **0.5 mm(20 mil)** 占 48/55,1 unit = 0.254 mm 占 7 | 电源/一般线以 20 mil 为主 |
| 过孔 | **133 个** | 换层极其频繁,靠过孔+铺铜而不是绕线 |
| 铺铜 | **26 个 COPPERAREA** | 地/电源大面积铺铜,大量连接靠铜皮完成 |

**要点:真实板子靠“短斜段倒角 + 大量过孔 + 大面积铺铜”来走线,而不是靠长距离绕线。**

## 二·补二、工具里的 45° 实现(已内置,不要再手写直角)

- `src/pcb/route.js` 的 A* 已改为**八方向搜索**(`octilinear`,默认开):
  对角步进代价 √2,启发函数用 octile 距离;对角步**要求两侧正交格都空闲**,否则会切角压到别的焊盘。
- `legalizeAngles(points)`(同文件导出):把任何非 0/45/90/135 的线段拆成「正交段 + 45° 段」。
  焊盘中心常常不在布线栅格上,落盘那一下会产生 8°、153° 这种斜线,必须过这个函数。
- `autoroute()` 已经在输出前对每条走线调用它;手工补的线(如 USB-C 扇出)也要自己调用一次。
- 自检口径:统计所有 TRACK 线段的 `atan2(dy,dx) mod 180`,**合法角必须是 100%**:

```bash
# 角度自检(应输出 illegal 0)
node -e "const d=require('./board.json');const m={};for(const s of d.shape){if(!s.startsWith('TRACK~'))continue;const f=s.split('~');if(f[2]==='10')continue;const n=f[4].split(/\\s+/).map(Number);for(let i=0;i+2<n.length;i+=2){const a=Math.round(Math.atan2(n[i+3]-n[i+1],n[i+2]-n[i])*180/Math.PI)%180;m[a]=(m[a]||0)+1}}console.log(m)"
```

## 三、检查清单(交付前)

1. `lceda_pcb_drc` 全项跑一遍:线宽、间距、过孔环、孔到孔、板边、丝印压盘、连通性。
2. 用几何脚本复核 DRC 覆盖不到的地方:**安装孔(NPTH)不在布线避障里**、顶层独立丝印不参与压盘检查。
3. 逐条核对上面 8 条布线规则;八方向 A* + `legalizeAngles` 之后仍要跑一次角度自检(见上),**合法角 100% 才算过**。
4. 渲染正/反两面 PNG 目视检查:丝印压盘、位号可读、连接器朝板边、安装孔周围无铜。
5. 差分对用几何量测确认:两条线间距恒定、长度差 < 5 mil、全程同层。

## 四、已知的自动布线器限制(必须人工补)

- 四邻接 A*:**只会 90° 拐弯**;`viaHole` 参数实际按**半径**写入;`routeBoard` 重建文档时会丢掉
  每网络 DRC override 和标题,布线后要恢复 `DRCRULE`。
- 0.5 mm 间距的 USB-C 焊盘无法自动扇出:焊盘宽 0.3 mm、间距 0.2 mm,10 mil 线 + 10 mil 间距挤不进去。
  必须手工把 A6/B6、A7/B7 两对同网络焊盘在焊盘阵列外侧合并(必要时用过孔换层),
  再按差分对走进 ESD/桥片。
- `buildGrid` 不避让独立 `HOLE`;`DRC` 的孔到孔也不统计独立安装孔 —— 安装孔位置要自己按几何核。
- DRC 的规则以 **1 unit = 0.254 mm** 取整,0.15/0.2 mm 的规则会被抬到 0.254 mm;
  0.5 mm 间距连接器因此必然报“间距不足”,这是量化误差,交付说明里要写清楚。

## 五、推荐流程

```bash
node bin/lceda-ai.js pcb from-sch sheet.json -o board.json --place rule
node bin/lceda-ai.js pcb route board.json -o routed.json --cell 1 --width 1
node bin/lceda-ai.js pcb pour  routed.json -o poured.json --net GND
node bin/lceda-ai.js pcb via   poured.json -o final.json --net GND --spacing 5
node bin/lceda-ai.js pcb drc   final.json -o drc.md
```

布局原则:连接器贴板边、晶振紧贴 MCU 且下方净空、去耦电容贴着电源脚、开关/指示灯放板边可操作、
排针沿板边一字排开且与 MCU 对应引脚同侧,减少跨板走线。
