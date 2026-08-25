"use strict";
/**
 * lib/dsh-boot.js — attach to or start the DeepSeek Harness web server.
 *
 * The desktop app prefers attaching to an already-running `dsh web` (e.g. a
 * harness session's own UI on 127.0.0.1:3080). If none responds, it spawns one
 * itself — standalone, no manual server startup required:
 *
 *   1. resolve a REAL Node.js executable (never the Electron binary);
 *   2. locate the locally installed `@deepseek-ai/dsh` CLI (npx cache first);
 *   3. spawn `node <bin.js> web --no-open --port <port>` and wait for it.
 */
const { spawn, spawnSync } = require("node:child_process");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_PORT = 3080;
const DEFAULT_HOST = "127.0.0.1";

/** Probe the URL; resolves true when the server answers 2xx/3xx. */
function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/**
 * Find a real Node.js executable. The Electron binary cannot run node scripts,
 * so we must resolve the system node — PATH first, then well-known install
 * locations (Windows nvm-windows / macOS Homebrew & nvm). Cross-platform.
 */
const IS_WIN = process.platform === "win32";
const PATH_SEP = IS_WIN ? ";" : ":";

function resolveNodeExecutable() {
  // 1) explicit override
  if (process.env.DSH_DESKTOP_NODE_BIN) {
    return fs.existsSync(process.env.DSH_DESKTOP_NODE_BIN) ? process.env.DSH_DESKTOP_NODE_BIN : null;
  }
  // 2) PATH entries carrying node(.exe)
  const names = IS_WIN ? ["node.exe", "node.cmd"] : ["node"];
  for (const dir of String(process.env.PATH || "").split(PATH_SEP)) {
    if (!dir) continue;
    for (const name of names) {
      const exe = path.join(dir, name);
      if (fs.existsSync(exe)) return exe;
    }
  }
  // 3) `where node` (Windows) / `which node` (macOS/Linux)
  try {
    const res = spawnSync(IS_WIN ? "where" : "which", ["node"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    if (res.status === 0) {
      const first = String(res.stdout || "").split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
      if (first) return first;
    }
  } catch {
    /* resolver unavailable */
  }
  // 4) common install locations
  const candidates = [];
  if (IS_WIN) {
    candidates.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe")
    );
    // nvm-windows: %APPDATA%\nvm\vX.Y.Z\node.exe
    const nvmRoot = path.join(os.homedir(), "AppData", "Roaming", "nvm");
    try {
      for (const entry of fs.readdirSync(nvmRoot)) {
        candidates.push(path.join(nvmRoot, entry, "node.exe"));
      }
    } catch { /* no nvm */ }
  } else {
    candidates.push(
      "/opt/homebrew/bin/node",   // Apple Silicon Homebrew
      "/usr/local/bin/node",      // Intel Homebrew / 系统
      path.join(os.homedir(), ".nvm", "versions", "node") // nvm（遍历版本）
    );
    const nvmVersions = path.join(os.homedir(), ".nvm", "versions", "node");
    try {
      for (const entry of fs.readdirSync(nvmVersions)) {
        candidates.push(path.join(nvmVersions, entry, "bin", "node"));
      }
    } catch { /* no nvm */ }
  }
  for (const exe of candidates) if (fs.existsSync(exe)) return exe;
  return null;
}

/** Resolve how to launch `dsh web`. Returns {cmd, args, label} or null. */
function resolveDshInvocation(port) {
  const node = resolveNodeExecutable();
  if (!node) return null;

  // 1) the npx cache that installed @deepseek-ai/dsh（跨平台：win 用 npm-cache，mac/linux 用 ~/.npm/_npx）
  const cacheRoot = IS_WIN
    ? path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx")
    : path.join(os.homedir(), ".npm", "_npx");
  let best = null;
  let bestMtime = 0;
  try {
    for (const hash of fs.readdirSync(cacheRoot)) {
      const bin = path.join(cacheRoot, hash, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(bin)) {
        const mtime = fs.statSync(bin).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          best = bin;
        }
      }
    }
  } catch {
    /* no npx cache */
  }
  if (best) {
    return { cmd: node, args: [best, "web", "--no-open", "--port", String(port)], label: best };
  }
  // 2) PATH fallback: `dsh web`
  if (resolveDshOnPath()) {
    return { cmd: "dsh", args: ["web", "--no-open", "--port", String(port)], label: "dsh (PATH)", shell: true };
  }
  // 3) 兜底：自动用 npx 安装并启动 dsh（分发版用户可能没装过）
  const npxCli = dirnameOfNpxCli();
  if (IS_WIN && npxCli) {
    return {
      cmd: node,
      args: [path.join(npxCli, "npx-cli.js"), "--yes", "@deepseek-ai/dsh", "web", "--no-open", "--port", String(port)],
      label: "npx @deepseek-ai/dsh",
    };
  }
  // macOS/Linux：直接 spawn npx（shell 解析）
  return {
    cmd: "npx",
    args: ["--yes", "@deepseek-ai/dsh", "web", "--no-open", "--port", String(port)],
    label: "npx @deepseek-ai/dsh",
    shell: true,
  };
}

