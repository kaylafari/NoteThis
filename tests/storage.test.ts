import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/storage";
import type { Meeting } from "../shared/types";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cadence-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const meeting = (): Meeting => ({
  id: "test-123",
  title: "Test meeting",
  createdAt: new Date().toISOString(),
  duration: 12,
  status: "ready",
  audioFile: "test-123.wav",
  segments: [],
  messages: [],
});
describe("private local storage", () => {
  it("persists meetings and rejects traversal", async () => {
    const store = new Store(dir);
    await store.init();
    await store.save(meeting());
    expect((await store.get("test-123"))?.title).toBe("Test meeting");
    expect((await store.list()).length).toBe(1);
    await expect(store.get("../secrets")).rejects.toThrow("Invalid meeting ID");
  });
  it("encrypts secrets, never includes keys in settings, survives restart", async () => {
    const store = new Store(dir);
    await store.init();
    await store.setSecret("api:openai", "sensitive-test-secret");
    expect(
      await readFile(path.join(dir, "secrets.json"), "utf8"),
    ).not.toContain("sensitive-test-secret");
    expect((await store.getSettings()).configuredKeys).toEqual(["openai"]);
    const next = new Store(dir);
    await next.init();
    expect(await next.getSecret("api:openai")).toBe("sensitive-test-secret");
    expect((await stat(path.join(dir, "secret.key"))).mode & 0o777).toBe(0o600);
  });
  it("serializes concurrent secret mutations and supports deletion", async () => {
    const store = new Store(dir);
    await store.init();
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.setSecret(`api:p${i}`, `value${i}`),
      ),
    );
    const next = new Store(dir);
    await next.init();
    expect((await next.getSettings()).configuredKeys).toHaveLength(8);
    await next.setSecret("api:p0", "");
    expect(await next.getSecret("api:p0")).toBeUndefined();
  });
  it("awaits asynchronous OS encryption and decryption across restart", async () => {
    const codec = {
      encrypt: async (value: string) =>
        Buffer.from(`fixture:${value}`).toString("base64"),
      decrypt: async (value: string) =>
        Buffer.from(value, "base64").toString().slice(8),
    };
    const store = new Store(dir, codec);
    await store.init();
    await Promise.all([
      store.setSecret("api:first", "synthetic-one"),
      store.setSecret("api:second", "synthetic-two"),
    ]);
    const saved = await readFile(path.join(dir, "secrets.json"), "utf8");
    expect(saved).not.toContain("[object Promise]");
    expect(saved).not.toContain("synthetic-one");
    expect(JSON.parse(saved)["api:first"]).toMatch(/^os:/);
    const next = new Store(dir, codec);
    await next.init();
    expect(await next.getSecret("api:first")).toBe("synthetic-one");
    expect(await next.getSecret("api:second")).toBe("synthetic-two");
  });
  it("preserves existing credentials on async encryption rejection and lets later writes recover", async () => {
    const codec = {
      encrypt: async (value: string) => {
        if (value === "rejected") throw new Error("Keychain denied");
        return Buffer.from(value).toString("base64");
      },
      decrypt: async (value: string) => Buffer.from(value, "base64").toString(),
    };
    const store = new Store(dir, codec);
    await store.init();
    await store.setSecret("api:first", "existing");
    const before = await readFile(path.join(dir, "secrets.json"), "utf8");
    await expect(store.setSecret("api:first", "rejected")).rejects.toThrow(
      "Keychain denied",
    );
    expect(await readFile(path.join(dir, "secrets.json"), "utf8")).toBe(before);
    expect(await store.getSecret("api:first")).toBe("existing");
    await store.setSecret("api:second", "recovered");
    expect(await store.getSecret("api:second")).toBe("recovered");
  });
  it("marks interrupted jobs retryable without losing audio references", async () => {
    const store = new Store(dir);
    await store.init();
    await store.save({ ...meeting(), status: "transcribing" });
    const next = new Store(dir);
    await next.init();
    expect(await next.get("test-123")).toMatchObject({
      status: "error",
      audioFile: "test-123.wav",
    });
  });
  it("requires the OS codec to decrypt desktop credentials", async () => {
    const codec = {
      encrypt: (s: string) => Buffer.from(s).toString("base64"),
      decrypt: (s: string) => Buffer.from(s, "base64").toString(),
    };
    const store = new Store(dir, codec);
    await store.init();
    await store.setSecret("api:provider", "private");
    expect(await store.getSecret("api:provider")).toBe("private");
    const web = new Store(dir);
    await web.init();
    await expect(web.getSecret("api:provider")).rejects.toThrow("desktop");
  });
});

