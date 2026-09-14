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
