import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson } from "./storage.js";

export type LocalSetupStatus = {
  state: "idle" | "running" | "ready" | "error";
  stage: string;
  message: string;
};
const OLLAMA_URL = "http://127.0.0.1:11434";
const CHAT_MODEL = "qwen3:0.6b";
const idle: LocalSetupStatus = {
  state: "idle",
  stage: "not-started",
  message:
    "Prepare Whisper base and Qwen3 0.6B for private, local transcription and meeting notes.",
};
const interrupted: LocalSetupStatus = {
  state: "error",
  stage: "interrupted",
  message:
    "Local AI preparation was interrupted. Select Prepare local AI to resume safely.",
};
const whisperCode = (download: boolean) =>
  `from faster_whisper import WhisperModel\nWhisperModel('base', device='cpu', compute_type='int8', cpu_threads=2, local_files_only=${download ? "False" : "True"})\n`;

/** Defaults follow the bundle; an explicitly selected Python remains unchanged. */
export function resolvePythonPath(
  configured: string | undefined,
  runtimeDir = process.env.CADENCE_RUNTIME_DIR,
): string {
  if (runtimeDir && (!configured || configured === ".venv/bin/python"))
    return path.join(runtimeDir, "python", "bin", "python3.12");
  return configured || "python3";
}
export function resolveRuntimeBinary(name: string) {
  return process.env.CADENCE_RUNTIME_DIR
    ? path.join(process.env.CADENCE_RUNTIME_DIR, "bin", name)
    : name;
}
export function configureLocalRuntime(runtimeDir: string, dataDir: string) {
  process.env.CADENCE_RUNTIME_DIR = runtimeDir;
  process.env.PATH = [
    path.join(runtimeDir, "bin"),
    path.join(runtimeDir, "ollama"),
    path.join(runtimeDir, "python", "bin"),
    process.env.PATH || "",
  ].join(path.delimiter);
  const cache = path.join(dataDir, "models", "huggingface");
  process.env.HF_HOME = cache;
  process.env.HF_HUB_CACHE = path.join(cache, "hub");
  process.env.HUGGINGFACE_HUB_CACHE = path.join(cache, "hub");
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.env.PYTHONNOUSERSITE = "1";
}
export async function readOnboarding(
  dataDir: string,
): Promise<{ completed: boolean }> {
  try {
    const saved = JSON.parse(
      await readFile(path.join(dataDir, "onboarding.json"), "utf8"),
    );
    return { completed: saved?.completed === true };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return { completed: false };
    throw error;
  }
}
export async function completeOnboarding(dataDir: string) {
  await atomicJson(path.join(dataDir, "onboarding.json"), { completed: true });
  return { completed: true };
}

type CommandOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
};
type OwnedService = {
  kill: (signal: NodeJS.Signals) => void;
  exited: Promise<void>;
};
export type SetupDependencies = {
  run: (
    command: string,
    args: string[],
    options: CommandOptions,
  ) => Promise<void>;
  fetch: typeof fetch;
  access: typeof access;
  spawnService: (command: string, env: NodeJS.ProcessEnv) => OwnedService;
};
function runCommand(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    options.signal.throwIfAborted();
    const child = spawn(command, args, {
      env: options.env,
      stdio: "ignore",
      windowsHide: true,
    });
    let failure: Error | undefined;
    const stop = () => {
      failure = new Error("Preparation cancelled.");
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 500);
      force.unref();
    };
    let force: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      failure = new Error(
        "The local preparation command timed out. Retry preparation after checking your connection and available disk space.",
      );
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref();
    options.signal.addEventListener("abort", stop, { once: true });
    const finish = () => {
      clearTimeout(timer);
      clearTimeout(force);
      options.signal.removeEventListener("abort", stop);
    };
    child.once("error", () => {
      finish();
      reject(
        new Error(
          `Could not start ${path.basename(command)}. The bundled local runtime is missing or damaged. Reinstall NoteThis, or select a working Python in Settings.`,
        ),
      );
    });
    child.once("close", (code) => {
      finish();
      failure
        ? reject(failure)
        : code === 0
          ? resolve()
          : reject(
              new Error(
                "A local AI dependency or model could not be loaded. Check your connection and free disk space, then retry preparation.",
              ),
            );
    });
  });
}
function spawnService(command: string, env: NodeJS.ProcessEnv): OwnedService {
  const child: ChildProcess = spawn(command, ["serve"], {
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  return {
    kill: (signal) => {
      child.kill(signal);
    },
    exited,
  };
}
const defaults: SetupDependencies = {
  run: runCommand,
  fetch: (...args) => fetch(...args),
  access,
  spawnService,
};
export type LocalSetupOptions = {
  dataDir: string;
  runtimeDir?: string;
  projectDir?: string;
  pythonPath: () => Promise<string>;
  dependencies?: Partial<SetupDependencies>;
};
export function createLocalSetup(options: LocalSetupOptions) {
  const deps = { ...defaults, ...options.dependencies };
  const lifetime = new AbortController();
  const filename = path.join(options.dataDir, "local-setup.json");
  let current: LocalSetupStatus = { ...idle };
  let active: Promise<void> | undefined;
  let checking: Promise<void> | undefined;
  let initialized = false;
  let closed = false;
  let owned: OwnedService | undefined;
  let starting: Promise<void> | undefined;
  let writes = Promise.resolve();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HOME: path.join(options.dataDir, "models", "huggingface"),
    HF_HUB_CACHE: path.join(options.dataDir, "models", "huggingface", "hub"),
    HUGGINGFACE_HUB_CACHE: path.join(
      options.dataDir,
      "models",
      "huggingface",
      "hub",
    ),
    HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    HF_HUB_DISABLE_XET: "1",
    HF_HUB_OFFLINE: undefined,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
  };
  delete env.HF_TOKEN;
  delete env.HUGGING_FACE_HUB_TOKEN;
  function update(status: LocalSetupStatus, persist = true) {
    current = status;
    if (persist)
      writes = writes
        .then(() => atomicJson(filename, status))
        .catch(() => {
          current = {
            state: "error",
            stage: "retry",
            message:
              "Could not save local setup progress. Check available disk space and retry.",
          };
        });
  }
  const command = async (
    program: string,
    args: string[],
    timeoutMs = 20_000,
  ) => {
    await deps.run(program, args, { signal: lifetime.signal, timeoutMs, env });
    lifetime.signal.throwIfAborted();
  };
  const bin = (name: string) =>
    options.runtimeDir ? path.join(options.runtimeDir, "bin", name) : name;
  const python = async () =>
    resolvePythonPath(await options.pythonPath(), options.runtimeDir);
  async function tags() {
    const response = await deps.fetch(`${OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(2_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Local Ollama is unavailable.");
    const data = (await response.json()) as {
      models?: { name?: string; model?: string }[];
    };
    if (!Array.isArray(data.models))
      throw new Error("The local service is not a compatible Ollama server.");
    return data.models;
  }
  async function ensureService() {
    if (closed) throw new Error("Preparation cancelled.");
    if (starting) return starting;
    starting = (async () => {
      try {
        await tags();
        return;
      } catch {
        lifetime.signal.throwIfAborted();
      }
      const executable = options.runtimeDir
        ? path.join(options.runtimeDir, "ollama", "ollama")
        : path.join(
            options.projectDir || process.cwd(),
            ".local",
            "bin",
            "ollama",
          );
      try {
        await deps.access(executable);
      } catch {
        throw new Error(
          "The local Ollama runtime is unavailable. Reinstall the complete NoteThis app, or start Ollama locally and retry preparation.",
        );
      }
      lifetime.signal.throwIfAborted();
      if (!owned) {
        owned = deps.spawnService(executable, {
          ...env,
          OLLAMA_HOST: "127.0.0.1:11434",
          OLLAMA_MODELS: path.join(options.dataDir, "models", "ollama"),
          OLLAMA_NO_CLOUD: "1",
        });
        const service = owned;
        void service.exited.then(() => {
          if (owned === service) owned = undefined;
        });
      }
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          await tags();
          return;
        } catch {
          lifetime.signal.throwIfAborted();
        }
        await delay(300, undefined, { signal: lifetime.signal });
      }
      throw new Error(
        "Local Ollama did not start. Check that port 11434 is available, then retry preparation.",
      );
    })().finally(() => {
      starting = undefined;
    });
    return starting;
  }
  async function checkReady() {
    const models = await tags();
    if (
      !models.some(
        (model) => model.name === CHAT_MODEL || model.model === CHAT_MODEL,
      )
    )
      return false;
    await command(await python(), ["-c", whisperCode(false)], 60_000);
    await command(bin("ffmpeg"), ["-version"]);
    await command(bin("ffprobe"), ["-version"]);
    return true;
  }
  async function initialize() {
    if (initialized) return;
    if (checking) return checking;
    checking = (async () => {
      try {
        const saved = JSON.parse(
          await readFile(filename, "utf8"),
        ) as LocalSetupStatus;
        if (saved?.state === "running") update({ ...interrupted });
        else if (saved?.state === "error")
          current = {
            state: "error",
            stage: "retry",
            message:
              "Local AI preparation did not finish. Select Prepare local AI to retry.",
          };
        else if (saved?.state === "ready") {
          try {
            await ensureService();
            if (await checkReady())
              current = {
                state: "ready",
                stage: "complete",
                message: "Whisper base and Qwen3 0.6B are ready for local use.",
              };
            else
              update({
                ...idle,
                message:
                  "A prepared local model is missing. Select Prepare local AI to restore it.",
              });
          } catch {
            update({
              ...idle,
              message:
                "Local models could not be verified. Select Prepare local AI to check and restore them.",
            });
          }
        }
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          !(error instanceof SyntaxError)
        )
          throw error;
      }
      initialized = true;
    })().finally(() => {
      checking = undefined;
    });
    return checking;
  }
  async function pullChatModel() {
    const response = await deps.fetch(`${OLLAMA_URL}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: CHAT_MODEL, stream: true }),
      signal: AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(45 * 60_000),
      ]),
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new Error(
        "Qwen3 could not be downloaded. Check your internet connection and available disk space, then retry.",
      );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let success = false;
    const line = (text: string) => {
      if (!text.trim()) return;
      const value = JSON.parse(text) as {
        error?: string;
        status?: string;
        total?: number;
        completed?: number;
      };
      if (value.error)
        throw new Error(
          "Ollama could not download Qwen3. Check your connection and free disk space, then retry.",
        );
      if (value.status === "success") success = true;
      const percent =
        typeof value.total === "number" &&
        value.total > 0 &&
        typeof value.completed === "number"
          ? Math.min(
              100,
              Math.max(0, Math.round((100 * value.completed) / value.total)),
            )
          : undefined;
      update(
        {
          state: "running",
          stage: "chat-model",
          message:
            percent === undefined
              ? "Preparing Qwen3 0.6B for local meeting notes…"
              : `Downloading Qwen3 0.6B: ${percent}%`,
        },
        false,
      );
    };
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        if (buffer.length > 128 * 1024)
          throw new Error("Ollama returned an invalid download response.");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
        }
      }
      buffer += decoder.decode();
      line(buffer);
      if (!success)
        throw new Error(
          "The Qwen3 download ended before completion. Retry preparation to resume.",
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async function prepare() {
    try {
      update({
        state: "running",
        stage: "runtime",
        message: "Checking the local audio and AI runtime…",
      });
      const interpreter = await python();
      await command(interpreter, [
        "-c",
        "import faster_whisper, av, ctranslate2",
      ]);
      await command(bin("ffmpeg"), ["-version"]);
      await command(bin("ffprobe"), ["-version"]);
      await ensureService();
      update({
        state: "running",
        stage: "speech-model",
        message:
          "Preparing Whisper base. The first download may take a few minutes…",
      });
      try {
        await command(interpreter, ["-c", whisperCode(false)], 60_000);
      } catch {
        lifetime.signal.throwIfAborted();
        await command(interpreter, ["-c", whisperCode(true)], 45 * 60_000);
      }
      update({
        state: "running",
        stage: "chat-model",
        message: "Checking Qwen3 0.6B…",
      });
      if (
        !(await tags()).some(
          (model) => model.name === CHAT_MODEL || model.model === CHAT_MODEL,
        )
      )
        await pullChatModel();
      update({
        state: "running",
        stage: "verify",
        message: "Verifying both local models…",
      });
      if (!(await checkReady()))
        throw new Error(
          "The downloaded models could not be verified. Select Prepare local AI to retry.",
        );
      update({
        state: "ready",
        stage: "complete",
        message: "Whisper base and Qwen3 0.6B are ready for local use.",
      });
    } catch (error) {
      update(
        closed || lifetime.signal.aborted
          ? { ...interrupted }
          : {
              state: "error",
              stage: "retry",
              message:
                error instanceof Error
                  ? error.message.slice(0, 400)
                  : "Local AI preparation failed. Retry preparation.",
            },
      );
    }
    await writes;
  }
  return {
    async status() {
      await initialize();
      return { ...current };
    },
    async start() {
      await initialize();
      if (closed) return { ...interrupted };
      if (active || current.state === "running") return { ...current };
      // Always verify again on an explicit request; a previous marker is not proof.
      update({
        state: "running",
        stage: "runtime",
        message: "Checking local AI…",
      });
      active = prepare()
        .catch(() => {
          current = {
            state: "error",
            stage: "retry",
            message:
              "Could not save local setup progress. Check available disk space and retry.",
          };
        })
        .finally(() => {
          active = undefined;
        });
      return { ...current };
    },
    startService: ensureService,
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      // Finished preparation can still be flushing its last status write.
      // Closing at that point must preserve the verified ready/error result.
      if (active && current.state === "running") update({ ...interrupted });
      const service = owned;
      if (service) {
        service.kill("SIGTERM");
        await Promise.race([service.exited, delay(750)]);
        if (owned === service) service.kill("SIGKILL");
      }
      await Promise.race([
        Promise.allSettled([active, checking, writes]),
        delay(1500),
      ]);
    },
  };
}
