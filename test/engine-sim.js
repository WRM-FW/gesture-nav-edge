/* 手势引擎 v3.2 · 仿真测试（精简手势集：双手缩放 / V 型视频 / OK 关标签）
 * 契约：
 *  A. 保持类手势：候选(≥3帧)→保持计时→触发一次→LOCKED(姿态释放才解锁)→冷却→重新待命
 *  B. 双手缩放：IDLE→START→ACTIVE(逐帧增量)→END/CANCEL→冷却→重新START
 *  C. 丢跟踪宽限：保持进行中短暂丢失(≤6帧)可续算；超时消失全量复位
 * 运行： node test/engine-sim.js
 */
"use strict";

const path = require("path");
const { GestureEngine: Engine } = require(path.join(__dirname, "..", "engine", "gesture-engine.js"));

/* ---------- 时间 mock ---------- */
let fakeNow = 1000000;
const realNow = Date.now;
Date.now = () => fakeNow;

/* ---------- 合成手模型 ---------- */
function P(x, y, z) { return { x, y, z: z || 0 }; }

function baseOpenHand() {
  return {
    0: P(0.50, 0.90),
    1: P(0.44, 0.78), 2: P(0.40, 0.72), 3: P(0.37, 0.66),
    4: P(0.30, 0.52),
    5: P(0.38, 0.62), 6: P(0.34, 0.45), 7: P(0.32, 0.36), 8: P(0.30, 0.25),
    9: P(0.46, 0.60), 10: P(0.46, 0.42), 11: P(0.46, 0.31), 12: P(0.46, 0.20),
    13: P(0.55, 0.61), 14: P(0.56, 0.48), 15: P(0.57, 0.38), 16: P(0.58, 0.28),
    17: P(0.63, 0.64), 18: P(0.64, 0.52), 19: P(0.65, 0.42), 20: P(0.66, 0.30)
  };
}
function victoryHand() {       // ✌️ 食指+中指伸（分叉），无名指+小指收
  const m = baseOpenHand();
  m[16] = P(0.56, 0.55); m[20] = P(0.63, 0.58);
  return m;
}
function fistHand() {          // 👊 握拳：四长指 + 拇指全部收拢（v1.0.3）
  const m = baseOpenHand();
  m[8] = P(0.36, 0.55); m[12] = P(0.46, 0.55); m[16] = P(0.56, 0.55); m[20] = P(0.63, 0.58);
  m[4] = P(0.42, 0.62);
  return m;
}
function pinchHand() {         // 👌 拇指食指靠拢，其余三指伸
  const m = baseOpenHand();
  m[8] = P(0.36, 0.28); m[4] = P(0.32, 0.30);
  return m;
}
function pointHand() {         // ☝️ 只伸食指：其余三指 + 拇指全部收拢
  const m = baseOpenHand();
  m[12] = P(0.46, 0.55); m[16] = P(0.56, 0.55); m[20] = P(0.63, 0.58);
  m[4] = P(0.42, 0.62);
  return m;
}
function fourHand() {          // 🤟 收拇指伸四指
  const m = baseOpenHand();
  m[4] = P(0.42, 0.62);
  return m;
}
function shiftAll(map, dx, dy) {
  const out = {};
  for (const k in map) out[k] = P(map[k].x + dx, map[k].y + dy, map[k].z);
  return out;
}
function asList(map) {
  const arr = [];
  for (let i = 0; i <= 20; i++) arr.push(map[i]);
  return arr;
}

/* ---------- 脚手架 ---------- */
const actions = [];
const engine = new Engine({
  video: {}, locateFile: f => f,
  onAction: a => actions.push(a),
  onGesture: () => {}, onStatus: () => {}
});

