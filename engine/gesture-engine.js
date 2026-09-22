/* 手势导航 · 识别引擎 v3.2 —— 精简手势集版
 *
 * v3.2 变更：按需求删除 暂停/恢复（拜拜摇手）、页面上下滚动（点赞挥动 + 握拳停止）、
 * 切换标签页（握拳横扫）三类手势及其挥动运动学层。保留：
 *  · 🤲 双手缩放：连续会话状态机 IDLE→START→ACTIVE→END/CANCEL
 *  · ✌️ V 型保持 0.6s → 视频播放/暂停（多帧确认 + 保持 + 冷却）
 *  · 👌 OK 保持 0.8s → 关闭当前标签页（倒计时环 + 冷却）
 * 生命周期契约不变：候选(≥3帧)→保持→触发一次→LOCKED→释放→冷却→重新待命。
 * 保留 v3 精度层：完整模型、丢跟踪宽限（保持类手势）、30fps 节流、超时自检、
 * 指数退避重连、generation 防竞态、单手 handedness 锁定。
 */

const PALM_IDS = [0, 5, 9, 13, 17];

function palmCenter(lm) {
  let x = 0, y = 0;
  for (const i of PALM_IDS) { x += lm[i].x; y += lm[i].y; }
  return { x: x / PALM_IDS.length, y: y / PALM_IDS.length };
}
function palmSize(lm) {
  return Math.hypot(lm[0].x - lm[9].x, lm[0].y - lm[9].y) || 0.001;
}
function fingerExtension(lm, tip, pip) {
  const wrist = lm[0];
  const dTip = Math.hypot(lm[tip].x - wrist.x, lm[tip].y - wrist.y);
  const dPip = Math.hypot(lm[pip].x - wrist.x, lm[pip].y - wrist.y) || 0.001;
  return dTip / dPip;
}
function fingerStraight(lm, tip, mcp) {
  const wx = lm[mcp].x - lm[0].x, wy = lm[mcp].y - lm[0].y;
  const fx = lm[tip].x - lm[mcp].x, fy = lm[tip].y - lm[mcp].y;
  const wLen = Math.hypot(wx, wy) || 0.001;
  const fLen = Math.hypot(fx, fy) || 0.001;
  return (wx * fx + wy * fy) / (wLen * fLen);
}
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

const BASE_THRESHOLDS = {
  // —— 模型与采集 ——
  modelComplexity: 1,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.5,
  dropGraceFrames: 6,            // 保持类手势的丢跟踪宽限帧数（≈200ms）

  // —— 姿态确认 ——
  confirmFrames: 3,

  // —— OK 保持 → 关闭标签页（高风险，保持时长最长）——
  pinchCloseRatio: 0.45, pinchReleaseRatio: 0.58,
  okHoldMs: 800, okCooldownMs: 1000,

  // —— ✌️ V 型保持 → 视频播放/暂停 ——
  victoryHoldMs: 600, victoryCooldownMs: 1000,

  // —— V1.0.1：☝️ 单伸食指 → 播放下一集；🤟 收拇指伸四指 → 复制链接 ——
  pointingHoldMs: 400, pointingCooldownMs: 1200,
  copyHoldMs: 400, copyCooldownMs: 1200,

  // —— V1.0.3：👊 握拳 → 视频回退 10 秒（原「数字 7」手势改造）——
  fistHoldMs: 800, fistCooldownMs: 1000,

  // —— 双手缩放会话 ——
  twoHandConfirmFrames: 3,       // START：双手稳定出现帧数
  twoHandEmaAlpha: 0.5,          // 掌距平滑系数
  twoHandDeadzone: 0.02,         // 运动判定阈值（滞回上沿）
  twoHandStopDeadzone: 0.012,    // 静止判定阈值（滞回下沿）
  twoHandMaxDelta: 0.15,         // 单帧掌距变化限幅
  twoHandGain: 0.9,              // 掌距变化 → 缩放增量增益
  twoHandMaxStep: 0.06,          // 单帧最大缩放变化（限速）
  twoHandStopHoldMs: 400,        // 静止持续该时长 → END
  twoHandNeutralBand: 0.10,      // 回到起始掌距 ±10% 且静止 → END
  twoHandNeutralHoldMs: 250,
  twoHandSessionCooldownMs: 500, // END 后必须重新满足 START

  // —— 单手锁定与调度 ——
  handLockReleaseMs: 900,
  frameIntervalMs: 1000 / 30,
  startupTimeoutMs: 15000, sendTimeoutMs: 2500, resultTimeoutMs: 3000,
  errorLimit: 3, recoveryAttempts: 3, recoveryDelaysMs: [600, 1200, 2500]
};

