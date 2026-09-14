import { contextBridge, ipcRenderer } from "electron";
import { version } from "../package.json";

// Only a validated web-link operation is exposed; no general shell/IPC access.
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    isElectron: true,
    platform: process.platform,
    appVersion: version,
    openExternal: (url: string) =>
      ipcRenderer.invoke("cadence:open-external", url),
  }),
);
