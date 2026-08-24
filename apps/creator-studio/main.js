"use strict";
/**
 * 达人营销工作台 — main process.
 *
 * 面向「达人营销工作流」的独立桌面版：
 *   - 主窗口 加载 dsh web UI（自动启动或挂接已有服务），内置「深海脉冲」皮肤与深色标题栏；
 *   - 工作台窗口（首启打开）：达人筛选→邀约→洽谈→确认→内容对接→脚本审核→发布上线→数据复盘
 *     的 8 阶段看板、达人库、话术/审核/复盘模板、CSV 导出、平台搜索；
 *   - 记忆库（右侧滑出面板）：读取【本机使用者自己】的 Codex / Claude Code 会话，绝不捆绑作者数据；
 *   - 首启用把工作流技能（creator-*）装到本机使用者的 ~/.agents/skills；
 *   - 此版本不使用动态壁纸。
 */
const { app, BrowserWindow, WebContentsView, Menu, Tray, ipcMain, shell, nativeImage, dialog, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { ensureDshWeb } = require("./lib/dsh-boot");
const memory = require("./lib/memory");
const { collectCapabilities } = require("./lib/capabilities");
const workflow = require("./lib/workflow");
const setup = require("./lib/setup");

const IS_SMOKE = process.argv.includes("--smoke") || process.env.DSH_SMOKE === "1";
const MAIN_URL = process.env.DSH_DESKTOP_URL || null;
const PORT = Number(process.env.DSH_DESKTOP_PORT || 3080);

let mainWindow = null;
let workflowWindow = null;
let tray = null;
let dshChild = null; // 我们拉起的子进程（挂接已有服务时为 null）
let memoryStore = null;

// 记忆库面板状态
let vaultView = null; // WebContentsView | null
let vaultVisible = false;
let vaultPendingRefresh = false;

// 自定义标题栏高度（仅 Windows 注入，mac/linux 用原生标题栏，偏移为 0）
const TITLE_BAR_H = process.platform === "win32" ? 44 : 0;

function storeDir() {
  return path.join(app.getPath("appData"), "dsh-creator-studio", "memory");
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

  // ---------- 达人营销工作流 ----------
  ipcMain.handle("workflow:list", () => workflow.listCreators());
  ipcMain.handle("workflow:add", (_e, input) => workflow.addCreator(input));
  ipcMain.handle("workflow:update", (_e, id, patch) => workflow.updateCreator(id, patch));
  ipcMain.handle("workflow:remove", (_e, id) => workflow.removeCreator(id));
  ipcMain.handle("workflow:advance", (_e, id, dir) => workflow.advanceStage(id, dir));
  ipcMain.handle("workflow:exportCsv", () => workflow.exportCsv());
  ipcMain.handle("workflow:templates", () => workflow.templates());
  ipcMain.handle("workflow:platformSearch", (_e, platform, keyword) => workflow.platformSearch(platform, keyword));
  ipcMain.handle("workflow:installSkills", () => workflow.installSkills(path.join(__dirname, "workflow-skills")));
  ipcMain.handle("workflow:openPlatform", (_e, platform, keyword) => {
    shell.openExternal(workflow.platformSearch(platform, keyword));
    return true;
  });

  // ---------- 开箱即用（引擎自举 + API Key） ----------
  let setupState = { nodeReady: false, engineReady: false, apiKeySet: false };
  let provisioning = null;

  function setupResources() {
    return {
      resourcesDir: process.resourcesPath, // 打包后指向 app 资源目录
      userDataDir: path.join(app.getPath("userData"), "runtime"),
    };
  }

  function pushSetupStatus(msg) {
    for (const w of [workflowWindow]) {
      if (w && !w.isDestroyed()) w.webContents.send("setup:status", msg);
    }
  }

  async function runProvision() {
    if (provisioning) return provisioning;
    provisioning = (async () => {
      try {
        pushSetupStatus("正在准备运行环境…");
        const { resourcesDir, userDataDir } = setupResources();
        const node = setup.ensureNode({ resourcesDir, userDataDir, onStatus: pushSetupStatus });
        process.env.DSH_DESKTOP_NODE_BIN = node; // dsh-boot 优先用它
        setupState.nodeReady = true;
        const engine = await setup.ensureEngine({ node, onStatus: pushSetupStatus });
        setupState.engineReady = !!engine;
        setupState.apiKeySet = setup.hasApiKey();
        pushSetupStatus(setupState.apiKeySet ? "引擎与密钥就绪" : "引擎就绪，请填写 API Key");
        for (const w of [workflowWindow]) if (w && !w.isDestroyed()) w.webContents.send("setup:ready", setupState);
      } catch (e) {
        setupState.nodeReady = false;
        pushSetupStatus("安装失败：" + e.message);
        for (const w of [workflowWindow]) if (w && !w.isDestroyed()) w.webContents.send("setup:error", e.message);
      } finally {
        provisioning = null;
      }
    })();
    return provisioning;
  }

  ipcMain.handle("setup:state", () => ({ ...setupState, hasSystemNode: !!setup.systemNode && typeof setup.systemNode === "function" }));
  ipcMain.handle("setup:run", () => runProvision());
  ipcMain.handle("setup:saveKey", (_e, key) => {
    setup.saveApiKey(key);
    setupState.apiKeySet = setup.hasApiKey();
    return setupState.apiKeySet;
  });
  ipcMain.handle("setup:openMain", async () => {
    try {
      await createMainWindow();
      const { url, child } = await ensureDshWeb({ port: PORT });
      dshChild = child;
      await enterHarness(url);
      return { ok: true, url };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
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
  vaultView.setBounds({ x: w - width, y: TITLE_BAR_H, width, height: h - TITLE_BAR_H });
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
    // 深色标题栏：Windows 用隐藏+overlay；macOS 保持原生（红绿灯按钮）
    ...(process.platform === "win32"
      ? { titleBarStyle: "hidden", titleBarOverlay: { color: "#05070f", symbolColor: "#9fc0ff", height: 44 } }
      : { titleBarStyle: "hiddenInset" }),
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
    mainWindow.setTitle(`达人营销工作台 — ${url}`);
  }
}

/** 达人营销工作台窗口（流程看板 + 模板 + 设置） */
function createWorkflowWindow() {
  if (workflowWindow) {
    workflowWindow.show();
    workflowWindow.focus();
    return workflowWindow;
  }
  workflowWindow = new BrowserWindow({
    width: 1420,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    title: "达人营销工作台",
    backgroundColor: "#05070f",
    icon: iconPath(256),
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  workflowWindow.loadFile(path.join(__dirname, "renderer", "workflow.html"));
  workflowWindow.on("closed", () => {
    workflowWindow = null;
  });
  return workflowWindow;
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
      label: "工作台",
      submenu: [
        { label: "达人营销工作台", accelerator: "CmdOrCtrl+W", click: () => createWorkflowWindow() },
        { label: "导出达人库 CSV", click: () => { const f = workflow.exportCsv(); shell.showItemInFolder(f); } },
      ],
    },
    {
      label: "记忆库",
      submenu: [
        { label: "打开 / 收起记忆库", accelerator: "CmdOrCtrl+M", click: () => toggleVaultPanel() },
        { label: "重新扫描本机 Codex / Claude Code 会话", click: () => { vaultPendingRefresh = true; showVaultPanel(); } },
      ],
    },
    {
      label: "帮助",
      submenu: [
        { label: "DSH Web 地址", click: () => shell.openExternal(`http://127.0.0.1:${PORT}`) },
        { label: "关于 达人营销工作台", click: () => aboutDialog() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function aboutDialog() {
  dialog.showMessageBox(mainWindow || undefined, {
    type: "info",
    title: "关于 达人营销工作台",
    message: "达人营销工作台 v" + app.getVersion(),
    detail: [
      "",
      "面向达人营销工作流的桌面端：",
      "· 8 阶段流程看板：达人筛选→邀约→洽谈→确认→内容对接→脚本审核→发布上线→数据复盘",
      "· 达人库、话术/审核/复盘模板、CSV 导出、平台搜索与自动化助手",
      "· 内置 DeepSeek Harness 引擎（主窗口 = harness，含记忆库与能力词典）",
      "· 记忆库读取【本机使用者自己】的 Codex / Claude Code 会话，不捆绑任何作者数据",
      "· 所有业务数据仅保存在本机（%APPDATA%\\dsh-creator-studio）",
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
      // 首启用：把工作流技能装到本机使用者的技能目录（谁下载装给谁）
      try {
        const r = workflow.installSkills(path.join(__dirname, "workflow-skills"));
        if (r.installed && r.installed.length) {
          console.log("[creator-studio] installed workflow skills:", r.installed.join(", "));
        }
      } catch { /* 技能安装失败不阻塞启动 */ }

      // 1) 打开达人营销工作台（含「开箱即用」引导：自动装引擎 + 界面填 API）
      createWorkflowWindow();
      // 2) 后台自举引擎（内置 Node → npx 装 dsh），就绪后由界面引导打开主窗口
      runProvision();
    } catch (err) {
      dialog.showErrorBox("达人营销工作台 启动失败", `${err.message}`);
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
