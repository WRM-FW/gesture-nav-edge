/* 手势导航 · 侧边栏面板
 * 职责：摄像头授权与预览、驱动 GestureEngine、把手势动作分发到
 *  - 内容脚本（滚动 / 缩放 / 复位，发给当前活动网页标签）
 *  - background（切换 / 关闭标签页，浏览器级 API）
 */

const $ = (id) => document.getElementById(id);
const video = $("camera");
const overlay = $("overlay");
const octx = overlay.getContext("2d");

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17]
];

let engine = null;
let running = false;
let zoomLevel = 1;
let lastSendErrorAt = 0;
let activeTab = { tabId: null, supported: false };

const settings = {
  sensitivity: "normal",
  allowClose: true,
  autostart: false
};

/* 标签页授权模式：?grant=1 打开时自动启动并引导用户完成一次性授权 */
const GRANT_MODE = new URLSearchParams(location.search).get("grant") === "1";
let grantTabOpened = false;

function openGrantTab() {
  if (grantTabOpened || GRANT_MODE) return;
  grantTabOpened = true;
  chrome.runtime.sendMessage({ type: "open-grant-tab" })
    .then(res => {
      if (res && res.ok) log("已在新标签页打开授权页面，请在弹窗中点「允许」，之后回到侧边栏即可正常使用");
      else { grantTabOpened = false; warnOnce("无法打开授权标签页：" + ((res && res.error) || "未知错误")); }
    })
    .catch(err => { grantTabOpened = false; warnOnce("无法打开授权标签页：" + err.message); });
}

/* ---------------- 状态与日志 ---------------- */

function setPill(text, cls) {
  const pill = $("status-pill");
  pill.textContent = text;
  pill.className = "pill " + cls;
}

function log(text, warn) {
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  li.innerHTML = `<span class="t">${t}</span>${text}`;
  if (warn) li.className = "warn";
  const ul = $("log");
  ul.prepend(li);
  while (ul.children.length > 30) ul.lastChild.remove();
}

/* ---------------- 活动标签页跟踪 ---------------- */

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = (tab && tab.url) || "";
    activeTab = { tabId: tab ? tab.id : null, supported: /^https?:\/\//i.test(url) };
  } catch (e) {
    activeTab = { tabId: null, supported: false };
  }
}
setInterval(refreshActiveTab, 800);
refreshActiveTab();

/* ---------------- 动作分发 ---------------- */

async function sendToContentTab(msg) {
  if (activeTab.tabId == null || !activeTab.supported) {
    warnOnce("当前标签页不支持（edge://、扩展页或尚未加载完成），页面动作已忽略");
    return null;
  }
  try {
    return await chrome.tabs.sendMessage(activeTab.tabId, msg);
  } catch (e) {
    warnOnce("无法连接到页面控制脚本，请刷新该网页后重试");
    return null;
  }
}

function warnOnce(text) {
  const now = Date.now();
  if (now - lastSendErrorAt < 3000) return;
  lastSendErrorAt = now;
  log(text, true);
}

let zoomLogTimer = 0;