const SENSITIVITY = {
  low:    { deadScale: 1.4 },
  normal: { deadScale: 1.0 },
  high:   { deadScale: 0.75 }
};

/* ================= 通用「姿态保持」状态机 =================
 * 候选(confirmFrames) → 保持(holdMs) → 触发一次 → LOCKED(姿态释放才解锁) → 冷却。
 * 用于：👌 OK 保持 → 关闭标签页；✌️ V 型保持 → 视频播放/暂停。 */
class HoldFSM {
  constructor(engine, opts) {
    this.eng = engine;
    this.holdMs = opts.holdMs;
    this.cooldownMs = opts.cooldownMs;
    this.action = opts.action;
    this.resetAll();
  }
  resetAll() {
    this.state = "idle";       // idle|holding|locked|cooldown
    this.count = 0;
    this.holdStart = 0;
    this.cooldownUntil = 0;
  }
  get holdProgress() {
    return this.state === "holding" ? clamp((Date.now() - this.holdStart) / this.holdMs, 0, 1) : 0;
  }
  update(poseOk, now) {
    let fire = null;
    if (this.state === "cooldown" && now >= this.cooldownUntil) this.resetAll();

    switch (this.state) {
      case "idle":
        if (poseOk) { if (++this.count >= this.eng.t.confirmFrames) { this.state = "holding"; this.holdStart = now; } }
        else this.count = 0;
        break;

      case "holding":
        if (!poseOk) this.resetAll();                    // 提前放下 = 生命周期作废
        else if (now - this.holdStart >= this.holdMs) {
          fire = { type: this.action };
          this.state = "locked";
        }
        break;

      case "locked":
        if (!poseOk) { this.state = "cooldown"; this.cooldownUntil = now + this.cooldownMs; }
        break;

      case "cooldown":
        break;
    }
    return fire;
  }
}

/* ================= 双手缩放会话状态机 =================
 * IDLE →(双手连续 N 帧)→ ACTIVE(记录起始掌距) → 每帧按 EMA 平滑后的相对上一帧
 * 增量连续发 zoom{delta} →(静止滞回持续 / 回中立 / 任意手消失)→ END/CANCEL →
 * 冷却 → IDLE。结束后必须重新满足 START，一次手势生命周期只建一个会话。 */
class TwoHandZoomFSM {
  constructor(engine) { this.eng = engine; this.reset(); }
  reset() {
    this.state = "idle";
    this.confirm = 0;
    this.ema = null; this.prev = null;
    this.startSpread = null;
    this.lastMotionAt = 0;
    this.cooldownUntil = 0;
  }
  cancel(now) { if (this.state === "active") this._end(now); }
  _end(now) {
    this.state = "cooldown";
    this.cooldownUntil = now + this.eng.t.twoHandSessionCooldownMs;
    this.ema = null; this.prev = null; this.startSpread = null; this.confirm = 0;
  }

