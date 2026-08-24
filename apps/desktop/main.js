"use strict";
/**
 * DSH Desktop — main process.
 *
 * 单窗口桌面客户端：
 *   - 主窗口 加载 dsh web UI（自动启动或挂接已有服务）；启动时先展示「深海脉冲」启动页，
 *     引擎就绪后注入「深海脉冲」皮肤并切入工作台；深色标题栏（titleBarStyle hidden + overlay）。
 *   - 记忆库 以右侧滑出面板内嵌（WebContentsView）：导入并全文检索 Codex / Claude Code 会话。
 *   - 能力词典 面板页：Skills / MCP / 插件 的中文说明。
 *   - 动态壁纸 bg.mp4 通过 dsh-media:// 协议喂给 http 页面（绕过跨源/CSP）。
 */
const { app, BrowserWindow, WebContentsView, Menu, Tray, ipcMain, shell, nativeImage, dialog, protocol, net } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const { ensureDshWeb } = require("./lib/dsh-boot");
const memory = require("./lib/memory");
const { collectCapabilities } = require("./lib/capabilities");

// 自定义协议 dsh-media:// —— 把本地动态壁纸喂给 http 页面，绕过跨源/CSP
protocol.registerSchemesAsPrivileged([
  { scheme: "dsh-media", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
function bgVideoPath() {
  const p = path.join(__dirname, "assets", "bg.mp4");
  return fs.existsSync(p) ? p : null;
}

const IS_SMOKE = process.argv.includes("--smoke") || process.env.DSH_SMOKE === "1";
const MAIN_URL = process.env.DSH_DESKTOP_URL || null;
const PORT = Number(process.env.DSH_DESKTOP_PORT || 3080);

let mainWindow = null;
let tray = null;
let dshChild = null; // 我们拉起的子进程（挂接已有服务时为 null）
let memoryStore = null;

// 记忆库面板状态
let vaultView = null; // WebContentsView | null
let vaultVisible = false;
let vaultPendingRefresh = false;

function storeDir() {
  return path.join(app.getPath("appData"), "dsh-desktop", "memory");
}

function iconPath(size) {
  const p = path.join(__dirname, "assets", `icon-${size}.png`);
  return fs.existsSync(p) ? p : null;
}

// ---------------------------------------------------------------------------
// 记忆库 IPC
// ---------------------------------------------------------------------------

async function scanMemory() {
  memoryStore = memory.scanAll();
  memory.saveStore(memoryStore, storeDir());
  return summarizeStore();
}

function summarizeStore() {
  const s = memoryStore || memory.loadStore(storeDir());
  if (!s) return { scannedAt: null, sources: {}, sessions: [], count: 0 };
  return {
    scannedAt: s.scannedAt,
    sources: s.sources,
    count: s.sessions.length,
    sessions: s.sessions.map((x) => ({
      source: x.source,
      id: x.id,
      title: x.title,
      preview: x.preview,
      project: x.project,
      startedAt: x.startedAt,
      updatedAt: x.updatedAt,
      msgCount: x.msgCount,
      userMsgCount: x.userMsgCount,
      model: x.model,
      cliVersion: x.cliVersion,
      originator: x.originator,
      sizeBytes: x.sizeBytes,
    })),
  };
}

function registerMemoryIpc() {
  ipcMain.handle("memory:scan", () => scanMemory());
  ipcMain.handle("memory:list", () => summarizeStore());
  ipcMain.handle("memory:search", (_e, q) => {
    const s = memoryStore || memory.loadStore(storeDir());
    if (!s) return [];
    return memory.search(s, q).map((h) => ({
      session: summarizeStore().sessions.find((x) => x.id === h.session.id && x.source === h.session.source),
      snippet: h.snippet,
      inTitle: h.inTitle,
    }));
  });
  ipcMain.handle("memory:session", (_e, id) => {
    const s = memoryStore || memory.loadStore(storeDir());
    if (!s) return null;
    const rec = s.sessions.find((x) => x.id === id);
    if (!rec) return null;
    const detail = memory.getSessionMessages(rec);
    return {
      session: summarizeStore().sessions.find((x) => x.id === id && x.source === rec.source),
      ...detail,
    };
  });
  ipcMain.handle("memory:openDir", (_e, source) => {
    const dir = source === "codex" ? memory.CODEX_DIR() : memory.CLAUDE_DIR();
    return shell.openPath(dir);
  });
  ipcMain.handle("memory:export", async (_e, id) => {
    const s = memoryStore || memory.loadStore(storeDir());
    if (!s) return { ok: false, error: "no index" };
    const rec = s.sessions.find((x) => x.id === id);
    if (!rec) return { ok: false, error: "not found" };
    const exportDir = path.join(app.getPath("documents"), "dsh-desktop-exports");
    const file = memory.exportSessionMarkdown(rec, exportDir);
    return { ok: true, file };
  });
  ipcMain.handle("memory:appInfo", () => ({
    version: app.getVersion(),
    storeDir: storeDir(),
    codexDir: memory.CODEX_DIR(),
    claudeDir: memory.CLAUDE_DIR(),
  }));
  ipcMain.handle("memory:capabilities", () => collectCapabilities());

  ipcMain.on("vault:toggle", () => toggleVaultPanel());
  ipcMain.on("vault:close", () => hideVaultPanel());
}

// ---------------------------------------------------------------------------
// 嵌入记忆库面板（WebContentsView）
// ---------------------------------------------------------------------------

function ensureVaultView() {
  if (vaultView) return vaultView;
  vaultView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  vaultView.setBackgroundColor("#05070f");
  vaultView.webContents.loadFile(path.join(__dirname, "renderer", "memories.html"));
  vaultView.webContents.on("did-finish-load", () => {
    if (vaultPendingRefresh) {
      vaultPendingRefresh = false;
      vaultView.webContents.send("memory:refresh-requested");
    }
  });
  return vaultView;
}

function setVaultBounds() {
  if (!mainWindow || !vaultView) return;
  const [w, h] = mainWindow.getContentSize();
  const width = Math.min(640, Math.max(460, Math.round(w * 0.42)));
  // 顶部留 44px 给深色标题栏
  vaultView.setBounds({ x: w - width, y: 44, width, height: h - 44 });
}

function showVaultPanel() {
  if (!mainWindow) return;
  ensureVaultView();
  if (!vaultVisible) {
    mainWindow.contentView.addChildView(vaultView);
    vaultVisible = true;
  }
  setVaultBounds();
  vaultView.webContents.focus();
}

function hideVaultPanel() {
  if (mainWindow && vaultView && vaultVisible) {
    mainWindow.contentView.removeChildView(vaultView);
  }
  vaultVisible = false;
}

function toggleVaultPanel() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (vaultVisible) hideVaultPanel();
  else showVaultPanel();
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    title: "DSH Desktop · 深海智能体工作台",
    backgroundColor: "#05070f",
    icon: iconPath(256),
    autoHideMenuBar: false,
    // 深色标题栏：隐藏系统默认白条，用 overlay 画标题栏 + 原生窗口控件
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#05070f", symbolColor: "#9fc0ff", height: 44 },
    webPreferences: {
      preload: path.join(__dirname, "preload-main.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (mainWindow && !url.startsWith("http://127.0.0.1:") && !url.startsWith("http://localhost:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });

  // 先展示启动页，引擎就绪后在 enterHarness 切到工作台
  await mainWindow.loadFile(path.join(__dirname, "renderer", "boot.html"));

  // 记忆库面板跟随窗口右缘
  mainWindow.on("resize", () => {
    if (vaultVisible) setVaultBounds();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    vaultView = null;
    vaultVisible = false;
  });

  return mainWindow;
}

/** 引擎就绪：注入皮肤并切换到 harness 界面 */
async function enterHarness(url) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(url);
  try {
    const skin = fs.readFileSync(path.join(__dirname, "skin", "skin.css"), "utf8");
    mainWindow.webContents.insertCSS(skin, { cssOrigin: "user" });
  } catch {
    /* 皮肤缺失不影响使用 */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(`DSH Desktop · 深海智能体工作台 — ${url}`);
  }
}

// ---------------------------------------------------------------------------
// 菜单 / 托盘
// ---------------------------------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "记忆库", accelerator: "CmdOrCtrl+M", click: () => toggleVaultPanel() },
        { type: "separator" },
        { label: "退出", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新加载页面" },
        { role: "forceReload", label: "强制重新加载" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "记忆库",
      submenu: [
        { label: "打开 / 收起记忆库", accelerator: "CmdOrCtrl+M", click: () => toggleVaultPanel() },
        { label: "重新扫描 Codex / Claude Code 会话", click: () => { vaultPendingRefresh = true; showVaultPanel(); } },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "DSH Web 地址", click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
        { label: "关于 DSH Desktop", click: () => aboutDialog() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function aboutDialog() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: "info",
    title: "关于 DSH Desktop",
    message: "DSH Desktop · 深海智能体工作台",
    detail: [
      `版本 ${app.getVersion()}`,
      "",
      "DeepSeek Harness 的桌面客户端（单窗口）：",
      "· 主窗口加载 dsh web UI（自动启动或挂接已有服务）",
      "· 右下角「记忆库」按钮 / Ctrl+M 滑出侧边面板",
      "· 记忆库：导入并全文检索 Codex 与 Claude Code 的会话历史",
      "· 能力词典：Skills / MCP / 插件 的中文说明",
      "· 所有数据仅保存在本机",
    ].join("\n"),
  });
}

function createTray() {
  const p = iconPath(32) || iconPath(256);
  if (!p) return;
  const image = nativeImage.createFromPath(p);
  if (image.isEmpty()) return;
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip("DSH Desktop");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => (mainWindow ? mainWindow.show() : createMainWindow()) },
      { label: "记忆库", click: () => (mainWindow ? toggleVaultPanel() : createMainWindow()) },
      { type: "separator" },
      { label: "退出", click: () => app.quit() },
    ])
  );
  tray.on("click", () => (mainWindow ? mainWindow.show() : createMainWindow()));
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    registerMemoryIpc();
    buildMenu();
    // 服务动态壁纸（dsh-media://）—— 直接读文件流，兼容 asar 打包
    try {
      protocol.handle("dsh-media", (req) => {
        const file = bgVideoPath();
        if (!file) return new Response("", { status: 404 });
        try {
          const data = fs.readFileSync(file);
          return new Response(data, { headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store" } });
        } catch {
          return new Response("", { status: 500 });
        }
      });
    } catch { /* 已注册则忽略 */ }

    if (IS_SMOKE) {
      // 无窗口冒烟：验证 web 挂接、记忆、按钮、皮肤、启动页、能力词典、面板
      try {
        fs.writeFileSync(path.join(process.cwd(), "smoke-phase.txt"), "smoke-start");
      } catch {}
      try {
        const { url, attached } = await ensureDshWeb({ port: PORT });
        memoryStore = memory.scanAll();
        const summary = summarizeStore();

        // 1) 记忆库渲染 + IPC 往返（隐藏探测窗口）
        const probe = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        await probe.loadFile(path.join(__dirname, "renderer", "memories.html"));
        const rendererResult = await probe.webContents.executeJavaScript(
          `(async () => {
             const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
             const info = await window.dshMemory.appInfo();
             const list = await window.dshMemory.list();
             const hits = await window.dshMemory.search("comfyui");
             const caps = await window.dshMemory.capabilities();
             const first = list.sessions && list.sessions[0];
             const detail = first ? await window.dshMemory.getSession(first.id) : null;
             for (let i = 0; i < 20 && !document.querySelector(".session-card"); i++) await sleep(200);
             const dictTab = document.querySelector('.tab[data-tab="dictionary"]');
             if (dictTab) dictTab.click();
             for (let i = 0; i < 20 && !document.querySelector(".dict-item"); i++) await sleep(200);
             return {
               api: !!(info && list && hits && caps),
               count: list.count,
               searchHits: hits.length,
               firstTitle: first ? first.title : null,
               detailMessages: detail ? detail.messages.length : 0,
               domCards: document.querySelectorAll(".session-card").length,
               domStats: (document.getElementById("stats") || {}).innerText || "",
               tabs: document.querySelectorAll(".tab").length,
               dictItems: document.querySelectorAll(".dict-item").length,
               dictSkills: (caps.skills || []).length,
               dictMcps: (caps.mcps || []).length,
               dictBundles: (caps.bundles || []).length,
               vaultVideo: !!document.getElementById("bg-video"),
             };
           })()`
        );

        // 2) 主窗口：注入按钮 + 皮肤 + 视频背景 + 标题栏
        const mainProbe = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, "preload-main.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        await mainProbe.loadURL(url);
        try {
          const skin = fs.readFileSync(path.join(__dirname, "skin", "skin.css"), "utf8");
          await mainProbe.webContents.insertCSS(skin, { cssOrigin: "user" });
        } catch { /* 皮肤缺失 */ }
        const buttonResult = await mainProbe.webContents.executeJavaScript(
          `(async () => {
             const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
             for (let i = 0; i < 20 && !document.getElementById("dsh-desktop-vault-toggle"); i++) await sleep(200);
             const btn = document.getElementById("dsh-desktop-vault-toggle");
             const bodyVar = getComputedStyle(document.body).getPropertyValue("--dsw-static-neutral-bluish-950").trim();
             const frame = document.querySelector("#root [class*='_frame']");
             return {
               buttonInjected: !!btn,
               buttonText: btn ? btn.textContent : null,
               skinBgVar: bodyVar,
               skinApplied: /rgba\\(5, ?7, ?15/.test(bodyVar) || bodyVar === "#05070f",
               videoInjected: !!document.getElementById("dsh-bg-video"),
               videoSrc: (document.getElementById("dsh-bg-video") || {}).src || null,
               titleBarInjected: !!document.getElementById("dsh-titlebar"),
               titleBarHeight: (document.getElementById("dsh-titlebar") || {}).style?.height || null,
               frameTop: frame ? Math.round(frame.getBoundingClientRect().top) : null,
               atmosStatus: window.__dshAtmos || null,
             };
           })()`
        );

        // 2b) 启动页
        const bootProbe = new BrowserWindow({ show: false });
        await bootProbe.loadFile(path.join(__dirname, "renderer", "boot.html"));
        const bootResult = await bootProbe.webContents.executeJavaScript(
          `({ title: document.querySelector("h1")?.textContent || null, status: document.getElementById("status")?.textContent || null, video: !!document.getElementById("bg-video") })`
        );

        // 3) 嵌入面板：WebContentsView 承载记忆库
        const host = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, "preload-main.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        await host.loadURL(url);
        const vault = new WebContentsView({ webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
        vault.setBackgroundColor("#05070f");
        await vault.webContents.loadFile(path.join(__dirname, "renderer", "memories.html"));
        host.contentView.addChildView(vault);
        vault.setBounds({ x: 200, y: 44, width: 480, height: 560 });
        const vaultBounds = vault.getBounds();
        let vaultCards = 0;
        for (let i = 0; i < 20; i++) {
          vaultCards = await vault.webContents.executeJavaScript('document.querySelectorAll(".session-card").length');
          if (vaultCards > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const childCountWith = host.contentView.children ? host.contentView.children.length : "n/a";
        host.contentView.removeChildView(vault);
        const childCountAfter = host.contentView.children ? host.contentView.children.length : "n/a";
        const panelResult = { vaultBounds, vaultCards, childCountWith, childCountAfter };

        const result = { url, attached, memory: summary.count, codex: summary.sources.codex?.sessions ?? 0, claude: summary.sources.claude?.sessions ?? 0, renderer: rendererResult, mainWindowButton: buttonResult, boot: bootResult, embeddedPanel: panelResult };
        console.log(JSON.stringify(result, null, 2));
        try {
          fs.writeFileSync(path.join(process.cwd(), "smoke-result.json"), JSON.stringify(result, null, 2), "utf8");
          fs.writeFileSync(path.join(process.cwd(), "smoke-phase.txt"), "smoke-done");
        } catch {}
        process.exit(0);
      } catch (err) {
        try { fs.writeFileSync(path.join(process.cwd(), "smoke-phase.txt"), "smoke-failed: " + err.message); } catch {}
        console.error("SMOKE FAILED:", err.message);
        process.exit(1);
      }
      return;
    }

    try {
      // 1) 先展示启动页
      await createMainWindow();
      const { url, child } = await ensureDshWeb({ port: PORT });
      dshChild = child;
      await enterHarness(url);
      createTray();
      showVaultPanel();
    } catch (err) {
      dialog.showErrorBox("DSH Desktop 启动失败", `${err.message}\n\n请确认 DeepSeek Harness (dsh) 已安装，或先手动运行 dsh web。`);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    if (dshChild && !dshChild.killed) {
      try {
        dshChild.kill();
      } catch { /* already gone */ }
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}
