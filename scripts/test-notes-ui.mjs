import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import electron from "electron";
const scratch = await mkdtemp(path.join(os.tmpdir(), "notethis-notes-ui-"));
async function run(root, scratch) {
  const { app, BrowserWindow } = require("electron");
  const { writeFile, mkdir } = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const assert = require("node:assert/strict");
  app.setPath("userData", path.join(scratch, "profile"));
  await app.whenReady();
  const { startServer } = await import(
    require("node:url").pathToFileURL(path.join(root, "dist-server/index.mjs"))
      .href
  );
  const dataDir = path.join(scratch, "data");
  await mkdir(path.join(dataDir, "meetings"), { recursive: true });
  await mkdir(path.join(dataDir, "audio"), { recursive: true });
  const pcmBytes = 16000 * 2 * 20;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);
  await writeFile(path.join(dataDir, "audio/fixture.wav"), wav);
  const meeting = {
    id: "fixture",
    title: "Sample · Physics lesson",
    createdAt: new Date().toISOString(),
    duration: 20,
    status: "ready",
    audioFile: "fixture.wav",
    messages: [],
    segments: [
      {
        id: "s1",
        start: 0,
        end: 10,
        text: "Force equals mass times acceleration.",
        words: [],
      },
      {
        id: "s2",
        start: 10,
        end: 20,
        text: "Mass is two kilograms.",
        words: [],
      },
    ],
    insight: {
      summary: "A lesson about force.",
      decisions: [],
      actions: [{ id: "old", text: "Retired task", done: false }],
      notesMarkdown:
        "# Force\n\n## Relationship [0:00]\n$F=ma$\n\n| Quantity | Value |\n|---|---|\n| Mass | 2 kg |\n\n```js\nconst force = mass * acceleration;\n```\n\n<script>window.pwned=true</script>\n![untrusted](https://example.invalid/tracking.png)",
    },
  };
  await writeFile(
    path.join(dataDir, "meetings/fixture.json"),
    JSON.stringify(meeting),
  );
  const server = await startServer({
    port: 0,
    dataDir,
    staticDir: path.join(root, "dist"),
  });
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  try {
    await w.loadURL(origin);
    const evalJS = (code) => w.webContents.executeJavaScript(code);
    const snapshot = async (name) => {
      // Flush React updates and Chromium paint before capturing a hidden window.
      await new Promise((r) => setTimeout(r, 180));
      await writeFile(
        path.join(os.tmpdir(), `notethis-${name}.png`),
        (await w.webContents.capturePage())
          .resize({ width: w.getSize()[0] })
          .toPNG(),
      );
    };
    const wait = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evalJS(code)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("UI timeout: " + code);
    };
    await wait(`!!document.querySelector('.welcome-footer button')`);
    await evalJS(`document.querySelector('.welcome-footer button').click()`);
    await wait(`!!document.querySelector('.overview-summary')`);
    const state = await evalJS(
      `({tabs:[...document.querySelectorAll('[role=tab]')].map(x=>x.textContent.trim()),order:!!(document.querySelector('.overview-summary').compareDocumentPosition(document.querySelector('.transcript-scroll')) & Node.DOCUMENT_POSITION_FOLLOWING),text:document.body.innerText})`,
    );
    assert.deepEqual(state.tabs, ["Overview", "Notes"]);
    assert.ok(state.order);
    assert.ok(!state.text.includes("Retired task"));
    await snapshot("overview-refined");
    await evalJS(`document.querySelectorAll('[role=tab]')[1].click()`);
    await wait(`!!document.querySelector('.markdown-notes table')`);
    assert.equal(
      await evalJS(
        `!!document.querySelector('.markdown-notes .katex') && !!document.querySelector('.markdown-notes pre code') && !document.querySelector('.markdown-notes img') && !window.pwned`,
      ),
      true,
    );
    await snapshot("notes-refined");
    await evalJS(`document.querySelectorAll('[role=tab]')[0].click()`);
    await wait(`!!document.querySelector('.overview-scroll #segment-s2')`);
    await evalJS(`document.querySelector('#segment-s2 .segment-time').click()`);
    assert.equal(
      await evalJS(`document.querySelector('audio').currentTime`),
      10,
    );
    for (const width of [900, 600, 375]) {
      w.setSize(width, 780);
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(
        await evalJS(`document.documentElement.scrollWidth <= innerWidth`),
        `Page overflow at ${width}px`,
      );
      assert.ok(
        await evalJS(
          `document.querySelector('.overview-scroll').clientHeight > 160`,
        ),
        `Content has usable height at ${width}px`,
      );
      await snapshot(`overview-${width}`);
    }
    w.setSize(1280, 900);
    await evalJS(`document.querySelector('.settings-nav').click()`);
    await wait(`!!document.querySelector('.settings-tabs')`);
    await snapshot("settings-refined");
    await evalJS(
      `document.querySelector('.modal-header .icon-button').click()`,
    );
    await wait(`!document.querySelector('.settings-tabs')`);
    await evalJS(`document.querySelector('.brand').click()`);
    await wait(`!!document.querySelector('.welcome-heading')`);
    await snapshot("home-refined");
    await evalJS(`document.querySelector('.welcome-record').click()`);
    await wait(`!!document.querySelector('.recording-body')`);
    await snapshot("recorder-refined");
    console.log(
      "PASS: overview ordering, retired actions, Markdown table/code/math, timestamp seeking, responsive layout and screen captures",
    );
  } finally {
    w.destroy();
    await server.close();
    app.quit();
  }
}
try {
  const file = path.join(scratch, "check.cjs");
  await writeFile(
    file,
    `(${run.toString()})(${JSON.stringify(process.cwd())},${JSON.stringify(scratch)}).catch(e=>{console.error(e);require('electron').app.exit(1)});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [file], { env, stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
  const code = await new Promise((r, j) => {
    child.on("exit", r);
    child.on("error", j);
  });
  clearTimeout(timer);
  if (code !== 0) throw Error("Meeting UI verification failed");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