function onAction(action) {
  switch (action.type) {
    case "toggle-video":
      sendToContentTab({ type: "gesture-toggle-video" }).then(res => {
        if (!res) return;
        if (!res.videoFound) log("页面中没有找到可控制的视频", true);
        else if (res.blocked) log("浏览器阻止自动播放，请点击视频后手动播放", true);
        else log(res.playing ? "视频已播放 ▶" : "视频已暂停 ⏸");
      });
      break;

    case "zoom": {
      // 连续增量（会话内每帧一个小 delta），面板持有绝对缩放级别
      const next = clampZoom(zoomLevel + action.delta);
      if (Math.abs(next - zoomLevel) < 0.0005) break;
      zoomLevel = next;
      sendToContentTab({ type: "gesture-zoom", level: zoomLevel });
      $("zoom-readout").textContent = Math.round(zoomLevel * 100) + "%";
      clearTimeout(zoomLogTimer);
      zoomLogTimer = setTimeout(() => log(`缩放会话结束 → ${Math.round(zoomLevel * 100)}%`), 500);
      break;
    }

    case "next-episode":
      sendToContentTab({ type: "gesture-next-episode" }).then(res => {
        if (!res) return;
        if (!res.found) log("当前页面未找到「下一集」入口", true);
        else if (res.ok) log("☝️ 已跳转播放下一集");
        else log("点击下一集失败：" + (res.error || ""), true);
      });
      break;

    case "copy-url":
      sendToContentTab({ type: "gesture-copy-url" }).then(res => {
        if (!res) return;
        if (res.copied) log("📋 已复制当前网页链接");
        else log("复制失败：" + (res.error || "页面阻止"), true);
      });
      break;

    case "video-seek-back":
      sendToContentTab({ type: "gesture-video-seek-back", sec: 10 }).then(res => {
        if (!res) return;
        if (!res.videoFound) log("页面中没有找到可控制的视频", true);
        else if (res.ok) log("👊 视频已回退 10 秒 ⏪");
        else log("回退失败：" + (res.error || ""), true);
      });
      break;

    case "close-tab":
      if (!settings.allowClose) { warnOnce("关闭标签页手势已被设置禁用"); break; }
      chrome.runtime.sendMessage({ type: "gesture-action", action: "close-tab" })
        .then(res => {
          if (res && res.ok) log("已关闭当前标签页");
          else if (res && res.error) warnOnce("关闭失败：" + res.error);
        })
        .catch(err => warnOnce("关闭标签页失败：" + err.message));
      break;
  }
}

function clampZoom(z) { return Math.min(4, Math.max(0.3, Math.round(z * 100) / 100)); }

/* ---------------- 骨架绘制（支持单手/双手） ---------------- */

let lastLandmarks = null; // lm 数组，或 [lmA, lmB]
function drawOneHand(lm) {
  const w = overlay.clientWidth, h = overlay.clientHeight;
  octx.strokeStyle = "rgba(79,140,255,.9)";
  octx.lineWidth = 2;
  for (const [a, b] of HAND_CONNECTIONS) {
    octx.beginPath();
    octx.moveTo(lm[a].x * w, lm[a].y * h);
    octx.lineTo(lm[b].x * w, lm[b].y * h);
    octx.stroke();
  }
  octx.fillStyle = "#3ddc84";
  for (const p of lm) {
    octx.beginPath();
    octx.arc(p.x * w, p.y * h, 2.4, 0, Math.PI * 2);
    octx.fill();
  }
}

function drawOverlay() {
  const w = overlay.clientWidth, h = overlay.clientHeight;
  if (overlay.width !== w || overlay.height !== h) { overlay.width = w; overlay.height = h; }
  octx.clearRect(0, 0, w, h);
  if (lastLandmarks) {
    // 视频用 CSS scaleX(-1) 镜像，画布坐标同步镜像
    octx.save();
    octx.translate(w, 0);
    octx.scale(-1, 1);
    if (Array.isArray(lastLandmarks[0])) lastLandmarks.forEach(drawOneHand);
    else drawOneHand(lastLandmarks);
    octx.restore();
  }
  requestAnimationFrame(drawOverlay);
}
requestAnimationFrame(drawOverlay);

/* ---------------- 手势可视化（卡片高亮 / 倒计时环） ---------------- */

const CARD_BY_LABEL = [
  ["缩放", "card-zoom"], ["放大", "card-zoom"], ["缩小", "card-zoom"],
  ["关闭", "card-close"],
  ["视频", "card-video"], ["播放", "card-video"], ["V 型", "card-video"],
  ["下一集", "card-next"], ["食指", "card-next"],
  ["复制", "card-copy"], ["四指", "card-copy"], ["链接", "card-copy"],
  ["回退", "card-seek"], ["握拳", "card-seek"]
];

function onGesture(state) {
  lastLandmarks = state.handVisible ? state.landmarks : null;

  // 倒计时环（OK 保持 → 关闭标签页）
  const ring = $("victory-ring");
  const fg = $("ring-fg");
  const progress = state.holdProgress || 0;
  if (progress > 0) {
    ring.classList.add("show");
    const C = 263.9;
    fg.style.strokeDashoffset = String(C * (1 - progress));
  } else {
    ring.classList.remove("show");
  }

  $("gesture-label").textContent = state.gestureLabel || "";
  $("fps-readout").textContent = state.fps ? state.fps + " fps" : "--";

  document.querySelectorAll(".card").forEach(c => c.classList.remove("active"));
  const label = state.gestureLabel || "";
  for (const [key, id] of CARD_BY_LABEL) {
    if (label.includes(key)) { $(id).classList.add("active"); break; }
  }
}

