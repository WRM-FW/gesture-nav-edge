/* 手势导航 · Service Worker
 * 职责：
 *  1) 点击工具栏按钮时打开 Edge 侧边栏（不支持 sidePanel API 时退回独立标签页）
 *  2) 代执行只有扩展后台才能做的动作：关闭当前标签页、切换标签页
 *  3) 帮面板解析“当前活动网页标签”，避免面板直接持有标签操作权
 */

const PANEL_PATH = "panel/panel.html";

/* ---------- 侧边栏注册（带旧版本 Edge 兜底） ---------- */
function trySetupSidePanel() {
  try {
    if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
      return true;
    }
  } catch (e) { /* 旧版本 Edge：没有 sidePanel API */ }
  return false;
}
let sidePanelReady = trySetupSidePanel();
chrome.runtime.onStartup.addListener(() => { sidePanelReady = trySetupSidePanel(); });

/* 尝试通过 contentSettings 给本扩展 origin 直接放行摄像头（能成功就免弹窗；
 * Edge 多数版本会拒绝，失败则静默忽略，走「标签页授权」兜底流程） */
function tryAutoGrantCamera() {
  try {
    const cs = chrome.contentSettings && chrome.contentSettings.camera;
    if (!cs || !cs.setContentSetting) return;
    cs.setContentSetting({
      primaryPattern: chrome.runtime.getURL("").replace(/\/+$/, ""), // chrome-extension://<id>
      setting: "allow"
    }, () => void chrome.runtime.lastError);
  } catch (e) { /* 不支持则忽略 */ }
}
tryAutoGrantCamera();
chrome.runtime.onInstalled.addListener(tryAutoGrantCamera);

chrome.action.onClicked.addListener(async () => {
  if (sidePanelReady) return; // setPanelBehavior 已经接管点击
  chrome.tabs.create({ url: PANEL_PATH });
});

/* ---------- 工具 ---------- */
function isWebPage(url) {
  return !!url && /^https?:\/\//i.test(url);
}

async function getActiveWebTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("没有可用的活动标签页");
  return tab;
}

/* ---------- 消息路由（来自侧边栏面板） ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type === "get-active-tab") {
    getActiveWebTab()
      .then(tab => sendResponse({
        ok: true,
        tabId: tab.id,
        url: tab.url || "",
        supported: isWebPage(tab.url)
      }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // 异步应答
  }

  if (msg.type === "gesture-action") {
    handleAction(msg)
      .then(result => sendResponse({ ok: true, ...result }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  if (msg.type === "get-panel-mode") {
    sendResponse({ sidePanel: sidePanelReady });
    return false;
  }

  /* 侧边栏内无法弹出摄像头授权窗（Chromium 限制）：
   * 以普通标签页打开面板并带 grant=1 标记，在标签页里完成一次性授权 */
  if (msg.type === "open-grant-tab") {
    chrome.tabs.create({ url: PANEL_PATH + "?grant=1", active: true })
      .then(tab => sendResponse({ ok: true, tabId: tab.id }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

async function handleAction(msg) {
  const action = msg && msg.action;
  const tab = await getActiveWebTab();

  switch (action) {
    case "close-tab": {
      // 安全护栏：不允许通过手势关闭扩展自己的页面
      if ((tab.url || "").startsWith(chrome.runtime.getURL(""))) {
        throw new Error("当前活动页是扩展页面，已忽略关闭请求");
      }
      await chrome.tabs.remove(tab.id);
      return { closed: true };
    }

    case "switch-tab": {
      return await switchTab(msg.dir < 0 ? -1 : 1);
    }

    default:
      throw new Error("未知动作: " + action);
  }
}

/* V1.0.5：在普通网页标签之间前后切换（循环），跳过 edge:// / chrome:// 内部页 */
async function switchTab(dir) {
  const tabs = await chrome.tabs.query({ currentWindow: true, windowType: "normal" });
  const usable = tabs.filter(t => typeof t.id === "number" &&
    !String(t.url || "").startsWith("edge://") &&
    !String(t.url || "").startsWith("chrome://"));
  if (usable.length < 2) throw new Error("没有其他可切换的标签页");
  const activeIndex = usable.findIndex(t => t.active);
  if (activeIndex < 0) throw new Error("当前活动页不在可切换列表中");
  const nextIndex = (activeIndex + dir + usable.length) % usable.length;
  const next = usable[nextIndex];
  await chrome.tabs.update(next.id, { active: true });
  return { switched: next.id, forward: dir > 0 };
}

/* ============================================================
 * V1.0.6 · 摄像头悬浮窗
 * 架构：悬浮模式下摄像头与手势引擎搬到 offscreen 文档（侧边栏被关闭后
 * 仍可运行）；页面里由 content/float.js 注入圆角悬浮窗显示画面。
 * 本文件负责：悬浮状态与几何（跨标签页保持）、帧/HUD 中继、
 * 手势指令分发、侧边栏的关闭与点击恢复。
 * offscreen 文档存在期间 service worker 不会被休眠，内存状态可靠；
 * 几何另存一份到 storage 供重装/重启复用。
 * ============================================================ */

const OFFSCREEN_URL = "float/offscreen.html";
const float = {
  active: false,
  tabId: null,        // 当前承载悬浮窗的标签页
  windowId: null,
  geometry: null,     // {x,y,w,h}；x/y 为 null 时悬浮窗自行落到右下角
  resume: false,      // 退出悬浮后，面板加载时自动恢复摄像头
  lastFrame: null,    // 最近一帧 JPEG dataURL，新标签页秒开不黑屏
  lastHud: null
};

function defaultGeometry() {
  return { x: null, y: null, w: 360, h: 202 };
}

function saveFloatState() {
  // 读-改-写：保留面板可能写入的其他键
  chrome.storage.local.get(["gn-float"]).then(st => {
    const f = (st && st["gn-float"]) || {};
    f.active = float.active;
    f.geometry = float.geometry;
    f.resume = float.resume;
    chrome.storage.local.set({ "gn-float": f }).catch(() => {});
  }).catch(() => {});
}

async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error("当前浏览器不支持 offscreen 文档，无法进入悬浮窗模式");
  try { if (await chrome.offscreen.hasDocument()) return; } catch (e) { /* 老版本无 hasDocument */ }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "悬浮窗模式下在页面中显示摄像头画面并进行手势识别"
  });
}

