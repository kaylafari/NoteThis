import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

// Rebuild the original SVG icon using the same Chromium renderer as the app.
// macOS's iconutil packages the standard 16–1024px PNG representations.
if (process.platform !== "darwin")
  throw new Error("Building the .icns icon requires macOS iconutil and sips.");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(path.join(tmpdir(), "notethis-icons-"));
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error?.message || result.stderr}`,
    );
}
try {
  const output = path.join(root, "assets/notethis-icon.png");
  const renderer = path.join(work, "render.cjs");
  const svg = await readFile(
    path.join(root, "assets/notethis-icon.svg"),
    "utf8",
  );
  await writeFile(
    renderer,
    `const {app,BrowserWindow}=require('electron');
const {writeFileSync}=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(work, "electron"))});
app.whenReady().then(async()=>{
 const window=new BrowserWindow({width:1024,height:1024,useContentSize:true,show:false,frame:false,transparent:true,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false}});
 await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}svg{display:block;width:1024px;height:1024px}</style>'+${JSON.stringify(svg)}));
 await window.webContents.executeJavaScript('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const image=await window.webContents.capturePage();
 writeFileSync(${JSON.stringify(output)},image.resize({width:1024,height:1024,quality:'best'}).toPNG());
 window.destroy();app.quit();
}).catch(error=>{console.error(error);app.exit(1)});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  run(electron, [renderer], env);
  const iconset = path.join(work, "notethis.iconset");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const filename = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      run("/usr/bin/sips", [
        "-z",
        String(size * scale),
        String(size * scale),
        output,
        "--out",
        path.join(iconset, filename),
      ]);
    }
  }
  run("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(root, "assets/notethis.icns"),
  ]);
  console.log(
    "Built assets/notethis-icon.png and assets/notethis.icns from the original SVG.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
