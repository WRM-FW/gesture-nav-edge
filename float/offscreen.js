/* V1.0.6 · 悬浮窗离屏宿主脚本
 * 职责：悬浮模式期间持有摄像头与 GestureEngine（侧边栏已关闭），
 *  - 每 ~100ms 把画面压成低分辨率 JPEG 发给 background 中继到页面悬浮窗
 *  - 手势识别结果（HUD 文案）同样中继
 *  - 引擎触发的动作统一交给 background 分发（float-action）
 * 逻辑与 panel.js 的启动/分发保持一致，但没有本地 UI。
 */

const video = document.getElementById("camera");
const pump = document.getElementById("pump");
const pctx = pump.getContext("2d");

const FRAME_INTERVAL_MS = 100;   // 悬浮窗预览 ~10fps，够用且省
const FRAME_WIDTH = 480;
const FRAME_QUALITY = 0.55;

let engine = null;
let running = false;
let zoomLevel = 1;
let zoomStoreTimer = 0;
let lastHudText = null;
let settings = { sensitivity: "normal", allowClose: true };
let bindings = null;

/* ---------------- HUD 中继 ---------------- */

function sendHud(text, warn) {
  if (text === lastHudText) return;
  lastHudText = text;
  chrome.runtime.sendMessage({ type: "gn-float-hud", text, warn: !!warn }).catch(() => {});
}

/* ---------------- 动作分发（经 background） ---------------- */

function dispatch(action) {
  if (action.type === "close-tab" && !settings.allowClose) {
    sendHud("⚠ 关闭标签页手势已被设置禁用", true);
    return;
  }
  chrome.runtime.sendMessage({ type: "float-action", action })
    .then(res => {
      if (!res) return;
      if (!res.ok) sendHud("⚠ " + res.error, true);
    })
    .catch(() => {});
}

function clampZoom(z) { return Math.min(4, Math.max(0.3, Math.round(z * 100) / 100)); }

function onAction(action) {
  if (action.type === "zoom") {
    // 面板同款逻辑：连续增量 → 绝对级别（跨悬浮/面板会话经 gn-zoom 延续）
    const next = clampZoom(zoomLevel + action.delta);
    if (Math.abs(next - zoomLevel) < 0.0005) return;
    zoomLevel = next;
    dispatch({ type: "zoom", level: zoomLevel });
    clearTimeout(zoomStoreTimer);
    zoomStoreTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: "gn-zoom-store", level: zoomLevel }).catch(() => {});
    }, 600);
    return;
  }
  dispatch(action);
}

/* ---------------- 手势 → HUD ---------------- */

function onGesture(state) {
  if (state.gestureLabel) sendHud(state.gestureLabel, false);
}

function onStatus(text) {
  if (text) sendHud("⚠ " + text, true);
}

/* ---------------- 帧中继 ---------------- */

let pumping = false;
let pumpTimer = 0;
function startPump() {
  stopPump();
  pumpTimer = setInterval(() => {
    if (pumping || !running || video.readyState < 2) return;
    pumping = true;
    try {
      const w = FRAME_WIDTH;
      const h = Math.round(w * (video.videoHeight / (video.videoWidth || 1))) || Math.round(w * 9 / 16);
      if (pump.width !== w || pump.height !== h) { pump.width = w; pump.height = h; }
      pctx.drawImage(video, 0, 0, w, h);
      const data = pump.toDataURL("image/jpeg", FRAME_QUALITY);
      chrome.runtime.sendMessage({ type: "gn-frame", data }).catch(() => {});
    } catch (e) { /* 单帧失败忽略 */ }
    pumping = false;
  }, FRAME_INTERVAL_MS);
}
function stopPump() { if (pumpTimer) { clearInterval(pumpTimer); pumpTimer = 0; } }

/* ---------------- 摄像头与引擎生命周期 ---------------- */

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 }, height: { ideal: 720 },
      frameRate: { ideal: 30 }
    }
  });
  video.srcObject = stream;
  await new Promise(resolve => {
    if (video.readyState >= 2) return resolve();
    video.onloadedmetadata = () => resolve();
  });
  await video.play().catch(() => {});
}

function stopCamera() {
  const stream = video.srcObject;
  if (stream) stream.getTracks().forEach(t => t.stop());
  video.srcObject = null;
}

async function start() {
  if (running) return;
  try {
    sendHud("启动中…", false);
    // 缩放级别延续上一次会话（面板/悬浮共享）
    try {
      const st = await chrome.storage.local.get(["gn-zoom"]);
      const lv = st && st["gn-zoom"] && st["gn-zoom"].level;
      if (typeof lv === "number") zoomLevel = clampZoom(lv);
    } catch (e) { /* 默认 1 */ }

    await startCamera();
    engine = new GestureEngine({
      video,
      locateFile: (f) => chrome.runtime.getURL("mediapipe/" + f),
      onAction,
      onGesture,
      onStatus
    });
    engine.setSensitivity(settings.sensitivity);
    if (bindings) engine.setGestureConfig(bindings);
    await engine.start();
    running = true;
    startPump();
    sendHud("识别中", false);
  } catch (e) {
    stopCamera();
    engine && engine.stop();
    engine = null;
    running = false;
    const name = e && e.name;
    const hint = name === "NotAllowedError"
      ? "摄像头未授权：请先在侧边栏完成一次授权（🔑 按钮）"
      : name === "NotFoundError"
        ? "未检测到摄像头设备"
        : "悬浮窗启动失败：" + ((e && e.message) || e);
    sendHud("⚠ " + hint, true);
  }
}

function stop() {
  if (!running && !engine) return;
  running = false;
  stopPump();
  if (engine) { engine.stop(); engine = null; }
  stopCamera();
}

/* ---------------- 配置加载与启动 ---------------- */

(async () => {
  try {
    const stored = await chrome.storage.local.get(["gn-settings", "gn-gestures"]);
    if (stored && stored["gn-settings"]) Object.assign(settings, stored["gn-settings"]);
    if (stored && stored["gn-gestures"]) bindings = stored["gn-gestures"];
  } catch (e) { /* 用默认 */ }
  start();
})();

window.addEventListener("pagehide", () => { stop(); });