function feedMulti(hands) {
  engine._detect({
    multiHandLandmarks: hands.map(asList),
    multiHandedness: hands.map((_, i) => ({ label: i === 0 ? "Right" : "Left" }))
  });
}
function feed(map) { feedMulti(map ? [map] : []); }
function step() { fakeNow += 33; }
function frames(n, map) { for (let i = 0; i < n; i++) { step(); feed(map); } }
/* 段落切换：送 16 空帧（>丢帧宽限 6 帧，且 >缩放会话冷却 500ms），保证全量复位 */
function teleport(map, n = 1) {
  fakeNow += 100;
  for (let i = 0; i < 16; i++) { step(); feedMulti([]); }
  if (map) frames(n, map);
}
function count(type) { return actions.filter(a => a.type === type).length; }
function takeAll(type) {
  const out = actions.filter(a => a.type === type);
  for (let i = actions.length - 1; i >= 0; i--) if (actions[i].type === type) actions.splice(i, 1);
  return out;
}
function clear() { actions.length = 0; }

let pass = 0, fail = 0;
function assert(cond, name) {
  if (cond) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ FAIL: " + name); }
}

/* ============ 1. ✌️ V 型保持 → 视频播放/暂停 ============ */
console.log("[1] victory hold → toggle-video");
teleport(baseOpenHand(), 3);
step(); feed(victoryHand()); step(); feed(victoryHand());       // 仅 2 帧（<confirmFrames=3）
step(); feed(baseOpenHand());
assert(count("toggle-video") === 0, "V 型一闪而过（候选不足）不触发");
fakeNow += 1100;
teleport(victoryHand(), 4);                                     // 确认 3 帧 → holding
fakeNow += 400; feed(victoryHand());
assert(count("toggle-video") === 0, "保持 400ms 未到 600ms 不触发");
fakeNow += 300; feed(victoryHand());
assert(count("toggle-video") === 1, "保持 600ms 触发一次");
for (let i = 0; i < 40; i++) { fakeNow += 50; feed(victoryHand()); }  // 继续握 2s
assert(count("toggle-video") === 1, "持续保持不重复触发（LOCKED）");
frames(3, baseOpenHand());                                      // 释放姿态
fakeNow += 1200;
teleport(victoryHand(), 4);
fakeNow += 750; feed(victoryHand());
assert(takeAll("toggle-video").length === 2, "释放+冷却后可再次触发");
fakeNow += 1500; clear();

/* ============ 2. 👌 OK 保持 0.8s → 关标签页；短捏不算 ============ */
console.log("[2] OK hold → close-tab; short pinch ignored");
teleport(baseOpenHand(), 3);
frames(2, pinchHand()); frames(2, baseOpenHand());
fakeNow += 250;
frames(2, pinchHand()); frames(2, baseOpenHand());              // 快速双捏（旧手势语义）
assert(count("toggle-video") === 0, "双捏不产生视频动作");
assert(count("close-tab") === 0, "短捏（未达保持时长）不关标签页");
fakeNow += 1200;
teleport(pinchHand(), 4);                                       // OK 保持：确认 3 帧
fakeNow += 900; feed(pinchHand());
assert(count("close-tab") === 1, "OK 保持 800ms 触发关闭");
for (let i = 0; i < 60; i++) { fakeNow += 50; feed(pinchHand()); }
assert(count("close-tab") === 1, "保持 3 秒仍只一次（LOCKED）");
frames(3, baseOpenHand());
fakeNow += 1200;
teleport(pinchHand(), 4);
fakeNow += 900; feed(pinchHand());
assert(takeAll("close-tab").length === 2, "释放+冷却后可再次关闭");
fakeNow += 1500; clear();

