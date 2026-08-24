"use strict";
/**
 * preload-main.js — runs inside the dsh web page.
 *
 * Injects the floating「记忆库」button (bottom-right, 深海脉冲玻璃风格) that
 * toggles the embedded Memory Vault side panel. Uses CSSOM for styling so it
 * survives the page's Content-Security-Policy, and a MutationObserver to
 * re-attach the button if the SPA ever removes it.
 */
const { ipcRenderer } = require("electron");

const BUTTON_ID = "dsh-desktop-vault-toggle";

function styleButton(btn) {
  const s = btn.style;
  s.position = "fixed";
  s.right = "18px";
  s.bottom = "18px";
  s.zIndex = "2147483647";
  s.display = "inline-flex";
  s.alignItems = "center";
  s.gap = "10px";
  s.padding = "9px 16px 9px 12px";
  s.borderRadius = "22px";
  s.border = "1px solid rgba(79,140,255,0.45)";
  s.background = "linear-gradient(135deg, rgba(20,34,66,0.92), rgba(9,15,32,0.94))";
  s.backdropFilter = "blur(10px)";
  s.boxShadow =
    "0 0 0 1px rgba(79,140,255,0.10), 0 8px 28px rgba(0,0,0,0.5), 0 0 22px rgba(79,140,255,0.28)";
  s.color = "#dbe6f7";
  s.cursor = "pointer";
  s.userSelect = "none";
  s.transition = "transform .18s ease, box-shadow .18s ease";
  s.animation = "dshVaultBreathe 3.4s ease-in-out infinite";
}

function styleIcon(icon) {
  const s = icon.style;
  s.display = "inline-flex";
  s.alignItems = "center";
  s.justifyContent = "center";
  s.width = "26px";
  s.height = "26px";
  s.borderRadius = "50%";
  s.background = "linear-gradient(135deg, rgba(79,140,255,0.9), rgba(34,211,238,0.85))";
  s.boxShadow = "0 0 14px rgba(79,140,255,0.6)";
  s.fontSize = "14px";
  s.color = "#04101f";
}

function styleTexts(wrap) {
  const s = wrap.style;
  s.display = "flex";
  s.flexDirection = "column";
  s.alignItems = "flex-start";
  s.lineHeight = "1.15";
}
function styleTitle(t) {
  const s = t.style;
  s.font = "600 13px 'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',system-ui,sans-serif";
  s.letterSpacing = "1px";
}
function styleSub(sub) {
  const s = sub.style;
  s.font = "400 10px 'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',system-ui,sans-serif";
  s.color = "#7d8fb5";
  s.letterSpacing = "0.5px";
}

function makeButton() {
  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  btn.title = "记忆库 — 检索 Codex / Claude Code 会话记忆 (Ctrl+M)";
  const icon = document.createElement("span");
  icon.textContent = "◈";
  styleIcon(icon);
  const wrap = document.createElement("span");
  const title = document.createElement("span");
  title.textContent = "记忆库";
  styleTitle(title);
  const sub = document.createElement("span");
  sub.textContent = "会话记忆检索";
  styleSub(sub);
  wrap.appendChild(title);
  wrap.appendChild(sub);
  styleTexts(wrap);
  btn.appendChild(icon);
  btn.appendChild(wrap);
  styleButton(btn);

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "translateY(-2px)";
    btn.style.boxShadow =
      "0 0 0 1px rgba(79,140,255,0.2), 0 12px 34px rgba(0,0,0,0.55), 0 0 34px rgba(79,140,255,0.5)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "translateY(0)";
    btn.style.boxShadow =
      "0 0 0 1px rgba(79,140,255,0.10), 0 8px 28px rgba(0,0,0,0.5), 0 0 22px rgba(79,140,255,0.28)";
  });
  btn.addEventListener("click", () => ipcRenderer.send("vault:toggle"));
  return btn;
}

/** 呼吸光晕 keyframes：通过 CSSOM 注入，绕过 CSP */
function ensureBreathKeyframes() {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      `@keyframes dshVaultBreathe {
         0%, 100% { box-shadow: 0 0 0 1px rgba(79,140,255,0.10), 0 8px 28px rgba(0,0,0,0.5), 0 0 18px rgba(79,140,255,0.22); }
         50%      { box-shadow: 0 0 0 1px rgba(79,140,255,0.22), 0 8px 28px rgba(0,0,0,0.5), 0 0 34px rgba(79,140,255,0.5); }
       }`
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    /* CSP 极严时降级：无动画 */
  }
}

function ensureButton() {
  if (!document.body) return;
  if (document.getElementById(BUTTON_ID)) return;
  ensureBreathKeyframes();
  document.body.appendChild(makeButton());
}

// initial inject as soon as body exists
if (document.body) {
  ensureButton();
} else {
  document.addEventListener("DOMContentLoaded", ensureButton);
}

// SPA resilience: keep the button present
const observer = new MutationObserver(() => ensureButton());
try { observer.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* documentElement 未就绪？忽略 */ }

// keyboard escape: hide the panel if the page has focus
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") ipcRenderer.send("vault:close");
});

