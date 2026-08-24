# DSH Desktop

DeepSeek Harness 的**单窗口桌面客户端**：把 `dsh web` 的界面装进原生窗口，右下角
"记忆库"按钮滑出侧边面板，自动检索、索引、全文搜索你机器上 **Codex** 和
**Claude Code** 留下的全部会话历史。

> **独立运行**：本应用自带 harness 自启逻辑 —— 双击即用，**无需手动先启动 `dsh web`**。
> 它会自动找到系统 Node.js 与已安装的 `@deepseek-ai/dsh` CLI，拉起 harness 引擎并打开界面；
> 若 127.0.0.1:3080 已有 `dsh web` 在运行则直接挂接。
>
> 本应用作为 `apps/desktop` 集成在 deepseek-harness 仓库中（已从仓库 pnpm workspace 排除，
> 独立 npm 工程，不影响仓库构建）。`harness-config/` 存放本机 profile 配置快照
> （MCP 服务器、agent 预设、补丁层），`docs/` 是使用与扩展手册。

## 功能

- **单窗口集成**：一个窗口 = harness 界面 + 记忆库侧边面板。
  - 主界面右下角有悬浮 **🗂 记忆库** 按钮，点击（或 `Ctrl+M`、菜单、托盘）滑出面板；
  - 面板内搜索框支持**全文检索**所有历史会话（命中高亮 + snippet），按来源筛选
    （全部 / Codex / Claude Code），点击会话查看完整对话（思考过程可折叠、
    工具调用标签、模型名），一键导出 Markdown，`Esc` 或 ✕ 收起面板。
- **自动启动 harness**：若 127.0.0.1:3080 已有 `dsh web` 在运行（如 Harness 会话），
  直接挂接；否则自动用本机安装的 `@deepseek-ai/dsh` CLI 拉起 `dsh web --no-open`，
  退出应用时自动关闭它。
- **数据全部在本地**：只读取原始 jsonl，不复制、不上传。

## 安装 / 运行

### 打包好的应用（推荐，无需 Node）

构建产出在 `dist\`：

- `DSH-Desktop-Setup-0.2.0.exe` — 安装包（可选安装目录，创建桌面/开始菜单快捷方式）
- `DSH-Desktop-0.2.0-portable.exe` — 便携版，双击即用（**双击后自动拉起 harness，无需先开 web**）

### 从源码运行

```powershell
npm install      # 安装依赖（Electron + electron-builder）
npm start        # 开发模式启动
```

### 重新打包

```powershell
npm run dist     # 产出 nsis 安装包 + portable 便携版到 dist\
```

## 数据位置

| 内容 | 路径 |
| --- | --- |
| 记忆库索引 | `%APPDATA%\dsh-desktop\memory\`（index.json + corpus.json） |
| Markdown 导出 | `%USERPROFILE%\Documents\dsh-desktop-exports\` |
| 原始会话文件 | 不复制，始终直接读取 Codex / Claude Code 的原始 jsonl |

## 环境变量

- `DSH_DESKTOP_URL` — 指定主窗口加载的 URL（默认 `http://127.0.0.1:3080`）
- `DSH_DESKTOP_PORT` — 期望的 dsh web 端口（默认 3080）
- `DSH_DESKTOP_DSH_BIN` — 指定 dsh CLI 入口（默认自动在 npx 缓存 / PATH 中查找）

## 开发

```powershell
node scripts/gen-icon.js     # 重新生成图标（含 Windows .ico，纯 Node 无依赖）
node lib/memory.js --scan    # 命令行查看扫描结果（--search <词> 试全文检索）
npm run smoke                # 无窗口冒烟测试：web 挂接 + 记忆索引 + 按钮注入 + 面板切换
```

## 说明

- 记忆库解析会话**原始 jsonl**：Codex 的 `rollout-*.jsonl` 与 Claude Code 的
  `<uuid>.jsonl`，损坏行安全跳过；会话按更新时间倒序，搜索大小写不敏感，
  命中来自会话正文语料（每会话上限 80k 字符）。
- 面板是主窗口内的原生 `WebContentsView` 侧滑层，窗口缩放时自动贴合右缘。
