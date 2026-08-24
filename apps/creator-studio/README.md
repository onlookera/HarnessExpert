# 达人营销工作台（Creator Studio）

面向 **达人营销工作流** 的桌面端：`达人筛选 → 邀约 → 洽谈 → 确认 → 内容对接 → 脚本审核 → 发布上线 → 数据复盘`。

- **8 阶段流程看板**：每阶段一列，卡片推进/回退，达人信息一目了然
- **达人库 + 模板库**：话术/审核清单/复盘指标，一键复制
- **平台自动化**：内置 DeepSeek Harness 引擎（AI 助手）+ 浏览器/Office/数据库 MCP 示例，自动筛达人、抓数据、出报表
- **记忆库**：读取【本机使用者自己】的 Codex / Claude Code 会话（谁下载读谁的，不捆绑作者数据）
- **数据全在本地**：`%APPDATA%\dsh-creator-studio\`；API Key 由使用者自行填写

## 目录

- 安装包：`dist\达人营销工作台-Setup-1.0.0.exe`、`dist\达人营销工作台-1.0.0-portable.exe`
- 使用文档：`docs\达人营销工作流使用文档.md`
- 工作流数据层：`lib\workflow.js`；工作台界面：`renderer\workflow.*`
- 工作流技能：`workflow-skills\`（首启用自动安装到本机 `~/.agents/skills`）

## 开发 / 打包

```powershell
npm start        # 开发模式（node scripts/launch.cjs）
npm run dist     # 打包 Setup + portable 到 dist\
```

## 说明

- 本版本为分发版：不包含动态壁纸、不包含任何作者个人数据/记忆；每个人的 API Key、达人数据、
  记忆库均取自其本机。
- 首次启动会自动用 npx 安装 DeepSeek Harness 引擎（需 Node.js ≥ 18 与网络）。