async function closeOffscreen() {
  // 无条件尝试关闭（文档不存在时 reject 直接吞掉），确保摄像头一定被释放
  try { if (chrome.offscreen) await chrome.offscreen.closeDocument(); } catch (e) { /* 忽略 */ }
}

async function showOverlayOn(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "gn-float-show",
      geometry: float.geometry,
      frame: float.lastFrame,
      hud: float.lastHud
    });
  } catch (e) { /* 该页尚未加载 content script，等其 gn-float-hello 上报 */ }
}

async function hideOverlayOn(tabId) {
  if (tabId == null) return;
  try { await chrome.tabs.sendMessage(tabId, { type: "gn-float-hide" }); } catch (e) { /* 页面已关闭 */ }
}

/* 进入悬浮模式（由面板按钮触发；面板须已自行停止摄像头） */
async function floatEnter() {
  if (float.active) return { ok: true, already: true };
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !isWebPage(tab.url)) throw new Error("当前标签页不是普通网页，无法显示悬浮窗");
  if (tab.id === undefined) throw new Error("标签页 ID 不可用");

  await ensureOffscreen();
  // 先探测该页的 content script 是否可达，不可达就别白起引擎
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "gn-float-show", geometry: float.geometry, frame: null, hud: null });
  } catch (e) {
    await closeOffscreen();
    throw new Error("该页面无法注入悬浮窗（可能是特殊页面），请换一个普通网页");
  }
  float.active = true;
  float.resume = false;
  float.tabId = tab.id;
  float.windowId = tab.windowId;
  if (!float.geometry) float.geometry = defaultGeometry();
  saveFloatState();
  closeSidePanel(tab.windowId);
  return { ok: true };
}

/* 彻底退出悬浮模式（不重开面板） */
async function floatCleanup() {
  float.active = false;
  const t = float.tabId;
  float.tabId = null;
  await closeOffscreen();
  hideOverlayOn(t);
  saveFloatState();
}

/* 侧边栏关闭（Chromium 129+ 支持 close；旧版本忽略，面板已停摄像头不影响悬浮） */
function closeSidePanel(windowId) {
  try {
    if (chrome.sidePanel && chrome.sidePanel.close) {
      chrome.sidePanel.close({ windowId }).catch(() => {});
    }
  } catch (e) { /* 不支持则跳过 */ }
}

/* 手势指令分发：页面类指令转发给悬浮窗所在标签页，浏览器级动作本地执行。
 * 动作名与 engine COMMAND_NAMES 一致，映射规则与 panel.js onAction 对齐 */
function pageMsgFor(action) {
  switch (action.type) {
    case "toggle-video":       return { type: "gesture-toggle-video" };
    case "next-episode":       return { type: "gesture-next-episode" };
    case "copy-url":           return { type: "gesture-copy-url" };
    case "video-seek-back":    return { type: "gesture-video-seek-back", sec: action.sec || 10 };
    case "video-seek-forward": return { type: "gesture-video-seek-forward", sec: action.sec || 10 };
    case "volume-up":          return { type: "gesture-video-volume", delta: 0.1 };
    case "volume-down":        return { type: "gesture-video-volume", delta: -0.1 };
    case "scroll-up":          return { type: "gesture-scroll-step", dir: -1 };
    case "scroll-down":        return { type: "gesture-scroll-step", dir: 1 };
    case "zoom":               return { type: "gesture-zoom", level: action.level };
    default: return null;
  }
}

