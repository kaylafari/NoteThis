import { contextBridge, ipcRenderer } from "electron";
import { version } from "../package.json";

// Expose narrow validated operations only; no general shell/IPC access.
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    isElectron: true,
    platform: process.platform,
    appVersion: version,
    onPowerState: (callback: (state: "suspend" | "resume") => void) => {
      const listener = (_event: unknown, state: unknown) => {
        if (state === "suspend" || state === "resume") callback(state);
      };
      ipcRenderer.on("notethis:power-state", listener);
      return () => ipcRenderer.removeListener("notethis:power-state", listener);
    },
    updates: Object.freeze({
      state: () => ipcRenderer.invoke("notethis:update-state"),
      action: (action: import("../shared/updates").UpdateAction) =>
        ipcRenderer.invoke("notethis:update-action", action),
      subscribe: (
        callback: (state: import("../shared/updates").UpdateState) => void,
      ) => {
        const listener = (
          _event: unknown,
          state: import("../shared/updates").UpdateState,
        ) => callback(state);
        ipcRenderer.on("notethis:update-changed", listener);
        return () =>
          ipcRenderer.removeListener("notethis:update-changed", listener);
      },
    }),
    openExternal: (url: string) =>
      ipcRenderer.invoke("cadence:open-external", url),
  }),
);