// keep the preload contract available to the page (harmless; page may ignore it)
window.__dshDesktop = { toggleVault: () => ipcRenderer.send("vault:toggle") };

// ---------------------------------------------------------------------------
// 动态壁纸背景（dsh-media:// 协议由主进程服务）+ 深色标题栏拖拽条
// ---------------------------------------------------------------------------

function injectVideoBackground() {
  if (document.getElementById("dsh-bg-video")) return;
  const video = document.createElement("video");
  video.id = "dsh-bg-video";
  video.muted = true;
  video.autoplay = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  try { video.src = "dsh-media://bg.mp4"; } catch (e) { window.__dshAtmos = Object.assign(window.__dshAtmos || {}, { videoSrcErr: String(e) }); }
  // 确保自动播放（部分环境需要显式 play）
  try { video.addEventListener("canplay", () => { const p = video.play(); if (p && p.catch) p.catch(() => {}); }); } catch {}
  const s = video.style;
  s.position = "fixed";
  s.inset = "0";
  s.width = "100vw";
  s.height = "100vh";
  s.objectFit = "cover";
  s.zIndex = "0";
  s.opacity = "0.8";             // 壁纸（略降不透明度，辅助文字显示）
  s.pointerEvents = "none";
  s.filter = "brightness(0.68) saturate(1.1)";   // 再压暗一点亮度，壁纸仍清晰可见

  // 深蓝底幕：半透明深蓝，壁纸透出但被压暗，文字下面是深色底（清晰）
  const overlay = document.createElement("div");
  overlay.id = "dsh-bg-overlay";
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:1;pointer-events:none;" +
    "background:linear-gradient(180deg, rgba(14,26,52,0.50), rgba(20,38,74,0.58));";

  const root = document.documentElement;
  root.appendChild(video);
  root.appendChild(overlay);
}

function injectTitleBar() {
  if (document.getElementById("dsh-titlebar")) return;
  const bar = document.createElement("div");
  bar.id = "dsh-titlebar";
  const s = bar.style;
  try { s.setProperty("-webkit-app-region", "drag"); } catch { /* 忽略 */ }
  s.position = "fixed";
  s.left = "0";
  s.right = "0";
  s.top = "0";
  s.height = "44px";
  s.zIndex = "2147483646";
  s.display = "flex";
  s.alignItems = "center";
  s.padding = "0 160px 0 16px"; // 右侧留给系统窗口控件
  s.background = "linear-gradient(180deg, rgba(8,14,30,0.92), rgba(5,8,18,0.72))";
  s.backdropFilter = "blur(8px)";
  s.borderBottom = "1px solid rgba(99,140,255,0.12)";
  s.color = "#a9bce0";
  s.font = "500 12px 'Segoe UI','Microsoft YaHei UI','Microsoft YaHei',system-ui,sans-serif";
  s.letterSpacing = "0.6px";
  s.userSelect = "none";
  s.cursor = "default";

  const logo = document.createElement("span");
  logo.textContent = "◈";
  logo.style.cssText =
    "color:#4f8cff;font-size:14px;margin-right:9px;text-shadow:0 0 12px rgba(79,140,255,.7);";
  const title = document.createElement("span");
  title.textContent = "DSH Desktop · 深海智能体工作台";
  const right = document.createElement("span");
  right.style.cssText = "margin-left:auto;font-size:11px;color:#5c7094;";
  right.textContent = "DeepSeek Harness";

  bar.appendChild(logo);
  bar.appendChild(title);
  bar.appendChild(right);
  document.documentElement.appendChild(bar);
}

function injectTitleLine() {
  if (document.getElementById("dsh-titleline")) return;
  const line = document.createElement("div");
  line.id = "dsh-titleline";
  line.style.cssText =
    "position:fixed;top:44px;left:0;right:0;height:1px;z-index:2147483646;pointer-events:none;" +
    "background:linear-gradient(90deg,transparent,rgba(79,140,255,.8),rgba(34,211,238,.6),rgba(139,92,246,.7),transparent);opacity:.7;";
  document.documentElement.appendChild(line);
}

function ensureAtmosphere() {
  if (!document.documentElement) return;
  const status = window.__dshAtmos || {};
  try { injectVideoBackground(); status.video = true; } catch (e) { status.videoErr = String(e); }
  try { injectTitleBar(); status.titlebar = true; } catch (e) { status.titlebarErr = String(e); }
  try { injectTitleLine(); status.line = true; } catch (e) { status.lineErr = String(e); }
  window.__dshAtmos = status;
}

// 覆盖最新初始化：确保按钮与氛围层都在 body 就绪后注入
if (document.body) {
  ensureButton();
  ensureAtmosphere();
} else {
  document.addEventListener("DOMContentLoaded", () => {
    ensureButton();
    ensureAtmosphere();
  });
}

// SPA 重建时保持注入存在
const atmosphereObserver = new MutationObserver(() => {
  ensureButton();
  ensureAtmosphere();
});
try { atmosphereObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch { /* 忽略 */ }
