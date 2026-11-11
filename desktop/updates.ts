import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { UpdateState, UpdateAction } from "../shared/updates";
export const RELEASE_API =
  "https://api.github.com/repos/kaylafari/NoteThis/releases/latest";
export const RELEASE_PAGE =
  "https://github.com/kaylafari/NoteThis/releases/latest";
type Asset = { url: string; size: number; sha256?: string };
export type Release = {
  version: string;
  date: string;
  dmg: Asset;
  zip?: Asset;
};
function versionParts(value: unknown): number[] | null {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
  )
    return null;
  return value.split(".").map(Number);
}
export function parseRelease(value: unknown, current: string): Release | null {
  if (!value || typeof value !== "object")
    throw Error("Invalid release response");
  const r = value as Record<string, unknown>;
  if (r.draft !== false || r.prerelease !== false) return null;
  const version =
    typeof r.tag_name === "string" && r.tag_name.startsWith("v")
      ? r.tag_name.slice(1)
      : "";
  const next = versionParts(version),
    previous = versionParts(current);
  if (!next || !previous) return null;
  const diff = next.map((n, i) => n - previous[i]).find((n) => n !== 0) || 0;
  if (diff <= 0) return null;
  if (!Array.isArray(r.assets)) throw Error("Missing release assets");
  const assets = r.assets;
  const asset = (extension: string): Asset | undefined => {
    const name = `NoteThis-${version}-mac-arm64.${extension}`;
    const a = assets.find((a: any) => a?.name === name) as any;
    if (!a) return;
    const expected = `https://github.com/kaylafari/NoteThis/releases/download/v${version}/${name}`;
    if (
      a.browser_download_url !== expected ||
      a.state !== "uploaded" ||
      !Number.isSafeInteger(a.size) ||
      a.size <= 0 ||
      a.size > 2_000_000_000
    )
      throw Error("Invalid release asset");
    const digest =
      typeof a.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(a.digest)
        ? a.digest.slice(7)
        : undefined;
    if (extension === "zip" && !digest) return;
    return { url: expected, size: a.size, sha256: digest };
  };
  const dmg = asset("dmg");
  if (!dmg) throw Error("Installer not available yet");
  return {
    version,
    dmg,
    zip: asset("zip"),
    date: typeof r.published_at === "string" ? r.published_at : "",
  };
}
export async function fetchLatestRelease(): Promise<unknown> {
  const response = await fetch(RELEASE_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "NoteThis updater",
    },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!response.ok) throw Error("Release check unavailable");
  const text = await response.text();
  if (text.length > 1_000_000) throw Error("Release response too large");
  return JSON.parse(text);
}
/** A private loopback feed adapts vetted GitHub metadata to native Squirrel. */
export async function makeUpdateFeed(
  release: Release,
): Promise<{ url: string; close: () => void }> {
  if (!release.zip) throw Error("No signed update archive");
  const route = "/" + randomUUID();
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== route) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(
      JSON.stringify({
        url: release.zip!.url,
        name: release.version,
        notes: "NoteThis update",
        pub_date: release.date,
        sha256: release.zip!.sha256,
        size: release.zip!.size,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  server.unref();
  const port = (server.address() as import("node:net").AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${route}`,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}
type NativeUpdater = {
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  setFeedURL(options: { url: string }): void;
  checkForUpdates(): void;
  quitAndInstall(): void;
};
type Dependencies = {
  version: string;
  supported: boolean;
  native: NativeUpdater;
  fetchRelease: () => Promise<unknown>;
  makeFeed: (release: Release) => Promise<{ url: string; close: () => void }>;
  canRestart: () => Promise<boolean>;
  openInstaller: (url: string) => Promise<void>;
  notify: (state: UpdateState) => void;
};
export class UpdateController {
  state: UpdateState;
  private release?: Release;
  private feed?: { url: string; close: () => void };
  private restarting = false;
  constructor(private deps: Dependencies) {
    this.state = {
      currentVersion: deps.version,
      status: deps.supported ? "idle" : "unavailable",
    };
    deps.native.on("error", this.nativeError);
    deps.native.on("update-downloaded", this.downloaded);
    deps.native.on("update-not-available", this.notAvailable);
  }
  private set(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch };
    this.deps.notify({ ...this.state });
  }
  private closeFeed() {
    this.feed?.close();
    this.feed = undefined;
  }
  private nativeError = () => {
    if (this.state.status === "restarting" || this.state.status === "ready") {
      this.set({
        status: "ready",
        error:
          "The installer could not restart NoteThis. Try again or use Download installer.",
      });
      return;
    }
    if (this.state.status === "downloading") {
      this.closeFeed();
      this.set({
        status: "error",
        error:
          "The update could not be downloaded or verified. Try again, or use Download installer.",
      });
    }
  };
  private downloaded = () => {
    if (this.state.status === "downloading") {
      this.closeFeed();
      this.set({ status: "ready", error: undefined });
    }
  };
  private notAvailable = () => {
    if (this.state.status === "downloading") {
      this.closeFeed();
      this.set({
        status: "error",
        error:
          "The update is not available yet. Check again or download the installer.",
      });
    }
  };
  async check() {
    if (
      !this.deps.supported ||
      ["checking", "downloading", "ready", "restarting"].includes(
        this.state.status,
      )
    )
      return this.state;
    this.set({ status: "checking", error: undefined });
    try {
      const release = parseRelease(
        await this.deps.fetchRelease(),
        this.deps.version,
      );
      this.release = release || undefined;
      this.set({
        status: release ? "available" : "up-to-date",
        version: release?.version,
        native: !!release?.zip,
      });
    } catch {
      this.set({
        status: "error",
        error:
          "Could not check for updates. Check your internet connection and try again later.",
      });
    }
    return this.state;
  }
  async installer() {
    try {
      await this.deps.openInstaller(this.release?.dmg.url || RELEASE_PAGE);
    } catch {
      this.set({
        error:
          "Could not open your browser. Download NoteThis from github.com/kaylafari/NoteThis/releases/latest.",
      });
    }
    return this.state;
  }
  async download() {
    if (!this.release || !["available", "error"].includes(this.state.status))
      return this.state;
    if (!this.release.zip) return this.installer();
    this.set({ status: "downloading", error: undefined });
    try {
      this.closeFeed();
      this.feed = await this.deps.makeFeed(this.release);
      this.deps.native.setFeedURL({ url: this.feed.url });
      this.deps.native.checkForUpdates();
    } catch {
      this.nativeError();
    }
    return this.state;
  }
  async restart() {
    if (this.state.status !== "ready" || this.restarting) return this.state;
    this.restarting = true;
    try {
      if (!(await this.deps.canRestart())) throw Error("busy");
      this.set({ status: "restarting", error: undefined });
      this.deps.native.quitAndInstall();
    } catch {
      this.set({
        status: "ready",
        error:
          "Finish or save your recording, close any unsaved settings, and wait for processing to finish before restarting.",
      });
    } finally {
      this.restarting = false;
    }
    return this.state;
  }
  cancelRestart() {
    if (this.state.status === "restarting")
      this.set({
        status: "ready",
        error:
          "Restart canceled to keep your unsaved work. Finish or save it before updating.",
      });
  }
  dispose() {
    this.closeFeed();
    this.deps.native.removeListener("error", this.nativeError);
    this.deps.native.removeListener("update-downloaded", this.downloaded);
    this.deps.native.removeListener("update-not-available", this.notAvailable);
  }
}
export function registerUpdates(
  ipc: Pick<IpcMain, "handle">,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  controller: UpdateController,
) {
  ipc.handle("notethis:update-state", (event) => {
    if (!trusted(event))
      throw Error("Updates must be requested from the NoteThis window.");
    return controller.state;
  });
  ipc.handle("notethis:update-action", async (event, action: unknown) => {
    if (!trusted(event))
      throw Error("Updates must be requested from the NoteThis window.");
    if (
      !["check", "download", "restart", "installer"].includes(action as string)
    )
      throw Error("Invalid update action");
    const method: Record<UpdateAction, () => Promise<UpdateState>> = {
      check: () => controller.check(),
      download: () => controller.download(),
      restart: () => controller.restart(),
      installer: () => controller.installer(),
    };
    return method[action as UpdateAction]();
  });
}
