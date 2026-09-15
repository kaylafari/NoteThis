import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireDataLock } from "../server/lock";
it("prevents concurrent writers and releases only its own lock", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cadence-lock-"));
  try {
    const release = await acquireDataLock(dir);
    await expect(acquireDataLock(dir)).rejects.toThrow("another NoteThis");
    release();
    const next = await acquireDataLock(dir);
    release();
    await expect(acquireDataLock(dir)).rejects.toThrow("another NoteThis");
    next();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
