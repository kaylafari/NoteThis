import { it, expect, vi } from "vitest";
import {
  prepareUpdateRestart,
  cancelUpdateForUnload,
} from "../desktop/update-restart";
function fixture() {
  const win = {
    isDestroyed: () => false,
    setEnabled: vi.fn(),
    webContents: { executeJavaScript: vi.fn(async () => true) },
  };
  const server = {
    prepareForUpdate: vi.fn(async () => true),
    cancelUpdateRestart: vi.fn(),
  };
  return { win, server };
}
it("freezes input before checking readiness and checks again after server preparation", async () => {
  const { win, server } = fixture();
  win.webContents.executeJavaScript.mockImplementation(async () => {
    expect(win.setEnabled).toHaveBeenCalledWith(false);
    return true;
  });
  expect(await prepareUpdateRestart(win, server)).toBe(true);
  expect(win.webContents.executeJavaScript).toHaveBeenCalledTimes(2);
  expect(win.setEnabled).not.toHaveBeenCalledWith(true);
});
it("restores input and writes if renderer becomes busy during server check", async () => {
  const { win, server } = fixture();
  win.webContents.executeJavaScript
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false);
  expect(await prepareUpdateRestart(win, server)).toBe(false);
  expect(server.cancelUpdateRestart).toHaveBeenCalled();
  expect(win.setEnabled).toHaveBeenLastCalledWith(true);
});
it("fails closed and restores input if readiness throws", async () => {
  const { win, server } = fixture();
  win.webContents.executeJavaScript.mockRejectedValue(Error("gone"));
  expect(await prepareUpdateRestart(win, server)).toBe(false);
  expect(win.setEnabled).toHaveBeenLastCalledWith(true);
});
it("cancels an update when unload protection vetoes window close", () => {
  const controller = {
    state: { status: "restarting" },
    cancelRestart: vi.fn(),
  };
  expect(cancelUpdateForUnload(controller)).toBe(true);
  expect(controller.cancelRestart).toHaveBeenCalledTimes(1);
  controller.state.status = "idle";
  expect(cancelUpdateForUnload(controller)).toBe(false);
});