/* ============ 3. 🤲 双手缩放会话生命周期 ============ */
console.log("[3] two-hand zoom session lifecycle");
function twoHands(gap) {
  return [shiftAll(baseOpenHand(), -gap, 0), shiftAll(baseOpenHand(), gap, 0)];
}
function holdStill(gap, n) { for (let i = 0; i < n; i++) { step(); feedMulti(twoHands(gap)); } }
feedMulti([]);
for (let g = 0.10; g <= 0.26; g += 0.02) { step(); feedMulti(twoHands(g)); }
let zooms = takeAll("zoom");
assert(zooms.length >= 3, "会话建立后连续输出增量事件 (n=" + zooms.length + ")");
assert(zooms.every(z => z.delta > 0), "外移 → delta 全部为正（放大）");
assert(zooms.every(z => z.delta <= engine.t.twoHandMaxStep + 1e-9), "单帧增量受 maxStep 限速");
holdStill(0.26, 8); clear();
holdStill(0.26, 12);
assert(count("zoom") === 0, "静止 400ms 后会话 END，不再输出增量");
for (let g = 0.26; g <= 0.40; g += 0.02) { step(); feedMulti(twoHands(g)); }
assert(takeAll("zoom").length < 3, "END 后处于冷却/重确认，不黏连");
holdStill(0.40, 16); clear();
fakeNow += 700;
for (let g = 0.40; g <= 0.52; g += 0.02) { step(); feedMulti(twoHands(g)); }
zooms = takeAll("zoom");
assert(zooms.length >= 2 && zooms.every(z => z.delta > 0), "重新满足 START 后新会话正常输出");
holdStill(0.52, 16); clear();
fakeNow += 700;
for (let g = 0.52; g >= 0.40; g -= 0.02) { step(); feedMulti(twoHands(g)); }
zooms = takeAll("zoom");
assert(zooms.length >= 1 && zooms.every(z => z.delta < 0), "内收 → 全部为负（缩小）");
feedMulti([twoHands(0.40)[0]]);
clear();
for (let g = 0.40; g >= 0.30; g -= 0.02) { step(); feedMulti([shiftAll(baseOpenHand(), -g, 0)]); }
assert(count("zoom") === 0, "任意一只手消失 → 会话立即 CANCEL");
fakeNow += 1500; clear();

/* ============ 4. 双手期间保持类手势静默 ============ */
console.log("[4] two-hand suppresses hold gestures");
for (let g = 0.10; g <= 0.20; g += 0.02) { step(); feedMulti([asListVictoryPair(g)[0], asListVictoryPair(g)[1]]); }
function asListVictoryPair(g) {
  return [shiftAll(victoryHand(), -g, 0), shiftAll(victoryHand(), g, 0)];
}
assert(count("toggle-video") === 0 && count("close-tab") === 0, "双手入画时 V 型保持不误触视频动作");
fakeNow += 1500; clear();

/* ============ 5. 丢跟踪宽限（保持类）与超时复位 ============ */
console.log("[5] drop-grace for holds; long loss resets");
teleport(victoryHand(), 3);                                     // holding 建立
fakeNow += 200; feed(victoryHand());                            // 进入保持尾段但未触发
for (let i = 0; i < 3; i++) { step(); feedMulti([]); }          // 丢 3 帧（<grace=6）
fakeNow += 500; feed(victoryHand());                            // 回手继续 → 累计 ≥600ms
assert(takeAll("toggle-video").length === 1, "宽限期内回手，保持计时延续并触发一次");
for (let i = 0; i < 3; i++) { fakeNow += 50; feed(victoryHand()); } // 释放前锁定
frames(3, baseOpenHand());
fakeNow += 1500;
teleport(victoryHand(), 2);                                     // 只 2 帧确认（未进 holding）
for (let i = 0; i < 10; i++) { step(); feedMulti([]); }         // 超时消失（>grace）
fakeNow += 700;
for (let i = 0; i < 4; i++) { step(); feed(victoryHand()); }    // 回手重新出现
assert(count("toggle-video") === 0, "超时消失全量复位，回手短保持（未到600ms）不补触发");
fakeNow += 1500; clear();

/* ============ 6. ☝️ 单伸食指保持 → 播放下一集 ============ */
console.log("[6] pointing hold → next-episode");
teleport(pointHand(), 2);                                       // 仅 2 帧（候选不足）
step(); feed(baseOpenHand());
assert(count("next-episode") === 0, "食指一闪而过不触发");
fakeNow += 1300;
teleport(pointHand(), 4);                                       // 确认 3 帧 → holding
fakeNow += 500; feed(pointHand());
assert(count("next-episode") === 1, "保持 ≥400ms 触发一次下一集");
for (let i = 0; i < 20; i++) { fakeNow += 50; feed(pointHand()); }  // 继续握 1s
assert(count("next-episode") === 1, "持续保持不重复触发（LOCKED）");
frames(3, baseOpenHand());                                      // 释放
fakeNow += 1300;
teleport(pointHand(), 4);
fakeNow += 500; feed(pointHand());
assert(takeAll("next-episode").length === 2, "释放+冷却后可再次触发");
fakeNow += 1500; clear();

