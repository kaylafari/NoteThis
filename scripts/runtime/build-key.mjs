import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
export async function runtimeBuildKey(root) {
  const hash = createHash("sha256");
  for (const relative of [
    "scripts/prepare-runtime.mjs",
    "scripts/runtime/build-key.mjs",
    "scripts/runtime/verify-runtime.mjs",
    "scripts/runtime/test-audio.mjs",
    "scripts/runtime/audio-fixtures.json",
    "scripts/runtime/sources.json",
    "scripts/runtime/python-wheels.json",
    "scripts/runtime/ffmpeg-configure.json",
    "scripts/runtime/rebuild-ffmpeg.sh",
    "scripts/runtime/THIRD-PARTY-NOTICES.md",
  ]) {
    hash.update(relative + "\0");
    hash.update(await readFile(path.join(root, relative)));
  }
  return hash.digest("hex");
}
