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
  const assert = require("node:assert/strict");
  app.setPath("userData", path.join(scratch, "profile"));
  await app.whenReady();
  const { startServer } = await import(
    require("node:url").pathToFileURL(path.join(root, "dist-server/index.mjs"))
      .href
  );
  const dataDir = path.join(scratch, "data");
  await mkdir(path.join(dataDir, "meetings"), { recursive: true });
  const meeting = {
    id: "fixture",
    title: "Physics lesson",
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
    await evalJS(`document.querySelectorAll('[role=tab]')[1].click()`);
    await wait(`!!document.querySelector('.markdown-notes table')`);
    assert.equal(
      await evalJS(
        `!!document.querySelector('.markdown-notes .katex') && !!document.querySelector('.markdown-notes pre code') && !document.querySelector('.markdown-notes img') && !window.pwned`,
      ),
      true,
    );
    await evalJS(`document.querySelectorAll('[role=tab]')[0].click()`);
    await wait(`!!document.querySelector('#segment-s2')`);
    await evalJS(`document.querySelector('#segment-s2 .segment-time').click()`);
    assert.equal(
      await evalJS(`document.querySelector('audio').currentTime`),
      10,
    );
    await writeFile(
      "/private/tmp/notethis-overview.png",
      (await w.webContents.capturePage()).toPNG(),
    );
    console.log(
      "PASS: overview ordering, retired actions, Markdown table/code/math and unsafe-content isolation",
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
