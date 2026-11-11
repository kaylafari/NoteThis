/** Freeze input before sampling readiness, then recheck after the server drains. */
type Window = {
  isDestroyed: () => boolean;
  setEnabled: (enabled: boolean) => void;
  webContents: { executeJavaScript: (code: string) => Promise<unknown> };
};
type Server = {
  prepareForUpdate: () => Promise<boolean>;
  cancelUpdateRestart: () => void;
};
export async function prepareUpdateRestart(
  win: Window,
  server: Server,
): Promise<boolean> {
  let prepared = false;
  try {
    if (win.isDestroyed()) return false;
    win.setEnabled(false);
    const ready = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return (
          (await Promise.race([
            win.webContents.executeJavaScript(
              'document.documentElement.dataset.appUpdateBusy === "false" && document.documentElement.dataset.settingsUpdateBusy !== "true"',
            ),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), 3000);
              timer.unref();
            }),
          ])) === true
        );
      } finally {
        clearTimeout(timer);
      }
    };
    if (!(await ready()) || win.isDestroyed()) return false;
    if (!(await server.prepareForUpdate())) return false;
    prepared = !win.isDestroyed() && (await ready());
    return prepared;
  } catch {
    return false;
  } finally {
    if (!prepared) {
      server.cancelUpdateRestart();
      if (!win.isDestroyed()) win.setEnabled(true);
    }
  }
}
export function cancelUpdateForUnload(controller?: {
  state: { status: string };
  cancelRestart: () => void;
}): boolean {
  if (controller?.state.status !== "restarting") return false;
  controller.cancelRestart();
  return true;
}
