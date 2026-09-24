import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { build } from "esbuild";

describe("native macOS credential compatibility", () => {
  it.skipIf(process.platform !== "darwin")(
    "reads sync v10 credentials using the production async codec with Chromium's fake keychain",
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), "notethis-fake-keychain-test-"),
      );
      try {
        const profile = path.join(directory, "profile");
        await mkdir(profile);
        const entry = path.join(directory, "probe.cjs");
        const reportPath = path.join(directory, "result.json");
        await build({
          stdin: {
            contents: `
              import { app, safeStorage } from 'electron';
              import assert from 'node:assert/strict';
              import { writeFileSync } from 'node:fs';
              import { createSecretCodec } from './desktop/secret-codec';
              // Both restored sync OSCrypt and async KeychainKeyProvider honor
              // this switch. Abort before any credential operation if absent.
              if (!app.commandLine.hasSwitch('use-mock-keychain')) throw Error('Fake keychain is required');
              app.setPath('userData', process.env.SECRET_CODEC_TEST_PROFILE);
              app.setPath('sessionData', process.env.SECRET_CODEC_TEST_PROFILE);
              app.setName('NoteThis Synthetic Keychain Test');
              app.whenReady().then(async () => {
                app.dock.hide();
                const codec = createSecretCodec(safeStorage, 'darwin');
                const value = 'Synthetic fixture — no user credentials';
                const legacy = safeStorage.encryptString(value);
                assert.equal(legacy.subarray(0, 3).toString(), 'v10');
                assert.equal(await codec.decrypt(legacy.toString('base64')), value);
                const fresh = await codec.encrypt(value);
                assert.equal(safeStorage.decryptString(Buffer.from(fresh, 'base64')), value);
                assert.equal(await codec.decrypt(fresh), value);
                writeFileSync(process.env.SECRET_CODEC_TEST_REPORT, JSON.stringify({
                  fakeKeychain: true, syncToAsync: true, asyncToSync: true, roundtrip: true,
                  electron: process.versions.electron,
                }));
                app.exit(0);
              }).catch(error => { console.error(error.message); app.exit(1); });
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
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          SECRET_CODEC_TEST_PROFILE: profile,
          SECRET_CODEC_TEST_REPORT: reportPath,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        await new Promise<void>((resolve, reject) => {
          // Pass the switch at process launch, before Electron initializes any
          // key provider. The test never creates a window or uses real Keychain.
          const child = spawn(electron, ["--use-mock-keychain", entry], {
            env,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let errors = "";
          let timedOut = false;
          child.stderr.on("data", (data) => {
            errors = (errors + data).slice(-8192);
          });
          const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, 20_000);
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            if (timedOut)
              reject(new Error("Native fake-keychain probe timed out"));
            else if (code === 0) resolve();
            else
              reject(
                new Error(
                  `Native fake-keychain probe failed (${code}): ${errors}`,
                ),
              );
          });
        });
        expect(JSON.parse(await readFile(reportPath, "utf8"))).toEqual({
          fakeKeychain: true,
          syncToAsync: true,
          asyncToSync: true,
          roundtrip: true,
          electron: expect.any(String),
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