  update(list, now) {
    const t = this.eng.t;
    if (this.state === "cooldown" && now >= this.cooldownUntil) this.reset();

    if (this.state === "idle") {
      const spread = this.eng._twoHandSpread(list);
      this.confirm++;
      this.ema = this.ema == null ? spread : this.ema + t.twoHandEmaAlpha * (spread - this.ema);
      if (this.confirm >= t.twoHandConfirmFrames) {
        this.state = "active";                 // START：会话建立
        this.startSpread = this.ema;
        this.prev = this.ema;
        this.lastMotionAt = now;
      }
      return { fire: null, state: this.state };
    }

    if (this.state !== "active") return { fire: null, state: this.state };
    if (!list || list.length < 2) { this._end(now); return { fire: null, state: this.state }; }

    const spread = this.eng._twoHandSpread(list);
    this.ema += t.twoHandEmaAlpha * (spread - this.ema);
    const delta = clamp(this.ema - this.prev, -t.twoHandMaxDelta, t.twoHandMaxDelta);
    this.prev = this.ema;

    let fire = null;
    if (Math.abs(delta) > t.twoHandDeadzone) {
      this.lastMotionAt = now;
      fire = { type: "zoom", delta: clamp(delta * t.twoHandGain, -t.twoHandMaxStep, t.twoHandMaxStep) };
    }
    // |delta| 在滞回带内：既不确认运动也不重置静止计时

    const backAtNeutral = this.startSpread != null &&
      Math.abs(this.ema - this.startSpread) <= this.startSpread * t.twoHandNeutralBand;
    if (now - this.lastMotionAt > t.twoHandStopHoldMs ||
        (backAtNeutral && now - this.lastMotionAt > t.twoHandNeutralHoldMs)) {
      this._end(now);                          // END：会话结束，进入冷却
    }
    return { fire, state: this.state };
  }
}

/* ================= 引擎 ================= */
class GestureEngine {
  constructor(opts) {
    this.video = opts.video;
    this.locateFile = opts.locateFile;
    this.onAction = opts.onAction || (() => {});
    this.onGesture = opts.onGesture || (() => {});
    this.onStatus = opts.onStatus || (() => {});

    this.t = { ...BASE_THRESHOLDS, _deadScale: 1 };
    this.sensitivity = "normal";

    this._hands = null;
    this._generation = 0;
    this._running = false;
    this._pumpTimer = 0;
    this._healthTimer = 0;

    this.okFSM = new HoldFSM(this, { holdMs: this.t.okHoldMs, cooldownMs: this.t.okCooldownMs, action: "close-tab" });
    this.videoFSM = new HoldFSM(this, { holdMs: this.t.victoryHoldMs, cooldownMs: this.t.victoryCooldownMs, action: "toggle-video" });
    this.nextEpisodeFSM = new HoldFSM(this, { holdMs: this.t.pointingHoldMs, cooldownMs: this.t.pointingCooldownMs, action: "next-episode" });
    this.copyUrlFSM = new HoldFSM(this, { holdMs: this.t.copyHoldMs, cooldownMs: this.t.copyCooldownMs, action: "copy-url" });
    this.seekBackFSM = new HoldFSM(this, { holdMs: this.t.fistHoldMs, cooldownMs: this.t.fistCooldownMs, action: "video-seek-back" });
    this.zoomSession = new TwoHandZoomFSM(this);
    this._resetAll();

    // 帧调度健康层
    this._busy = false; this._sendStartedAt = 0; this._lastSentAt = -Infinity;
    this._lastVideoTime = -1; this._lastSuccessAt = 0; this._instanceHasResults = false;
    this._consecutiveErrors = 0; this._recoveryAttempts = 0; this._recovering = false;
    this._recoveryTimer = 0; this._lastResultAt = 0; this._resultTimes = [];
  }

  setSensitivity(level) {
    if (!SENSITIVITY[level]) return;
    this.sensitivity = level;
    const s = SENSITIVITY[level];
    this.t = { ...BASE_THRESHOLDS, _deadScale: s.deadScale };
    this.t.twoHandDeadzone *= s.deadScale;
    this.t.twoHandStopDeadzone *= s.deadScale;
  }

  _emit(action) { this.onAction(action); }

  _resetAll() {
    this._lockedHand = ""; this._lockLastSeenAt = 0;
    this._posePinchRatioClosed = false;
    this._victoryFrames = 0;
    this._dropFrames = 0;
    this.okFSM.resetAll(); this.videoFSM.resetAll();
    this.nextEpisodeFSM.resetAll(); this.copyUrlFSM.resetAll();
    this.seekBackFSM.resetAll();
    this.zoomSession.reset();
  }

