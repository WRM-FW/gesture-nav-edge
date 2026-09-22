/* 手势导航 · 内容脚本 v1.0.1
 * 注入 http(s) 页面，执行页面内动作：
 *  - gesture-toggle-video   : ✌️ V 型保持 → 播放/暂停页面内最主要的视频
 *  - gesture-zoom           : 双手缩放会话 → 连续整页缩放（CSS zoom）
 *  - gesture-next-episode   : ☝️ 单伸食指 → 点击"下一集"入口（常见播放器选择器 + 文本匹配）
 *  - gesture-copy-url       : 🤟 收拇指伸四指 → 复制当前网页链接到剪贴板
 * 关闭标签页由侧边栏 → background 代执行，不经过这里。
 */

(() => {
  if (window.__gestureNavControllerLoaded) return;
  window.__gestureNavControllerLoaded = true;

  const ZOOM_MIN = 0.3;
  const ZOOM_MAX = 4.0;
  let zoomLevel = 1;

  function applyZoom(level) {
    zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, level));
    try {
      document.documentElement.style.zoom = String(zoomLevel);
    } catch (e) {
      document.documentElement.style.setProperty("transform", `scale(${zoomLevel})`);
      document.documentElement.style.setProperty("transform-origin", "top left");
    }
    return zoomLevel;
  }

  /* 选“最主要”的视频：可见面积最大者 */
  function pickVideo() {
    const vids = Array.from(document.querySelectorAll("video"));
    let best = null, bestArea = 0;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      const visible = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) *
                      Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
      if (visible > bestArea) { bestArea = visible; best = v; }
    }
    return best;
  }

  function toggleVideo() {
    const v = pickVideo();
    if (!v) return { ok: true, videoFound: false };
    if (!v.paused) {
      v.pause();
      return { ok: true, videoFound: true, playing: false };
    }
    return v.play().then(
      () => ({ ok: true, videoFound: true, playing: true }),
      () => ({ ok: true, videoFound: true, playing: !!v.paused, blocked: true })
    );
  }

  /* ---------- V1.0.1：下一集 ---------- */
  function isVisible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 &&
      r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  }

  function findNextEpisodeControl() {
    // 1) 主流播放器已知选择器
    const known = [
      ".bpx-player-ctrl-next", ".bilibili-player-video-btn-next",  // B 站
      ".ytp-next-button", ".ytp-autonav-countdown-container button", // YouTube
      ".getone-video-next", ".next-video", ".video-next", ".btn-next", ".player-next"
    ];
    for (const sel of known) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    // 2) 通用文本匹配：aria-label / title / 短文本 含"下一集/下集/next"
    const re = /下一集|下集|next\s*(episode|video)|^next$/i;
    const cands = document.querySelectorAll('button, a, [role="button"], [tabindex]');
    for (const el of cands) {
      const label = ((el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("title") || "") + " " +
        (el.textContent || "")).trim();
      if (label.length <= 16 && re.test(label) && isVisible(el)) return el;
    }
    return null;
  }

  function nextEpisode() {
    const el = findNextEpisodeControl();
    if (!el) return { ok: true, found: false };
    try { el.click(); return { ok: true, found: true }; }
    catch (e) { return { ok: false, found: true, error: String(e && e.message || e) }; }
  }

  /* ---------- V1.0.1：复制当前网页链接 ---------- */
  function copyUrl() {
    const url = location.href;
    return navigator.clipboard.writeText(url).then(
      () => ({ ok: true, copied: true }),
      () => {
        // 兜底：临时 textarea + execCommand（manifest 已声明 clipboardWrite）
        try {
          const ta = document.createElement("textarea");
          ta.value = url;
          ta.setAttribute("readonly", "");
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          ta.remove();
          return { ok: true, copied: ok, fallback: true };
        } catch (err) {
          return { ok: false, copied: false, error: String(err && err.message || err) };
        }
      }
    );
  }

  /* ---------- V1.0.2：7️⃣ 视频回退 10 秒 ---------- */
  function seekBackVideo(sec) {
    const v = pickVideo();
    if (!v) return { ok: true, videoFound: false };
    try {
      v.currentTime = Math.max(0, (v.currentTime || 0) - sec);
      return { ok: true, videoFound: true, to: v.currentTime };
    } catch (e) {
      return { ok: false, videoFound: true, error: String(e && e.message || e) };
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return false;

    switch (msg.type) {
      case "gesture-ping":
        sendResponse({ ok: true, zoom: zoomLevel });
        return false;

      case "gesture-toggle-video": {
        const r = toggleVideo();
        if (r && typeof r.then === "function") {
          r.then(res => sendResponse(res)).catch(e => sendResponse({ ok: false, error: String(e) }));
          return true; // 异步应答
        }
        sendResponse(r);
        return false;
      }

      case "gesture-next-episode": {
        sendResponse(nextEpisode());
        return false;
      }

      case "gesture-copy-url": {
        const r = copyUrl();
        if (r && typeof r.then === "function") {
          r.then(res => sendResponse(res)).catch(e => sendResponse({ ok: false, copied: false, error: String(e) }));
          return true; // 异步应答
        }
        sendResponse(r);
        return false;
      }

      case "gesture-video-seek-back":
        sendResponse(seekBackVideo(typeof msg.sec === "number" ? msg.sec : 10));
        return false;

      case "gesture-zoom":
        if (typeof msg.level === "number" && isFinite(msg.level)) {
          sendResponse({ ok: true, zoom: applyZoom(msg.level) });
        }
        return false;

      default:
        return false;
    }
  });
})();
