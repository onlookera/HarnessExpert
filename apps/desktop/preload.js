"use strict";
/**
 * preload.js — secure bridge for the 记忆库 (Memory Vault) window.
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
