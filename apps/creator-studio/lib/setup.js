"use strict";
/**
 * lib/setup.js — 「开箱即用」引擎自举 + API Key 配置。
 * 让对方下载后：打开应用 → 界面引导安装引擎 → 界面填写 API Key → 直接使用。
 * 全程不需要对方碰命令行 / 装 Node / 装 dsh。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const IS_WIN = process.platform === "win32";
const NODE_NAME = IS_WIN ? "node.exe" : "node";

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** 1) 系统 PATH 里的 node */
function systemNode() {
  const names = IS_WIN ? ["node.exe", "node.cmd"] : ["node"];
  for (const dir of String(process.env.PATH || "").split(IS_WIN ? ";" : ":")) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 2) 已解压到用户目录 / 随应用分发的 node（win: node.exe；mac/linux: bin/node） */
function bundledNode(resourcesDir, userDataDir) {
  const candidates = [
    path.join(userDataDir, NODE_NAME),
    path.join(userDataDir, "node-portable", NODE_NAME),
    path.join(userDataDir, "node-portable", "bin", NODE_NAME),
    path.join(resourcesDir, "node-portable", NODE_NAME),
    path.join(resourcesDir, "node-portable", "bin", NODE_NAME),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // 已解压过（目录结构含版本层）：递归搜索一次
  return findFile(userDataDir, NODE_NAME) || findFile(resourcesDir, NODE_NAME) || null;
}

function findFile(root, name, depth = 0) {
  if (depth > 7 || !fs.existsSync(root)) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name, depth + 1);
      if (f) return f;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

/** 平台对应的内置 Node 归档文件（extraResources） */
function nodeArchiveName() {
  if (IS_WIN) return "node-portable.zip";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `node-v20.18.0-darwin-${arch}.tar.gz`;
}

/** 确保有一个可用的 node：优先内置/已解压，其次系统，最后解压随应用分发的归档 */
function ensureNode({ resourcesDir, userDataDir, onStatus }) {
  let node = bundledNode(resourcesDir, userDataDir);
  if (node) return node;
  node = systemNode();
  if (node) return node;
  const archive = path.join(resourcesDir, nodeArchiveName());
  if (!fs.existsSync(archive)) throw new Error("未找到内置运行环境，请安装 Node.js 后重试");
  onStatus && onStatus("正在解压内置运行环境…");
  fs.mkdirSync(userDataDir, { recursive: true });
  const r = IS_WIN
    ? spawnSync("tar", ["-xf", archive, "-C", userDataDir], { encoding: "utf8", timeout: 180000 })
    : spawnSync("tar", ["-xzf", archive, "-C", userDataDir], { encoding: "utf8", timeout: 180000 });
  if (r.status !== 0) throw new Error("内置运行环境解压失败: " + String(r.stderr || "").slice(0, 200));
  const found = findFile(userDataDir, NODE_NAME);
  if (!found) throw new Error("内置运行环境不完整");
  onStatus && onStatus("运行环境就绪");
  return found;
}

/** 在 npx 缓存里找 dsh CLI（win / mac 两处都查） */
function findDshBin() {
  const roots = [
    path.join(os.homedir(), "AppData", "Local", "npm-cache", "_npx"),
    path.join(os.homedir(), ".npm", "_npx"),
  ];
  let best = null;
  let bestM = 0;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let hashes;
    try { hashes = fs.readdirSync(root); } catch { continue; }
    for (const hash of hashes) {
      const bin = path.join(root, hash, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
      if (fs.existsSync(bin)) {
        const m = fs.statSync(bin).mtimeMs;
        if (m > bestM) { bestM = m; best = bin; }
      }
    }
  }
  return best;
}

/** node 同目录下的 npx-cli.js（node 发行版自带 npm） */
function npxCliFor(node) {
  const dir = path.dirname(node);
  const cands = [
    path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"),
    path.join(dir, "npx-cli.js"),
    path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npx-cli.js"),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function runAsync(cmd, args, onStatus, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    const t = setTimeout(() => { child.kill(); reject(new Error("超时")); }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error("安装引擎失败(exit " + code + ")\n" + log.slice(-400)));
    });
  });
}

/** 确保 dsh 引擎可用：没有就用 node 的 npx 装一次 */
async function ensureEngine({ node, onStatus }) {
  let bin = findDshBin();
  if (bin) { onStatus && onStatus("引擎已就绪"); return bin; }
  onStatus && onStatus("正在安装 DeepSeek Harness 引擎（首次约 1~3 分钟）…");
  const npxCli = npxCliFor(node);
  if (!npxCli) throw new Error("内置运行环境缺少 npm");
  await runAsync(node, [npxCli, "--yes", "@deepseek-ai/dsh", "--version"], onStatus);
  bin = findDshBin();
  if (!bin) throw new Error("引擎安装失败，请检查网络后重试");
  onStatus && onStatus("引擎已就绪");
  return bin;
}

/* ---------- API Key ---------- */

function readYamlish(file) {
  try {
    const out = {};
    let cur = null;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m) { cur = m[1]; out[cur] = m[2] || ""; continue; }
      const m2 = line.match(/^\s{2}([A-Za-z0-9_-]+):\s*(.*)$/);
      if (m2 && cur) {
        if (typeof out[cur] !== "object") out[cur] = {};
        out[cur][m2[1]] = m2[2] || "";
      }
    }
    return out;
  } catch {
    return {};
  }
}

function yamlString(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) lines.push(`  ${k2}: ${v2}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** 保存 API Key 到 ~/.dsh/.credentials.yaml，并确保模型默认配置 */
function saveApiKey(key) {
  const keyValue = String(key || "").trim();
  if (!keyValue) throw new Error("请填写 API Key");
  const home = dshHome();
  fs.mkdirSync(home, { recursive: true });
  const credFile = path.join(home, ".credentials.yaml");
  const existing = readYamlish(credFile);
  const refs = existing.refs && typeof existing.refs === "object" ? existing.refs : {};
  refs.DEEPSEEK_API_KEY = keyValue;
  existing.refs = refs;
  existing.version = existing.version || "1";
  fs.writeFileSync(credFile, yamlString(existing), "utf8");

  // 确保 agent-default-model 存在（没有则写入默认模型）
  const setFile = path.join(home, "settings.yaml");
  const settings = readYamlish(setFile);
  if (!settings["agent-default-model"]) {
    settings["agent-default-model"] = { provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "high" };
    fs.writeFileSync(setFile, yamlString(settings), "utf8");
  }
  return true;
}

function hasApiKey() {
  const cred = readYamlish(path.join(dshHome(), ".credentials.yaml"));
  const refs = cred.refs || {};
  return !!(refs.DEEPSEEK_API_KEY && String(refs.DEEPSEEK_API_KEY).trim().length > 4);
}

module.exports = { ensureNode, ensureEngine, saveApiKey, hasApiKey, findDshBin, dshHome };
