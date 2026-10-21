import { spawnSync } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLocalSigningIdentity,
  withUnlockedLocalSigningIdentity,
  runSigningCommand,
} from "./local-signing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Build the Apple Silicon installer on an Apple Silicon Mac.");
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(
      "Installer build stopped. Fix the preceding error before retrying.",
    );
};
// Check identity before expensive downloads. Setup is explicit and never rotates it.
const identity = await getLocalSigningIdentity();
run(["scripts/prepare-runtime.mjs"]);
run(["node_modules/typescript/bin/tsc", "--noEmit"]);
run(["node_modules/vite/bin/vite.js", "build"]);
run(["scripts/build-desktop.mjs"]);
run([
  "node_modules/electron-builder/cli.js",
  "--config",
  "electron-builder.installer.yml",
  "--mac",
  "dmg",
  "--arm64",
  "--publish",
  "never",
  "--config.electronDist=node_modules/electron/dist",
]);
const { version } = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const artifact = path.join(
  root,
  "release",
  "installer",
  `NoteThis-${version}-mac-arm64.dmg`,
);
await access(artifact);
await withUnlockedLocalSigningIdentity(identity, async (verified) => {
  await runSigningCommand(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      verified.fingerprint,
      "--keychain",
      verified.keychainPath,
      "--timestamp=none",
      artifact,
    ],
    "sign installer disk image",
  );
  await runSigningCommand(
    "/usr/bin/codesign",
    ["--verify", "--strict", artifact],
    "verify installer disk image",
  );
});
const hash = createHash("sha256");
for await (const chunk of createReadStream(artifact)) hash.update(chunk);
await writeFile(
  `${artifact}.sha256`,
  `${hash.digest("hex")}  ${path.basename(artifact)}\n`,
);
console.log(
  `Installer ready: ${artifact}\nLocally signed; not Apple-notarized. macOS may require Open Anyway in Privacy & Security.`,
);
