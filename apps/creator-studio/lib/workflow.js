"use strict";
/**
 * lib/workflow.js — 达人营销工作流数据层。
 * 工作流：达人筛选 → 邀约 → 洽谈 → 确认 → 内容对接 → 脚本审核 → 发布上线 → 数据复盘。
 * 数据仅存本机（%APPDATA%\dsh-creator-studio\workflow.json），谁下载谁用自己的数据。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const STAGES = [
  { id: "screening", name: "达人筛选", desc: "按平台/粉丝量/垂类筛选候选达人", color: "#4f8cff" },
  { id: "invite", name: "达人邀约", desc: "发送合作邀约（私信/邮件/微信）", color: "#22d3ee" },
  { id: "negotiate", name: "洽谈合作", desc: "沟通报价 / 合作形式 / 排期", color: "#8b5cf6" },
  { id: "confirm", name: "确认合作", desc: "确认合作并定档", color: "#f59e0b" },
  { id: "handoff", name: "内容对接", desc: "提供产品 / 卖点 / 脚本素材", color: "#34d399" },
  { id: "review", name: "脚本内容审核", desc: "脚本与成片审核，过审", color: "#f87171" },
  { id: "publish", name: "内容发布上线", desc: "按排期发布", color: "#e879f9" },
  { id: "data", name: "数据回收复盘", desc: "回收数据，复盘归档", color: "#a3b3d6" },
];

const PLATFORMS = [
  { name: "小红书", search: "https://www.xiaohongshu.com/search_result?keyword=" },
  { name: "抖音", search: "https://www.douyin.com/search/" },
  { name: "快手", search: "https://www.kuaishou.com/search?searchWord=" },
  { name: "B站", search: "https://search.bilibili.com/all?keyword=" },
  { name: "微博", search: "https://s.weibo.com/weibo?q=" },
  { name: "视频号", search: "https://channels.weixin.qq.com/" },
];

const CONTACTS = ["微信", "私信", "邮箱", "手机号", "其他"];

/** 邀约/洽谈话术模板（可在工作台里复制/让 AI 改写） */
const TALKING_TEMPLATES = [
  {
    name: "标准合作邀约",
    text:
      "Hi {name}，我们是{品牌}，看到你在{platform}的内容风格很适合我们这次的合作。\n" +
      "想邀请你做一期{类型}的内容合作，产品会免费寄送，费用按{报价}结算，时间{排期}。\n" +
      "方便的话我们可以细聊合作细节，期待你的回复～",
  },
  {
    name: "带货合作邀约（佣金）",
    text:
      "{name}你好，我们在{platform}看到你的粉丝画像和我们的产品非常匹配。\n" +
      "希望合作带货：佣金{佣金比例} + 坑位费{坑位费}，档期{排期}。\n" +
      "这是我们的产品资料，你看是否感兴趣：{素材链接}",
  },
  {
    name: "长期合作邀约",
    text:
      "{name}您好，我们是{品牌}，希望与您建立长期合作：每月{频次}次内容合作，\n" +
      "年框报价{年框价}，内容方向以{方向}为主。附件是我们的合作方案，期待沟通。",
  },
];

/** 脚本/内容审核清单 */
const REVIEW_CHECKLIST = [
  "产品信息准确（名称/卖点/价格）",
  "无夸大宣传 / 违禁词（最好、第一、绝对等）",
  "广告标识合规（种草需注明广告/合作）",
  "口播脚本与画面一致",
  "品牌露出次数与要求一致",
  "优惠信息 / 链接正确",
  "无竞品 / 负面内容",
  "时长符合要求",
  "封面与标题规范",
  "成片画质 / 字幕 / BGM 版权",
];

/** 复盘指标 */
const REVIEW_METRICS = [
  "曝光量", "播放量", "点赞量", "评论量", "收藏量", "分享量", "互动率", "涨粉量",
  "进店/点击量", "成交金额 GMV", "ROI", "客单价", "退货率", "转化率",
];

/** 跨平台应用数据目录：win → %APPDATA%\dsh-creator-studio；mac → ~/Library/Application Support/dsh-creator-studio；linux → ~/.local/share/dsh-creator-studio */
function workflowDir() {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, "dsh-creator-studio");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "dsh-creator-studio");
  return path.join(os.homedir(), ".local", "share", "dsh-creator-studio");
}

