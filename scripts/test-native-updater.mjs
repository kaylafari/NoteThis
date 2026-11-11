import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  getLocalSigningIdentity,
  withUnlockedLocalSigningIdentity,
} from "./local-signing.mjs";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tamper = process.argv.includes("--tamper");
const require = createRequire(root + "/package.json");
const { signAsync } = require("@electron/osx-sign");
const scratch = await mkdtemp("/private/tmp/notethis-update-spike-");
console.log("SPIKE", scratch);
const run = (c, args) => {
  const r = spawnSync(c, args, { encoding: "utf8" });
  if (r.status !== 0) throw Error(c + ": " + r.stderr);
  return r.stdout;
};
const server = createServer((req, res) => {
  if (req.url === "/feed") {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/payload.zip`,
        name: "1.0.1",
        notes: "probe",
        pub_date: new Date().toISOString(),
      }),
    );
  } else if (req.url === "/payload.zip") {
    res.setHeader("content-type", "application/zip");
    createReadStream(scratch + "/payload.zip").pipe(res);
  } else {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const identifier = "dev.notethis.updaterprobe." + Date.now();
const marker = scratch + "/result.json";
try {
  const identity = await getLocalSigningIdentity();
  for (const version of ["1.0.0", "1.0.1"]) {
    const dir = scratch + "/" + version;
    await mkdir(dir);
    const app = dir + "/NoteThis Probe.app";
    run("/usr/bin/ditto", [
      root + "/node_modules/electron/dist/Electron.app",
      app,
    ]);
    const plist = app + "/Contents/Info.plist";
    for (const [key, value] of Object.entries({
      CFBundleIdentifier: identifier,
      CFBundleName: "NoteThis Probe",
      CFBundleDisplayName: "NoteThis Probe",
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
    }))
      run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
    await mkdir(app + "/Contents/Resources/app");
    await writeFile(
      app + "/Contents/Resources/app/package.json",
      JSON.stringify({
        name: "notethis-update-probe",
        version,
        main: "main.cjs",
      }),
    );
    await writeFile(
      app + "/Contents/Resources/app/main.cjs",
      `const {app,autoUpdater}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(scratch + "/profile")});app.whenReady().then(()=>{if(app.getVersion()==='1.0.1'){fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({updated:true,version:app.getVersion(),path:app.getAppPath()}));app.quit();return;}autoUpdater.on('error',e=>{fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({updated:false,error:String(e)}));app.quit()});autoUpdater.on('update-downloaded',()=>{console.log('DOWNLOADED');autoUpdater.quitAndInstall()});autoUpdater.setFeedURL({url:'http://127.0.0.1:${port}/feed'});autoUpdater.checkForUpdates();});`,
    );
    await mkdir(scratch + "/profile", { recursive: true });
    await withUnlockedLocalSigningIdentity(identity, (verified) =>
      signAsync({
        app,
        platform: "darwin",
        identity: verified.fingerprint,
        keychain: verified.keychainPath,
        identityValidation: false,
        preAutoEntitlements: false,
        preEmbedProvisioningProfile: false,
        optionsForFile: () => ({
          entitlements: root + "/desktop/entitlements.mac.plist",
          hardenedRuntime: true,
          timestamp: "none",
        }),
      }),
    );
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    console.log("SIGNED", version);
  }
  if (tamper)
    await writeFile(
      scratch + "/1.0.1/NoteThis Probe.app/Contents/Resources/app/main.cjs",
      "// changed after signing",
    );
  run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    scratch + "/1.0.1/NoteThis Probe.app",
    scratch + "/payload.zip",
  ]);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    scratch + "/1.0.0/NoteThis Probe.app/Contents/MacOS/Electron",
    [],
    { env, stdio: "inherit" },
  );
  let result;
  for (let n = 0; n < 240; n++) {
    try {
      result = JSON.parse(await readFile(marker, "utf8"));
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!result) {
    child.kill("SIGTERM");
    throw Error("Update probe timed out");
  }
  console.log("RESULT", JSON.stringify(result));
  const finalVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    scratch + "/1.0.0/NoteThis Probe.app/Contents/Info.plist",
  ]).trim();
  console.log("INSTALLED VERSION", finalVersion);
  if (
    tamper
      ? result.updated ||
        !/signature|valid/i.test(result.error || "") ||
        finalVersion !== "1.0.0"
      : !result.updated || finalVersion !== "1.0.1"
  )
    process.exitCode = 1;
} finally {
  server.close();
}
