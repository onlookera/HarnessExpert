"use strict";
/**
 * lib/memory.js — Memory Vault scanner for DSH Desktop.
 *
 * Reads session history left by two external agents and normalizes it into a
 * compact, searchable index:
 *
 *   - Codex      : %USERPROFILE%\.codex\sessions\<YYYY>\<MM>\<DD>\rollout-*.jsonl
 *   - Claude Code: %USERPROFILE%\.claude\projects\<project-dir>\<uuid>.jsonl
 *
 * The same module runs as a plain CLI (`node lib/memory.js --scan`) and as a
 * library from the Electron main process (require("../lib/memory")).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CODEX_DIR = () => path.join(os.homedir(), ".codex", "sessions");
const CLAUDE_DIR = () => path.join(os.homedir(), ".claude", "projects");

const MAX_FILE_BYTES = 64 * 1024 * 1024; // skip anything absurd
const MAX_CORPUS_CHARS = 80 * 1000;      // per-session search corpus cap
const MAX_MSG_CHARS = 20 * 1000;         // per-message display cap
const MAX_MESSAGES = 400;                // detail view cap

// ---------------------------------------------------------------------------
// text extraction helpers
// ---------------------------------------------------------------------------

/** Claude Code content: string | [{type:"text"|"thinking"|"tool_use"|...}] */
function extractClaudeContent(content, out) {
  if (typeof content === "string") {
    if (content.trim()) out.text.push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      out.text.push(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
      out.thinking.push(block.thinking);
    } else if (block.type === "tool_use" && block.name) {
      out.tools.push(String(block.name));
    } else if (block.type === "tool_result") {
      // tool outputs are noise for search; skip
    }
  }
}

/** Codex content: string | [{type:"output_text"|"text", text}] or message.text */
function extractCodexContent(content, out) {
  if (typeof content === "string") {
    if (content.trim()) out.text.push(content);
    return;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string" && item.text.trim()) {
        out.text.push(item.text);
      }
    }
    return;
  }
  if (content && typeof content === "object" && typeof content.text === "string" && content.text.trim()) {
    out.text.push(content.text);
  }
}

/** Strip <command-*> tags that Codex wraps user commands in. */
function cleanUserText(raw) {
  return raw
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function makeTitle(text) {
  const clean = cleanUserText(text);
  return clean.length > 120 ? clean.slice(0, 120) + "…" : clean;
}

function makePreview(text, max = 300) {
  const clean = cleanUserText(text);
  return clean.length > max ? clean.slice(0, max) + "…" : clean;
}

/** Decode a Claude project dir name ("E--vibecoding-videoagent") back to a path. */
function decodeProjectDir(name) {
  const decoded = name.replace(/-/g, "\\").replace(/\\\\+/g, "\\");
  return /^[A-Za-z]:/.test(decoded) ? decoded : name;
}

// ---------------------------------------------------------------------------
// per-file parsers
// ---------------------------------------------------------------------------

/** Parse one Codex rollout jsonl. Returns a Session record (no messages). */
function parseCodexFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  let meta = null;
  const messages = [];
  let lastTs = null;

  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      continue; // tolerate partial/corrupt lines
    }
    const ts = ev.timestamp || null;
    if (ts) lastTs = ts;
    const type = ev.type;
    if (type === "session_meta" && ev.payload) {
      meta = ev.payload;
      continue;
    }
    if (type === "event_msg" && ev.payload && ev.payload.type === "user_message") {
      const text =
        typeof ev.payload.message === "string"
          ? ev.payload.message
          : (ev.payload.message && ev.payload.message.text) || "";
      if (text && text.trim()) messages.push({ role: "user", text: text.trim(), ts });
      continue;
    }
    // agent message: either type:"agent_message" or event_msg payload.type
    const payload = type === "event_msg" ? ev.payload : null;
    if (type === "agent_message" || (payload && payload.type === "agent_message")) {
      const msg = type === "agent_message" ? ev.message : payload.message;
      if (!msg) continue;
      const out = { text: [], thinking: [], tools: [] };
      extractCodexContent(msg.content, out);
      if (typeof msg.text === "string" && msg.text.trim()) out.text.push(msg.text);
      const text = out.text.join("\n").trim();
      if (text) messages.push({ role: "assistant", text, ts, thinking: out.thinking.join("\n").trim() || null });
      continue;
    }
    // treat generic event_msg with message payload as text (defensive)
    if (payload && payload.message && typeof payload.message === "string" && payload.message.trim()) {
      messages.push({ role: "assistant", text: payload.message.trim(), ts });
    }
  }

  const id = (meta && (meta.session_id || meta.id)) || path.basename(file, ".jsonl").replace(/^rollout-/, "");
  const cwd = (meta && meta.cwd) || null;
  const firstUser = messages.find((m) => m.role === "user");
  const startedAt = (meta && meta.timestamp) || (firstUser && firstUser.ts) || lastTs;
  return {
    source: "codex",
    id,
    file,
    cwd,
    project: cwd || null,
    model: (meta && meta.model_provider) || null,
    cliVersion: (meta && meta.cli_version) || null,
    originator: (meta && (meta.originator || meta.source)) || null,
    startedAt,
    updatedAt: lastTs || startedAt,
    title: firstUser ? makeTitle(firstUser.text) : "(无标题会话)",
    preview: firstUser ? makePreview(firstUser.text) : "",
    msgCount: messages.length,
    userMsgCount: messages.filter((m) => m.role === "user").length,
    charCount: messages.reduce((n, m) => n + m.text.length, 0),
    sizeBytes: fs.statSync(file).size,
  };
}

