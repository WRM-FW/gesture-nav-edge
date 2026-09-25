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
/* V1.0.6：悬浮窗点击恢复（sidePanel.open 不可用时的标签页兜底）也自动启动 */
const FLOAT_RESUME = new URLSearchParams(location.search).get("float-resume") === "1";
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
      zoomLogTimer = setTimeout(() => {
        log(`缩放会话结束 → ${Math.round(zoomLevel * 100)}%`);
        chrome.storage.local.set({ "gn-zoom": { level: zoomLevel } }).catch(() => {});
      }, 500);
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

    case "video-seek-forward":
      sendToContentTab({ type: "gesture-video-seek-forward", sec: 10 }).then(res => {
        if (!res) return;
        if (!res.videoFound) log("页面中没有找到可控制的视频", true);
        else if (res.ok) log("视频已前进 10 秒 ⏩");
        else log("前进失败：" + (res.error || ""), true);
      });
      break;

    case "volume-up":
    case "volume-down": {
      const delta = action.type === "volume-up" ? 0.1 : -0.1;
      sendToContentTab({ type: "gesture-video-volume", delta }).then(res => {
        if (!res) return;
        if (!res.videoFound) log("页面中没有找到可控制的视频", true);
        else log(`音量 → ${Math.round(res.volume * 100)}%` + (res.volume <= 0 ? "（已静音）" : ""));
      });
      break;
    }

    case "scroll-up":
    case "scroll-down": {
      const dir = action.type === "scroll-down" ? 1 : -1;
      sendToContentTab({ type: "gesture-scroll-step", dir });
      log(dir > 0 ? "页面向下滚一屏×0.6" : "页面向上滚一屏×0.6");
      break;
    }

    case "switch-tab-next":
    case "switch-tab-prev": {
      const dir = action.type === "switch-tab-next" ? 1 : -1;
      chrome.runtime.sendMessage({ type: "gesture-action", action: "switch-tab", dir })
        .then(res => {
          if (res && res.ok) log(`已切换到${dir > 0 ? "下" : "上"}一个标签页`);
          else if (res && res.error) warnOnce("切换标签页失败：" + res.error);
        })
        .catch(err => warnOnce("切换标签页失败：" + err.message));
      break;
    }

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

/* ---------------- 手势 · 指令映射（V1.0.4 自定义配置） ---------------- */

const GESTURE_SLOTS = [
  { id: "twoHand",  icon: "🤲", name: "双手相远 / 相近", hint: "连续会话", fixedCmd: "zoom" },
  { id: "victory",  icon: "✌️", name: "V 型保持 0.6s", hint: "食指中指伸、无名小指收" },
  { id: "fist",     icon: "👊", name: "握拳保持 0.8s", hint: "五指全部收拢" },
  { id: "pointing", icon: "☝️", name: "单伸食指保持 0.4s", hint: "仅食指伸出" },
  { id: "four",     icon: "🤟", name: "收拇指伸四指保持 0.4s", hint: "L 形" },
  { id: "ok",       icon: "👌", name: "OK 保持 0.8s", hint: "高风险操作", danger: true }
];
const COMMAND_OPTIONS = [
  ["toggle-video", "视频播放 / 暂停"],
  ["video-seek-back", "视频回退 10 秒"],
  ["video-seek-forward", "视频前进 10 秒"],
  ["volume-up", "音量增加"],
  ["volume-down", "音量降低"],
  ["scroll-up", "页面向上滚动"],
  ["scroll-down", "页面向下滚动"],
  ["next-episode", "播放下一集"],
  ["copy-url", "复制网页链接"],
  ["switch-tab-next", "切换下一个标签页"],
  ["switch-tab-prev", "切换上一个标签页"],
  ["close-tab", "关闭标签页"]
];
const DEFAULT_BINDINGS = {
  twoHand:  { enabled: true },
  victory:  { enabled: true, command: "toggle-video" },
  fist:     { enabled: true, command: "video-seek-back" },
  pointing: { enabled: true, command: "next-episode" },
  four:     { enabled: true, command: "copy-url" },
  ok:       { enabled: true, command: "close-tab" }
};

let bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));

function applyGestureConfig() {
  if (engine) engine.setGestureConfig(bindings);
}

function renderGestureList() {
  const list = $("gesture-list");
  list.innerHTML = "";
  for (const slot of GESTURE_SLOTS) {
    const cfg = bindings[slot.id];
    const row = document.createElement("div");
    row.className = "g-row" + (slot.danger ? " danger" : "");
    row.dataset.slot = slot.id;

    const icon = document.createElement("span");
    icon.className = "g-icon";
    icon.textContent = slot.icon;

    const info = document.createElement("div");
    info.className = "g-info";
    info.innerHTML = `<b>${slot.name}</b><small>${slot.hint || ""}</small>`;

    row.append(icon, info);

    if (slot.fixedCmd) {
      const fixed = document.createElement("span");
      fixed.className = "g-cmd fixed";
      fixed.textContent = (COMMAND_OPTIONS.map(([v, n]) => v === slot.fixedCmd ? n : "")[0] || slot.fixedCmd) + "（固定）";
      row.appendChild(fixed);
    } else {
      const sel = document.createElement("select");
      sel.className = "g-cmd";
      for (const [val, name] of COMMAND_OPTIONS) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = name;
        sel.appendChild(opt);
      }
      sel.value = cfg.command;
      sel.addEventListener("change", () => {
        bindings[slot.id].command = sel.value;
        saveGestureConfig();
        applyGestureConfig();
        log(`已重绑 ${slot.icon} ${slot.name} → ${sel.selectedOptions[0].textContent}`);
      });
      row.appendChild(sel);
    }

    const label = document.createElement("label");
    label.className = "switch";
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = !!cfg.enabled;
    chk.addEventListener("change", () => {
      bindings[slot.id].enabled = chk.checked;
      row.classList.toggle("off", !chk.checked);
      saveGestureConfig();
      applyGestureConfig();
      log(`${slot.icon} ${slot.name} 已${chk.checked ? "启用" : "关闭"}`);
    });
    const knob = document.createElement("span");
    label.append(chk, knob);
    row.appendChild(label);

    if (!cfg.enabled) row.classList.add("off");
    list.appendChild(row);
  }
}