  /* ---------- 生命周期 ---------- */
  async start() {
    this._resetAll();
    if (typeof Hands === "undefined") { this.onStatus("⚠️ 未加载 mediapipe/hands 脚本"); throw new Error("Hands library missing"); }
    this._initInstance();
    this._running = true;
    this._lastSuccessAt = Date.now();
    this._pump();
    this._healthTimer = setInterval(() => this._checkHealth(), 1000);
  }

  stop() {
    this._running = false;
    clearInterval(this._healthTimer);
    clearTimeout(this._pumpTimer);
    clearTimeout(this._recoveryTimer);
    this._closeInstance();
    this.onGesture({ handVisible: false, handCount: 0, gestureLabel: "", holdProgress: 0, landmarks: null, fps: 0, states: {} });
  }

  _closeInstance() {
    const old = this._hands;
    this._hands = null; this._instanceHasResults = false; this._busy = false;
    this._generation++;
    if (old && typeof old.close === "function") {
      try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
    }
  }

  _initInstance() {
    this._closeInstance();
    const generation = this._generation;
    try {
      const instance = new Hands({ locateFile: this.locateFile });
      instance.setOptions({
        maxNumHands: 2,
        modelComplexity: this.t.modelComplexity,
        minDetectionConfidence: this.t.minDetectionConfidence,
        minTrackingConfidence: this.t.minTrackingConfidence
      });
      instance.onResults((results) => {
        if (generation !== this._generation || instance !== this._hands) return;
        this._instanceHasResults = true;
        this._consecutiveErrors = 0; this._recoveryAttempts = 0; this._recovering = false;
        this._lastResultAt = Date.now();
        this.onStatus("");
        try { this._detect(results); } catch (e) { console.warn("[gesture-engine] detect error:", e); }
      });
      this._hands = instance;
      this._busy = false; this._sendStartedAt = 0; this._lastSuccessAt = Date.now();
      return true;
    } catch (e) {
      this.onStatus("⚠️ 识别初始化失败：" + (e && e.message || e));
      return false;
    }
  }

  /* ---------- 送帧节流 + 自动重连 ---------- */
  _pump() {
    if (!this._running) return;
    this._sendFrame();
    this._pumpTimer = setTimeout(() => this._pump(), this.t.frameIntervalMs - 1);
  }

  _sendFrame() {
    const v = this.video, hands = this._hands;
    if (!hands || this._busy || document.hidden) return;
    if (v.readyState < 2 || !v.videoWidth) return;
    const now = Date.now();
    if (now - this._lastSentAt < this.t.frameIntervalMs - 1) return;
    if (v.currentTime === this._lastVideoTime) return;
    this._lastSentAt = now; this._lastVideoTime = v.currentTime;

    const generation = this._generation;
    this._busy = true; this._sendStartedAt = now;
    let task;
    try { task = hands.send({ image: v }); }
    catch (e) { this._onFrameFailure(e, generation); return; }
    if (!task || typeof task.then !== "function") { this._onFrameFailure(new Error("hands.send 未返回 Promise"), generation); return; }
    task.catch(err => this._onFrameFailure(err, generation))
        .then(() => {
          if (generation !== this._generation) return;
          this._busy = false; this._sendStartedAt = 0; this._lastSuccessAt = Date.now();
        });
  }

  _onFrameFailure(err, generation) {
    if (generation !== this._generation) return;
    this._busy = false; this._sendStartedAt = 0;
    this._consecutiveErrors++;
    const text = (err && err.message) ? String(err.message) : String(err || "未知错误");
    console.warn(`[gesture-engine] frame failed (${this._consecutiveErrors}/${this.t.errorLimit}):`, text);
    if (this._recoveryAttempts > 0 || this._consecutiveErrors >= this.t.errorLimit) this._recover(text);
  }

