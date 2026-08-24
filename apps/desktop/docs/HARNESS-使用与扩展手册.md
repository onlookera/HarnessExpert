# DeepSeek Harness 使用与扩展手册

> 适用对象：开发者 + 需要办公/文档/自动化能力的普通用户。
> 本手册基于你机器上安装的 `@deepseek-ai/dsh` 0.1.1-rc.2（web profile）。

---

## 一、怎么用这个 harness

### 1. 三种入口

| 入口 | 命令 | 用途 |
|---|---|---|
| Web UI（浏览器） | `dsh web`（默认 `http://127.0.0.1:3080`） | 图形聊天界面，日常主力 |
| 桌面端 | `E:\vibecoding\deepseekharness` 的 `npm start` 或 `dist\*.exe` | 单窗口 + 记忆库面板 |
| 命令行一次性任务 | `dsh --profile headless "帮我把 xx 目录按修改时间排序"` | 脚本化调用，输出答案后退出 |

### 2. Web UI 常用操作

- 直接对话；在输入框输入 `/` 看命令面板（`/model` 换模型、`/plan` 计划模式、`/goal` 长期目标、`/export` 导出会话等）
- 支持**后台任务**（长命令可放后台继续跑）、**子代理**（把任务分给多个子 agent 并行）、**工作流**（多阶段编排）、**目标**（跨轮次长期任务）
- 会话自动持久化在 `~/.dsh/sessions/`，随时继续
- 设置（齿轮）：模型选择、agent 预设切换、插件清单

### 3. 配置文件在哪

| 文件 | 作用 |
|---|---|
| `~/.dsh/profiles/web/cordis.patch.yml` | **用户补丁层**：加插件、接 MCP、改任何配置都写这里 |
| `~/.dsh/settings.yaml` | UI 级设置 |
| `~/.dsh/.agent-presets/` | 自建 agent 预设（决定 agent 有哪些工具） |
| `~/.dsh/sessions/` | 会话数据 |

---

## 二、你现在已经具备的能力（standard 预设）

Web UI 默认用内置 `standard` 预设（完整编程 agent），自带：

- **执行**：PowerShell（Windows）/ bash、后台任务 jobs
- **文件**：读写/搜索/批量替换
- **网络**：web 搜索（当前 `fetch` 关闭，可开）
- **智能编排**：子代理（subagent / subagent_fork）、工作流（workflow）、Ralph 循环、目标（goal）、计划模式（plan）、上下文压缩（compaction）
- **技能系统**：skill 目录发现 + 加载（你的 `~/.claude/skills` 已有一批：`pdf`、`ppt-master`、`code-review`、`frontend-design`、`planning-with-files`、`skill-creator`、`video-prompt-engineer` 等）
- **人机交互**：提问确认（ask-user）、待办清单（todo）

> 也就是说：**文档处理（pdf/ppt）、代码审查、前端设计**这些你现在就能直接用，不用装任何东西。

---

## 三、插件机制（怎么装东西）

### 1. 安装插件包到 profile

```powershell
dsh plugin --profile web add <包名>     # 等价于在 ~/.dsh/profiles/web 里跑 pnpm add
```

### 2. 在 patch 层启用/配置（`~/.dsh/profiles/web/cordis.patch.yml`）

补丁是 YAML 列表，三种行：

```yaml
# 覆盖某行的配置（整段替换 config）
- id: tool-web
  config:
    fetch: true          # 打开网页抓取

# 禁用某行
- id: tool-ralph
  disabled: true

# 插入新行（加插件实例）
- insert:
    - id: mcp-playwright
      name: '@deepseek-ai/dsh-mcp-client'
      config: { ... }
```

改完**重启 dsh web** 生效（桌面端关掉重开即可）。

---

## 四、MCP：连接外部软件的关键机制

Harness 内置 MCP 客户端（`@deepseek-ai/dsh-mcp-client`），**一个实例连一个 MCP 服务器**，服务器提供的工具会以 `mcp__<服务器名>__<工具名>` 暴露给 agent。两种传输方式：

- `stdio`：本地启动一个命令（如 `npx xxx`）
- `streamable-http`：连一个 HTTP URL（如公司内网服务）