/* ============ 7. 🤟 收拇指伸四指保持 → 复制网页链接 ============ */
console.log("[7] four-fingers hold → copy-url");
teleport(fourHand(), 4);
fakeNow += 500; feed(fourHand());
assert(count("copy-url") === 1, "保持 ≥400ms 触发一次复制链接");
for (let i = 0; i < 20; i++) { fakeNow += 50; feed(fourHand()); }
assert(count("copy-url") === 1, "持续保持不重复触发（LOCKED）");
frames(3, baseOpenHand());
fakeNow += 1300;
teleport(fourHand(), 4);
fakeNow += 500; feed(fourHand());
assert(takeAll("copy-url").length === 2, "释放+冷却后可再次触发");
fakeNow += 1500; clear();

/* ============ 8. 新姿态与既有姿态互斥 ============ */
console.log("[8] pose mutual exclusion");
frames(6, pointHand());                                         // 食指：不应触发其他任何动作
assert(count("toggle-video") === 0 && count("close-tab") === 0 &&
       count("copy-url") === 0 && count("next-episode") === 0,
       "食指保持只走 next-episode 通道（冷却期后无残留）");
takeAll("next-episode");
frames(6, fourHand());                                          // 四指：只触发 copy
assert(count("toggle-video") === 0 && count("close-tab") === 0 && count("next-episode") === 0,
       "四指姿态不误触视频/关标签/下一集");
takeAll("copy-url");
frames(6, victoryHand());                                       // V 型：两者都不触发
assert(count("next-episode") === 0 && count("copy-url") === 0, "V 型不误触下一集/复制");
takeAll("toggle-video");
frames(4, pinchHand());
assert(count("next-episode") === 0 && count("copy-url") === 0, "OK 捏合不误触新手势");
takeAll("close-tab");
fakeNow += 1500; clear();

/* ============ 9. 双手通道压制新保持类手势 ============ */
console.log("[9] two-hand suppresses new gestures");
for (let g = 0.10; g <= 0.22; g += 0.02) {
  step();
  feedMulti([shiftAll(pointHand(), -g, 0), shiftAll(pointHand(), g, 0)]);
}
assert(count("next-episode") === 0, "双手入画时食指姿态不误触下一集");
fakeNow += 1500; clear();

/* ============ 10. 👊 握拳保持 0.8s → 视频回退 10 秒 ============ */
console.log("[10] fist hold → video-seek-back");
teleport(fistHand(), 2); step(); feed(baseOpenHand());
assert(count("video-seek-back") === 0 && count("close-tab") === 0, "握拳一闪而过不触发（也不误触 OK 关标签）");
fakeNow += 1300;
teleport(fistHand(), 4);                                        // 确认 3 帧 → holding
fakeNow += 500; feed(fistHand());
assert(count("video-seek-back") === 0, "保持 500ms 未到 800ms 不触发");
fakeNow += 400; feed(fistHand());
assert(count("video-seek-back") === 1, "保持 ≥800ms 触发一次回退");
assert(count("toggle-video") === 0 && count("close-tab") === 0, "握拳不误触播放/暂停与关标签");
for (let i = 0; i < 20; i++) { fakeNow += 50; feed(fistHand()); }
assert(count("video-seek-back") === 1, "持续保持不重复触发（LOCKED）");
frames(3, baseOpenHand());
fakeNow += 1100;
teleport(fistHand(), 4);
fakeNow += 900; feed(fistHand());
assert(takeAll("video-seek-back").length === 2, "释放+冷却后可再次触发");
frames(3, baseOpenHand());
fakeNow += 1200;
teleport(victoryHand(), 4);                                     // 拇指伸出的 V 型（v1.0.3 判据已放宽）
fakeNow += 650; feed(victoryHand());
assert(count("video-seek-back") === 0 && takeAll("toggle-video").length === 1,
       "V 型正常触发播放/暂停且不误触回退");
fakeNow += 1500; clear();

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
Date.now = realNow;
process.exit(fail ? 1 : 0);
