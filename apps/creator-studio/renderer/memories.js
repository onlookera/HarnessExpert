"use strict";
/* renderer for the 记忆库 window — talks to the main process through window.dshMemory */

const api = window.dshMemory;

const state = {
  sessions: [],      // list summaries from index (all)
  filter: "all",     // all | codex | claude
  query: "",
  activeId: null,
  info: null,
};

const $ = (sel) => document.querySelector(sel);
const listEl = $("#session-list");
const detailEl = $("#detail-body");
const detailEmpty = $("#detail-empty");
const statusbar = $("#statusbar");
const statsEl = $("#stats");
const emptyEl = $("#list-empty");
const emptyText = $("#empty-text");
const searchEl = $("#search");
const scanBtn = $("#btn-scan");

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function relTime(iso) {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = 60 * 1000, h = 60 * m, d = 24 * h;
  if (diff < m) return "刚刚";
  if (diff < h) return Math.floor(diff / m) + " 分钟前";
  if (diff < d) return Math.floor(diff / h) + " 小时前";
  if (diff < 30 * d) return Math.floor(diff / d) + " 天前";
  return new Date(t).toLocaleDateString("zh-CN");
}

function fmtSize(n) {
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
  return n + " B";
}

function setStatus(text) {
  statusbar.innerHTML = text;
}

function setBusy(busy) {
  scanBtn.disabled = busy;
  scanBtn.innerHTML = busy ? '<span class="spin">⟳</span> 扫描中…' : "⟳ 重新扫描";
}

function sourceBadge(source) {
  return source === "codex"
    ? `<span class="badge codex">CODEX · 代码代理</span>`
    : `<span class="badge claude">CLAUDE · 对话</span>`;
}

/* 模型/来源 → 中文标注（英文名后跟一句人话） */
const MODEL_ZH = {
  "deepseek-v4-flash": "DeepSeek V4 Flash（轻快模型）",
  "deepseek-v4-pro": "DeepSeek V4 Pro（深度推理）",
  "openai": "OpenAI（Codex 所用）",
  "custom": "自定义模型",
  "kimi-k3": "Kimi K3（月之暗面）",
  "kimi-k2.7-code": "Kimi K2.7（代码）",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "gpt-5": "GPT-5",
};
function modelLabel(m) {
  if (!m) return "";
  const key = Object.keys(MODEL_ZH).find((k) => String(m).toLowerCase().includes(k));
  return key ? `${m} · ${MODEL_ZH[key]}` : String(m);
}

/* ---------- rendering ---------- */

function visibleSessions() {
  const src = state.filter;
  return state.sessions.filter((s) => src === "all" || s.source === src);
}

function renderList(items, opts = {}) {
  listEl.innerHTML = "";
  if (!items.length) {
    emptyEl.hidden = false;
    emptyText.textContent = opts.emptyText || "没有找到会话";
    return;
  }
  emptyEl.hidden = true;
  for (const s of items) {
    const li = document.createElement("li");
    li.__id = s.id;
    li.className = "session-card" + (s.id === state.activeId ? " active" : "");
    const q = state.query;
    const title = q ? hl(s.title, q) : esc(s.title);
    const snippetHtml = opts.snippet && opts.snippet.trim()
      ? `<div class="snippet">${hl(opts.snippet, q)}</div>`
      : (s.preview && !q ? `<div class="snippet">${esc(s.preview.slice(0, 220))}</div>` : "");
    li.innerHTML = `
      <div class="row1">
        <div class="title">${title}</div>
        ${sourceBadge(s.source)}
        ${s.model ? `<span class="badge model" title="${esc(modelLabel(s.model))}">${esc(String(s.model).split("/").pop())}</span>` : ""}
      </div>
      <div class="meta">
        <span class="project">${esc(s.project || "—")}</span>
        <span>${s.msgCount} 条</span>
        <span class="spacer"></span>
        <span>${esc(relTime(s.updatedAt))}</span>
      </div>
      ${snippetHtml}`;
    li.addEventListener("click", () => openSession(s.id));
    listEl.appendChild(li);
  }
}

function hl(text, q) {
  const safe = esc(text);
  if (!q) return safe;
  try {
    const re = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  } catch {
    return safe;
  }
}

function renderStats(info) {
  const c = info.sources?.codex;
  const cl = info.sources?.claude;
  const when = info.scannedAt ? relTime(info.scannedAt) : "—";
  statsEl.innerHTML = `
    <span>Codex <b>${c ? c.sessions : 0}</b></span>
    <span>Claude <b>${cl ? cl.sessions : 0}</b></span>
    <span>共 <b>${info.count}</b> 个会话</span>
    <span>索引于 ${esc(when)}</span>`;
}

function statusFooter() {
  const info = state.info;
  if (!info) return;
  setStatus(`
    <span>数据目录: <a title="打开数据目录">${esc(info.storeDir)}</a></span>
    <span class="spacer"></span>
    <a data-open="codex">Codex: ${esc(info.codexDir)}</a>
    <a data-open="claude">Claude: ${esc(info.claudeDir)}</a>`);
  document.querySelectorAll("[data-open]").forEach((a) =>
    a.addEventListener("click", () => api.openDir(a.dataset.open))
  );
}

