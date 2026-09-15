/** Permission UI regression in real React/Chromium; no device APIs are invoked. */
import { test, expect } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

test("recording permissions stay pending until their source succeeds or rejects", async () => {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "cadence-recording-ui-"),
  );
  try {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {RecordingModal} from './src/App'; let root; window.mountRecording = props => { root?.unmount(); root=createRoot(document.getElementById('root')); root.render(React.createElement(RecordingModal, props)); }; window.unmountRecording = () => { root?.unmount(); root=null; };`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      plugins: [
        {
          name: "isolated-recorder",
          setup(builder) {
            builder.onResolve({ filter: /^\.\/recorder$/ }, () => ({
              path: "recorder",
              namespace: "synthetic-recorder",
            }));
            builder.onLoad(
              { filter: /.*/, namespace: "synthetic-recorder" },
              () => ({
                contents: `
            export function createCallRecorder(options) {
              let resolve, reject;
              const control = {
                options, starts: [], disposed: 0, stopped: 0, pauses: 0, resumes: 0,
                permission: source => options.onPermissionRequest?.(source),
                succeed: () => { options.onPermissionRequest?.(null); options.onStateChange?.('recording'); resolve(); },
                deny: message => { options.onPermissionRequest?.(null); reject(new Error(message)); },
              };
              window.syntheticRecorder = control;
              return {
                start(sources) { control.starts.push(sources); return new Promise((yes, no) => { resolve=yes; reject=no; options.onPermissionRequest?.(sources.includeMic ? 'microphone' : 'system'); }); },
                pause() { control.pauses++; options.onStateChange?.('paused'); },
                resume() { control.resumes++; options.onStateChange?.('recording'); },
                async stop() { control.stopped++; options.onStateChange?.('idle'); return { blob: new Blob(['synthetic-audio'], {type:'audio/webm'}), mimeType:'audio/webm', durationMs:2200 }; },
                dispose() { control.disposed++; },
              };
            }
          `,
                loader: "js",
              }),
            );
          },
        },
      ],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
    });
    await writeFile(
      path.join(scratch, "index.html"),
      `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`,
    );
    const run = async function () {
      const w = window as any;
      const passed: string[] = [];
      const saved: any[] = [];
      let closed = 0;
      const text = () => document.getElementById("root")!.textContent || "";
      const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
      const until = async (predicate: () => unknown, message: string) => {
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          try {
            if (predicate()) return;
          } catch {}
          await wait();
        }
        throw new Error(`${message}; UI=${text()}`);
      };
      const check = async (predicate: () => unknown, message: string) => {
        await until(predicate, message);
        passed.push(message);
      };
      const button = (name: string) =>
        Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
          (item) => item.textContent?.trim() === name,
        )!;
      const click = async (name: string) => {
        await until(
          () => button(name) && !button(name).disabled,
          `Button ready: ${name}`,
        );
        button(name).click();
        await wait();
      };
      const source = (name: string) =>
        Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".source-options button",
          ),
        ).find((item) => item.textContent?.startsWith(name))!;
      const status = () =>
        Array.from(document.querySelectorAll('[role="status"]'))
          .map((element) => element.textContent || "")
          .join(" ");
      const unloadPrevented = () => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      };
      async function mount() {
        const previous = w.syntheticRecorder;
        w.mountRecording({
          saving: false,
          onClose: () => {
            closed++;
            w.unmountRecording();
          },
          onSave: async (file: File, title: string) => {
            saved.push({ size: file.size, type: file.type, title });
          },
        });
        await until(
          () => w.syntheticRecorder && w.syntheticRecorder !== previous,
          "Recorder effect initializes",
        );
      }
      await mount();
      await check(
        () =>
          text().includes(
            "Starting will request microphone and system audio / screen-sharing access",
          ),
        "Prestart helper names selected permission categories",
      );
      await check(
        () =>
          !document.querySelector('[role="alert"]') &&
          !status().includes("Requesting"),
        "No permission denial or pending state appears before start",
      );
      await click("Start recording");
      await check(
        () =>
          w.syntheticRecorder.starts[0].includeMic &&
          w.syntheticRecorder.starts[0].includeSystem,
        "Default recording requests both selected sources",
      );
      await check(
        () => status().includes("Requesting microphone access…"),
        "Microphone request is shown while its promise remains pending",
      );
      await check(
        () => !document.querySelector('[role="alert"]'),
        "Pending microphone request is not called a denial",
      );
      await check(
        () =>
          button("Start recording").disabled &&
          source("Microphone").disabled &&
          source("System audio").disabled,
        "Pending request prevents duplicate start and source changes",
      );
      await check(
        unloadPrevented,
        "Pending permission protects navigation from discarding work",
      );
      w.syntheticRecorder.permission("system");
      await check(
        () =>
          status().includes(
            "Requesting system audio / screen sharing access…",
          ) && !status().includes("Requesting microphone"),
        "Pending message follows the permission source currently requested",
      );
      await check(
        () => !document.querySelector('[role="alert"]'),
        "Pending system-sharing request remains non-error state",
      );
      w.syntheticRecorder.succeed();
      await check(
        () =>
          text().includes("RECORDING LIVE") && !status().includes("Requesting"),
        "Successful permissions clear pending status and enter recording",
      );
      await click("Pause");
      await check(
        () => text().includes("PAUSED") && w.syntheticRecorder.pauses === 1,
        "Pause remains available after permission grant",
      );
      await click("Resume");
      await check(
        () =>
          text().includes("RECORDING LIVE") &&
          w.syntheticRecorder.resumes === 1,
        "Resume retains recording lifecycle",
      );
      await click("Finish recording");
      await check(
        () =>
          text().includes("CAPTURE COMPLETE") &&
          w.syntheticRecorder.stopped === 1,
        "Stop captures audio after successful permission flow",
      );
      await check(
        unloadPrevented,
        "Unsaved captured audio retains navigation protection",
      );
      await click("Save & transcribe");
      await check(
        () =>
          saved.length === 1 &&
          saved[0].type === "audio/webm" &&
          saved[0].size > 0,
        "Captured audio reaches save callback with its original media type",
      );

      await mount();
      source("System audio").click();
      await wait();
      await check(
        () =>
          text().includes("Starting will request microphone access if needed"),
        "Microphone-only helper mentions only microphone permission",
      );
      await click("Start recording");
      await check(
        () =>
          w.syntheticRecorder.starts[0].includeMic &&
          !w.syntheticRecorder.starts[0].includeSystem,
        "Microphone-only mode never requests system source",
      );
      await check(
        () =>
          status().includes("Requesting microphone access…") &&
          !document.querySelector('[role="alert"]'),
        "Microphone-only request waits before showing an outcome",
      );
      const microphoneError =
        "Microphone permission was denied. Open macOS System Settings → Privacy & Security → Microphone and enable NoteThis, then restart the app.";
      w.syntheticRecorder.deny(microphoneError);
      await check(
        () =>
          document.querySelector('[role="alert"]')?.textContent ===
          microphoneError,
        "Actual microphone rejection names the permission and exact manual setting",
      );
      await check(
        () =>
          !status().includes("Requesting") &&
          !button("Start recording").disabled,
        "Rejected permission clears pending status and enables retry",
      );
      await click("Start recording");
      await check(
        () =>
          !document.querySelector('[role="alert"]') &&
          status().includes("Requesting microphone"),
        "Retry clears the prior error while permission is pending again",
      );
      const pendingController = w.syntheticRecorder;
      (
        document.querySelector(
          '[aria-label="Close dialog"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () => text().includes("Discard this recording?"),
        "Closing during a pending prompt keeps discard protection",
      );
      await click("Keep recording");
      await check(
        () => status().includes("Requesting microphone"),
        "Keeping pending recording preserves permission status",
      );
      (
        document.querySelector(
          '[aria-label="Close dialog"]',
        ) as HTMLButtonElement
      ).click();
      await click("Discard & close");
      await check(
        () => pendingController.disposed === 1 && closed === 1,
        "Discarding a pending request disposes recorder exactly once",
      );
      await check(
        () => !unloadPrevented(),
        "Closing removes the navigation guard",
      );

      await mount();
      source("Microphone").click();
      await wait();
      await check(
        () =>
          text().includes(
            "Starting will request system audio / screen-sharing access if needed",
          ),
        "System-only helper names system sharing permission",
      );
      await click("Start recording");
      await check(
        () =>
          !w.syntheticRecorder.starts[0].includeMic &&
          w.syntheticRecorder.starts[0].includeSystem,
        "System-only mode never requests microphone source",
      );
      await check(
        () =>
          status().includes(
            "Requesting system audio / screen sharing access…",
          ) && !document.querySelector('[role="alert"]'),
        "System-only request shows pending state before any outcome",
      );
      const systemError =
        "System audio permission was denied. Open macOS System Settings → Privacy & Security → Screen & System Audio Recording and enable NoteThis, then restart the app.";
      w.syntheticRecorder.deny(systemError);
      await check(
        () =>
          document.querySelector('[role="alert"]')?.textContent === systemError,
        "Actual system-audio rejection displays its specific manual recovery path",
      );
      await check(
        () => !status().includes("Requesting"),
        "System rejection clears pending permission status",
      );
      w.unmountRecording();
      return { passed };
    };
    const report = path.join(scratch, "result.json");
    const main = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(${JSON.stringify(path.join(scratch, "index.html"))});const value=await win.webContents.executeJavaScript('('+${JSON.stringify(run.toString())}+')()',true);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(value));app.exit(0)}).catch(error=>{console.error(error);app.exit(1)});`;
    await writeFile(path.join(scratch, "main.cjs"), main);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        electron as unknown as string,
        [path.join(scratch, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      child.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Recording UI timed out: ${logs}`));
      }, 30000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error(`Recording UI exited ${code}: ${logs}`));
      });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    expect(result.passed.length).toBeGreaterThanOrEqual(28);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45000);
