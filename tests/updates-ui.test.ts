import { expect, test } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
test("update UI handles available, busy, downloaded, and failed updates", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notethis-update-ui-"));
  try {
    const bundled = await build({
      stdin: {
        contents: `import React from 'react';import{createRoot}from'react-dom/client';import{UpdatesPanel,UpdateBanner}from'./src/Updates';let listener;window.actions=[];let state={currentVersion:'0.5.4',status:'available',version:'0.5.5',native:true};window.desktop={isElectron:true,platform:'darwin',appVersion:'0.5.4',updates:{state:async()=>state,subscribe:fn=>{listener=fn;return()=>{}},action:async action=>{window.actions.push(action);state={...state,status:action==='download'?'downloading':state.status};listener(state);return state}}};let root=createRoot(document.getElementById('root'));window.mount=(busy=false,banner=false)=>root.render(React.createElement(banner?UpdateBanner:UpdatesPanel,{busy}));window.emit=s=>{state={...state,...s};listener(state)};window.mount();`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
    });
    await writeFile(
      path.join(dir, "index.html"),
      `<div id="root"></div><script>${bundled.outputFiles[0].text}</script>`,
    );
    const verify = async function () {
      const w = window as any;
      const button = (s: string) =>
        [...document.querySelectorAll("button")].find(
          (b) => b.textContent?.trim() === s,
        );
      const wait = async (fn: () => unknown) => {
        for (let i = 0; i < 100; i++) {
          if (fn()) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw Error(document.body.innerText);
      };
      await wait(() => button("Download update"));
      button("Download update")!.click();
      await wait(() => document.body.innerText.includes("Downloading"));
      if (w.actions.join() !== "download")
        throw Error("Unexpected automatic action");
      w.emit({ status: "ready" });
      w.mount(true);
      await wait(() => button("Restart to update")?.disabled);
      button("Restart to update")!.click();
      if (w.actions.includes("restart"))
        throw Error("Restart allowed while busy");
      w.mount(false);
      await wait(
        () =>
          button("Restart to update") && !button("Restart to update")!.disabled,
      );
      button("Restart to update")!.click();
      await wait(() => w.actions.includes("restart"));
      w.emit({ status: "error", error: "Could not verify update" });
      await wait(
        () =>
          document.body.innerText.includes("Could not verify update") &&
          button("Download installer"),
      );
      button("Download installer")!.click();
      await wait(() => w.actions.includes("installer"));
      w.mount(false, true);
      await wait(
        () =>
          document.querySelector(".update-banner") &&
          document.body.innerText.includes("Could not verify update"),
      );
      return true;
    };
    await writeFile(
      path.join(dir, "run.cjs"),
      `const{app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir, "profile"))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true}});try{await w.loadFile(${JSON.stringify(path.join(dir, "index.html"))});await w.webContents.executeJavaScript('('+${JSON.stringify(verify.toString())}+')()');console.log('PASS update UI');app.exit(0)}catch(e){console.error(e);app.exit(1)}});`,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron as unknown as string,
      [path.join(dir, "run.cjs")],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    const code = await new Promise((r) => child.on("exit", r));
    clearTimeout(timer);
    expect(code, out).toBe(0);
    expect(out).toContain("PASS update UI");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
