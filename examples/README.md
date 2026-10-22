# 示例

| 文件 | 内容 |
|---|---|
| `build-stc89c52rc-usb-isp.mjs` | 生成下面这块板的原理图(全部器件取自立创EDA 标准库,uuid 已锁定) |
| `stc89c52rc-usb-isp.esch` | **原理图源文件**,嘉立创EDA 直接打开 |
| `stc89c52rc-usb-isp.json` | 同上,立创EDA 可导入的 JSON |
| `stc89c52rc-usb-isp/board.json` | **PCB 源文件**(24 器件 / 128 焊盘 / 53 网络,113.06 × 78.69 mm) |
| `stc89c52rc-usb-isp/build.mjs` | 从原理图跑到 Gerber/BOM 的完整流水线 |
| `stc89c52rc-usb-isp/README.md` | 设计说明、结果与已知问题 |

## STC89C52RC + AMS1117-5.0 + CH340G USB 下载板

USB 5V → LDO 稳压 → CH340G 转串口 → STC89C52RC 的 **UART ISP** 下载;P1/P2 两组 IO 引出到排针。
布局按功能分区:micro-USB 贴左边(可插拔)、电源/串口/主控/复位各自成块、排针在右侧一列。

## 重新生成

```bash
node examples/build-stc89c52rc-usb-isp.mjs        # 原理图(.esch / .json / 渲染 / 报告)
node examples/stc89c52rc-usb-isp/build.mjs        # PCB:布局 → 布线 → 铺铜 → 缝合孔 → DRC → Gerber → BOM → 渲染
```

生成物(BOM、Gerber、各阶段板文件、渲染图、报告)都在 `.gitignore` 里,不纳入版本管理 ——
需要时跑上面两条命令即可重建。

## 测试夹具

`test/fixtures/` 下有测试用的小样例(最小系统原理图、13 器件的演示板),测试不依赖 `examples/`。