function workflowFile() {
  return path.join(workflowDir(), "workflow.json");
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(workflowFile(), "utf8"));
  } catch {
    return { creators: [], updatedAt: null };
  }
}

function save(data) {
  fs.mkdirSync(workflowDir(), { recursive: true });
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(workflowFile(), JSON.stringify(data, null, 2), "utf8");
  return data;
}

function listCreators() {
  const d = load();
  return {
    stages: STAGES,
    creators: d.creators || [],
    updatedAt: d.updatedAt,
  };
}

function addCreator(input) {
  const d = load();
  const creator = {
    id: "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(input.name || "").trim(),
    platform: input.platform || "小红书",
    account: String(input.account || "").trim(),
    niche: String(input.niche || "").trim(),
    followerCount: Number(input.followerCount || 0),
    contact: input.contact || "私信",
    contactValue: String(input.contactValue || "").trim(),
    price: String(input.price || "").trim(),
    stage: input.stage || "screening",
    notes: String(input.notes || "").trim(),
    tags: Array.isArray(input.tags) ? input.tags : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (!creator.name) throw new Error("请填写达人名称");
  d.creators.push(creator);
  save(d);
  return creator;
}

function updateCreator(id, patch) {
  const d = load();
  const c = (d.creators || []).find((x) => x.id === id);
  if (!c) throw new Error("达人不存在");
  Object.assign(c, patch, { updatedAt: new Date().toISOString() });
  save(d);
  return c;
}

function removeCreator(id) {
  const d = load();
  d.creators = (d.creators || []).filter((x) => x.id !== id);
  save(d);
  return true;
}

function advanceStage(id, dir = 1) {
  const d = load();
  const c = (d.creators || []).find((x) => x.id === id);
  if (!c) throw new Error("达人不存在");
  const idx = STAGES.findIndex((s) => s.id === c.stage);
  const next = Math.min(STAGES.length - 1, Math.max(0, idx + dir));
  c.stage = STAGES[next].id;
  c.updatedAt = new Date().toISOString();
  save(d);
  return c;
}

function exportCsv() {
  const d = load();
  const rows = [["达人", "平台", "账号", "垂类", "粉丝量", "联系方式", "报价", "阶段", "备注", "标签", "创建时间", "更新时间"]];
  for (const c of d.creators || []) {
    const stage = STAGES.find((s) => s.id === c.stage);
    rows.push([
      c.name, c.platform, c.account, c.niche, c.followerCount,
      `${c.contact}:${c.contactValue}`, c.price, stage ? stage.name : c.stage,
      c.notes, (c.tags || []).join("|"), c.createdAt, c.updatedAt,
    ]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
  fs.mkdirSync(workflowDir(), { recursive: true });
  const file = path.join(workflowDir(), "达人库导出_" + new Date().toISOString().slice(0, 10) + ".csv");
  fs.writeFileSync(file, "\ufeff" + csv, "utf8");
  return file;
}

function templates() {
  return {
    talking: TALKING_TEMPLATES,
    reviewChecklist: REVIEW_CHECKLIST,
    metrics: REVIEW_METRICS,
  };
}

/** 平台搜索链接（配合 Playwright MCP 在 harness 里自动打开/抓取） */
function platformSearch(platform, keyword) {
  const p = PLATFORMS.find((x) => x.name === platform) || PLATFORMS[0];
  return p.search + encodeURIComponent(keyword);
}

/** 首启用：把内置工作流技能装到本机使用者的技能目录（谁下载装给谁） */
function installSkills(skillsRoot) {
  const src = skillsRoot || path.join(__dirname, "..", "workflow-skills");
  const destRoot = path.join(os.homedir(), ".agents", "skills");
  const installed = [];
  if (!fs.existsSync(src)) return { ok: false, installed, error: "内置技能目录缺失" };
  fs.mkdirSync(destRoot, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const from = path.join(src, entry.name);
    const to = path.join(destRoot, entry.name);
    fs.cpSync(from, to, { recursive: true, force: true });
    installed.push(entry.name);
  }
  return { ok: true, installed, dir: destRoot };
}

module.exports = {
  STAGES, PLATFORMS, CONTACTS,
  listCreators, addCreator, updateCreator, removeCreator, advanceStage,
  exportCsv, templates, platformSearch, installSkills,
};