$("reset-gestures").addEventListener("click", () => {
  bindings = JSON.parse(JSON.stringify(DEFAULT_BINDINGS));
  renderGestureList();
  saveGestureConfig();
  applyGestureConfig();
  log("手势映射已恢复默认");
});

function saveGestureConfig() {
  chrome.storage.local.set({ "gn-gestures": bindings }).catch(() => {});
}

function onGesture(state) {
  lastLandmarks = state.handVisible ? state.landmarks : null;

  // 倒计时环（OK 保持进度）
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

  // 高亮当前正在保持/触发的 gesture 行
  const label = state.gestureLabel || "";
  document.querySelectorAll(".g-row").forEach(r => {
    const slot = GESTURE_SLOTS.find(s => s.id === r.dataset.slot);
    r.classList.toggle("active", !!slot && slot.icon !== "🤲" && label.includes(slot.icon));
  });
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
    // V1.0.6：缩放级别延续上一会话（与悬浮窗 offscreen 共享 gn-zoom）
    try {
      const zst = await chrome.storage.local.get(["gn-zoom"]);
      const lv = zst && zst["gn-zoom"] && zst["gn-zoom"].level;
      if (typeof lv === "number") {
        zoomLevel = clampZoom(lv);
        $("zoom-readout").textContent = Math.round(zoomLevel * 100) + "%";
      }
    } catch (e) { /* 默认从 100% 起 */ }
    await startCamera();
    engine = new GestureEngine({
      video,
      locateFile: (f) => chrome.runtime.getURL("mediapipe/" + f),
      onAction,
      onGesture,
      onStatus
    });
    engine.setSensitivity(settings.sensitivity);
    engine.setGestureConfig(bindings);
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

/* ---------------- V1.0.6 · 悬浮窗模式 ---------------- */

async function enterFloatMode() {
  if (GRANT_MODE) { log("授权标签页不支持悬浮窗模式", true); return; }
  stop();                      // 先释放摄像头，交给 offscreen 宿主
  try {
    const res = await chrome.runtime.sendMessage({ type: "float-enter" });
    if (res && res.ok) {
      // 成功后侧边栏会被 background 自动关闭；不支持 close 的旧版本停留在此页
      log("已切入悬浮窗模式：拖边缩放，单击悬浮窗返回面板");
    } else {
      log("进入悬浮窗失败：" + ((res && res.error) || "未知错误"), true);
    }
  } catch (e) {
    log("进入悬浮窗失败：" + (e.message || e), true);
  }
}
$("float-btn").addEventListener("click", enterFloatMode);

/* ---------------- 设置持久化 ---------------- */

async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(["gn-settings", "gn-gestures"]);
    if (stored && stored["gn-settings"]) Object.assign(settings, stored["gn-settings"]);
    if (stored && stored["gn-gestures"]) {
      const src = stored["gn-gestures"];
      for (const slot in bindings) if (src[slot]) Object.assign(bindings[slot], src[slot]);
    } else if (settings.allowClose === false) {
      // 迁移旧版全局开关：禁止关标签 → 关掉默认的 close-tab 槽位（OK）
      bindings.ok.enabled = false;
    }
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
  renderGestureList();
  if (GRANT_MODE) {
    $("float-btn").style.display = "none";
    setPill("授权模式", "off");
    log("标签页授权模式：点击下方按钮（或系统询问时选「允许」）完成摄像头授权");
    start();                     // 标签页里 getUserMedia 会正常弹出授权询问
    return;
  }
  // V1.0.6：悬浮窗联动——面板被手动打开时接管悬浮窗；被点击恢复时自动启动
  let f = null;
  try {
    const st = await chrome.storage.local.get(["gn-float"]);
    f = st && st["gn-float"];
  } catch (e) { /* 无状态 */ }
  if (f && f.active) {
    try { await chrome.runtime.sendMessage({ type: "float-takeover" }); } catch (e) { /* 忽略 */ }
    log("检测到悬浮窗模式，已收回侧边栏");
    await new Promise(r => setTimeout(r, 300));   // 等 offscreen 卸载、摄像头释放
    start();
    return;
  }
  if (FLOAT_RESUME || (f && f.resume)) {
    try {
      await chrome.storage.local.set({ "gn-float": Object.assign({}, f, { resume: false }) });
    } catch (e) { /* 忽略 */ }
    log("已从悬浮窗返回侧边栏");
    await new Promise(r => setTimeout(r, 300));   // 等 offscreen 卸载、摄像头释放
    start();
    return;
  }
  if (settings.autostart) start();
})();