/** Parse one Claude Code project jsonl. Returns a Session record (no messages). */
function parseClaudeFile(file, projectDir) {
  const raw = fs.readFileSync(file, "utf8");
  const messages = [];
  let lastTs = null;
  let sessionId = path.basename(file, ".jsonl");
  let model = null;

  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (ev.sessionId) sessionId = ev.sessionId;
    const ts = ev.timestamp || null;
    if (ts) lastTs = ts;
    const type = ev.type;
    if (type === "user" && ev.message) {
      const out = { text: [], thinking: [], tools: [] };
      extractClaudeContent(ev.message.content, out);
      const text = out.text.join("\n").trim();
      if (text) messages.push({ role: "user", text, ts });
    } else if (type === "assistant" && ev.message) {
      if (ev.message.model) model = ev.message.model;
      const out = { text: [], thinking: [], tools: [] };
      extractClaudeContent(ev.message.content, out);
      const text = out.text.join("\n").trim();
      if (text) messages.push({ role: "assistant", text, ts, thinking: out.thinking.join("\n").trim() || null, tools: out.tools });
    }
  }

  const firstUser = messages.find((m) => m.role === "user");
  return {
    source: "claude",
    id: sessionId,
    file,
    project: projectDir,
    cwd: projectDir,
    model,
    cliVersion: null,
    originator: null,
    startedAt: firstUser && firstUser.ts ? firstUser.ts : lastTs,
    updatedAt: lastTs || (firstUser && firstUser.ts),
    title: firstUser ? makeTitle(firstUser.text) : "(无标题会话)",
    preview: firstUser ? makePreview(firstUser.text) : "",
    msgCount: messages.length,
    userMsgCount: messages.filter((m) => m.role === "user").length,
    charCount: messages.reduce((n, m) => n + m.text.length, 0),
    sizeBytes: fs.statSync(file).size,
  };
}

// ---------------------------------------------------------------------------
// directory walkers
// ---------------------------------------------------------------------------

function walkJsonl(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".jsonl") && (!filter || filter(full))) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.size > 0 && st.size <= MAX_FILE_BYTES) out.push(full);
      }
    }
  }
  return out;
}

function scanCodex(codexDir = CODEX_DIR()) {
  const files = walkJsonl(codexDir, (f) => /rollout-/.test(path.basename(f)) || !/^[a-f0-9-]{36}$/.test(path.basename(f, ".jsonl")));
  return files.map((f) => {
    try {
      return parseCodexFile(f);
    } catch (err) {
      return null;
    }
  }).filter(Boolean);
}