/* ---------- data loading ---------- */

async function load(forceScan = false) {
  setBusy(true);
  try {
    if (!state.info) {
      state.info = await api.appInfo();
      statusFooter();
    }
    if (forceScan || !state.info.storeDir) {
      await api.scan();
    }
    let data = await api.list();
    if (!data || !data.sessions.length) {
      data = await api.scan();
    }
    state.sessions = data.sessions || [];
    renderStats(data);
    renderList(visibleSessions());
    if (!state.sessions.length) {
      emptyEl.hidden = false;
      emptyText.innerHTML =
        "没有找到会话。<br/>请确认 Codex (<code>~/.codex/sessions</code>) 或 Claude Code (<code>~/.claude/projects</code>) 有历史记录后点击重新扫描。";
    }
    setStatus(`已索引 ${data.count} 个会话 · 数据保存在 ${esc(data.scannedAt ? state.info.storeDir : "")}`);
    statusFooter();
  } catch (err) {
    emptyEl.hidden = false;
    emptyText.textContent = "加载失败: " + err.message;
  } finally {
    setBusy(false);
  }
}

async function refresh() {
  setBusy(true);
  try {
    const data = await api.scan();
    state.sessions = data.sessions || [];
    renderStats(data);
    renderList(visibleSessions());
    statusFooter();
  } catch (err) {
    setStatus("扫描失败: " + err.message);
  } finally {
    setBusy(false);
  }
}

async function runSearch(q) {
  setBusy(true);
  try {
    const hits = await api.search(q);
    const items = hits.filter((h) => state.filter === "all" || h.session?.source === state.filter);
    renderList(
      items.map((h) => h.session).filter(Boolean),
      { snippet: items[0]?.snippet || "" }
    );
    // show snippets per item
    const byId = new Map(items.map((h) => [h.session?.id, h.snippet]));
    for (const li of listEl.children) {
      const id = li.__id;
      const sn = byId.get(id);
      if (sn) {
        const div = li.querySelector(".snippet");
        if (div) div.innerHTML = hl(sn, q);
        else li.insertAdjacentHTML("beforeend", `<div class="snippet">${hl(sn, q)}</div>`);
      }
    }
    if (!items.length) {
      emptyEl.hidden = false;
      emptyText.textContent = `没有命中 "${q}"`;
    }
    setStatus(`搜索 "${q}"：命中 ${items.length} 个会话`);
  } catch (err) {
    setStatus("搜索失败: " + err.message);
  } finally {
    setBusy(false);
  }
}

/* ---------- detail ---------- */

async function openSession(id) {
  state.activeId = id;
  renderList(visibleSessions());
  document.getElementById("pane-memories").classList.add("has-session");
  detailEmpty.hidden = true;
  detailEl.hidden = false;
  detailEl.innerHTML = '<p class="note">加载会话…</p>';
  try {
    const d = await api.getSession(id);
    if (!d) throw new Error("会话不存在");
    renderDetail(d);
  } catch (err) {
    detailEl.innerHTML = `<p class="note">加载失败: ${esc(err.message)}</p>`;
  }
}

function msgHtml(m) {
  const isUser = m.role === "user";
  const thinking = m.thinking
    ? `<details class="thinking"><summary>🧠 思考过程 (${m.thinking.length} 字)</summary><div class="think-body">${esc(m.thinking)}</div></details>`
    : "";
  const tools = m.tools && m.tools.length
    ? `<div class="tools">${m.tools.slice(0, 12).map((t) => `<span class="tool-chip">${esc(t)}</span>`).join("")}</div>`
    : "";
  const model = m.model ? `<div class="model-tag">${esc(modelLabel(m.model))}</div>` : "";
  const ts = m.ts ? `<span class="ts">${esc(relTime(m.ts))}</span>` : "";
  return `
    <div class="msg ${isUser ? "user" : "assistant"}">
      ${isUser ? "" : '<div class="avatar">🤖</div>'}
      <div class="bubble">
        ${model}${esc(m.text)}${thinking}${tools}
      </div>
      ${isUser ? '<div class="avatar">🧑</div>' : ""}
      ${ts}
    </div>`;
}

