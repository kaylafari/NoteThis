import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import * as storage from "../server/storage.js";
import path from "node:path";
import {
  createLocalSetup,
  resolvePythonPath,
  configureLocalRuntime,
  resolveRuntimeBinary,
  readOnboarding,
  completeOnboarding,
  type SetupDependencies,
} from "../server/local-setup.js";
let dir: string;
let managers: ReturnType<typeof createLocalSetup>[];
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "notethis-setup-test-"));
  managers = [];
});
afterEach(async () => {
  await Promise.all(managers.map((manager) => manager.close()));
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture(initial = false) {
  let whisper = initial;
  let chat = initial;
  let healthy = true;
  let finishService: () => void = () => {};
  const kill = vi.fn(() => finishService());
  const run = vi.fn<SetupDependencies["run"]>(
    async (_command, args, options) => {
      options.signal.throwIfAborted();
      if (args[1]?.includes("local_files_only=True") && !whisper)
        throw new Error("Missing local model");
      if (args[1]?.includes("local_files_only=False")) whisper = true;
    },
  );
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (!healthy) throw new Error("Not listening");
    if (String(url).endsWith("/api/tags"))
      return Response.json({ models: chat ? [{ name: "qwen3:0.6b" }] : [] });
    expect(String(url)).toBe("http://127.0.0.1:11434/api/pull");
    expect(JSON.parse(init?.body as string)).toEqual({
      model: "qwen3:0.6b",
      stream: true,
    });
    chat = true;
    return new Response(
      '{"status":"pulling","total":100,"completed":50}\n{"status":"success"}\n',
    );
  });
  const spawnService = vi.fn<SetupDependencies["spawnService"]>(() => {
    healthy = true;
    return {
      kill,
      exited: new Promise<void>((resolve) => {
        finishService = resolve;
      }),
    };
  });
  const dependencies = {
    run,
    fetch: fetcher,
    spawnService,
    access: vi.fn(async () => {}),
  };
  const make = (pythonPath = ".venv/bin/python") => {
    const manager = createLocalSetup({
      dataDir: dir,
      runtimeDir: "/Synthetic NoteThis.app/runtime",
      pythonPath: async () => pythonPath,
      dependencies,
    });
    managers.push(manager);
    return manager;
  };
  return {
    make,
    dependencies,
    kill,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
    removeWhisper: () => {
      whisper = false;
    },
  };
}
async function finished(manager: ReturnType<typeof createLocalSetup>) {
  await vi.waitFor(
    async () => expect((await manager.status()).state).not.toBe("running"),
    { timeout: 3000, interval: 10 },
  );
  return manager.status();
}
describe("local preparation", () => {
  it("does not download, start services or run commands on first status read", async () => {
    const f = fixture();
    const manager = f.make();
    expect((await manager.status()).state).toBe("idle");
    expect(f.dependencies.run).not.toHaveBeenCalled();
    expect(f.dependencies.fetch).not.toHaveBeenCalled();
    expect(f.dependencies.spawnService).not.toHaveBeenCalled();
  });
  it("prepares only defaults after explicit start and serializes duplicate requests", async () => {
    const f = fixture();
    const manager = f.make();
    const statuses = await Promise.all([
      manager.start(),
      manager.start(),
      manager.start(),
    ]);
    expect(statuses.every((s) => s.state === "running")).toBe(true);
    expect(await finished(manager)).toMatchObject({
      state: "ready",
      stage: "complete",
    });
    expect(
      f.dependencies.run.mock.calls.filter((call) =>
        call[1][1]?.includes("local_files_only=False"),
      ),
    ).toHaveLength(1);
    expect(
      f.dependencies.fetch.mock.calls.filter((call) =>
        String(call[0]).endsWith("/api/pull"),
      ),
    ).toHaveLength(1);
    const [command, , options] = f.dependencies.run.mock.calls[0];
    expect(command).toBe(
      "/Synthetic NoteThis.app/runtime/python/bin/python3.12",
    );
    expect(options.env).toMatchObject({
      HF_HOME: path.join(dir, "models", "huggingface"),
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
      HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    });
    await manager.close();
    expect(f.dependencies.spawnService).not.toHaveBeenCalled();
    expect(f.kill).not.toHaveBeenCalled();
  });
  it("does not download already installed models and preserves custom Python paths", async () => {
    const f = fixture(true);
    const manager = f.make("/custom/python");
    await manager.start();
    expect((await finished(manager)).state).toBe("ready");
    expect(f.dependencies.run.mock.calls[0][0]).toBe("/custom/python");
    expect(
      f.dependencies.run.mock.calls.some((call) =>
        call[1][1]?.includes("local_files_only=False"),
      ),
    ).toBe(false);
    expect(
      f.dependencies.fetch.mock.calls.some((call) =>
        String(call[0]).endsWith("/api/pull"),
      ),
    ).toBe(false);
  });
  it("validates persisted ready models rather than trusting the marker", async () => {
    const f = fixture(true);
    const manager = f.make();
    await manager.start();
    await finished(manager);
    await manager.close();
    expect(
      JSON.parse(await readFile(path.join(dir, "local-setup.json"), "utf8"))
        .state,
    ).toBe("ready");
    f.removeWhisper();
    const next = f.make();
    expect((await next.status()).state).toBe("idle");
    expect(
      f.dependencies.run.mock.calls.some((call) =>
        call[1][1]?.includes("local_files_only=False"),
      ),
    ).toBe(false);
    await next.start();
    expect((await finished(next)).state).toBe("ready");
  });
  it("preserves completed setup when shutdown overlaps its final disk write", async () => {
    const save = storage.atomicJson;
    let release!: () => void;
    let writingReady!: () => void;
    const readyWrite = new Promise<void>((resolve) => {
      writingReady = resolve;
    });
    const holdWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(storage, "atomicJson").mockImplementation(
      async (filename, value) => {
        if ((value as { state?: string }).state === "ready") {
          writingReady();
          await holdWrite;
        }
        return save(filename, value);
      },
    );
    const manager = fixture(true).make();
    await manager.start();
    await readyWrite;
    expect((await manager.status()).state).toBe("ready");
    const closing = manager.close();
    release();
    await closing;
    expect(
      JSON.parse(await readFile(path.join(dir, "local-setup.json"), "utf8"))
        .state,
    ).toBe("ready");
  });
  it("reports interrupted persisted preparation as retryable", async () => {
    await writeFile(
      path.join(dir, "local-setup.json"),
      JSON.stringify({ state: "running" }),
    );
    const manager = fixture().make();
    expect(await manager.status()).toMatchObject({
      state: "error",
      stage: "interrupted",
    });
    await manager.start();
    expect((await finished(manager)).state).toBe("ready");
  });
  it("fails clearly when the runtime is missing and permits retry", async () => {
    const f = fixture();
    const manager = f.make();
    f.dependencies.run.mockRejectedValueOnce(
      new Error("Bundled Python missing. Reinstall NoteThis."),
    );
    await manager.start();
    expect(await finished(manager)).toMatchObject({
      state: "error",
      message: expect.stringContaining("Reinstall"),
    });
    await manager.start();
    expect((await finished(manager)).state).toBe("ready");
  });
  it("honors simultaneous retries while the failed attempt flushes its final write", async () => {
    const save = storage.atomicJson;
    let release!: () => void;
    let writingError!: () => void;
    const errorWrite = new Promise<void>((resolve) => {
      writingError = resolve;
    });
    const holdWrite = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(storage, "atomicJson").mockImplementation(
      async (filename, value) => {
        if ((value as { state?: string }).state === "error") {
          writingError();
          await holdWrite;
        }
        return save(filename, value);
      },
    );
    const f = fixture();
    f.dependencies.run.mockRejectedValueOnce(
      new Error("Synthetic first failure"),
    );
    const manager = f.make();
    await manager.start();
    await errorWrite;
    let retriesSettled = false;
    const retry = Promise.all([manager.start(), manager.start()]).then(
      (value) => {
        retriesSettled = true;
        return value;
      },
    );
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect((await manager.status()).state).toBe("error");
      expect(retriesSettled).toBe(false);
      expect(f.dependencies.run).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await retry).every((value) => value.state === "running")).toBe(
      true,
    );
    expect((await finished(manager)).state).toBe("ready");
    expect(
      f.dependencies.run.mock.calls.filter((call) =>
        call[1][1]?.includes("local_files_only=False"),
      ),
    ).toHaveLength(1);
  });
  it("spawns only its own loopback service and stops only that child", async () => {
    const f = fixture(true);
    f.setHealthy(false);
    const manager = f.make();
    await manager.startService();
    expect(f.dependencies.spawnService).toHaveBeenCalledWith(
      "/Synthetic NoteThis.app/runtime/ollama/ollama",
      expect.objectContaining({
        OLLAMA_HOST: "127.0.0.1:11434",
        OLLAMA_MODELS: path.join(dir, "models", "ollama"),
        OLLAMA_NO_CLOUD: "1",
      }),
    );
    await manager.close();
    expect(f.kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("allows a first service startup longer than 20 seconds without restarting it", async () => {
    vi.useFakeTimers();
    const f = fixture(true);
    f.setHealthy(false);
    let finish!: () => void;
    const exited = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.dependencies.spawnService.mockImplementation(() => ({
      kill: () => finish(),
      exited,
    }));
    const manager = f.make();
    let ready = false;
    const starting = manager.startService().then(() => {
      ready = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(21_000);
      expect(ready).toBe(false);
      expect(f.dependencies.spawnService).toHaveBeenCalledTimes(1);
      f.setHealthy(true);
      await vi.advanceTimersByTimeAsync(500);
      await starting;
      expect(ready).toBe(true);
      expect(f.dependencies.spawnService).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
      vi.useRealTimers();
    }
  });
  it("cancels an active Python model download and persists retryable state", async () => {
    const f = fixture();
    const manager = f.make();
    f.dependencies.run.mockImplementation(async (_command, args, options) => {
      if (args[1]?.includes("local_files_only=True"))
        throw new Error("missing");
      if (args[1]?.includes("local_files_only=False"))
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
    });
    await manager.start();
    await vi.waitFor(() =>
      expect(
        f.dependencies.run.mock.calls.some((call) =>
          call[1][1]?.includes("local_files_only=False"),
        ),
      ).toBe(true),
    );
    await manager.close();
    expect(
      JSON.parse(await readFile(path.join(dir, "local-setup.json"), "utf8")),
    ).toMatchObject({ state: "error", stage: "interrupted" });
    expect((await manager.start()).state).toBe("error");
    expect(
      f.dependencies.fetch.mock.calls.some((call) =>
        String(call[0]).endsWith("/api/pull"),
      ),
    ).toBe(false);
  });
  it("aborts streamed Ollama downloads when the app closes", async () => {
    const f = fixture();
    const normalFetch = f.dependencies.fetch.getMockImplementation()!;
    let aborted = false;
    f.dependencies.fetch.mockImplementation(async (url, init) => {
      if (!String(url).endsWith("/api/pull")) return normalFetch(url, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode('{"status":"pulling"}\n'),
            );
            init?.signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new Error("cancelled"));
              },
              { once: true },
            );
          },
        }),
      );
    });
    const manager = f.make();
    await manager.start();
    await vi.waitFor(() =>
      expect(
        f.dependencies.fetch.mock.calls.some((call) =>
          String(call[0]).endsWith("/api/pull"),
        ),
      ).toBe(true),
    );
    await manager.close();
    expect(aborted).toBe(true);
    expect(
      JSON.parse(await readFile(path.join(dir, "local-setup.json"), "utf8")),
    ).toMatchObject({ state: "error", stage: "interrupted" });
    expect(f.kill).not.toHaveBeenCalled();
  });
  it("requires a terminal Ollama success event before marking setup ready", async () => {
    const f = fixture();
    const fallback = f.dependencies.fetch.getMockImplementation()!;
    f.dependencies.fetch.mockImplementation(async (url, init) =>
      String(url).endsWith("/api/pull")
        ? new Response('{"status":"pulling","completed":50,"total":100}\n')
        : fallback(url, init),
    );
    const manager = f.make();
    await manager.start();
    expect(await finished(manager)).toMatchObject({
      state: "error",
      message: expect.stringContaining("before completion"),
    });
  });
});
describe("onboarding and runtime preferences", () => {
  it("persists completion per data directory without relying on browser origin", async () => {
    expect(await readOnboarding(dir)).toEqual({ completed: false });
    expect(await completeOnboarding(dir)).toEqual({ completed: true });
    expect(await readOnboarding(dir)).toEqual({ completed: true });
  });
  it("resolves only default Python paths to the bundle", () => {
    expect(resolvePythonPath(".venv/bin/python", "/bundle/runtime")).toBe(
      "/bundle/runtime/python/bin/python3.12",
    );
    expect(resolvePythonPath("/chosen/python", "/bundle/runtime")).toBe(
      "/chosen/python",
    );
    expect(resolvePythonPath(".venv/bin/python", "")).toBe(".venv/bin/python");
  });
  it("keeps runtime writes in userdata and prepends bundled executables", () => {
    for (const key of [
      "CADENCE_RUNTIME_DIR",
      "PATH",
      "HF_HOME",
      "HF_HUB_CACHE",
      "HUGGINGFACE_HUB_CACHE",
      "PYTHONDONTWRITEBYTECODE",
      "PYTHONNOUSERSITE",
    ])
      vi.stubEnv(key, process.env[key]);
    configureLocalRuntime("/readonly/bundle/runtime", dir);
    expect(process.env.PATH?.startsWith("/readonly/bundle/runtime/bin:")).toBe(
      true,
    );
    expect(resolveRuntimeBinary("ffmpeg")).toBe(
      "/readonly/bundle/runtime/bin/ffmpeg",
    );
    expect(process.env.HF_HOME).toBe(path.join(dir, "models", "huggingface"));
    expect(process.env.PYTHONDONTWRITEBYTECODE).toBe("1");
  });
});
