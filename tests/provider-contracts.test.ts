import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { providerCatalog, transcribeCloudChunk } from "../server/providers.js";
import type { Settings } from "../shared/types.js";
const settings: Settings = {
  stt: { provider: "openai", model: "whisper-1", language: "" },
  llm: { provider: "ollama", model: "qwen3:0.6b", baseUrl: "" },
  local: {
    pythonPath: "python3",
    whisperModel: "base",
    ollamaUrl: "http://127.0.0.1:11434",
  },
  configuredKeys: [],
  oauthConnections: [],
};
const endpoints: Record<string, string> = {
  openai: "https://api.openai.com/v1/audio/transcriptions",
  groq: "https://api.groq.com/openai/v1/audio/transcriptions",
  deepgram: "https://api.deepgram.com/v1/listen",
  elevenlabs: "https://api.elevenlabs.io/v1/speech-to-text",
  mistral: "https://api.mistral.ai/v1/audio/transcriptions",
  deepinfra: "https://api.deepinfra.com/v1/openai/audio/transcriptions",
  openrouter: "https://openrouter.ai/api/v1/audio/transcriptions",
  senseaudio: "https://api.senseaudio.cn/v1/audio/transcriptions",
  xai: "https://api.x.ai/v1/stt",
};
const variants = providerCatalog()
  .stt.filter((p) => p.id !== "local")
  .flatMap((p) => p.models.map((model) => ({ provider: p.id, model })));
