import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import {
  answerMediaPermissionRequest,
  checkMediaPermission,
  decideMediaPermissionRequest,
  oncePermissionReply,
  type MediaPermissionContext,
} from "../desktop/permissions";

const trusted = (): MediaPermissionContext => ({
  expectedOrigin: "http://127.0.0.1:4318",
  rendererUrl: "http://127.0.0.1:4318/",
  sameWebContents: true,
  details: {
    isMainFrame: true,
    requestingUrl: "http://127.0.0.1:4318/",
    securityOrigin: "http://127.0.0.1:4318/",
    mediaTypes: [],
  },
});

describe("desktop recording authorization", () => {
  it("admits Electron's empty media display preflight only from the trusted main frame", () => {
    expect(decideMediaPermissionRequest("media", trusted())).toMatchObject({
      allowed: true,
      kind: "display-preflight",
    });
    for (const context of [
      { ...trusted(), sameWebContents: false },
      { ...trusted(), rendererUrl: "https://untrusted.example/" },
      { ...trusted(), details: { ...trusted().details, isMainFrame: false } },
      {
        ...trusted(),
        details: { ...trusted().details, isMainFrame: undefined },
      },
      {
        ...trusted(),
        details: {
          ...trusted().details,
          requestingUrl: "https://untrusted.example/",
        },
      },
      {
        ...trusted(),
        details: {
          isMainFrame: true,
          embeddingOrigin: "http://127.0.0.1:4318/",
          mediaTypes: [],
        },
      },
    ])
      expect(decideMediaPermissionRequest("media", context).allowed).toBe(
        false,
      );
  });

  it("denies camera and mixed camera/microphone requests", () => {
    for (const mediaTypes of [["video"], ["audio", "video"], ["unknown"]]) {
      expect(
        decideMediaPermissionRequest("media", {
          ...trusted(),
          details: { ...trusted().details, mediaTypes },
        }).allowed,
      ).toBe(false);
    }
    expect(
      checkMediaPermission("media", {
        ...trusted(),
        details: { ...trusted().details, mediaType: "video" },
      }),
    ).toBe(false);
  });

  it("awaits the OS request on every trusted microphone attempt, including denial", async () => {
    const requestMicrophone = vi.fn().mockResolvedValue(false);
    const callback = vi.fn();
    const context = () => ({
      ...trusted(),
      details: { ...trusted().details, mediaTypes: ["audio"] },
    });
    await answerMediaPermissionRequest({
      permission: "media",
      context,
      requestMicrophone,
      callback,
    });
    await answerMediaPermissionRequest({
      permission: "media",
      context,
      requestMicrophone,
      callback,
    });
    expect(requestMicrophone).toHaveBeenCalledTimes(2);
    expect(callback.mock.calls).toEqual([[false], [false]]);
  });

  it("rechecks the live renderer after an OS approval before granting access", async () => {
    const current = trusted();
    current.details.mediaTypes = ["audio"];
    const callback = vi.fn();
    await answerMediaPermissionRequest({
      permission: "media",
      context: () => current,
      callback,
      requestMicrophone: async () => {
        current.rendererUrl = "https://untrusted.example/";
        return true;
      },
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("answers once if the OS request rejects or an Electron callback throws", async () => {
    const callback = vi.fn(() => {
      throw new Error("Frame destroyed");
    });
    const reply = oncePermissionReply(callback);
    reply(null);
    reply(null);
    expect(callback).toHaveBeenCalledOnce();
    const failed = vi.fn();
    await answerMediaPermissionRequest({
      permission: "media",
      context: () => ({
        ...trusted(),
        details: { ...trusted().details, mediaTypes: ["audio"] },
      }),
      callback: failed,
      requestMicrophone: async () => {
        throw new Error("OS failure");
      },
    });
    expect(failed).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not request the microphone for system-only preflight or untrusted requests", async () => {
    const requestMicrophone = vi.fn();
    const callback = vi.fn();
    await answerMediaPermissionRequest({
      permission: "media",
      context: trusted,
      requestMicrophone,
      callback,
    });
    expect(callback).toHaveBeenCalledExactlyOnceWith(true);
    await answerMediaPermissionRequest({
      permission: "media",
      context: () => ({
        ...trusted(),
        sameWebContents: false,
        details: { ...trusted().details, mediaTypes: ["audio"] },
      }),
      requestMicrophone,
      callback,
    });
    expect(requestMicrophone).not.toHaveBeenCalled();
  });

  // This macOS-specific native regression is part of npm test on macOS;
  // the pure permission-policy tests above run on every platform.
  it.skipIf(process.platform !== "darwin")(
    "uses real Electron callbacks for fake mic, camera denial, and display preflight",
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "cadence-permission-test-"),
      );
      try {
        const profile = path.join(directory, "profile");
        await mkdir(profile);
        const entry = path.join(directory, "probe.cjs"),
          reportPath = path.join(directory, "result.json");
        await build({
          entryPoints: ["desktop/permission-probe.ts"],
          outfile: entry,
          bundle: true,
          platform: "node",
          format: "cjs",
          external: ["electron"],
        });
        const electron = (await import("electron"))
          .default as unknown as string;
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        const logs = await new Promise<string>((resolve, reject) => {
          const child = spawn(
            electron,
            [
              entry,
              `--user-data-dir=${profile}`,
              `--cadence-probe-result=${reportPath}`,
            ],
            { env, stdio: ["ignore", "pipe", "pipe"] },
          );
          let output = "";
          child.stdout.on("data", (data) => {
            output += data;
          });
          child.stderr.on("data", (data) => {
            output += data;
          });
          const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Native permission probe timed out"));
          }, 20_000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            code === 0
              ? resolve(output)
              : reject(
                  new Error(
                    `Native permission probe failed (${code}): ${output}`,
                  ),
                );
          });
        });
        const report = JSON.parse(await readFile(reportPath, "utf8"));
        expect(report).toMatchObject({
          microphoneRequests: 2,
          emptyPreflightObserved: true,
          displayReached: true,
          displayTrusted: true,
          cameraDenied: true,
        });
        expect(report.results).toEqual([
          { kind: "microphone", result: "success" },
          { kind: "microphone", result: "success" },
          { kind: "camera", result: "NotAllowedError" },
          { kind: "display", result: "AbortError" },
        ]);
        expect(logs).not.toContain("UnhandledPromiseRejection");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
