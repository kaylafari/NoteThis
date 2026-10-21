/** Build-time only. No model weights, credentials, or host-installed tools are copied. */
import { createHash, randomUUID } from "node:crypto";
import { auditRuntime } from "./runtime/verify-runtime.mjs";
import { verifyRuntimeAudio } from "./runtime/test-audio.mjs";
import { runtimeBuildKey } from "./runtime/build-key.mjs";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  chmod,
  cp,
  readdir,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "scripts/runtime/sources.json");
const wheelPath = path.join(root, "scripts/runtime/python-wheels.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (process.platform !== manifest.platform || process.arch !== manifest.arch)
  throw new Error(
    "Runtime preparation currently requires macOS on Apple Silicon.",
  );
const build = path.join(root, "build");
const cache = path.join(build, "runtime-cache");
const stage = path.join(build, `.runtime-stage-${randomUUID()}`);
const relocated = path.join(build, `.runtime relocation ${randomUUID()}`);
const destination = path.join(build, "runtime");
const buildKey = await runtimeBuildKey(root);
if (!process.argv.includes("--force")) {
  try {
    const previous = JSON.parse(
      await readFile(path.join(destination, "manifest.json"), "utf8"),
    );
    const verification = JSON.parse(
      await readFile(path.join(destination, "verification.json"), "utf8"),
    );
    if (previous.buildKey === buildKey && verification.relocated === true) {
      await auditRuntime(destination);
      await verifyRuntimeAudio(destination);
      console.log(`Reusing verified runtime: ${destination}`);
      process.exit(0);
    }
  } catch {
    /* Missing, stale, or damaged builds must be prepared again. */
  }
}

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `${path.basename(command)} failed: ${result.error?.message || result.stderr || result.stdout}`,
    );
  return result.stdout.trim();
};
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function download(asset) {
  if (
    !/^[a-f0-9]{64}$/.test(asset.sha256) ||
    path.basename(asset.filename) !== asset.filename
  )
    throw new Error("Invalid runtime pin.");
  const target = path.join(cache, asset.filename);
  try {
    if ((await sha256(target)) === asset.sha256) return target;
  } catch {
    /* Missing cache. */
  }
  const partial = target + ".partial";
  console.log(`Downloading ${asset.filename}`);
  const response = await fetch(asset.url, {
    signal: AbortSignal.timeout(20 * 60_000),
  });
  if (!response.ok || !response.body)
    throw new Error(`Download failed (${response.status}): ${asset.filename}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
    if ((await sha256(partial)) !== asset.sha256)
      throw new Error(`SHA256 mismatch: ${asset.filename}`);
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return target;
}
function extract(archive, target) {
  const names = run("/usr/bin/tar", ["-tf", archive]).split("\n");
  if (
    names.some(
      (name) => path.isAbsolute(name) || name.split("/").includes(".."),
    )
  )
    throw new Error("Unsafe archive path.");
  run("/usr/bin/tar", ["-xf", archive, "-C", target]);
}
await mkdir(cache, { recursive: true });
await mkdir(stage, { recursive: true });
try {
  const sources = new Map();
  // A small concurrency limit avoids overwhelming the network during packaging.
  for (let i = 0; i < manifest.sources.length; i += 3) {
    await Promise.all(
      manifest.sources
        .slice(i, i + 3)
        .map(async (asset) => sources.set(asset.id, await download(asset))),
    );
  }
  extract(sources.get("python"), stage);
  await mkdir(path.join(stage, "ollama"));
  extract(sources.get("ollama"), path.join(stage, "ollama"));
  await mkdir(path.join(stage, "bin"));
  const sourceBuild = path.join(stage, "ffmpeg-build");
  await mkdir(sourceBuild);
  extract(sources.get("ffmpeg-source"), sourceBuild);
  const ffmpegSource = path.join(sourceBuild, "ffmpeg-8.0.1");
  const configure = JSON.parse(
    await readFile(
      path.join(root, "scripts/runtime/ffmpeg-configure.json"),
      "utf8",
    ),
  );
  console.log(
    "Compiling LGPL-only FFmpeg/FFprobe with Apple's compiler (no Homebrew dependencies)",
  );
  const buildEnv = {
    PATH: "/usr/bin:/bin",
    HOME: stage,
    LANG: "C",
    MACOSX_DEPLOYMENT_TARGET: "14.0",
  };
  run("/bin/sh", ["configure", ...configure], {
    cwd: ffmpegSource,
    env: buildEnv,
  });
  run("/usr/bin/make", ["-j4", "ffmpeg", "ffprobe"], {
    cwd: ffmpegSource,
    env: buildEnv,
  });
  for (const name of ["ffmpeg", "ffprobe"]) {
    await cp(path.join(ffmpegSource, name), path.join(stage, "bin", name));
    await chmod(path.join(stage, "bin", name), 0o755);
  }
  await mkdir(path.join(stage, "licenses"));
  for (const asset of manifest.sources.filter((asset) =>
    asset.id.endsWith("-license"),
  ))
    await cp(
      sources.get(asset.id),
      path.join(stage, "licenses", `${asset.id}.txt`),
    );
  await cp(
    path.join(ffmpegSource, "COPYING.LGPLv2.1"),
    path.join(stage, "licenses/ffmpeg-LGPLv2.1.txt"),
  );
  await cp(
    path.join(ffmpegSource, "LICENSE.md"),
    path.join(stage, "licenses/ffmpeg-license.txt"),
  );
  await mkdir(path.join(stage, "sources"));
  await cp(
    sources.get("ffmpeg-source"),
    path.join(stage, "sources/ffmpeg-8.0.1.tar.xz"),
  );
  await cp(
    path.join(root, "scripts/runtime/ffmpeg-configure.json"),
    path.join(stage, "sources/ffmpeg-configure.json"),
  );
  await cp(
    path.join(root, "scripts/runtime/rebuild-ffmpeg.sh"),
    path.join(stage, "sources/rebuild-ffmpeg.sh"),
  );
  await rm(sourceBuild, { recursive: true, force: true });
  const wheels = JSON.parse(await readFile(wheelPath, "utf8"));
  for (let i = 0; i < wheels.length; i += 4)
    await Promise.all(wheels.slice(i, i + 4).map(download));
  const requirements =
    wheels
      .map(
        (wheel) =>
          `${wheel.name}==${wheel.version} --hash=sha256:${wheel.sha256}`,
      )
      .join("\n") + "\n";
  const lock = path.join(stage, "python-requirements.lock");
  await writeFile(lock, requirements);
  const python = path.join(stage, "python/bin/python3.12");
  const cleanEnvironment = {
    PATH: "/usr/bin:/bin",
    HOME: stage,
    TMPDIR: process.env.TMPDIR || "/tmp",
    LANG: "en_US.UTF-8",
    OLLAMA_HOST: "127.0.0.1:1",
    OLLAMA_NO_CLOUD: "1",
    HF_HUB_OFFLINE: "1",
    PYTHONNOUSERSITE: "1",
  };
  console.log("Installing hash-locked Python wheels from the local cache");
  run(
    python,
    [
      "-I",
      "-m",
      "pip",
      "install",
      "--no-index",
      "--find-links",
      cache,
      "--require-hashes",
      "--only-binary=:all:",
      "--disable-pip-version-check",
      "--no-compile",
      "-r",
      lock,
    ],
    { env: cleanEnvironment },
  );
  // Console scripts record a build-time shebang. Use python -m at runtime instead.
  for (const entry of await readdir(path.join(stage, "python/bin")))
    if (!/^python(?:3(?:\.12)?)?$/.test(entry))
      await rm(path.join(stage, "python/bin", entry), {
        recursive: true,
        force: true,
      });
  async function removeBytecode(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (
        entry.name === "__pycache__" ||
        entry.name.endsWith(".pyc") ||
        entry.name.endsWith(".pyo")
      )
        await rm(file, { recursive: true, force: true });
      else if (entry.isDirectory()) await removeBytecode(file);
    }
  }
  await removeBytecode(path.join(stage, "python"));
  await cp(
    path.join(root, "scripts/runtime/THIRD-PARTY-NOTICES.md"),
    path.join(stage, "THIRD-PARTY-NOTICES.md"),
  );
  await writeFile(
    path.join(stage, "manifest.json"),
    JSON.stringify(
      {
        ...manifest,
        buildKey,
        wheels,
        executables: {
          python: "python/bin/python3.12",
          ffmpeg: "bin/ffmpeg",
          ffprobe: "bin/ffprobe",
          ollama: "ollama/ollama",
        },
      },
      null,
      2,
    ) + "\n",
  );
  // Moving the entire tree catches absolute library paths and build-directory dependencies.
  await rename(stage, relocated);
  const env = { ...cleanEnvironment, HOME: relocated };
  const pythonVersion = run(
    path.join(relocated, "python/bin/python3.12"),
    [
      "-I",
      "-B",
      "-c",
      "import sys, platform, importlib.metadata, faster_whisper, av, ctranslate2, onnxruntime; assert platform.machine() == 'arm64'; assert importlib.metadata.version('faster-whisper') == '1.2.1'; print(sys.version.split()[0] + ' faster-whisper=' + importlib.metadata.version('faster-whisper'))",
    ],
    { env },
  );
  const versions = { python: pythonVersion };
  for (const binary of ["ffmpeg", "ffprobe"])
    versions[binary] = run(path.join(relocated, "bin", binary), ["-version"], {
      env,
    }).split("\n")[0];
  if (
    /--enable-(?:nonfree|gpl|version3)/.test(
      run(path.join(relocated, "bin/ffmpeg"), ["-buildconf"], { env }),
    )
  )
    throw new Error("FFmpeg must remain LGPL-only.");
  versions.ollama = run(path.join(relocated, "ollama/ollama"), ["--version"], {
    env,
  });
  const audioFormats = await verifyRuntimeAudio(relocated);
  await writeFile(
    path.join(relocated, "verification.json"),
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        relocated: true,
        path: env.PATH,
        versions,
        audioFormats,
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    path.join(relocated, "mach-o-files.json"),
    JSON.stringify(await auditRuntime(relocated), null, 2) + "\n",
  );
  // Replace only this script's generated runtime after all validation succeeds.
  await rm(destination, { recursive: true, force: true });
  await rename(relocated, destination);
  console.log(JSON.stringify(versions, null, 2));
  console.log(`Prepared relocatable runtime: ${destination}`);
} finally {
  await rm(stage, { recursive: true, force: true });
  await rm(relocated, { recursive: true, force: true });
}
