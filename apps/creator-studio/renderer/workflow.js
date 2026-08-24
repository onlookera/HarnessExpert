"use strict";
/* 达人营销工作台 — renderer，通过 window.dshWorkflow 与主进程通信 */

const wf = window.dshWorkflow;
const $ = (s) => document.querySelector(s);

const state = { stages: [], creators: [], query: "", platform: "", editingId: null };

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtCount(n) {
  const v = Number(n || 0);
  if (v >= 10000) return (v / 10000).toFixed(v >= 100000 ? 0 : 1) + "w";
  return String(v);
}
function setStatus(t) { $("#statusbar").innerHTML = t; }
function stageOf(id) { return state.stages.find((s) => s.id === id); }

/* ---------- 看板渲染 ---------- */
function visibleCreators() {
  const q = state.query.toLowerCase();
  return state.creators.filter((c) => {
    if (state.platform && c.platform !== state.platform) return false;
    if (!q) return true;
    return [c.name, c.platform, c.account, c.niche, c.notes, c.contactValue, c.price]
      .join(" ").toLowerCase().includes(q);
  });
}

function renderBoard() {
  const board = $("#board");
  const list = visibleCreators();
  $("#board-count").textContent = `${list.length} / ${state.creators.length} 位达人`;
  $("#board-empty").hidden = state.creators.length > 0;
  board.innerHTML = "";
  for (const st of state.stages) {
    const cards = list.filter((c) => c.stage === st.id);
    const col = document.createElement("div");
    col.className = "stage-col";
    col.innerHTML = `
      <div class="stage-head">
        <span class="dot" style="background:${st.color};color:${st.color}"></span>
        <span>${esc(st.name)}</span>
        <span class="n">${cards.length}</span>
      </div>
      <div class="stage-body"></div>`;
    const body = col.querySelector(".stage-body");
    for (const c of cards) body.appendChild(cardEl(c));
    board.appendChild(col);
  }
}

function cardEl(c) {
  const div = document.createElement("div");
  div.className = "creator-card";
  div.title = c.notes || "";
  div.innerHTML = `
    <div class="row1">
      <span class="name">${esc(c.name)}</span>
      <span class="plat">${esc(c.platform)}</span>
    </div>
    <div class="meta">
      ${c.niche ? `<span>${esc(c.niche)}</span>` : ""}
      ${c.followerCount ? `<span>粉丝 <b>${fmtCount(c.followerCount)}</b></span>` : ""}
      ${c.price ? `<span>报价 <b>${esc(c.price)}</b></span>` : ""}
    </div>
    <div class="foot">
      <span class="act" data-act="prev" title="退回上一阶段">←</span>
      <span class="act" data-act="next" title="推进到下一阶段">→</span>
      <span class="act" data-act="edit" title="编辑">✎</span>
      <span class="act del" data-act="del" title="删除">✕</span>
    </div>`;
  div.addEventListener("click", (e) => {
    const act = e.target.closest(".act");
    if (!act) { openEdit(c.id); return; }
    e.stopPropagation();
    const a = act.dataset.act;
    if (a === "prev") step(c.id, -1);
    else if (a === "next") step(c.id, 1);
    else if (a === "edit") openEdit(c.id);
    else if (a === "del") del(c.id);
  });
  return div;
}

/* ---------- 数据操作 ---------- */
async function reload() {
  const d = await wf.list();
  state.stages = d.stages;
  state.creators = d.creators || [];
  renderBoard();
  setStatus(`共 ${state.creators.length} 位达人 · 数据仅存本机`);
}
async function step(id, dir) {
  await wf.advance(id, dir);
  await reload();
}
async function del(id) {
  if (!confirm("确定删除这位达人？")) return;
  await wf.remove(id);
  await reload();
}

