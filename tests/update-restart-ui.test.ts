import { expect, test } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
test("native window unload protection restores updater state, input and writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "notethis-restart-ui-"));
  try {
    const code = `import{app,BrowserWindow}from'electron';import{EventEmitter}from'node:events';import assert from'node:assert/strict';import{UpdateController}from'./desktop/updates';import{prepareUpdateRestart,cancelUpdateForUnload}from'./desktop/update-restart';
 app.setPath('userData',${JSON.stringify(path.join(dir, "profile"))});
 app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});let gate=false;const server={prepareForUpdate:async()=>{gate=true;return true},cancelUpdateRestart:()=>{gate=false}};let quits=0;const native=Object.assign(new EventEmitter(),{setFeedURL:()=>{},checkForUpdates:()=>{},quitAndInstall:()=>{quits++;w.close()}});const version='0.5.5';const c=new UpdateController({version:'0.5.4',supported:true,native,fetchRelease:async()=>({draft:false,prerelease:false,tag_name:'v'+version,assets:['zip','dmg'].map(ext=>({name:'NoteThis-'+version+'-mac-arm64.'+ext,browser_download_url:'https://github.com/kaylafari/NoteThis/releases/download/v'+version+'/NoteThis-'+version+'-mac-arm64.'+ext,state:'uploaded',size:12,digest:'sha256:'+'a'.repeat(64)}))}),makeFeed:async()=>({url:'http://127.0.0.1/feed',close:()=>{}}),openInstaller:async()=>{},canRestart:()=>prepareUpdateRestart(w,server),notify:s=>{if(s.status!=='restarting'){server.cancelUpdateRestart();w.setEnabled(true)}}});w.webContents.on('will-prevent-unload',()=>cancelUpdateForUnload(c));
 try{await w.loadURL('data:text/html,<p>Saved recording fixture</p>');await w.webContents.executeJavaScript("document.documentElement.dataset.appUpdateBusy='true'");await c.check();await c.download();native.emit('update-downloaded');await c.restart();assert.equal(quits,0);assert.equal(w.isEnabled(),true);
 await w.webContents.executeJavaScript("document.documentElement.dataset.appUpdateBusy='false'; window.onbeforeunload=()=>false;true",true);await c.restart();for(let i=0;i<100&&c.state.status==='restarting';i++)await new Promise(r=>setTimeout(r,20));assert.equal(quits,1);assert.equal(w.isDestroyed(),false);assert.equal(w.isEnabled(),true);assert.equal(gate,false);assert.equal(c.state.status,'ready');console.log('PASS protected window remains usable');w.destroy();app.exit(0);}catch(e){console.error(e);app.exit(1)}});`;
    await build({
      stdin: { contents: code, resolveDir: process.cwd(), loader: "ts" },
      outfile: path.join(dir, "run.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
    });
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      electron as unknown as string,
      [path.join(dir, "run.cjs")],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    const status = await new Promise((r) => child.once("exit", r));
    clearTimeout(timer);
    expect(status, out).toBe(0);
    expect(out).toContain("PASS protected window remains usable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
