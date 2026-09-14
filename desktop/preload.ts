import { contextBridge, ipcRenderer } from "electron";

// Only a validated web-link operation is exposed; no general shell/IPC access.
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    isElectron: true,
    platform: process.platform,
    appVersion: "0.1.0",
    openExternal: (url: string) =>
      ipcRenderer.invoke("cadence:open-external", url),
  }),
);
