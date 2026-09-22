# NOTICE

手势导航 · Hand Gesture Navigator（gesture-nav-edge）

本项目的部分代码衍生自上游开源项目，第三方组件按各自许可证发布，
本仓库的 MIT License（见 `LICENSE`）不覆盖以下内容：

- **globe（深空制图仪）** — Copyright (c) 2026 Wenke Sun，MIT License。
  `engine/gesture-engine.js` 中的手势识别核心机制移植并改写自该项目
  （上游仓库：<https://github.com/Wencle-Sun/globe>，
  许可证全文保留于 `THIRD_PARTY_LICENSES/LICENSE`，
  移植清单见 `docs/原项目实现分析.md`）。
- **MediaPipe Hands 0.4.1675469240** — Copyright Google LLC，Apache License 2.0。
  `mediapipe/` 目录为未修改的随包分发副本
  （许可证全文见 `THIRD_PARTY_LICENSES/MediaPipe-Apache-2.0.txt`）。

完整第三方声明：`THIRD_PARTY_LICENSES/THIRD_PARTY_NOTICES.md`。