  _recover(reason) {
    if (this._recovering || !this._running) return;
    this._recovering = true;
    this._closeInstance();
    if (this._recoveryAttempts >= this.t.recoveryAttempts) {
      this._recovering = false; this._running = false;
      this.onStatus("⚠️ 识别暂不可用：" + reason + "（请点击停止后重新启动）");
      this.onGesture({ handVisible: false, handCount: 0, gestureLabel: "", holdProgress: 0, landmarks: null, fps: 0, states: {} });
      return;
    }
    const idx = this._recoveryAttempts++;
    const delay = this.t.recoveryDelaysMs[Math.min(idx, this.t.recoveryDelaysMs.length - 1)];
    this.onStatus(`⚠️ ${reason} · 自动重连 ${this._recoveryAttempts}/${this.t.recoveryAttempts}`);
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = setTimeout(() => {
      if (!this._recovering || !this._running || document.hidden) { this._recovering = false; return; }
      if (this._initInstance()) this._recovering = false;
      else { this._recovering = false; this._recover("重建识别实例失败"); }
    }, delay);
  }

  _checkHealth() {
    if (!this._running || this._recovering || document.hidden) return;
    const now = Date.now();
    if (this._busy && this._sendStartedAt &&
        now - this._sendStartedAt > (this._instanceHasResults ? this.t.sendTimeoutMs : this.t.startupTimeoutMs)) {
      this._busy = false; this._sendStartedAt = 0;
      this._recover("识别处理超时");
      return;
    }
    if (this._instanceHasResults && !this._busy &&
        this._lastResultAt && now - this._lastResultAt > this.t.resultTimeoutMs) {
      this._recover("识别长时间没有返回结果");
    }
  }

  /* ---------- 姿态特征 ---------- */
  _extractPose(lm) {
    const eIndex = fingerExtension(lm, 8, 6);
    const eMiddle = fingerExtension(lm, 12, 10);
    const eRing = fingerExtension(lm, 16, 14);
    const ePinky = fingerExtension(lm, 20, 18);
    // 拇指伸展度（拇指尖/拇指指节到手腕的距离比）
    const dThumbTip = Math.hypot(lm[4].x - lm[0].x, lm[4].y - lm[0].y);
    const dThumbIp = Math.hypot(lm[3].x - lm[0].x, lm[3].y - lm[0].y) || 0.001;
    const thumbExt = dThumbTip / dThumbIp;
    // ✌️ V 型：食指+中指伸直且分叉，无名指+小指收拢（判据来自 globe isVictoryGesture，
    // v1.0.3 起不再约束拇指——与 👊 握拳天然互斥）
    const split = Math.hypot(lm[8].x - lm[12].x, lm[8].y - lm[12].y) / palmSize(lm);
    const victory = eIndex > 1.10 && eMiddle > 1.10 &&
      fingerStraight(lm, 8, 5) > 0.56 && fingerStraight(lm, 12, 9) > 0.56 &&
      eRing < 1.04 && ePinky < 1.04 && split > 0.18;
    // 👊 握拳（v1.0.3）：四长指 + 拇指全部收拢
    const fist = eIndex < 1.04 && eMiddle < 1.04 && eRing < 1.04 && ePinky < 1.04 && thumbExt < 1.2;
    const pinchDist = Math.hypot(lm[4].x - lm[8].x, lm[4].y - lm[8].y);
    const ratio = pinchDist / palmSize(lm);
    const otherOpen = (eMiddle > 1.02 ? 1 : 0) + (eRing > 1.02 ? 1 : 0) + (ePinky > 1.02 ? 1 : 0);
    // ☝️ 单伸食指：仅食指伸直，其余三指 + 拇指全部收拢
    const pointing = eIndex > 1.10 && eMiddle < 1.04 && eRing < 1.04 && ePinky < 1.04 && thumbExt < 1.2;
    // 🤟 收拇指伸四指：四长指全部伸直，拇指收拢
    const fourNoThumb = eIndex > 1.08 && eMiddle > 1.08 && eRing > 1.08 && ePinky > 1.08 && thumbExt < 1.2;
    return { victory, fist, ratio, otherOpen: otherOpen >= 1, pointing, fourNoThumb };
  }

