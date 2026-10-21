import { open, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Inspect linkage without loading credentials, model weights, or network services. */
export async function auditRuntime(directory) {
  const runtime = path.resolve(directory);
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__")
          throw new Error("Python bytecode cache must not be shipped");
        await walk(full);
      } else if (entry.isFile()) {
        if (/\.py[co]$/.test(entry.name))
          throw new Error("Python bytecode must not be shipped");
        const handle = await open(full, "r");
        const header = Buffer.alloc(4);
        try {
          await handle.read(header, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (
          ![
            "cffaedfe",
            "feedfacf",
            "cefaedfe",
            "feedface",
            "cafebabe",
            "bebafeca",
            "cafebabf",
            "bfbafeca",
          ].includes(header.toString("hex"))
        )
          continue;
        const inspect = spawnSync("/usr/bin/otool", ["-L", full], {
          encoding: "utf8",
        });
        if (inspect.status !== 0)
          throw new Error(`Cannot inspect ${path.relative(runtime, full)}`);
        const dependencies = [
          ...inspect.stdout.matchAll(/^\s+(.+?) \(compatibility version/gm),
        ].map((match) => match[1]);
        // otool -L includes LC_ID_DYLIB itself; it is a library identity, not
        // a dependency loaded from disk. Wheel delocation can retain this ID.
        const identity = spawnSync("/usr/bin/otool", ["-D", full], {
          encoding: "utf8",
        });
        const ownIds = new Set(
          (identity.stdout || "")
            .split("\n")
            .filter((line) => line && !line.endsWith(":")),
        );
        for (const dependency of dependencies) {
          if (ownIds.has(dependency)) continue;
          if (
            dependency.startsWith("/") &&
            !dependency.startsWith("/usr/lib/") &&
            !dependency.startsWith("/System/Library/")
          )
            throw new Error(
              `External native dependency in ${path.relative(runtime, full)}: ${dependency}`,
            );
        }
        files.push({ path: path.relative(runtime, full), dependencies });
      }
    }
  }
  await walk(runtime);
  for (const required of ["bin/ffmpeg", "bin/ffprobe", "ollama/ollama"]) {
    if (!files.some((file) => file.path === required))
      throw new Error(`Missing native executable: ${required}`);
  }
  return { nativeFiles: files.length, files };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(
    JSON.stringify(
      await auditRuntime(process.argv[2] || "build/runtime"),
      null,
      2,
    ),
  );
}