/** PATH 上是否有 dsh 可执行文件（win 用 where，mac/linux 用 which） */
function resolveDshOnPath() {
  try {
    const r = require("node:child_process").spawnSync(IS_WIN ? "where" : "which", ["dsh"], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    return r.status === 0 && String(r.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

/** 定位 npm 的 npx-cli.js（node 安装目录下）；mac/linux 走 shell 不依赖此路径 */
function dirnameOfNpxCli() {
  for (const dir of String(process.env.PATH || "").split(PATH_SEP)) {
    if (!dir) continue;
    const cand = path.join(dir, "npx-cli.js");
    if (fs.existsSync(cand)) return dir;
    const nodeExe = path.join(dir, "node.exe");
    if (fs.existsSync(nodeExe)) return dir;
  }
  return process.env.ProgramFiles || "C:\\Program Files\\nodejs";
}

/**
 * Ensure the DSH web UI is reachable.
 * @returns {Promise<{url: string, attached: boolean, child: import("node:child_process").ChildProcess|null}>}
 */
async function ensureDshWeb(opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const port = opts.port || DEFAULT_PORT;
  const url = `http://${host}:${port}`;

  if (await probe(url)) {
    return { url, attached: true, child: null };
  }

  const inv = resolveDshInvocation(port);
  if (!inv) {
    throw new Error(
      "找不到 Node.js 或 dsh CLI。请先安装 Node.js（https://nodejs.org），" +
        "或手动运行一次 `npx -y @deepseek-ai/dsh web` 以完成安装。"
    );
  }

  const spawnOpts = {
    windowsHide: true,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  };
  const child = spawn(inv.cmd, inv.args, { ...spawnOpts, ...(inv.shell ? { shell: true } : {}) });

  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", (code, sig) => {
    if (code !== 0 && code !== null) {
      console.error(`dsh web exited early (code=${code} sig=${sig})\n${log}`);
    }
  });

  const deadline = Date.now() + (opts.timeoutMs || 90_000);
  while (Date.now() < deadline) {
    if (await probe(url)) {
      console.log(`[dsh-desktop] attached to dsh web at ${url} (${inv.label})`);
      return { url, attached: false, child };
    }
    if (child.exitCode !== null) {
      throw new Error(`dsh web failed to start (exit ${child.exitCode})\n${log.slice(-4000)}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  child.kill();
  throw new Error(`dsh web did not become reachable at ${url} in time\n${log.slice(-4000)}`);
}

module.exports = { ensureDshWeb, probe, resolveDshInvocation, resolveNodeExecutable, DEFAULT_PORT, DEFAULT_HOST };
