"use strict";
/**
 * scripts/analyze-memory.js — mine the Memory Vault for usage patterns.
 * Reads the persisted index/corpus and prints a profile-oriented analysis:
 * projects, task topics, tool/model mentions, and sample titles.
 */
const path = require("node:path");
const os = require("node:os");
const memory = require("../lib/memory");

const store = memory.loadStore();
if (!store) {
  console.error("no store; run: node lib/memory.js --scan --out %APPDATA%/dsh-desktop/memory");
  process.exit(1);
}

const sessions = store.sessions;
console.log(`总会话: ${sessions.length} (codex=${sessions.filter((s) => s.source === "codex").length}, claude=${sessions.filter((s) => s.source === "claude").length})\n`);

// ---- project distribution ----
const projCount = new Map();
for (const s of sessions) {
  const key = s.project || s.cwd || "(unknown)";
  projCount.set(key, (projCount.get(key) || 0) + 1);
}
console.log("== 项目分布 (top 20) ==");
[...projCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([p, n]) => console.log(`  ${String(n).padStart(3)}  ${p}`));

// ---- keyword topic buckets ----
const topics = {
  "视频/ComfyUI/图片生成": /comfyui|sageattention|loral|视频|vide|图片|图像|生成|model|模型|ffmpeg|高清|放大|工作流/,
  "Web/前端开发": /web|网站|前端|html|css|react|vue|js|javascript|页面|部署|域名|jianli|简历/,
  "办公/文档": /word|excel|ppt|pdf|docx|xlsx|wps|表格|文档|合同|汇报/,
  "Python/脚本": /python|pip|venv|脚本|爬虫|requests|pandas/,
  "桌宠/AI 助手": /桌宠|宠物|pet|companion|agent/,
  "游戏": /游戏|gta|fivem|citizenfx|palworld|幻兽帕鲁|原神/,
  "Windows/系统/环境": /windows|powershell|注册表|环境变量|路径|启动|开机|服务/,
  "API/集成": /api|token|密钥|接口|gpt|deepseek|claude|codex|ollama/,
};
const topicHits = {};
for (const [name, re] of Object.entries(topics)) topicHits[name] = 0;
const topicSessions = {};
for (const [name] of Object.entries(topics)) topicSessions[name] = [];
for (const s of sessions) {
  const text = (s.title || "") + " " + (s.preview || "") + " " + (s.project || "");
  const lower = text.toLowerCase();
  for (const [name, re] of Object.entries(topics)) {
    if (re.test(lower)) {
      topicHits[name]++;
      if (topicSessions[name].length < 5) topicSessions[name].push(s.title);
    }
  }
}
console.log("\n== 主题聚类 (按命中会话数) ==");
Object.entries(topicHits).sort((a, b) => b[1] - a[1]).forEach(([name, n]) => {
  console.log(`  ${String(n).padStart(3)}  ${name}`);
  topicSessions[name].slice(0, 3).forEach((t) => console.log(`         · ${t}`));
});

// ---- model mentions ----
const modelCount = new Map();
for (const s of sessions) {
  const m = s.model || s.originator || "n/a";
  modelCount.set(m, (modelCount.get(m) || 0) + 1);
}
console.log("\n== 模型/来源 ==");
[...modelCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([m, n]) => console.log(`  ${String(n).padStart(3)}  ${m}`));

// ---- timeframe ----
const times = sessions.map((s) => s.startedAt).filter(Boolean).sort();
if (times.length) {
  console.log(`\n== 时间范围 ==\n  ${times[0]}  ~  ${times[times.length - 1]}`);
}

// ---- top tools mentioned in corpora (rough) ----
const toolRe = /\b(python|node|npm|pnpm|pip|git|docker|powershell|ffmpeg|excel|word|wps|comfyui|ollama|codex|claude|vscode|chrome|uv)\b/gi;
const toolCount = new Map();
for (const s of sessions) {
  const corpus = store.corpus[`${s.source}:${s.id}`] || "";
  const m = corpus.match(toolRe);
  if (m) for (const t of m) toolCount.set(t.toLowerCase(), (toolCount.get(t.toLowerCase()) || 0) + 1);
}
console.log("\n== 语料高频工具/关键词 (top 25) ==");
[...toolCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([t, n]) => console.log(`  ${String(n).padStart(5)}  ${t}`));
