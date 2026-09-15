import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let ownedOllama;
try {
  const response = await fetch("http://127.0.0.1:11434/api/tags", {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error();
} catch {
  const local = path.join(root, ".local", "bin", "ollama");
  if (existsSync(local)) {
    ownedOllama = spawn(local, ["serve"], {
      cwd: root,
      env: {
        ...process.env,
        OLLAMA_MODELS: path.join(root, ".local", "models"),
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_NO_CLOUD: "1",
      },
      stdio: "ignore",
    });
  } else
    console.log(
      "Start Ollama to use local meeting intelligence, or choose a cloud model in Settings.",
    );
}
const packaged = path.join(root, "release", "mac-arm64", "NoteThis.app");
const usePackaged = process.argv.includes("--packaged") && existsSync(packaged);
const executable = usePackaged
  ? "/usr/bin/open"
  : (await import("electron")).default;
const app = spawn(executable, usePackaged ? ["-W", packaged] : ["."], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
});
const cleanup = () => {
  ownedOllama?.kill();
};
app.on("exit", (code) => {
  cleanup();
  process.exit(code || 0);
});
app.on("error", (error) => {
  console.error(error.message);
  cleanup();
  process.exit(1);
});
process.on("SIGINT", () => {
  app.kill();
  cleanup();
});
process.on("SIGTERM", () => {
  app.kill();
  cleanup();
});