完整配置模板见 [`harness-config/mcp-servers.example.yml`](../harness-config/mcp-servers.example.yml)，官方说明见 [deepseek-harness mcp-client 文档](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.zh.md)。

---

## 五、技能（Skills）：给 agent"安装"能力的最简单方式

技能 = 一个目录里的 `SKILL.md`（带 name/description frontmatter），agent 在任务匹配时自动加载并照做。**不用装任何插件**，丢文件即可：

| 位置 | 作用域 |
|---|---|
| `~/.agents/skills/<名字>/SKILL.md` | 当前用户全局（DSH 默认 agentsHome） |
| `~/.dsh/skills/<名字>/SKILL.md` | 当前用户全局 |
| `<项目>/.dsh/skills/<名字>/SKILL.md` | 仅该项目 |
| `~/.claude/skills/<名字>/SKILL.md` | 你的 Claude Code 技能（本会话验证可被加载） |

格式示例：

```markdown
---
name: 我的技能名
description: 一句话说明何时用这个技能
---
# 正文：给 agent 的操作指引、命令、注意事项
```

> 想写自己的技能，直接让 agent 加载 `skill-creator` 技能来帮你写。

---

## 六、推荐扩展清单

### ✅ 已实际安装并配置（本机验证通过）

| 扩展 | 说明 | 验证状态 |
|---|---|---|
| `standard-codex` 预设（默认） | 完整编程 Agent + **Codex / Claude Code 子代理** + 网页抓取 `fetch: true` | 配置树组合通过 |
| `@deepseek-ai/dsh-subagent-codex` | Codex 子代理提供者（one-shot，走官方 app-server 协议） | 已装入 web profile bundle |
| `@deepseek-ai/dsh-subagent-claude-code` | Claude Code 子代理提供者 | 已装入 web profile bundle |
| **Playwright MCP**（`browser`） | `npx -y @playwright/mcp@latest`，浏览器自动化 | ✅ 实测可启动 |
| **OfficeMCP**（`office`） | `uvx officemcp`，Word/Excel/PPT/Outlook/WPS | ✅ 实测可启动（本机已装 Office+WPS） |
| **SQLite MCP**（`db`） | `npx -y mcp-server-sqlite --db C:\Users\25280\.dsh\data\sqlite.db` | ✅ 实测可启动 |

