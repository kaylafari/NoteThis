import { mkdir, open, readFile, rm } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
/** Prevent two app processes from recovering or overwriting each other's meetings. */
export async function acquireDataLock(dataDir: string) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataDir, "app.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(lockPath, "wx", 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, token }));
      await file.close();
      const cleanup = () => {
        try {
          if (JSON.parse(readFileSync(lockPath, "utf8")).token === token)
            unlinkSync(lockPath);
        } catch {}
      };
      process.on("exit", cleanup);
      return () => {
        process.removeListener("exit", cleanup);
        cleanup();
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: { pid?: number };
      try {
        owner = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {
        throw new Error(
          "Another Cadence process is starting. Close other copies and try again.",
        );
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid! <= 0)
        throw new Error(
          "The workspace lock is invalid. Close Cadence before removing app.lock from its data folder.",
        );
      try {
        process.kill(owner.pid!, 0);
        throw new Error(
          "This workspace is open in another Cadence process. Close the other desktop app or development server first.",
        );
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
      await rm(lockPath, { force: true });
    }
  }
  throw new Error("Could not lock the meeting workspace. Try again.");
}