/* ---------- 弹窗（新增/编辑） ---------- */
function fillStageSelect(selected) {
  const sel = $("#f-stage");
  sel.innerHTML = state.stages.map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${esc(s.name)}</option>`).join("");
}

function openEdit(id) {
  const c = id ? state.creators.find((x) => x.id === id) : null;
  state.editingId = id || null;
  $("#modal-title").textContent = c ? "编辑达人：" + c.name : "新增达人";
  $("#f-name").value = c ? c.name : "";
  $("#f-platform").value = c ? c.platform : "小红书";
  $("#f-followers").value = c ? c.followerCount : "";
  $("#f-account").value = c ? c.account : "";
  $("#f-niche").value = c ? c.niche : "";
  $("#f-contact").value = c ? c.contact : "私信";
  $("#f-contact-value").value = c ? c.contactValue : "";
  $("#f-price").value = c ? c.price : "";
  $("#f-notes").value = c ? c.notes : "";
  fillStageSelect(c ? c.stage : "screening");
  $("#modal").hidden = false;
}

async function saveModal() {
  const input = {
    name: $("#f-name").value,
    platform: $("#f-platform").value,
    followerCount: Number($("#f-followers").value || 0),
    account: $("#f-account").value,
    niche: $("#f-niche").value,
    contact: $("#f-contact").value,
    contactValue: $("#f-contact-value").value,
    price: $("#f-price").value,
    stage: $("#f-stage").value,
    notes: $("#f-notes").value,
  };
  if (!input.name.trim()) { alert("请填写达人名称"); return; }
  if (state.editingId) await wf.update(state.editingId, input);
  else await wf.add(input);
  $("#modal").hidden = true;
  await reload();
}

/* ---------- 模板库 ---------- */
async function loadTemplates() {
  const t = await wf.templates();
  $("#tpl-talking").innerHTML = (t.talking || []).map((x, i) => `
    <div class="tpl-card">
      <div class="tpl-name">${esc(x.name)}</div>
      <div class="tpl-text">${esc(x.text)}</div>
      <button class="btn tpl-copy" data-copy="${i}">复制话术</button>
    </div>`).join("");
  document.querySelectorAll(".tpl-copy").forEach((b) =>
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(t.talking[Number(b.dataset.copy)].text);
      b.textContent = "✓ 已复制";
      setTimeout(() => (b.textContent = "复制话术"), 1200);
    })
  );
  $("#tpl-review").innerHTML = (t.reviewChecklist || []).map((x) => `<div class="check">☐ ${esc(x)}</div>`).join("");
  $("#tpl-metrics").innerHTML = (t.metrics || []).map((x) => `<span class="chip">${esc(x)}</span>`).join("");
}

/* ---------- 设置 ---------- */
const MCP_EXAMPLE = `# 追加到 %USERPROFILE%\\.dsh\\profiles\\web\\cordis.patch.yml，重启生效
- insert:
    # 浏览器自动化（筛选达人 / 抓数据 / 发布监测）
    - id: mcp-browser
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: browser
        command: npx
        args: ["-y", "@playwright/mcp@latest"]
        failOnStartupError: false
        reconnect: { enabled: true }

    # Office 文档自动化（Excel 报表 / 复盘表）
    - id: mcp-office
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: office
        command: uvx
        args: ["officemcp"]
        failOnStartupError: false

    # 数据库（达人库 / 数据留档，可选用）
    - id: mcp-db
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: db
        command: npx
        args: ["-y", "mcp-server-sqlite", "--db", "<你的数据库路径>"]
        failOnStartupError: false`;

function initSettings() {
  $("#mcp-config").textContent = MCP_EXAMPLE;
  $("#btn-copy-mcp").addEventListener("click", async () => {
    await navigator.clipboard.writeText(MCP_EXAMPLE);
    $("#btn-copy-mcp").textContent = "✓ 已复制";
    setTimeout(() => ($("#btn-copy-mcp").textContent = "复制 MCP 配置"), 1200);
  });
  const doInstall = async () => {
    const s = $("#skills-status");
    s.textContent = "安装中…";
    const r = await wf.installSkills();
    if (r.ok) {
      s.textContent = "✓ 已安装：" + r.installed.join("、") + "（~/.agents/skills）";
      s.style.color = "#34d399";
    } else {
      s.textContent = "安装失败：" + (r.error || "");
      s.style.color = "#f0a1a1";
    }
  };
  $("#btn-skills").addEventListener("click", doInstall);
  $("#btn-skills2").addEventListener("click", doInstall);
}

/* ---------- 标签页 ---------- */
function switchTab(which) {
  document.querySelectorAll("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === which));
  $("#pane-board").hidden = which !== "board";
  $("#pane-templates").hidden = which !== "templates";
  $("#pane-settings").hidden = which !== "settings";
  if (which === "templates") loadTemplates();
}

/* ---------- 事件绑定 ---------- */
document.querySelectorAll("#tabs .tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);
$("#btn-add").addEventListener("click", () => openEdit(null));
$("#btn-export").addEventListener("click", async () => {
  const f = await wf.exportCsv();
  setStatus("✓ 已导出： " + f);
});
$("#search").addEventListener("input", () => {
  state.query = $("#search").value;
  renderBoard();
});
$("#filter-platform").addEventListener("change", () => {
  state.platform = $("#filter-platform").value;
  renderBoard();
});
$("#btn-modal-cancel").addEventListener("click", () => ($("#modal").hidden = true));
$("#btn-modal-save").addEventListener("click", saveModal);
$("#modal").addEventListener("click", (e) => { if (e.target === $("#modal")) $("#modal").hidden = true; });

/* ---------- 启动 ---------- */
initSettings();
bootSetup();

/* ---------- 开箱即用引导 ---------- */
const st = window.dshSetup;
let setup = { engineReady: false, apiKeySet: false };

function setupStatus(text, cls) {
  const el = $("#setup-status");
  el.textContent = text;
  el.className = "step-status" + (cls ? " " + cls : "");
  const bar = $("#setup-bar");
  if (cls === "ok") bar.style.width = "100%";
  else if (cls === "err") bar.style.width = "60%";
}

async function bootSetup() {
  reload(); // 看板数据照常加载（引导层关闭后立即可用）
  try {
    const s = await st.state();
    setup.engineReady = !!s.engineReady;
    setup.apiKeySet = !!s.apiKeySet;
    if (setup.engineReady && setup.apiKeySet) {
      $("#setup-wizard").hidden = true;
      return;
    }
    $("#setup-wizard").hidden = false;
    if (!setup.engineReady) {
      setupStatus("正在自动安装引擎（无需你操作）…");
      st.run();
    } else {
      onSetupReady(setup);
    }
  } catch (e) {
    setupStatus("初始化失败：" + e.message, "err");
  }
}

function onSetupReady(s) {
  setup.engineReady = !!s.engineReady;
  setup.apiKeySet = !!s.apiKeySet;
  $("#step-engine").classList.add("done");
  setupStatus(setup.engineReady ? "✓ 引擎已就绪" : "引擎未就绪", "ok");
  $("#btn-setup-next").disabled = false;
  if (setup.apiKeySet) {
    $("#step-key").classList.add("done");
    $("#setup-done-status").textContent = "✓ 已配置 API Key，可直接使用";
    $("#btn-setup-open").hidden = false;
    $("#btn-setup-next").hidden = true;
  } else {
    $("#btn-setup-next").textContent = "填写 API Key →";
  }
}

st.onStatus((m) => setupStatus(m));
st.onReady((s) => onSetupReady(s));
st.onError((m) => setupStatus("安装失败：" + m, "err"));

$("#btn-setup-next").addEventListener("click", async () => {
  const btn = $("#btn-setup-next");
  if (!setup.engineReady) {
    btn.disabled = true;
    setupStatus("正在自动安装引擎…");
    st.run();
    return;
  }
  const key = $("#setup-api-key").value.trim();
  if (!key) { $("#setup-api-key").focus(); return; }
  btn.disabled = true;
  setupStatus("正在保存…");
  const ok = await st.saveKey(key);
  if (ok) {
    setup.apiKeySet = true;
    $("#step-key").classList.add("done");
    $("#setup-done-status").textContent = "✓ API Key 已保存到本机";
    setupStatus("✓ 全部就绪", "ok");
    btn.hidden = true;
    $("#btn-setup-open").hidden = false;
    const r = await st.openMain();
    if (r && r.ok) { $("#setup-wizard").hidden = true; }
    else setupStatus("打开主窗口失败：" + (r ? r.error : "未知"), "err");
  } else {
    btn.disabled = false;
    setupStatus("保存失败，请重试", "err");
  }
});

$("#btn-setup-open").addEventListener("click", async () => {
  const r = await st.openMain();
  if (r && r.ok) $("#setup-wizard").hidden = true;
  else setupStatus("打开主窗口失败：" + (r ? r.error : "未知"), "err");
});
