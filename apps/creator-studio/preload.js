"use strict";
/**
 * preload.js — secure bridge for 记忆库 / 达人营销工作台 windows.
 * Only this small surface is exposed; the renderer stays sandboxed.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshMemory", {
  scan: () => ipcRenderer.invoke("memory:scan"),
  list: () => ipcRenderer.invoke("memory:list"),
  search: (q) => ipcRenderer.invoke("memory:search", q),
  getSession: (id) => ipcRenderer.invoke("memory:session", id),
  openDir: (source) => ipcRenderer.invoke("memory:openDir", source),
  exportMd: (id) => ipcRenderer.invoke("memory:export", id),
  appInfo: () => ipcRenderer.invoke("memory:appInfo"),
  capabilities: () => ipcRenderer.invoke("memory:capabilities"),
  closePanel: () => ipcRenderer.send("vault:close"),
  onRefreshRequested: (cb) => {
    ipcRenderer.on("memory:refresh-requested", () => cb());
  },
});

contextBridge.exposeInMainWorld("dshWorkflow", {
  list: () => ipcRenderer.invoke("workflow:list"),
  add: (input) => ipcRenderer.invoke("workflow:add", input),
  update: (id, patch) => ipcRenderer.invoke("workflow:update", id, patch),
  remove: (id) => ipcRenderer.invoke("workflow:remove", id),
  advance: (id, dir) => ipcRenderer.invoke("workflow:advance", id, dir),
  exportCsv: () => ipcRenderer.invoke("workflow:exportCsv"),
  templates: () => ipcRenderer.invoke("workflow:templates"),
  platformSearch: (platform, keyword) => ipcRenderer.invoke("workflow:platformSearch", platform, keyword),
  installSkills: () => ipcRenderer.invoke("workflow:installSkills"),
  openPlatform: (platform, keyword) => ipcRenderer.invoke("workflow:openPlatform", platform, keyword),
});

contextBridge.exposeInMainWorld("dshSetup", {
  state: () => ipcRenderer.invoke("setup:state"),
  run: () => ipcRenderer.invoke("setup:run"),
  saveKey: (key) => ipcRenderer.invoke("setup:saveKey", key),
  openMain: () => ipcRenderer.invoke("setup:openMain"),
  onStatus: (cb) => { ipcRenderer.on("setup:status", (_e, m) => cb(m)); },
  onReady: (cb) => { ipcRenderer.on("setup:ready", (_e, s) => cb(s)); },
  onError: (cb) => { ipcRenderer.on("setup:error", (_e, m) => cb(m)); },
});
