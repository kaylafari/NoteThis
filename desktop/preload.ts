import { contextBridge } from "electron";

// No filesystem, shell, credential, or general-purpose IPC API is exposed.
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    isElectron: true,
    platform: process.platform,
    appVersion: "0.1.0",
  }),
);
