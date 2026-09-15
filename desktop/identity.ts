import type { App } from "electron";
import path from "node:path";
import { mkdirSync } from "node:fs";

type IdentityApp = Pick<
  App,
  | "setName"
  | "isReady"
  | "getPath"
  | "setPath"
  | "setAppLogsPath"
  | "commandLine"
>;

/** Run before the single-instance lock and before Electron becomes ready. */
export function preserveDesktopIdentity(app: IdentityApp) {
  if (app.isReady())
    throw new Error("Desktop identity must be configured before ready");
  // Electron 44 snapshots this name for macOS Keychain / Linux keyring before
  // ready. Changing it here would orphan existing encrypted provider credentials.
  // https://github.com/electron/electron/blob/v44.3.0/shell/browser/electron_browser_main_parts.cc#L591-L633
  app.setName("Cadence");
  const profile =
    app.commandLine.getSwitchValue("user-data-dir") ||
    path.join(app.getPath("appData"), "Cadence");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  // Keep existing diagnostics discoverable alongside earlier versions' logs.
  app.setAppLogsPath();
}

/** Rename visible menus after Electron has captured the legacy encryption name. */
export function showProductName(app: Pick<App, "isReady" | "setName">) {
  if (!app.isReady())
    throw new Error("Product name must be applied after ready");
  app.setName("NoteThis");
}
