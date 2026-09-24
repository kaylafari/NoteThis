import { it, expect } from "vitest";
import { mkdtemp, mkdir, copyFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
it("never substitutes a development app when a packaged launch is requested", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "notethis-launcher-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await copyFile("scripts/launch.mjs", path.join(root, "scripts/launch.mjs"));
    const result = await promisify(execFile)(
      process.execPath,
      [path.join(root, "scripts/launch.mjs"), "--packaged"],
      { timeout: 5000 },
    ).then(
      () => {
        throw new Error("Expected missing bundle to fail");
      },
      (error) => error,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("will not substitute a development app");
    expect(result.stderr).toContain("npm run setup:signing");
    expect(result.stderr).not.toContain("Cannot find package");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