function renderDetail(d) {
  const s = d.session || {};
  const head = `
    <div class="detail-head">
      <h2>${esc(s.title || "(无标题)")}</h2>
      <div class="meta-line">
        ${sourceBadge(s.source || "claude")}
        <span class="proj">${esc(s.project || "—")}</span>
        <span>${s.msgCount || 0} 条消息</span>
        ${s.model ? `<span>模型 ${esc(modelLabel(s.model))}</span>` : ""}
        ${s.originator ? `<span>来源 ${esc(s.originator)}</span>` : ""}
        ${s.cliVersion ? `<span>CLI ${esc(s.cliVersion)}</span>` : ""}
        <span>开始 ${esc(relTime(s.startedAt))}</span>
        <span>更新 ${esc(relTime(s.updatedAt))}</span>
      </div>
      <div class="actions">
        <button class="btn" id="btn-back" title="返回会话列表">← 返回列表</button>
        <button class="btn" id="btn-export">⬇ 导出 Markdown</button>
      </div>
    </div>`;
  const body = d.messages.map(msgHtml).join("");
  const note = d.truncated
    ? `<div class="note">会话较长，仅显示最近 ${d.messages.length} / ${d.total} 条消息（完整内容仍在原文件中）。</div>`
    : "";
  detailEl.innerHTML = head + note + body;
  $("#btn-export").addEventListener("click", async () => {
    const r = await api.exportMd(s.id);
    if (r.ok) {
      const btn = $("#btn-export");
      btn.textContent = "✓ 已导出: " + r.file;
      btn.title = r.file;
    } else {
      alert("导出失败: " + r.error);
    }
  });
  const back = $("#btn-back");
  if (back) {
    back.addEventListener("click", () => {
      document.getElementById("pane-memories").classList.remove("has-session");
      detailEmpty.hidden = false;
      detailEl.hidden = true;
      state.activeId = null;
      renderList(visibleSessions());
    });
  }
}

/* ---------- events ---------- */

searchEl.addEventListener("input", () => {
  state.query = searchEl.value.trim();
  clearTimeout(searchEl.__t);
  searchEl.__t = setTimeout(() => {
    if (state.query) runSearch(state.query);
    else {
      renderList(visibleSessions());
      setStatus(`已索引 ${state.sessions.length} 个会话`);
      statusFooter();
    }
  }, 250);
});

document.querySelectorAll("#filters .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    document.querySelectorAll("#filters .chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    state.filter = chip.dataset.source;
    if (state.query) runSearch(state.query);
    else renderList(visibleSessions());
  })
);

scanBtn.addEventListener("click", () => refresh());

api.onRefreshRequested(() => refresh());

// close the embedded panel
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && api.closePanel) api.closePanel();
});
const closeBtn = $("#btn-close");
if (closeBtn) {
  closeBtn.addEventListener("click", () => api.closePanel && api.closePanel());
}

/* ---------- 标签页切换 ---------- */

const tabsEl = $("#tabs");
document.querySelectorAll("#tabs .tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#pane-memories").hidden = which !== "memories";
    $("#pane-dictionary").hidden = which !== "dictionary";
    if (which === "dictionary") loadDictionary();
  })
);

/* ---------- 能力词典（Skill / MCP / 插件 中文说明） ---------- */

let dictCache = null;
const dictSearchEl = $("#dict-search");
const dictBodyEl = $("#dict-body");

const DICT_TYPE = {
  skill: '<span class="dict-tag skill">技能 SKILL</span>',
  mcp: '<span class="dict-tag mcp">MCP 服务</span>',
  bundle: '<span class="dict-tag bundle">插件 BUNDLE</span>',
};

function dictItemHtml(item) {
  const meta = [];
  if (item.sources && item.sources.length) meta.push(`来源: ${item.sources.join(" / ")}`);
  if (item.command) meta.push(`启动: <code>${esc(item.command)}</code>`);
  if (item.args) meta.push(`参数: <code>${esc(item.args)}</code>`);
  if (item.description && item.description !== item.zh) meta.push(`原文: ${esc(item.description.slice(0, 80))}`);
  return `
    <div class="dict-item">
      <div class="dict-name">${DICT_TYPE[item.type] || ""}<span>${esc(item.name || item.serverName || "")}</span></div>
      <div class="dict-zh">${esc(item.zh)}</div>
      ${meta.length ? `<div class="dict-meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>` : ""}
    </div>`;
}

function renderDictionary(data) {
  const q = (dictSearchEl.value || "").trim().toLowerCase();
  const section = (title, items, type) => {
    const list = items.filter((it) => {
      if (!q) return true;
      const hay = `${it.name || it.serverName || ""} ${it.zh || ""} ${it.description || ""}`.toLowerCase();
      return hay.includes(q);
    });
    if (!list.length) return "";
    return `
      <div class="dict-section">
        <h3>${title}（${list.length}）</h3>
        <div class="dict-grid">
          ${list.map((it) => dictItemHtml({ ...it, type })).join("")}
        </div>
      </div>`;
  };
  dictBodyEl.innerHTML =
    section("🛠 技能 Skills — 说一句话即可触发，中文说明", data.skills || [], "skill") +
    section("🔌 MCP 服务器 — 连接外部软件自动化干活", data.mcps || [], "mcp") +
    section("📦 插件 Bundles — 引擎能力组件", data.bundles || [], "bundle") ||
    '<div class="empty">未找到匹配的能力</div>';
}

async function loadDictionary() {
  if (!dictCache) {
    try {
      dictCache = await api.capabilities();
    } catch (err) {
      dictBodyEl.innerHTML = `<div class="empty">能力词典加载失败：${esc(err.message)}</div>`;
      return;
    }
  }
  renderDictionary(dictCache);
}

if (dictSearchEl) {
  dictSearchEl.addEventListener("input", () => {
    clearTimeout(dictSearchEl.__t);
    dictSearchEl.__t = setTimeout(() => {
      if (dictCache) renderDictionary(dictCache);
    }, 200);
  });
}

/* ---------- boot ---------- */

load();
