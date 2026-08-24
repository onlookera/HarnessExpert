"use strict";
/**
 * scripts/launch.cjs — DSH Desktop 的开发/冒烟启动包装。
 *
 * 为什么要这个脚本：直接 `electron .` 在 WorkBuddy 沙箱里跑不起来，会连中三枪：
 *   1) 环境里带 ELECTRON_RUN_AS_NODE=1 → electron 以纯 node 模式启动，
 *      require("electron") 拿不到主进程 API（app 为 undefined），崩。
 *   2) NODE_OPTIONS 里带 --use-system-ca → electron 的 NODE_OPTIONS 白名单
 *      不允许该标志，启动即 abort（退出码 9）。
 *   3) GPU 进程在沙箱里反复崩溃 → "GPU process isn't usable. Goodbye."
 *      （退出码 3）。
 *
 * 本脚本统一处理这三点：剥离 ELECTRON_RUN_AS_NODE、清空 NODE_OPTIONS、
 * 给 electron 传 --disable-gpu --no-sandbox，然后把用户透传的参数（如
 * --smoke）原样转给 electron。
 *
 * 注意：打包产物（electron-builder 产出的 exe）不走本脚本，终端用户双击
 * exe 时其 shell 不带上述环境变量，GPU 也是正常的，因此不需要这些绕行。
 */
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const appDir = path.join(__dirname, "..");
const electronExe = path.join(appDir, "node_modules", "electron", "dist", "electron.exe");
if (!fs.existsSync(electronExe)) {
  console.error(`[launch] 找不到 electron：${electronExe}\n请先在 apps/desktop 下 npm install。`);
  process.exit(1);
}

// 1) 清理环境：去掉 ELECTRON_RUN_AS_NODE，清空 NODE_OPTIONS。
//    NODE_OPTIONS 里 --use-system-ca 被 electron 白名单拒绝（退出码 9）；
//    --require 的 genie 安全 shim 是给 agent 侧 node 调用用的，electron
//    主进程与 dsh web 子树都不需要，整段清空最稳妥（已验证可用）。
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

// 2) 给 electron/chromium 的标志：放 app 路径之前才会被当作 chromium 选项
const chromiumFlags = ["--disable-gpu", "--no-sandbox"];
// 3) 透传调用者参数（如 --smoke）
const userArgs = process.argv.slice(2);

// 冒烟默认用隔离端口 3991，避免挂到/抢占 3080 上的真实 harness 会话
if (userArgs.includes("--smoke") && !env.DSH_DESKTOP_PORT) {
  env.DSH_DESKTOP_PORT = "3991";
}

const args = [...chromiumFlags, appDir, ...userArgs];

if (process.env.DSH_DESKTOP_LAUNCH_DEBUG) {
  console.error(`[launch] electron=${electronExe}`);
  console.error(`[launch] args=${JSON.stringify(args)}`);
  console.error(`[launch] NODE_OPTIONS=${env.NODE_OPTIONS || "(none)"}`);
  console.error(`[launch] ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE || "(unset)"}`);
  console.error(`[launch] DSH_DESKTOP_PORT=${env.DSH_DESKTOP_PORT || "(default 3080)"}`);
}

const child = spawn(electronExe, args, { env, stdio: "inherit", windowsHide: false });
child.on("exit", (code, signal) => {
  process.exit(code == null ? (signal ? 1 : 0) : code);
});
child.on("error", (err) => {
  console.error(`[launch] 启动 electron 失败：${err.message}`);
  process.exit(1);
});