> 配置写在 `C:\Users\25280\.dsh\profiles\web\cordis.patch.yml`（MCP 服务器 + 默认预设），
> 预设文件在 `C:\Users\25280\.dsh\.agent-presets\standard-codex\`。
> **重启 dsh web / 桌面端后生效**；MCP 工具名形如 `mcp__browser__*`、`mcp__office__*`、`mcp__db__*`。

### A. 开发者向（已配置，可再补）

1. **Codex / Claude Code 子代理**（已装好并默认启用）：新会话里 agent 多出 `subagent_codex` / `subagent_claude_code` 工具，可把子任务外包给你本机的 Codex / Claude Code。换回内置标准预设：把 `~/.dsh/profiles/web/cordis.patch.yml` 里 `default` 改回 `standard`。
2. **打开网页抓取**（已配置）：`standard-codex` 预设里 `tool-web` 的 `fetch: true`，agent 可以直接读网页正文。
3. **自建 preset**：`~/.dsh/.agent-presets/<名字>/`，按需裁剪工具集（内置有 standard / code / cordis / minimal 可参考）。

### B. 办公自动化向（连接各种软件干活）

| 需求 | 方案 | 说明 |
|---|---|---|
| 浏览器自动化（填表/爬取/点页面） | **Playwright MCP**（`npx @playwright/mcp@latest`） | 官方，最成熟；也可用 chrome-devtools-mcp |
| Word / Excel / PPT / Outlook / WPS | **OfficeMCP**（[github.com/OfficeMCP/OfficeMCP](https://github.com/OfficeMCP/OfficeMCP)） | Windows COM 驱动，覆盖面最全 |
| 数据库 | Postgres / MySQL / SQLite 的官方 MCP server | 让 agent 直接查库、生成报表 |
| 微信/飞书/钉钉/企业微信 | 社区 MCP server | 生态较杂，注意甄别安全与封号风险 |
| 邮件 | Gmail / Outlook MCP | 收发、归档、自动回复 |
| 不用装 MCP 也能干 | 本机 **pwsh 工具 + COM 自动化** | Windows 上直接操作 Office/Outlook 等（见 office-docs 技能） |

### C. 文档处理向

- **已具备**：`pdf` 技能（提取/生成/合并/填表）、`ppt-master` 技能（PPT）
- **本次新增**：`office-docs` 技能（已写入 `~/.agents/skills/` 和 `~/.claude/skills/`）——用 PowerShell COM + pandoc + python 处理 Word/Excel/PPT/PDF/Outlook，不依赖 MCP
- 想处理 docx/xlsx 的精细格式，可让 agent 用 `python-docx` / `openpyxl`（自动装）

### D. 已接入的 Skills 清单（~/.agents/skills，DSH 与 Claude Code 通用）

从你的 **Claude Code**（`~/.claude/skills`）和 **Codex**（`~/.codex/skills`）全部同步过来，
再加上基于**记忆库学习**新封装的技能：

| 技能 | 来源 | 用途 |
|---|---|---|
| `user-profile` 🆕 | 自封装（记忆库学习） | 用户画像、项目地图、日常用法、协作偏好 |
| `comfyui-video` 🆕 | 自封装（记忆库学习） | ComfyUI 启动/加速节点/模型/故障 |
| `windows-app-setup` 🆕 | 自封装（记忆库学习） | 软件安装、环境变量、开机启动、排错 |
| `office-docs` 🆕 | 自封装 | Word/Excel/PPT/Outlook/PDF 文档处理 |
| `hatch-pet` | Codex | 桌宠（spritesheet 动画、封装） |
| `video-prompt-engineer` | Claude Code | 中文文生视频/图生视频提示词工程 |
| `ppt-master` | Claude Code + Codex | 生成/填充/增强 PPTX |
| `pdf` | Claude Code + Codex | PDF 全套处理 |
| `code-review` | Claude Code + Codex | 双轴代码审查 |
| `frontend-design` | Claude Code + Codex | 前端视觉设计 |
| `planning-with-files` | Claude Code + Codex | 文件式持久规划 |
| `skill-creator` | Claude Code + Codex | 教你/帮写新技能 |
| `grill-me` | Claude Code + Codex | `/grilling` 命令式追问 |

> 新技能放进 `~/.agents/skills/<名字>/SKILL.md` **立即生效**（无需重启，本会话已验证实时加载）。
> `~/.claude/skills` 同理，两边互通。

### D. 社区第三方插件（已装 2 个，源码已审查）

- ✅ [dsh-workspace-scope](https://github.com/Ri0n72Y/dsh-workspace-scope) `0.3.2` — 按工作区启停 Skill 与 MCP：新建会话界面输入卡右侧「工作区能力」按钮，配置存各工程根目录 `.dsh-scope.json`（whitelist 只启用勾选 / blacklist 排除），让每个工程只加载需要的技能和 MCP，减小上下文。*已安装并挂载验证通过。*
- ✅ [dsh-skill-mcp-center](https://github.com/Max-Null/dsh-skill-mcp-center) `0.4.1` — 设置里新增「Skill & MCP」管理中心：浏览/开关技能（tier 分级）、增删改 MCP 服务器并热生效（免重启）、侧边栏 MCP 实时状态。*已安装并挂载验证通过。*

> 两者均为 MIT 协议；安装方式：`dsh plugin --profile web add <包名>`（自动加入 profile bundles 清单）。
> **重启 dsh web / 桌面端后生效**。卸载：`dsh plugin --profile web remove <包名>`。

---

## 七、几个典型用法示例

- 办公：`把 C:\报表\季度数据.xlsx 汇总，按部门生成图表，输出成 PPT`
- 文档：`把这份 PDF 提取成 Markdown，再生成一份 Word 版合同模板`
- 自动化：`每天 9 点检查邮箱，把附件下载到 D:\inbox 并归档`（配合 goal/计划）
- 网页：`打开浏览器登录后台，把订单表格抓下来存成 csv`
- 开发：`这个仓库做 code review，用 /plan 先出方案再实施`

---

*数据与隐私：所有技能、MCP 工具都在本机运行；MCP 服务器由你决定连什么，接外部服务（微信/网盘等）前先看它的开源与权限。*
