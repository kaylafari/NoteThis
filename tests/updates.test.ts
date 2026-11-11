import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  UpdateController,
  parseRelease,
  registerUpdates,
  makeUpdateFeed,
} from "../desktop/updates";
const release = (version = "0.5.5") => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  published_at: "2026-11-11T00:00:00Z",
  assets: ["zip", "dmg"].map((ext) => ({
    name: `NoteThis-${version}-mac-arm64.${ext}`,
    browser_download_url: `https://github.com/kaylafari/NoteThis/releases/download/v${version}/NoteThis-${version}-mac-arm64.${ext}`,
    state: "uploaded",
    size: 123,
    digest: "sha256:" + "a".repeat(64),
  })),
});
function harness(overrides: Record<string, unknown> = {}) {
  const native = Object.assign(new EventEmitter(), {
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  const deps = {
    version: "0.5.4",
    supported: true,
    native,
    fetchRelease: vi.fn(async () => release()),
    canRestart: vi.fn(async () => true),
    openInstaller: vi.fn(async () => {}),
    makeFeed: vi.fn(async () => ({
      url: "http://127.0.0.1:1234/token",
      close: vi.fn(),
    })),
    notify: vi.fn(),
    ...overrides,
  };
  return { deps, native, controller: new UpdateController(deps as any) };
}
describe("trusted stable releases", () => {
  it("accepts a newer release and binds asset links to its version and repository", () =>
    expect(parseRelease(release(), "0.5.4")?.version).toBe("0.5.5"));
  it.each(["0.5.4", "0.5.3", "0.4.99", "0.5.6-beta", "../0.5.5"])(
    "rejects non-new stable version %s",
    (v) => expect(parseRelease(release(v), "0.5.4")).toBeNull(),
  );
  it.each(["draft", "prerelease"])("ignores %s", (key) =>
    expect(parseRelease({ ...release(), [key]: true }, "0.5.4")).toBeNull(),
  );
  it("compares numeric versions", () =>
    expect(parseRelease(release("0.10.0"), "0.9.9")?.version).toBe("0.10.0"));
  it("rejects asset URL substitution", () => {
    const r = release();
    r.assets.forEach(
      (a) => (a.browser_download_url = "https://evil.example/" + a.name),
    );
    expect(() => parseRelease(r, "0.5.4")).toThrow();
  });
  it("supports installer-only releases", () => {
    const r = release();
    r.assets = r.assets.filter((a) => a.name.endsWith(".dmg"));
    expect(parseRelease(r, "0.5.4")?.zip).toBeUndefined();
  });
  it("does not trust ZIP metadata without digest", () => {
    const r = release();
    r.assets[0].digest = "";
    expect(parseRelease(r, "0.5.4")?.zip).toBeUndefined();
  });
});
describe("update lifecycle", () => {
  it("checks without downloading, suppresses duplicate downloads, and requires download completion", async () => {
    const { controller: c, native, deps } = harness();
    await c.check();
    expect(c.state.status).toBe("available");
    expect(native.checkForUpdates).not.toHaveBeenCalled();
    await c.restart();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    await Promise.all([c.download(), c.download()]);
    expect(deps.makeFeed).toHaveBeenCalledTimes(1);
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(c.state.status).toBe("downloading");
    native.emit("update-downloaded");
    expect(c.state.status).toBe("ready");
    await c.restart();
    expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it("blocks restart while recording or server work is active and allows retry", async () => {
    const { controller: c, native, deps } = harness();
    await c.check();
    await c.download();
    native.emit("update-downloaded");
    deps.canRestart.mockResolvedValueOnce(false);
    await c.restart();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(c.state.status).toBe("ready");
    expect(c.state.error).toMatch(/recording|processing/);
    await c.restart();
    expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it("fails closed when restart readiness cannot be checked", async () => {
    const { controller: c, native, deps } = harness();
    await c.check();
    await c.download();
    native.emit("update-downloaded");
    deps.canRestart.mockRejectedValueOnce(Error("renderer gone"));
    await c.restart();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    expect(c.state.status).toBe("ready");
  });
  it("keeps download and ready states when Check is clicked again", async () => {
    const { controller: c, native, deps } = harness();
    await c.check();
    await c.download();
    await c.check();
    native.emit("update-downloaded");
    await c.check();
    expect(deps.fetchRelease).toHaveBeenCalledTimes(1);
    expect(c.state.status).toBe("ready");
  });
  it("handles native signature errors without installing and permits retry", async () => {
    const { controller: c, native } = harness();
    await c.check();
    await c.download();
    native.emit("error", Error("signature invalid"));
    expect(c.state.status).toBe("error");
    await c.restart();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    await c.download();
    expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
  });
  it("recovers if native installation reports an error after restart is requested", async () => {
    const { controller: c, native } = harness();
    await c.check();
    await c.download();
    native.emit("update-downloaded");
    await c.restart();
    native.emit("error", Error("could not launch installer"));
    expect(c.state.status).toBe("ready");
    expect(c.state.error).toMatch(/installer/i);
  });
  it("shows network failure and recovers on retry", async () => {
    const { controller: c, deps } = harness();
    deps.fetchRelease.mockRejectedValueOnce(Error("network"));
    await c.check();
    expect(c.state.status).toBe("error");
    await c.check();
    expect(c.state.status).toBe("available");
  });
  it("uses the vetted installer fallback for DMG-only release", async () => {
    const r = release();
    r.assets = r.assets.slice(1);
    const {
      controller: c,
      native,
      deps,
    } = harness({ fetchRelease: async () => r });
    await c.check();
    await c.download();
    expect(deps.openInstaller).toHaveBeenCalledWith(
      r.assets[0].browser_download_url,
    );
    expect(native.checkForUpdates).not.toHaveBeenCalled();
  });
  it("never checks in an unsupported development build", async () => {
    const { controller: c, deps } = harness({ supported: false });
    await c.check();
    expect(deps.fetchRelease).not.toHaveBeenCalled();
    expect(c.state.status).toBe("unavailable");
  });
  it("serializes concurrent restart requests", async () => {
    const { controller: c, native } = harness();
    await c.check();
    await c.download();
    native.emit("update-downloaded");
    await Promise.all([c.restart(), c.restart()]);
    expect(native.quitAndInstall).toHaveBeenCalledTimes(1);
  });
  it("rejects untrusted IPC before any action", async () => {
    const { controller: c } = harness();
    const handlers = new Map();
    registerUpdates(
      { handle: (n: string, h: any) => handlers.set(n, h) } as any,
      () => false,
      c,
    );
    await expect(
      handlers.get("notethis:update-action")({}, "download"),
    ).rejects.toThrow(/window/);
  });
});

it("serves only vetted release metadata from a private loopback feed", async () => {
  const parsed = parseRelease(release(), "0.5.4")!;
  const feed = await makeUpdateFeed(parsed);
  try {
    expect(new URL(feed.url).hostname).toBe("127.0.0.1");
    const response = await fetch(feed.url);
    expect(await response.json()).toMatchObject({
      url: parsed.zip!.url,
      sha256: "a".repeat(64),
      size: 123,
      name: "0.5.5",
    });
    expect((await fetch(new URL("/", feed.url))).status).toBe(404);
  } finally {
    feed.close();
  }
});
