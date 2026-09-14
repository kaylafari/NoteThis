import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = process.env.CADENCE_PYTHON
  ? [process.env.CADENCE_PYTHON]
  : ["python3.12", "python3.13", "python3.11", "python3"];
const python = candidates.find(
  (cmd) =>
    spawnSync(
      cmd,
      ["-c", "import sys; assert (3,11) <= sys.version_info[:2] <= (3,13)"],
      { stdio: "ignore" },
    ).status === 0,
);
if (!python) {
  console.error(
    "Install Python 3.11–3.13, then run npm run setup:local again. On macOS: brew install python@3.12 ffmpeg",
  );
  process.exit(1);
}
const run = (cmd, args) => {
  const result = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
};
if (!existsSync(path.join(root, ".venv"))) run(python, ["-m", "venv", ".venv"]);
const executable = path.join(
  root,
  ".venv",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
run(executable, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "-r",
  "requirements.txt",
]);
console.log(
  `\nWhisper is ready. In Settings, use Python executable: ${executable}`,
);
console.log(
  "Whisper base weights download on your first transcription. Install Ollama, start it, and run: ollama pull qwen3:0.6b",
);
console.log(
  "Then run npm run desktop. For a browser-only preview, run npm run dev.",
);