function scanClaude(claudeDir = CLAUDE_DIR()) {
  const out = [];
  if (!fs.existsSync(claudeDir)) return out;
  for (const entry of fs.readdirSync(claudeDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = decodeProjectDir(entry.name);
    const dirPath = path.join(claudeDir, entry.name);
    const files = walkJsonl(dirPath);
    for (const f of files) {
      try {
        const rec = parseClaudeFile(f, projectDir);
        if (rec.msgCount > 0 || rec.charCount > 0) out.push(rec);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// store building / loading
// ---------------------------------------------------------------------------

function buildCorpus(sessions) {
  const corpus = {};
  for (const s of sessions) {
    let full = "";
    try {
      const raw = fs.readFileSync(s.file, "utf8");
      // reuse a lightweight pass: only pull text blocks, mirroring the parser
      if (s.source === "claude") {
        const parts = [];
        for (const line of raw.split("\n")) {
          const l = line.trim();
          if (!l) continue;
          let ev;
          try { ev = JSON.parse(l); } catch { continue; }
          if ((ev.type === "user" || ev.type === "assistant") && ev.message) {
            const out = { text: [], thinking: [], tools: [] };
            extractClaudeContent(ev.message.content, out);
            const t = out.text.join(" ").trim();
            if (t) parts.push((ev.type === "user" ? "user: " : "assistant: ") + t);
          }
        }
        full = parts.join("\n");
      } else {
        const parts = [];
        for (const line of raw.split("\n")) {
          const l = line.trim();
          if (!l) continue;
          let ev;
          try { ev = JSON.parse(l); } catch { continue; }
          if (ev.type === "event_msg" && ev.payload) {
            if (ev.payload.type === "user_message" && typeof ev.payload.message === "string") {
              parts.push("user: " + ev.payload.message);
            } else if (ev.payload.type === "agent_message" && ev.payload.message) {
              const out = { text: [], thinking: [], tools: [] };
              extractCodexContent(ev.payload.message.content, out);
              if (out.text.length) parts.push("assistant: " + out.text.join(" "));
            }
          } else if (ev.type === "agent_message" && ev.message) {
            const out = { text: [], thinking: [], tools: [] };
            extractCodexContent(ev.message.content, out);
            if (out.text.length) parts.push("assistant: " + out.text.join(" "));
          }
        }
        full = parts.join("\n");
      }
    } catch {
      full = "";
    }
    corpus[`${s.source}:${s.id}`] = full.slice(0, MAX_CORPUS_CHARS);
  }
  return corpus;
}

function dirStats(dir) {
  if (!fs.existsSync(dir)) return { dir, exists: false, fileCount: 0, totalBytes: 0 };
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          const st = fs.statSync(full);
          if (st.size <= MAX_FILE_BYTES) {
            fileCount += 1;
            totalBytes += st.size;
          }
        } catch { /* ignore */ }
      }
    }
  }
  return { dir, exists: true, fileCount, totalBytes };
}

/** Full scan: returns the store object {scannedAt, sources, sessions, corpus}. */
function scanAll(opts = {}) {
  const codexDir = opts.codexDir || CODEX_DIR();
  const claudeDir = opts.claudeDir || CLAUDE_DIR();
  const codex = scanCodex(codexDir);
  const claude = scanClaude(claudeDir);
  const sessions = [...codex, ...claude].sort((a, b) => {
    const ta = a.updatedAt || a.startedAt || "";
    const tb = b.updatedAt || b.startedAt || "";
    return String(tb).localeCompare(String(ta));
  });
  const corpus = buildCorpus(sessions);
  const store = {
    scannedAt: new Date().toISOString(),
    sources: {
      codex: { ...dirStats(codexDir), sessions: codex.length },
      claude: { ...dirStats(claudeDir), sessions: claude.length },
    },
    sessions,
    corpus,
  };
  return store;
}

const DEFAULT_STORE_DIR = () => path.join(os.homedir(), "AppData", "Roaming", "dsh-desktop", "memory");

function saveStore(store, dir = DEFAULT_STORE_DIR()) {
  fs.mkdirSync(dir, { recursive: true });
  const { corpus, ...index } = store;
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(index), "utf8");
  fs.writeFileSync(path.join(dir, "corpus.json"), JSON.stringify(corpus), "utf8");
  return dir;
}