const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8/8AAAAASUVORK5CYII=";
const withVisual = (): Meeting => ({
  ...meeting(),
  insight: {
    summary: "A branches into B and C.",
    decisions: [],
    actions: [],
    visuals: [
      {
        id: "diagram-1",
        title: "Tree",
        description: "A branches into B and C.",
        mimeType: "image/png",
        dataUrl: `data:image/png;base64,${png}`,
      },
    ],
  },
});
describe("optional features and summary diagrams", () => {
  it("defaults off, persists provider consent, and clears it on provider change", async () => {
    const store = new Store(dir);
    await store.init();
    const settings = await store.getSettings();
    expect(settings.llm).toMatchObject({
      webSearch: false,
      summaryDiagrams: false,
    });
    await store.updateSettings({
      llm: {
        ...settings.llm,
        provider: "openrouter",
        webSearch: true,
        summaryDiagrams: true,
      },
    });
    expect((await store.getSettings()).llm).toMatchObject({
      webSearch: false,
      summaryDiagrams: false,
    });
    await store.updateSettings({
      llm: {
        ...settings.llm,
        provider: "openrouter",
        webSearch: true,
        webSearchConsentProvider: "openrouter",
        summaryDiagrams: true,
        summaryDiagramsConsentProvider: "openrouter",
      },
    });
    const next = new Store(dir);
    await next.init();
    expect((await next.getSettings()).llm).toMatchObject({
      webSearch: true,
      summaryDiagrams: true,
    });
    await next.updateSettings({
      llm: { ...(await next.getSettings()).llm, provider: "openai" },
    });
    expect((await next.getSettings()).llm).toMatchObject({
      webSearch: false,
      summaryDiagrams: false,
    });
    expect(
      (await next.getSettings()).llm.webSearchConsentProvider,
    ).toBeUndefined();
  });
  it("stores images privately apart from library metadata and cleans them up", async () => {
    const store = new Store(dir);
    await store.init();
    const saved = await store.save(withVisual());
    expect(saved.insight?.visuals?.[0].imageUrl).toBe(
      "/api/meetings/test-123/visuals/diagram-1",
    );
    expect(JSON.stringify(await store.list())).not.toContain(png);
    expect(
      await readFile(path.join(dir, "meetings/test-123.json"), "utf8"),
    ).not.toContain("dataUrl");
    const next = new Store(dir);
    await next.init();
    expect(
      (await next.getVisual("test-123", "diagram-1"))?.data.toString("base64"),
    ).toBe(png);
    expect(
      (await stat(path.join(dir, "visuals/test-123-diagram-1.png"))).mode &
        0o777,
    ).toBe(0o600);
    await next.save((await next.get("test-123"))!);
    expect(await next.getVisual("test-123", "diagram-1")).not.toBeNull();
    await next.remove("test-123");
    await expect(
      stat(path.join(dir, "visuals/test-123-diagram-1.png")),
    ).rejects.toThrow();
  });
  it("removes replaced diagrams and treats missing files as unavailable", async () => {
    const store = new Store(dir);
    await store.init();
    await store.save(withVisual());
    await store.save(meeting());
    await expect(
      stat(path.join(dir, "visuals/test-123-diagram-1.png")),
    ).rejects.toThrow();
    await store.save(withVisual());
    await rm(path.join(dir, "visuals/test-123-diagram-1.png"));
    expect(await store.getVisual("test-123", "diagram-1")).toBeNull();
  });
  it("rejects invalid image payloads and path traversal", async () => {
    const store = new Store(dir);
    await store.init();
    for (const patch of [
      { id: "../secrets" },
      { mimeType: "image/svg+xml" },
      { dataUrl: "https://example.com/image.png" },
      { dataUrl: "data:image/png;base64,YmFk" },
      { dataUrl: `data:image/png;base64,${png}=` },
    ]) {
      const m = withVisual();
      Object.assign(m.insight!.visuals![0], patch);
      await expect(store.save(m)).rejects.toThrow();
    }
    expect(await store.get("test-123")).toBeNull();
  });
});
