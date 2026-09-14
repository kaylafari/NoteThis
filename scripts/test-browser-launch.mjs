/** Native browser handoff using harmless loopback pages, never account credentials. */
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
const temp = await mkdtemp(path.join(os.tmpdir(), "cadence-browser-test-"));
try {
  await build({
    entryPoints: ["desktop/external-links.ts"],
    outfile: path.join(temp, "external.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await build({
    entryPoints: ["desktop/preload.ts"],
    outfile: path.join(temp, "preload.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await writeFile(
    path.join(temp, "main.cjs"),
    `
const {app,BrowserWindow,ipcMain,shell}=require('electron');
const http=require('node:http'); const fs=require('node:fs');
const {registerExternalLinks}=require('./external.cjs');
app.setPath('userData',${JSON.stringify(path.join(temp, "profile"))});
app.whenReady().then(async()=>{
  const hits=new Set(); let oldHandlerCalls=0; const events=[];
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/probe/')) { hits.add(req.url); res.end('<title>Cadence browser check passed</title><p>Cadence successfully opened your browser. You can close this test tab.</p>'); }
    else res.end('<title>Cadence native link test</title><a id="old" target="_blank" rel="noreferrer" href="/probe/old">Old sign-in link</a>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:${JSON.stringify(path.join(temp, "preload.cjs"))}}});
  win.webContents.setWindowOpenHandler(({url})=>{oldHandlerCalls++; void shell.openExternal(url).catch(()=>{}); return {action:'deny'};});
  registerExternalLinks(ipcMain,e=>e.sender===win.webContents&&e.senderFrame===win.webContents.mainFrame&&new URL(e.senderFrame.url).origin===origin,url=>shell.openExternal(url),event=>events.push(event));
  await win.loadURL(origin);
  await win.webContents.executeJavaScript('document.querySelector("#old").click()',true);
  await new Promise(r=>setTimeout(r,1200));
  const result=await win.webContents.executeJavaScript('window.desktop.openExternal('+JSON.stringify(origin+'/probe/new')+')',true);
  const deadline=Date.now()+12000;
  while(!hits.has('/probe/new')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,200));
  const report={oldHandlerCalls,oldBrowserReceived:hits.has('/probe/old'),newResult:result,newBrowserReceived:hits.has('/probe/new'),events};
  fs.writeFileSync(${JSON.stringify(path.join(temp, "result.json"))},JSON.stringify(report));
  win.destroy(); server.close(); app.exit(result.ok&&report.newBrowserReceived?0:1);
}).catch(e=>{console.error(e.message);app.exit(1);});`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [path.join(temp, "main.cjs")], {
      env,
      stdio: "inherit",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Native browser launch timed out"));
    }, 25000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("Native browser handoff failed: " + code));
    });
  }).finally(async () => {
    try {
      console.log(await readFile(path.join(temp, "result.json"), "utf8"));
    } catch {}
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