function loadStore(dir = DEFAULT_STORE_DIR()) {
  const indexFile = path.join(dir, "index.json");
  const corpusFile = path.join(dir, "corpus.json");
  if (!fs.existsSync(indexFile) || !fs.existsSync(corpusFile)) return null;
  try {
    const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
    const corpus = JSON.parse(fs.readFileSync(corpusFile, "utf8"));
    return { ...index, corpus };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// search / detail / export
// ---------------------------------------------------------------------------

function makeSnippet(text, idx, qlen, radius = 80) {
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + qlen + radius);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}

/** Case-insensitive full-text search across the corpus. */
function search(store, query, { limit = 60 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  for (const s of store.sessions) {
    const corpus = store.corpus[`${s.source}:${s.id}`] || "";
    const idx = corpus.toLowerCase().indexOf(q);
    const titleHit = (s.title || "").toLowerCase().includes(q);
    const previewHit = (s.preview || "").toLowerCase().includes(q);
    if (idx >= 0 || titleHit || previewHit) {
      hits.push({
        session: s,
        snippet: idx >= 0 ? makeSnippet(corpus, idx, q.length) : makePreview(s.preview || s.title || "", 180),
        inTitle: titleHit || previewHit,
      });
    }
  }
  return hits.slice(0, limit);
}

/** Re-parse the original file to return the full message list for display. */
function getSessionMessages(record) {
  const raw = fs.readFileSync(record.file, "utf8");
  const messages = [];
  for (const line of raw.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    let ev;
    try { ev = JSON.parse(l); } catch { continue; }
    if (record.source === "claude") {
      if ((ev.type === "user" || ev.type === "assistant") && ev.message) {
        const out = { text: [], thinking: [], tools: [] };
        extractClaudeContent(ev.message.content, out);
        const text = out.text.join("\n").trim();
        if (!text) continue;
        messages.push({
          role: ev.type,
          ts: ev.timestamp || null,
          text: text.slice(0, MAX_MSG_CHARS),
          thinking: out.thinking.length ? out.thinking.join("\n").trim().slice(0, MAX_MSG_CHARS) : null,
          tools: out.tools,
          model: ev.message.model || null,
        });
      }
    } else {
      const payload = ev.type === "event_msg" ? ev.payload : null;
      if (ev.type === "event_msg" && payload && payload.type === "user_message") {
        const text = typeof payload.message === "string" ? payload.message : (payload.message && payload.message.text) || "";
        if (text && text.trim()) messages.push({ role: "user", ts: ev.timestamp || null, text: text.trim().slice(0, MAX_MSG_CHARS), thinking: null, tools: [] });
      } else if (ev.type === "agent_message" || (payload && payload.type === "agent_message")) {
        const msg = ev.type === "agent_message" ? ev.message : payload.message;
        if (!msg) continue;
        const out = { text: [], thinking: [], tools: [] };
        extractCodexContent(msg.content, out);
        if (typeof msg.text === "string" && msg.text.trim()) out.text.push(msg.text);
        const text = out.text.join("\n").trim();
        if (text) messages.push({ role: "assistant", ts: ev.timestamp || null, text: text.slice(0, MAX_MSG_CHARS), thinking: out.thinking.length ? out.thinking.join("\n").trim().slice(0, MAX_MSG_CHARS) : null, tools: out.tools });
      }
    }
  }
  const truncated = messages.length > MAX_MESSAGES;
  const kept = truncated ? messages.slice(-MAX_MESSAGES) : messages;
  return { messages: kept, total: messages.length, truncated };
}

/** Export a session to a Markdown transcript file; returns the written path. */
function exportSessionMarkdown(record, exportDir) {
  const { messages, total, truncated } = getSessionMessages(record);
  fs.mkdirSync(exportDir, { recursive: true });
  const safe = String(record.id).replace(/[^\w.-]+/g, "_");
  const file = path.join(exportDir, `${record.source}-${safe}.md`);
  const lines = [];
  lines.push(`# ${record.title}`);
  lines.push("");
  lines.push(`- 来源: ${record.source}`);
  lines.push(`- 会话: ${record.id}`);
  lines.push(`- 项目: ${record.project || "-"}`);
  lines.push(`- 开始: ${record.startedAt || "-"}`);
  lines.push(`- 更新: ${record.updatedAt || "-"}`);
  lines.push(`- 消息数: ${total}${truncated ? ` (仅导出最近 ${messages.length} 条)` : ""}`);
  if (record.model) lines.push(`- 模型: ${record.model}`);
  lines.push("");
  for (const m of messages) {
    lines.push(`## ${m.role === "user" ? "用户" : "助手"} ${m.ts ? "· " + m.ts : ""}`);
    lines.push("");
    if (m.tools && m.tools.length) lines.push(`*工具: ${m.tools.join(", ")}*`);
    lines.push(m.text);
    lines.push("");
  }
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--scan")) {
    const t0 = Date.now();
    const store = scanAll();
    const ms = Date.now() - t0;
    console.log(`扫描完成 (${ms}ms)`);
    for (const key of ["codex", "claude"]) {
      const s = store.sources[key];
      console.log(`  ${key.padEnd(6)}: ${s.sessions} 个会话, ${s.fileCount} 个文件, ${(s.totalBytes / 1024 / 1024).toFixed(1)} MB  ${s.dir}`);
    }
    const qIdx = args.indexOf("--search");
    if (qIdx >= 0 && args[qIdx + 1]) {
      const hits = search(store, args[qIdx + 1], { limit: 10 });
      console.log(`\n搜索 "${args[qIdx + 1]}": ${hits.length} 条命中`);
      for (const h of hits) {
        console.log(`  [${h.session.source}] ${h.session.title}  (${h.session.updatedAt || ""})`);
        console.log(`      ${(h.snippet || "").slice(0, 140)}`);
      }
    }
    const saveIdx = args.indexOf("--out");
    if (saveIdx >= 0 && args[saveIdx + 1]) {
      const dir = saveStore(store, args[saveIdx + 1]);
      console.log(`已保存索引到 ${dir}`);
    }
  } else {
    console.log("用法: node lib/memory.js --scan [--search <词>] [--out <目录>]");
  }
}

module.exports = {
  CODEX_DIR,
  CLAUDE_DIR,
  scanAll,
  saveStore,
  loadStore,
  search,
  getSessionMessages,
  exportSessionMarkdown,
  decodeProjectDir,
  DEFAULT_STORE_DIR,
};