const response = (provider: string, model: string): unknown => {
  if (provider === "google")
    return {
      candidates: [
        { finishReason: "STOP", content: { parts: [{ text: "Hello team." }] } },
      ],
    };
  if (provider === "deepgram")
    return {
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "Hello team.",
                words: [
                  {
                    word: "hello",
                    punctuated_word: "Hello",
                    start: 0.5,
                    end: 1,
                    speaker: 0,
                  },
                  {
                    word: "team",
                    punctuated_word: "team.",
                    start: 1,
                    end: 1.5,
                    speaker: 0,
                  },
                ],
              },
            ],
          },
        ],
      },
    };
  if (provider === "elevenlabs")
    return {
      text: "Hello team.",
      words: [
        {
          text: "Hello",
          start: 0.5,
          end: 1,
          type: "word",
          speaker_id: "speaker_0",
        },
        { text: " ", start: 1, end: 1, type: "spacing" },
        {
          text: "team.",
          start: 1,
          end: 1.5,
          type: "word",
          speaker_id: "speaker_0",
        },
      ],
    };
  if (provider === "mistral" || model.includes("diarize"))
    return {
      text: "Hello team.",
      segments: [{ start: 0.5, end: 1.5, text: "Hello team.", speaker: "A" }],
    };
  if (
    ["deepinfra", "senseaudio", "openrouter"].includes(provider) ||
    (provider === "openai" && model !== "whisper-1")
  )
    return { text: "Hello team." };
  return {
    text: "Hello team.",
    words: [
      { text: "Hello", word: "Hello", start: 0.5, end: 1 },
      { text: "team.", word: "team.", start: 1, end: 1.5 },
    ],
  };
};
describe("every advertised cloud speech model contract", () => {
  let directory: string;
  let audio: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "cadence-contract-"));
    audio = path.join(directory, "test.wav");
    await writeFile(audio, Buffer.from("RIFF"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  });
  it.each(variants)(
    "$provider / $model authenticates and interprets its native format",
    async ({ provider, model }) => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify(response(provider, model))),
      );
      const result = await transcribeCloudChunk(
        audio,
        3,
        { ...settings, stt: { provider, model, language: "" } },
        "  fixture-key\n",
      );
      expect(result.segments.map((s) => s.text).join(" ")).toBe("Hello team.");
      const [url, request] = fetchMock.mock.calls[0];
      const headers = new Headers(request.headers);
      const address = new URL(url);
      expect(request.redirect).toBe("error");
      expect(request.signal).toBeInstanceOf(AbortSignal);
      if (provider === "google") {
        expect(address.origin).toBe(
          "https://generativelanguage.googleapis.com",
        );
        expect(address.pathname).toBe(
          `/v1beta/models/${model}:generateContent`,
        );
        expect(headers.get("x-goog-api-key")).toBe("fixture-key");
        expect(headers.has("Authorization")).toBe(false);
        const body = JSON.parse(request.body);
        expect(body.contents[0].parts[1].inline_data).toEqual({
          mime_type: "audio/wav",
          data: "UklGRg==",
        });
        expect(result.timing).toBe("estimated");
        return;
      }
      expect(address.origin + address.pathname).toBe(endpoints[provider]);
      if (provider === "deepgram") {
        expect(headers.get("Authorization")).toBe("Token fixture-key");
        expect(address.searchParams.get("detect_language")).toBe("true");
        expect(address.searchParams.has("language")).toBe(false);
        expect(address.searchParams.get("model")).toBe(model);
        expect(Buffer.from(request.body).toString()).toBe("RIFF");
        expect(result.timing).toBe("word");
        return;
      }
      if (provider === "openrouter") {
        expect(headers.get("Authorization")).toBe("Bearer fixture-key");
        expect(JSON.parse(request.body)).toMatchObject({
          model,
          input_audio: { data: "UklGRg==", format: "wav" },
        });
        expect(result.timing).toBe("estimated");
        return;
      }
      const form = request.body as FormData;
      expect(form.get("file")).toBeInstanceOf(Blob);
      expect((form.get("file") as Blob).type).toBe("audio/wav");
      expect([...form.keys()].at(-1)).toBe("file");
      if (provider === "elevenlabs") {
        expect(headers.get("xi-api-key")).toBe("fixture-key");
        expect(headers.has("Authorization")).toBe(false);
        expect(form.get("model_id")).toBe(model);
        expect(form.get("timestamps_granularity")).toBe("word");
        expect(result.timing).toBe("word");
        return;
      }
      expect(headers.get("Authorization")).toBe("Bearer fixture-key");
      if (provider === "xai") {
        expect(form.has("model")).toBe(false);
        expect(form.get("diarize")).toBe("true");
        expect(result.timing).toBe("word");
        return;
      }
      expect(form.get("model")).toBe(model);
      if (provider === "groq" || model === "whisper-1") {
        expect(form.get("response_format")).toBe("verbose_json");
        expect(form.getAll("timestamp_granularities[]")).toEqual([
          "word",
          "segment",
        ]);
        expect(result.timing).toBe("word");
      } else if (model.includes("diarize")) {
        expect(form.get("response_format")).toBe("diarized_json");
        expect(form.get("chunking_strategy")).toBe("auto");
        expect(result.timing).toBe("segment");
      } else if (provider === "mistral") {
        expect(form.get("timestamp_granularities")).toBe("segment");
        expect(form.has("language")).toBe(false);
        expect(result.timing).toBe("segment");
      } else {
        expect(form.get("response_format")).toBe("json");
        expect(result.timing).toBe("estimated");
      }
    },
  );
  it("does not accept a partial Gemini transcript as a completed call", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "MAX_TOKENS",
              content: { parts: [{ text: "Only the beginning" }] },
            },
          ],
        }),
      ),
    );
    await expect(
      transcribeCloudChunk(
        audio,
        3,
        {
          ...settings,
          stt: { provider: "google", model: "gemini-2.5-flash", language: "" },
        },
        "key",
      ),
    ).rejects.toThrow("before completing");
  });
  it("excludes Gemini thought parts from the transcript", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  { thought: true, text: "Internal analysis" },
                  { text: "Hello team." },
                ],
              },
            },
          ],
        }),
      ),
    );
    const result = await transcribeCloudChunk(
      audio,
      3,
      {
        ...settings,
        stt: { provider: "google", model: "gemini-2.5-flash", language: "" },
      },
      "key",
    );
    expect(result.segments[0].text).toBe("Hello team.");
  });
  it.each([401, 403, 413, 429, 500])(
    "sanitizes HTTP %i errors",
    async (status) => {
      fetchMock.mockResolvedValue(
        new Response("fixture-key private-account-info", { status }),
      );
      await expect(
        transcribeCloudChunk(audio, 3, settings, "fixture-key"),
      ).rejects.toThrow(`HTTP ${status}`);
    },
  );
  it.each(["null", "[]", '"plain string"', "{broken"])(
    "rejects malformed success response %s",
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      await expect(
        transcribeCloudChunk(audio, 3, settings, "key"),
      ).rejects.toThrow("invalid JSON");
    },
  );
  it("handles provider error envelopes without exposing their contents", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: "fixture-key private-account-info" },
        }),
      ),
    );
    await expect(
      transcribeCloudChunk(audio, 3, settings, "key"),
    ).rejects.toThrow("reported a request error");
  });
  it("rejects blank API keys before making a request", async () => {
    await expect(
      transcribeCloudChunk(audio, 3, settings, " \n"),
    ).rejects.toThrow("Add an API key");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
