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

    default:
      throw new Error("未知动作: " + action);
  }
}