async function floatRunAction(action) {
  if (!action || typeof action.type !== "string") throw new Error("未知指令");
  if (action.type === "close-tab") {
    return await handleAction({ action: "close-tab" });
  }
  if (action.type === "switch-tab-next" || action.type === "switch-tab-prev") {
    return await handleAction({ action: "switch-tab", dir: action.type === "switch-tab-next" ? 1 : -1 });
  }
  const msg = pageMsgFor(action);
  if (!msg) throw new Error("悬浮窗不支持的指令: " + action.type);
  let tabId = float.tabId;
  if (tabId == null) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !isWebPage(tab.url)) throw new Error("当前没有可控制的网页标签");
    tabId = tab.id;
  }
  return await chrome.tabs.sendMessage(tabId, msg);
}

/* ---------- 标签页切换：悬浮窗跟随活动标签页“保持显示” ---------- */
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!float.active) return;
  let tab = null;
  try { tab = await chrome.tabs.get(tabId); } catch (e) { return; }
  if (!isWebPage(tab.url)) {           // 切到 edge:// 等页面：藏起旧窗，状态保留
    await hideOverlayOn(float.tabId);
    float.tabId = null;
    return;
  }
  const prev = float.tabId;
  float.tabId = tabId;
  float.windowId = windowId;
  if (prev != null && prev !== tabId) await hideOverlayOn(prev); // 旧页不留驻冻结画面
  showOverlayOn(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === float.tabId) float.tabId = null; // onActivated 将随新活动页重新锚定
});

/* ---------- 悬浮窗相关消息 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  /* 面板 → 进入悬浮模式 */
  if (msg.type === "float-enter") {
    floatEnter()
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  /* 面板被用户手动打开时发现仍在悬浮 → 面板接管（退出悬浮但不重开侧栏） */
  if (msg.type === "float-takeover") {
    float.resume = false;
    floatCleanup()
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  /* 悬浮窗被点击 → 恢复侧边栏。sidePanel.open 必须在用户手势上下文中
   * 同步发起，因此先调 open，再做异步清理；失败退回标签页打开面板。 */
  if (msg.type === "gn-float-exit") {
    const windowId = sender.tab && sender.tab.windowId;
    float.resume = true;                    // 面板加载后自动重启摄像头
    let opened = false;
    try {
      if (chrome.sidePanel && chrome.sidePanel.open && typeof windowId === "number") {
        chrome.sidePanel.open({ windowId })
          .catch(() => { chrome.tabs.create({ url: PANEL_PATH + "?float-resume=1" }); });
        opened = true;
      }
    } catch (e) { /* open 不可用则直接兜底 */ }
    if (!opened) chrome.tabs.create({ url: PANEL_PATH + "?float-resume=1" });
    floatCleanup();
    sendResponse({ ok: true });
    return false;
  }

  /* offscreen → 帧画面（高频，纯中继，不应答） */
  if (msg.type === "gn-frame") {
    float.lastFrame = msg.data;
    if (float.active && float.tabId != null) {
      chrome.tabs.sendMessage(float.tabId, { type: "gn-frame", data: msg.data }).catch(() => {});
    }
    return false;
  }

  /* offscreen → HUD 文案（手势标签/错误提示） */
  if (msg.type === "gn-float-hud") {
    float.lastHud = { text: msg.text, warn: !!msg.warn };
    if (float.active && float.tabId != null) {
      chrome.tabs.sendMessage(float.tabId, { type: "gn-float-hud", text: msg.text, warn: !!msg.warn }).catch(() => {});
    }
    return false;
  }

  /* 悬浮窗 → 几何变化（拖动/缩放结束上报） */
  if (msg.type === "gn-float-geometry") {
    if (msg.geometry && typeof msg.geometry === "object") {
      float.geometry = msg.geometry;
      saveFloatState();
    }
    return false;
  }

  /* 悬浮窗 content script 加载完成上报：若本标签页应承载悬浮窗则立刻显示 */
  if (msg.type === "gn-float-hello") {
    const tabId = sender.tab && sender.tab.id;
    (async () => {
      if (!float.active) return sendResponse({ show: false });
      if (float.tabId == null && tabId != null) {   // 切页竞态兜底：重新锚定
        float.tabId = tabId;
        float.windowId = sender.tab.windowId;
      }
      const ok = tabId != null && tabId === float.tabId;
      sendResponse({
        show: ok,
        geometry: float.geometry,
        frame: float.lastFrame,
        hud: float.lastHud
      });
    })();
    return true;
  }

  /* offscreen → 手势动作（页面指令或浏览器级动作） */
  if (msg.type === "float-action") {
    floatRunAction(msg.action)
      .then(r => sendResponse({ ok: true, result: r || null }))
      .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  /* offscreen → 缩放级别回存（供面板恢复后连续使用） */
  if (msg.type === "gn-zoom-store") {
    chrome.storage.local.set({ "gn-zoom": { level: msg.level } }).catch(() => {});
    return false;
  }

  return false;
});
