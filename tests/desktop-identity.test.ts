import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";
import { preserveDesktopIdentity, showProductName } from "../desktop/identity";

describe("NoteThis native identity", () => {
  it("rejects a branding change before encryption initialization and late storage changes", () => {
    const setName = vi.fn();
    expect(() => showProductName({ isReady: () => false, setName })).toThrow(
      "after ready",
    );
    expect(setName).not.toHaveBeenCalled();
    expect(() =>
      preserveDesktopIdentity({ isReady: () => true } as Parameters<
        typeof preserveDesktopIdentity
      >[0]),
    ).toThrow("before ready");
  });

  it.skipIf(process.platform !== "darwin")(
    "preserves legacy data/session paths and explicit isolated profiles across the native rename",
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "notethis-identity-test-"),
      );
      try {
        const appData = path.join(directory, "Application Support");
        const legacy = path.join(appData, "Cadence");
        const override = path.join(directory, "isolated-profile");
        await mkdir(legacy, { recursive: true });
        await mkdir(override);
        const sentinel =
          "synthetic encrypted credential fixture; never a real secret";
        await writeFile(path.join(legacy, "identity-sentinel"), sentinel);
        const entry = path.join(directory, "probe.cjs");
        await build({
          stdin: {
            contents: `
              import { app } from 'electron';
              import { writeFileSync } from 'node:fs';
              import { preserveDesktopIdentity, showProductName } from './desktop/identity';
              app.setPath('appData', process.env.IDENTITY_TEST_APP_DATA);
              preserveDesktopIdentity(app);
              const before = {name: app.getName(), ready: app.isReady(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData')};
              app.whenReady().then(() => {
                showProductName(app);
                writeFileSync(process.env.IDENTITY_TEST_REPORT, JSON.stringify({before, after: {name: app.getName(), ready: app.isReady(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData')}}));
                app.quit();
              });
            `,
            resolveDir: process.cwd(),
            loader: "ts",
          },
          outfile: entry,
          bundle: true,
          platform: "node",
          format: "cjs",
          external: ["electron"],
        });
        const electron = (await import("electron"))
          .default as unknown as string;
        for (const profile of [legacy, override]) {
          const reportPath = path.join(
            directory,
            `${path.basename(profile)}.json`,
          );
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            IDENTITY_TEST_APP_DATA: appData,
            IDENTITY_TEST_REPORT: reportPath,
          };
          delete env.ELECTRON_RUN_AS_NODE;
          await new Promise<void>((resolve, reject) => {
            const child = spawn(
              electron,
              [
                entry,
                ...(profile === override
                  ? [`--user-data-dir=${override}`]
                  : []),
              ],
              { env, stdio: ["ignore", "ignore", "pipe"] },
            );
            let errors = "";
            child.stderr.on("data", (data) => {
              errors += data;
            });
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              reject(new Error("Native identity probe timed out"));
            }, 15_000);
            child.once("error", (error) => {
              clearTimeout(timer);
              reject(error);
            });
            child.once("exit", (code) => {
              clearTimeout(timer);
              code === 0
                ? resolve()
                : reject(
                    new Error(
                      `Native identity probe failed (${code}): ${errors}`,
                    ),
                  );
            });
          });
          const report = JSON.parse(await readFile(reportPath, "utf8"));
          expect(report).toEqual({
            before: {
              name: "Cadence",
              ready: false,
              userData: profile,
              sessionData: profile,
            },
            after: {
              name: "NoteThis",
              ready: true,
              userData: profile,
              sessionData: profile,
            },
          });
        }
        expect(
          await readFile(path.join(legacy, "identity-sentinel"), "utf8"),
        ).toBe(sentinel);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