  /* 捏合双阈值迟滞 */
  _pinchHysteresis(ratio) {
    if (!this._posePinchRatioClosed && ratio < this.t.pinchCloseRatio) this._posePinchRatioClosed = true;
    else if (this._posePinchRatioClosed && ratio > this.t.pinchReleaseRatio) this._posePinchRatioClosed = false;
    return this._posePinchRatioClosed;
  }

  _twoHandSpread(list) {
    const pa = palmCenter(list[0]), pb = palmCenter(list[1]);
    const ref = (palmSize(list[0]) + palmSize(list[1])) / 2;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y) / ref;
  }

  /* ---------- 主检测 ---------- */
  _detect(results) {
    const now = Date.now();
    this._resultTimes.push(now);
    if (this._resultTimes.length > 20) this._resultTimes.shift();
    let fps = 0;
    if (this._resultTimes.length > 1) {
      const span = (now - this._resultTimes[0]) / 1000;
      if (span > 0) fps = Math.round((this._resultTimes.length - 1) / span);
    }

    let list = (results && results.multiHandLandmarks) || [];

    /* —— 双手通道：缩放会话；期间单手手势静默 —— */
    if (list.length >= 2) {
      this._dropFrames = 0;
      this.okFSM.resetAll(); this.videoFSM.resetAll();
      this.nextEpisodeFSM.resetAll(); this.copyUrlFSM.resetAll();
      this.seekBackFSM.resetAll();
      this._victoryFrames = 0; this._posePinchRatioClosed = false;
      const zs = this.zoomSession.update(list, now);
      if (zs.fire) this._emit(zs.fire);
      this.onGesture({
        handVisible: true, handCount: 2, landmarks: [list[0], list[1]], fps,
        gestureLabel: zs.state === "active" ? "🤲 缩放会话进行中" : "🤲 双手确认中…",
        holdProgress: 0, states: this._debugStates()
      });
      return;
    }
    if (this.zoomSession.state === "active") {
      this.zoomSession.cancel(now);            // 任意一只手消失 → 立即 END/CANCEL
    }
    if (this.zoomSession.state === "cooldown" && now >= this.zoomSession.cooldownUntil) {
      this.zoomSession.reset();
    }
    if (this.zoomSession.state !== "idle") {
      this.onGesture({ handVisible: list.length === 1, handCount: Math.min(list.length, 1), landmarks: list[0] || null, fps, gestureLabel: "🤲 缩放结束，稍候…", holdProgress: 0, states: this._debugStates() });
      return;
    }

    /* —— 单手锁定 —— */
    const handedness = (results && results.multiHandedness) || [];
    const label = handedness[0] && handedness[0].label ? handedness[0].label : "";
    if (!this._lockedHand && label) { this._lockedHand = label; this._lockLastSeenAt = now; }
    if (list.length && this._lockedHand && label && label !== this._lockedHand) {
      if (this._lockLastSeenAt && now - this._lockLastSeenAt > this.t.handLockReleaseMs) {
        this._lockedHand = label; this._lockLastSeenAt = now;
        this._resetAllKeepLock();
      } else {
        list = [];
      }
    } else if (list.length && label === this._lockedHand) {
      this._lockLastSeenAt = now;
    }

    /* —— 手不在画面：保持类手势给丢帧宽限，超时全量复位 —— */
    if (list.length === 0) {
      this._dropFrames++;
      const holding = this.okFSM.state === "holding" || this.videoFSM.state === "holding";
      if (this._dropFrames <= this.t.dropGraceFrames && holding) {
        this.onGesture({ handVisible: false, handCount: 0, gestureLabel: "…", holdProgress: this.okFSM.holdProgress, landmarks: null, fps, states: this._debugStates() });
        return;
      }
      this._resetAllKeepLock();
      this.onGesture({ handVisible: false, handCount: 0, gestureLabel: "手未入画", holdProgress: 0, landmarks: null, fps, states: this._debugStates() });
      return;
    }
    this._dropFrames = 0;

    const lm = list[0];
    const pose = this._extractPose(lm);
    this._victoryFrames = pose.victory ? this._victoryFrames + 1 : 0;

    /* —— 保持类通道（优先级：OK 关标签 > V 型视频）—— */
    const pinchClosedNow = this._pinchHysteresis(pose.ratio);
    const okFire = this.okFSM.update(pinchClosedNow && pose.otherOpen, now);
    if (okFire) {
      this._emit(okFire);
      this.onGesture({ handVisible: true, handCount: 1, landmarks: lm, fps, gestureLabel: "👌 已关闭标签页", holdProgress: 0, states: this._debugStates() });
      return;
    }
    const vidFire = this.videoFSM.update(pose.victory, now);
    if (vidFire) {
      this._emit(vidFire);
      this.onGesture({ handVisible: true, handCount: 1, landmarks: lm, fps, gestureLabel: "✌️ 视频已切换播放/暂停", holdProgress: 0, states: this._debugStates() });
      return;
    }
    /* —— V1.0.1：☝️ 单伸食指 → 下一集；🤟 收拇指伸四指 → 复制链接 —— */
    const nextFire = this.nextEpisodeFSM.update(pose.pointing, now);
    if (nextFire) {
      this._emit(nextFire);
      this.onGesture({ handVisible: true, handCount: 1, landmarks: lm, fps, gestureLabel: "☝️ 已跳转播放下一集", holdProgress: 0, states: this._debugStates() });
      return;
    }
    const copyFire = this.copyUrlFSM.update(pose.fourNoThumb, now);
    if (copyFire) {
      this._emit(copyFire);
      this.onGesture({ handVisible: true, handCount: 1, landmarks: lm, fps, gestureLabel: "🤟 网页链接已复制", holdProgress: 0, states: this._debugStates() });
      return;
    }
    /* —— V1.0.3：👊 握拳 → 视频回退 10 秒 —— */
    const seekFire = this.seekBackFSM.update(pose.fist, now);
    if (seekFire) {
      this._emit(seekFire);
      this.onGesture({ handVisible: true, handCount: 1, landmarks: lm, fps, gestureLabel: "👊 视频已回退 10 秒", holdProgress: 0, states: this._debugStates() });
      return;
    }

    let label2;
    if (this.okFSM.holdProgress > 0) label2 = "👌 保持中…关闭标签页";
    else if (this.videoFSM.state === "holding") label2 = "✌️ 保持中…播放/暂停";
    else if (this.nextEpisodeFSM.state === "holding") label2 = "☝️ 保持中…下一集";
    else if (this.copyUrlFSM.state === "holding") label2 = "🤟 保持中…复制链接";
    else if (this.seekBackFSM.state === "holding") label2 = "👊 保持中…回退 10 秒";
    else if (pose.victory || this._victoryFrames > 0) label2 = "✌️ V 型确认中";
    else if (pinchClosedNow && pose.otherOpen) label2 = "👌 OK 确认中";
    else if (pose.fist) label2 = "👊 握拳确认中";
    else if (pose.pointing) label2 = "☝️ 食指确认中";
    else if (pose.fourNoThumb) label2 = "🤟 四指确认中";
    else label2 = "🖐️ 待命";

    this.onGesture({
      handVisible: true, handCount: 1, landmarks: lm, fps,
      gestureLabel: label2,
      holdProgress: this.okFSM.holdProgress,
      states: this._debugStates()
    });
  }

  _resetAllKeepLock() {
    const lock = this._lockedHand, seen = this._lockLastSeenAt;
    this._resetAll();
    this._lockedHand = lock; this._lockLastSeenAt = seen;
  }

  _debugStates() {
    return {
      ok: this.okFSM.state, video: this.videoFSM.state,
      next: this.nextEpisodeFSM.state, copy: this.copyUrlFSM.state,
      seekBack: this.seekBackFSM.state,
      zoomSession: this.zoomSession.state
    };
  }
}

/* 导出：浏览器侧边栏用 window，测试环境用 module.exports */
if (typeof window !== "undefined" && window) window.GestureEngine = GestureEngine;
if (typeof module !== "undefined" && module.exports) module.exports = { GestureEngine, HoldFSM, TwoHandZoomFSM, palmCenter, fingerExtension };
