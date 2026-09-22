# Third-Party Notices

本仓库包含来自第三方项目的代码与素材。除本仓库自身的 MIT License 外，
以下组件还受各自许可证约束。

## 上游项目：globe（深空制图仪）

- 上游仓库：<https://github.com/Wencle-Sun/globe>
- 作者：Wenke Sun（Wencle-Sun）
- 许可证：MIT License（全文见 [`THIRD_PARTY_LICENSES/LICENSE`](THIRD_PARTY_LICENSES/LICENSE)）
- 衍生关系：`engine/gesture-engine.js` 中的手部几何判定原语
  （`palmCenter` / `fingerExtension` / `fingerStraight` / `handDist3`）、
  单手锁定、自适应指数平滑、静止死区迟滞、捏合双阈值、横扫状态机、
  30fps 送帧调度与摄像头自愈等机制，移植并改写自上游 `sketch.js`。
  逐条移植清单与差异说明见 [`docs/原项目实现分析.md`](docs/原项目实现分析.md)。
- 其余扩展架构代码（`manifest.json`、`background.js`、`content/`、`panel/`、`test/`）
  为本项目新编写，不在上游代码基础上逐行改写。

## MediaPipe Hands 0.4.1675469240

- 目录：`mediapipe/`
- 项目：<https://github.com/google-ai-edge/mediapipe>
- 许可证：Apache License 2.0
- 许可证全文：[Apache-2.0](THIRD_PARTY_LICENSES/MediaPipe-Apache-2.0.txt)
- npm 分发：<https://registry.npmjs.org/@mediapipe/hands/-/hands-0.4.1675469240.tgz>
- 说明：本目录文件为上游 npm 包的未修改副本（与 globe 随仓库分发的
  `assets/mediapipe/` 逐字节一致）。

## 图标

- `icons/`（16/48/128 PNG）为本项目随扩展分发的图标，不含第三方素材。
