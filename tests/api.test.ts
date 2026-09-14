import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
vi.mock("../server/providers", () => ({
  providerCatalog: () => ({ stt: [{ id: "local" }], llm: [{ id: "ollama" }] }),
  transcribeAudio: vi.fn(async () => ({
    segments: [
      {
        id: "seg-0",
        start: 0,
        end: 1,
        text: "Maya will send the proposal.",
        words: [{ text: "Maya", start: 0, end: 0.2 }],
      },
    ],
    duration: 1,
    timing: "word",
  })),
  generateText: vi.fn(async (_system: string, prompt: string) =>
    prompt.includes("Return only JSON")
      ? JSON.stringify({
          summary: "Maya committed to the proposal.",
          decisions: [],
          actions: [
            { text: "Send proposal", owner: "Maya", segmentId: "seg-0" },
          ],
        })
      : "Maya will send it. [seg-0]",
  ),
}));
vi.mock("../server/oauth", () => ({
  configureOAuthStorage: vi.fn(),
  getOAuthConnections: async () => [],
  getOAuthState: vi.fn(),
  startOAuth: vi.fn(),
  submitOAuthInput: vi.fn(),
  disconnectOAuth: vi.fn(),
}));
import { startServer } from "../server/index";
import { transcribeAudio } from "../server/providers";
let dataDir: string,
  base: string,
  server: Awaited<ReturnType<typeof startServer>>;
const headers = { "X-Meeting-App": "1", "Content-Type": "application/json" };
async function request(route: string, options?: RequestInit) {
  return fetch(base + route, options);
}
beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "cadence-api-"));
  server = await startServer({ port: 0, dataDir });
  base = `http://127.0.0.1:${server.port}/api`;
  const audio = Buffer.alloc(32044);
  audio.write("RIFF");
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28);
  audio.writeUInt16LE(2, 32);
  audio.writeUInt16LE(16, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(32000, 40);
  await writeFile(path.join(dataDir, "audio", "fixture.wav"), audio);
  await writeFile(
    path.join(dataDir, "meetings", "fixture.json"),
    JSON.stringify({
      id: "fixture",
      title: "Fixture",
      createdAt: new Date().toISOString(),
      duration: 1,
      status: "ready",
      audioFile: "fixture.wav",
      segments: [],
      messages: [],
    }),
  );
});
afterAll(async () => {
  await server.close();
  await rm(dataDir, { recursive: true, force: true });
});
describe("local API workflow", () => {
  it("blocks cross-origin and headerless mutations", async () => {
    expect(
      (
        await request("/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/settings", {
          headers: { Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
  });
  it("streams seekable audio byte ranges", async () => {
    const r = await request("/meetings/fixture/audio", {
      headers: { Range: "bytes=0-43" },
    });
    expect(r.status).toBe(206);
    expect((await r.arrayBuffer()).byteLength).toBe(44);
    expect(r.headers.get("content-range")).toContain("0-43/32044");
  });
  it("runs transcription then summary and preserves actions and chat", async () => {
    const response = await request("/meetings/fixture/transcribe", {
      method: "POST",
      headers,
    });
    expect(response.status).toBe(202);
    let meeting: any;
    for (let attempt = 0; attempt < 50; attempt++) {
      meeting = await (await request("/meetings/fixture")).json();
      if (!["transcribing", "summarizing"].includes(meeting.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(meeting.status).toBe("ready");
    expect(meeting.segments[0].words[0].text).toBe("Maya");
    expect(meeting.insight.actions[0].owner).toBe("Maya");
    const action = await request(
      `/meetings/fixture/actions/${meeting.insight.actions[0].id}`,
      { method: "PATCH", headers, body: '{"done":true}' },
    );
    expect((await action.json()).insight.actions[0].done).toBe(true);
    const chat = await request("/meetings/fixture/chat", {
      method: "POST",
      headers,
      body: '{"message":"Who will send it?"}',
    });
    expect((await chat.json()).citations).toEqual(["seg-0"]);
    expect(
      (await (await request("/meetings/fixture")).json()).messages,
    ).toHaveLength(2);
  });
  it("does not reveal saved API keys", async () => {
    const r = await request("/settings", {
      method: "PUT",
      headers,
      body: '{"apiKeys":{"openai":"private-key"}}',
    });
    const text = await r.text();
    expect(r.status).toBe(200);
    expect(text).not.toContain("private-key");
    expect(text).toContain("openai");
  });
  it("validates input and missing meetings", async () => {
    expect((await request("/meetings/missing")).status).toBe(404);
    expect(
      (
        await request("/meetings/fixture/chat", {
          method: "POST",
          headers,
          body: '{"message":""}',
        })
      ).status,
    ).toBe(400);
  });
});

describe("queued job isolation", () => {
  it("reserves meetings before awaits and freezes provider choices when queued", async () => {
    const fixture = await (await request("/meetings/fixture")).json();
    await writeFile(
      path.join(dataDir, "meetings", "queued.json"),
      JSON.stringify({ ...fixture, id: "queued" }),
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = vi.mocked(transcribeAudio);
    adapter.mockImplementationOnce(async () => {
      await gate;
      return { segments: fixture.segments, duration: 1, timing: "word" };
    });
    const first = await request("/meetings/fixture/transcribe", {
      method: "POST",
      headers,
    });
    expect(first.status).toBe(202);
    expect(
      (
        await request("/meetings/fixture/transcribe", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/meetings/fixture/chat", {
          method: "POST",
          headers,
          body: '{"message":"Hello"}',
        })
      ).status,
    ).toBe(409);
    const queued = await request("/meetings/queued/transcribe", {
      method: "POST",
      headers,
    });
    expect(queued.status).toBe(202);
    await request("/settings", {
      method: "PUT",
      headers,
      body: '{"stt":{"provider":"local","model":"tiny","language":"fr"}}',
    });
    release();
    for (let i = 0; i < 100; i++) {
      const result = await (await request("/meetings/queued")).json();
      if (!["transcribing", "summarizing"].includes(result.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finalSettings = adapter.mock.calls.at(-1)![1];
    expect(finalSettings.stt.model).toBe("base");
    expect(finalSettings.stt.language).toBe("");
  });
  it("allows blank OAuth input so provider adapters can accept default domains", async () => {
    const result = await request("/oauth/session/test/input", {
      method: "POST",
      headers,
      body: '{"text":""}',
    });
    expect(result.status).toBe(200);
  });
});
