/* V1.0.6 · 页面内摄像头悬浮窗（content script 覆盖层）
 * 由 background 在悬浮模式下通过 gn-float-show 唤起：
 *  - Shadow DOM 隔离页面样式，圆角矩形 + 描边 + 投影
 *  - gn-frame 推送的低频 JPEG 帧实时显示（镜像自拍视角）
 *  - 边缘/角落八向拖拽缩放，窗体拖拽移动，几何上报 background（跨标签页一致）
 *  - 单击（非拖动）→ 退出悬浮窗并恢复侧边栏面板
 */
(() => {
  if (window.__gnFloatLoaded) return;
  window.__gnFloatLoaded = true;

  const MIN_W = 200, MIN_H = 120, EDGE = 14, MARGIN = 12, DEFAULT_W = 360;
  let host = null, shadow = null, box = null, img = null, hud = null, hint = null;
  let geom = null;          // {x,y,w,h} 绝对坐标
  let visible = false;
  let lastFrame = null;
  let lastHud = null;

  /* ---------------- 几何工具 ---------------- */

  function viewport() { return { vw: innerWidth, vh: innerHeight }; }

  function normalize(g) {
    const { vw, vh } = viewport();
    let w = Math.max(MIN_W, Math.min((g && g.w) || DEFAULT_W, vw * 0.92));
    let h = Math.max(MIN_H, Math.min((g && g.h) || Math.round(w * 9 / 16), vh * 0.92));
    let x = g && typeof g.x === "number" ? g.x : vw - w - 28;
    let y = g && typeof g.y === "number" ? g.y : vh - h - 28;
    x = Math.max(4, Math.min(x, vw - w - 4));
    y = Math.max(4, Math.min(y, vh - h - 4));
    return { x, y, w, h };
  }

  function reportGeom() {
    try { chrome.runtime.sendMessage({ type: "gn-float-geometry", geometry: geom }); } catch (e) {}
  }

  function applyGeom() {
    if (!host || !geom) return;
    host.style.left = geom.x + "px";
    host.style.top = geom.y + "px";
    host.style.width = geom.w + "px";
    host.style.height = geom.h + "px";
  }

  /* ---------------- 构建（Shadow DOM） ---------------- */

  function build() {
    host = document.createElement("div");
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;left:0;top:0;";
    shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      .box{position:absolute;inset:0;border-radius:18px;overflow:hidden;
        background:#10131a;border:1px solid rgba(255,255,255,.18);
        box-shadow:0 14px 44px rgba(0,0,0,.55),0 0 0 1px rgba(0,0,0,.35);
        transition:border-color .18s, box-shadow .18s;}
      .box:hover{border-color:rgba(79,140,255,.55);}
      .frame{width:100%;height:100%;object-fit:cover;display:block;
        transform:scaleX(-1);user-select:none;-webkit-user-drag:none;pointer-events:none;}
      .wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
        color:#8b93a7;font:13px/1 system-ui,"Microsoft YaHei",sans-serif;letter-spacing:.5px;}
      .hud{position:absolute;left:0;right:0;bottom:0;padding:22px 12px 8px;
        background:linear-gradient(transparent,rgba(0,0,0,.62));
        color:#eef2ff;font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif;
        text-align:center;pointer-events:none;opacity:0;transition:opacity .25s;
        text-shadow:0 1px 3px rgba(0,0,0,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
      .hud.show{opacity:1;}
      .hud.warn{color:#ffb1b1;}
      .hint{position:absolute;top:6px;left:0;right:0;text-align:center;
        color:rgba(255,255,255,.75);font:11px/1 system-ui,"Microsoft YaHei",sans-serif;
        pointer-events:none;opacity:0;transition:opacity .2s;}
      .box:hover .hint{opacity:1;}
      .h{position:absolute;z-index:3;}
      .h.n{top:-3px;left:${EDGE}px;right:${EDGE}px;height:8px;cursor:n-resize;}
      .h.s{bottom:-3px;left:${EDGE}px;right:${EDGE}px;height:8px;cursor:s-resize;}
      .h.w{left:-3px;top:${EDGE}px;bottom:${EDGE}px;width:8px;cursor:w-resize;}
      .h.e{right:-3px;top:${EDGE}px;bottom:${EDGE}px;width:8px;cursor:e-resize;}
      .h.nw{top:-5px;left:-5px;width:18px;height:18px;cursor:nwse-resize;}
      .h.ne{top:-5px;right:-5px;width:18px;height:18px;cursor:nesw-resize;}
      .h.sw{bottom:-5px;left:-5px;width:18px;height:18px;cursor:nesw-resize;}
      .h.se{bottom:-5px;right:-5px;width:18px;height:18px;cursor:nwse-resize;}
      .dot{position:absolute;width:7px;height:7px;border-radius:50%;
        background:rgba(79,140,255,.0);border:1px solid rgba(255,255,255,.0);
        transition:background .18s,border-color .18s;pointer-events:none;}
      .box:hover .dot{background:rgba(79,140,255,.9);border-color:rgba(255,255,255,.7);}
      .dot.nw{top:5px;left:5px;}.dot.ne{top:5px;right:5px;}
      .dot.sw{bottom:5px;left:5px;}.dot.se{bottom:5px;right:5px;}
      .body{position:absolute;inset:0;cursor:grab;}
      .body.dragging{cursor:grabbing;}
      `;
    const b = document.createElement("div");
    b.className = "box";
    b.innerHTML = `
      <img class="frame" alt=""/>
      <div class="wait">等待画面…</div>
      <div class="body"></div>
      <div class="hud"></div>
      <div class="hint">单击返回侧边栏 · 拖动移动 · 拖边缩放</div>
      <i class="dot nw"></i><i class="dot ne"></i><i class="dot sw"></i><i class="dot se"></i>
      <div class="h n"  data-dir="n"></div><div class="h s"  data-dir="s"></div>
      <div class="h w"  data-dir="w"></div><div class="h e"  data-dir="e"></div>
      <div class="h nw" data-dir="nw"></div><div class="h ne" data-dir="ne"></div>
      <div class="h sw" data-dir="sw"></div><div class="h se" data-dir="se"></div>`;
    shadow.appendChild(style);
    shadow.appendChild(b);
    box = b;
    img = b.querySelector(".frame");
    hud = b.querySelector(".hud");
    hint = b.querySelector(".hint");
    bindInteractions(b);
    (document.body || document.documentElement).appendChild(host);
  }

  /* ---------------- 交互：缩放 / 移动 / 单击恢复 ---------------- */

  function bindInteractions(b) {
    // 缩放手柄
    b.querySelectorAll(".h").forEach(el => {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault(); e.stopPropagation();
        const dir = el.dataset.dir;
        const s = { mx: e.clientX, my: e.clientY, ...geom };
        const move = (ev) => {
          const dx = ev.clientX - s.mx, dy = ev.clientY - s.my;
          let { x, y, w, h } = s;
          if (dir.includes("e")) w = s.w + dx;
          if (dir.includes("s")) h = s.h + dy;
          if (dir.includes("w")) { w = s.w - dx; x = s.x + dx; }
          if (dir.includes("n")) { h = s.h - dy; y = s.y + dy; }
          if (w < MIN_W) { if (dir.includes("w")) x -= MIN_W - w; w = MIN_W; }
          if (h < MIN_H) { if (dir.includes("n")) y -= MIN_H - h; h = MIN_H; }
          const { vw, vh } = viewport();
          w = Math.min(w, vw * 0.92); h = Math.min(h, vh * 0.92);
          x = Math.max(4, Math.min(x, vw - w - 4));
          y = Math.max(4, Math.min(y, vh - h - 4));
          geom = { x, y, w, h };
          applyGeom();
        };
        const up = () => {
          removeEventListener("pointermove", move);
          removeEventListener("pointerup", up);
          reportGeom();
        };
        addEventListener("pointermove", move);
        addEventListener("pointerup", up);
      });
    });

    // 窗体：拖动移动；未位移的短按 = 单击 → 退出悬浮窗恢复面板
    const body = b.querySelector(".body");
    body.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const s = { mx: e.clientX, my: e.clientY, x: geom.x, y: geom.y, t: Date.now(), moved: false };
      const move = (ev) => {
        const dx = ev.clientX - s.mx, dy = ev.clientY - s.my;
        if (!s.moved && Math.hypot(dx, dy) < 5) return;
        s.moved = true;
        body.classList.add("dragging");
        const { vw, vh } = viewport();
        geom = {
          ...geom,
          x: Math.max(4, Math.min(s.x + dx, vw - geom.w - 4)),
          y: Math.max(4, Math.min(s.y + dy, vh - geom.h - 4))
        };
        applyGeom();
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        body.classList.remove("dragging");
        if (s.moved) { reportGeom(); return; }
        if (Date.now() - s.t < 500) exitToPanel();   // 单击
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
  }

  function exitToPanel() {
    hide();
    try { chrome.runtime.sendMessage({ type: "gn-float-exit", geometry: geom }); } catch (e) {}
  }

  /* ---------------- 显示 / 隐藏 / 消息 ---------------- */

  function setFrame(data) {
    if (!data) return;
    lastFrame = data;
    const wait = box && box.querySelector(".wait");
    if (wait) wait.style.display = "none";
    if (img) img.src = data;
  }

  function setHud(text, warn) {
    lastHud = { text, warn };
    if (!hud) return;
    hud.textContent = text || "";
    hud.classList.toggle("show", !!text);
    hud.classList.toggle("warn", !!warn);
  }

  function show(payload) {
    payload = payload || {};
    geom = normalize(payload.geometry);
    if (!host) build();
    visible = true;
    applyGeom();
    if (payload.frame) setFrame(payload.frame); else if (lastFrame) setFrame(lastFrame);
    if (payload.hud) setHud(payload.hud.text, payload.hud.warn);
  }

  function hide() {
    visible = false;
    if (host) { host.remove(); host = null; shadow = null; box = null; img = null; hud = null; }
  }

  addEventListener("resize", () => {
    if (visible && host) { geom = normalize(geom); applyGeom(); reportGeom(); }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "gn-float-show": show(msg); break;
      case "gn-frame": if (visible) setFrame(msg.data); break;
      case "gn-float-hud": if (visible) setHud(msg.text, msg.warn); break;
      case "gn-float-hide": hide(); break;
    }
    return false;
  });

  /* 页面加载完成即上报：若正处于悬浮模式且本标签页是承载页，立刻恢复显示
   * （保证切换标签 / 新开页面时悬浮窗“不消失、不重建感”） */
  try {
    chrome.runtime.sendMessage({ type: "gn-float-hello" }, (res) => {
      if (chrome.runtime.lastError || !res || !res.show) return;
      show({ geometry: res.geometry, frame: res.frame, hud: res.hud });
    });
  } catch (e) { /* 扩展重载后的旧页面，忽略 */ }
})();
