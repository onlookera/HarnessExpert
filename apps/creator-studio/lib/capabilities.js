"use strict";
/**
 * lib/capabilities.js — 能力词典：扫描本机已装/可用的 Skills、MCP 服务器与
 * 插件 bundle，并为每个英文标识附上中文用途说明（很多来自用户的记忆库画像）。
 * 供桌面端「能力词典」页展示，让英文名字不再难懂。
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const AGENTS_SKILLS = () => path.join(os.homedir(), ".agents", "skills");
const CLAUDE_SKILLS = () => path.join(os.homedir(), ".claude", "skills");
const CODEX_SKILLS = () => path.join(os.homedir(), ".codex", "skills");
const PROFILE_DIR = () => path.join(os.homedir(), ".dsh", "profiles", "web");

/** 已知技能的固定中文说明（覆盖 frontmatter 缺失或英文的情况） */
const SKILL_ZH = {
  "code-review": "代码审查：按规范与需求双轴审查分支/PR 改动",
  "frontend-design": "前端设计：独特视觉风格、字体排版与动效指导",
  "pdf": "PDF 处理：提取文本/表格、生成、合并拆分、填写表单",
  "planning-with-files": "文件式规划：task_plan/findings/progress 落盘，防上下文丢失",
  "skill-creator": "技能创作：教你/帮你编写新的 SKILL.md 技能",
  "grill-me": "犀利追问：像面试官一样拷问方案，逼出漏洞（/grilling）",
  "hatch-pet": "桌宠孵化：Codex 桌宠的创建/修复/动画 spritesheet/打包",
  "ppt-master": "演示文稿大师：生成可编辑 PPTX、套模板、美化成品",
  "video-prompt-engineer": "视频提示词工程：文生视频/图生视频/分镜/角色一致性",
  "user-profile": "用户画像：你的项目地图、日常用法与协作偏好",
  "comfyui-video": "ComfyUI 视频：启动/加速节点/模型/故障排查",
  "windows-app-setup": "Windows 环境：装软件/环境变量/开机启动/排错",
  "office-docs": "办公文档：Word/Excel/PPT/Outlook/PDF 处理（COM/pandoc/python）",
};

/** 已知 MCP 服务器（serverName）的中文说明 */
const MCP_ZH = {
  browser: "浏览器自动化（Playwright）：网页填表、爬取、自动化操作",
  office: "Office 文档自动化（OfficeMCP）：Word/Excel/PPT/Outlook/WPS 的 COM 控制",
  db: "数据库（SQLite）：直接查询、建表、生成报表",
};

/** 已知 profile bundle 的中文说明 */
const BUNDLE_ZH = {
  "@deepseek-ai/dsh-base": "核心引擎（会话/工具/沙箱/审批）",
  "@deepseek-ai/dsh-web-app": "Web 界面层",
  "@deepseek-ai/dsh-subagent-codex": "Codex 子代理（把子任务外包给本机 Codex）",
  "@deepseek-ai/dsh-subagent-claude-code": "Claude Code 子代理（外包给本机 Claude Code）",
  "dsh-workspace-scope": "工作区能力开关（按工程启用 Skill/MCP）",
  "@max-null/dsh-skill-mcp-center": "技能与 MCP 管理中心（设置页 + 热生效）",
};

function readFrontmatter(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return null;
    const out = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
      if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
    }
    return out;
  } catch {
    return null;
  }
}

function scanSkillDirs() {
  const found = new Map();
  for (const [source, dir] of [["agents", AGENTS_SKILLS()], ["claude", CLAUDE_SKILLS()], ["codex", CODEX_SKILLS()]]) {
    if (!fs.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const skillFile = path.join(dir, e.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      const fm = readFrontmatter(skillFile);
      const name = fm?.name || e.name;
      const desc = fm?.description || "";
      const prev = found.get(name);
      const zh = SKILL_ZH[name] || null;
      found.set(name, {
        name,
        en: name,
        zh: zh || shortZh(desc),
        description: desc,
        sources: prev ? [...prev.sources, source] : [source],
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 英文描述兜底：截断即可，展示时与 zh 并列 */
function shortZh(desc) {
  return desc ? desc.slice(0, 90) + (desc.length > 90 ? "…" : "") : "（无描述）";
}

function parseMcpServers() {
  const out = [];
  const patch = path.join(PROFILE_DIR(), "cordis.patch.yml");
  try {
    const raw = fs.readFileSync(patch, "utf8");
    // 简单解析：mcp-client 行的 serverName/command
    const chunks = raw.split("- id: mcp-");
    for (let i = 1; i < chunks.length; i++) {
      const seg = chunks[i];
      const serverName = /serverName:\s*([A-Za-z0-9_-]+)/.exec(seg)?.[1];
      const command = /command:\s*(\S+)/.exec(seg)?.[1];
      const args = /args:\s*\[([^\]]*)\]/.exec(seg)?.[1];
      if (!serverName) continue;
      out.push({
        serverName,
        command: command || "",
        args: args || "",
        zh: MCP_ZH[serverName] || "外部 MCP 服务（按需配置）",
      });
    }
  } catch {
    /* profile 未配置 */
  }
  return out;
}

function parseBundles() {
  const pkgFile = path.join(PROFILE_DIR(), "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
    const bundles = pkg?.dsh?.profile?.bundles || [];
    return bundles.map((b) => ({
      name: b,
      zh: BUNDLE_ZH[b] || "官方/社区插件（见 README）",
    }));
  } catch {
    return [];
  }
}

/** 返回能力词典的完整数据（技能 / MCP / 插件） */
function collectCapabilities() {
  return {
    skills: scanSkillDirs(),
    mcps: parseMcpServers(),
    bundles: parseBundles(),
    scannedAt: new Date().toISOString(),
  };
}

module.exports = { collectCapabilities, SKILL_ZH, MCP_ZH, BUNDLE_ZH };