function onStatus(text) {
  if (!running) return;
  if (text) setPill("识别异常", "err");
  else setPill("识别中", "on");
  if (text && text.includes("暂不可用")) {
    log(text, true);
  }
}

/* ---------------- 摄像头与引擎生命周期 ---------------- */

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 }, height: { ideal: 720 },   // v3：更高分辨率，快速挥动关键点更稳
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
  setPill("启动中…", "off");
  try {
    await startCamera();
    engine = new GestureEngine({
      video,
      locateFile: (f) => chrome.runtime.getURL("mediapipe/" + f),
      onAction,
      onGesture,
      onStatus
    });
    engine.setSensitivity(settings.sensitivity);
    await engine.start();
    running = true;
    setPill(GRANT_MODE ? "授权模式 · 识别中" : "识别中", "on");
    $("toggle-btn").textContent = "■ 停止手势";
    $("toggle-btn").classList.add("running");
    log("手势识别已启动");
    if (GRANT_MODE) log("✅ 摄像头授权成功！可关闭本标签页，回到侧边栏正常使用");
  } catch (e) {
    stopCamera();
    engine && engine.stop();
    engine = null;
    running = false;
    const name = e && e.name;
    if (name === "NotAllowedError") {
      setPill("待授权", "err");
      if (GRANT_MODE) {
        log("标签页内仍被拒绝：请到 edge://settings/content/camera 检查禁止列表，并确认 Windows 隐私设置中的摄像头开关", true);
      } else {
        log("侧边栏无法弹出授权窗（浏览器限制），正在打开标签页授权…", true);
        openGrantTab();
      }
    } else {
      const hint = name === "NotFoundError"
        ? "未检测到摄像头设备（也请检查 Windows 设置 → 隐私 → 摄像头）"
        : "启动失败：" + ((e && e.message) || e);
      setPill("未启动", "err");
      log(hint, true);
    }
  }
}

function stop() {
  if (!running && !engine) return;
  running = false;

  if (engine) { engine.stop(); engine = null; }
  stopCamera();
  setPill("未启动", "off");
  $("toggle-btn").textContent = "▶ 启动手势";
  $("toggle-btn").classList.remove("running");
  $("gesture-label").textContent = "";
  log("手势识别已停止");
}

$("toggle-btn").addEventListener("click", () => (running ? stop() : start()));
$("grant-btn").addEventListener("click", () => {
  if (GRANT_MODE) start();      // 已在授权标签页里：直接重试启动
  else { grantTabOpened = false; openGrantTab(); }
});

/* ---------------- 设置持久化 ---------------- */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(["gn-settings"]);
    if (stored && stored["gn-settings"]) Object.assign(settings, stored["gn-settings"]);
  } catch (e) { /* 首次运行 */ }
  $("sensitivity").value = settings.sensitivity;
  $("allow-close").checked = settings.allowClose;
  $("autostart").checked = settings.autostart;
}

function saveSettings() {
  chrome.storage.local.set({ "gn-settings": settings }).catch(() => {});
}

$("sensitivity").addEventListener("change", (e) => {
  settings.sensitivity = e.target.value;
  if (engine) engine.setSensitivity(settings.sensitivity);
  saveSettings();
});
$("allow-close").addEventListener("change", (e) => {
  settings.allowClose = e.target.checked;
  saveSettings();
});
$("autostart").addEventListener("change", (e) => {
  settings.autostart = e.target.checked;
  saveSettings();
});

/* ---------------- 页面生命周期 ---------------- */

window.addEventListener("pagehide", () => { if (engine) engine.stop(); stopCamera(); });

(async () => {
  await loadSettings();
  if (GRANT_MODE) {
    setPill("授权模式", "off");
    log("标签页授权模式：点击下方按钮（或系统询问时选「允许」）完成摄像头授权");
    start();                     // 标签页里 getUserMedia 会正常弹出授权询问
  } else if (settings.autostart) {
    start();
  }
})();
