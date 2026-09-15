import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("@mariozechner/pi-ai", async (original) => ({
  ...(await original<typeof import("@mariozechner/pi-ai")>()),
  complete: vi.fn(),
}));
import { complete } from "@mariozechner/pi-ai";
import { configureOAuthStorage } from "../server/oauth.js";
import { generateText } from "../server/providers.js";
import {
  clearModelDiscoveryCache,
  discoverProviderModels,
  CODEX_DISCOVERY_VERSION,
} from "../server/model-discovery.js";
import type { Settings } from "../shared/types.js";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
const settings: Settings = {
  stt: { provider: "local", model: "base", language: "" },
  llm: {
    provider: "openai-codex",
    model: "gpt-fixture-new",
    baseUrl: "http://127.0.0.1:1234/v1",
  },
  local: {
    pythonPath: "python3",
    whisperModel: "base",
    ollamaUrl: "http://127.0.0.1:11434",
  },
  configuredKeys: [],
  oauthConnections: [],
};
let saved: Record<string, OAuthCredentials>;
let fetchMock: ReturnType<typeof vi.fn>;
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const token = (account: string) =>
  `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url")}.fixture`;
function connect(account = "account-a") {
  saved["openai-codex"] = {
    access: token(account),
    refresh: "private-refresh",
    expires: Date.now() + 3600_000,
  };
}
const codexRows = {
  models: [
    {
      slug: "gpt-fixture-new",
      visibility: "list",
      priority: 0,
      context_window: 250000,
      supported_reasoning_levels: [{ effort: "high" }],
      supported_in_api: false,
    },
    { slug: "gpt-fixture-other", visibility: "list", priority: 5 },
    { slug: "gpt-hidden", visibility: "hide", priority: -1 },
  ],
};
const key = vi.fn(async () => "fixture-api-key");
beforeEach(() => {
  saved = {};
  clearModelDiscoveryCache();
  key.mockClear();
  configureOAuthStorage({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
    },
  });
  fetchMock = vi.fn(async () => json(codexRows));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(complete).mockReset();
  vi.mocked(complete).mockResolvedValue({
    content: [{ type: "text", text: "Fixture answer" }],
    stopReason: "stop",
  } as any);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("connected model discovery", () => {
  it("returns only normalized capabilities from the authenticated catalog", async () => {
    connect();
    fetchMock.mockResolvedValueOnce(
      json({
        models: [
          {
            slug: "gpt-fixture-capabilities",
            visibility: "list",
            priority: 0,
            input_modalities: ["text", "image"],
            web_search_tool_type: "text",
            private_metadata: "must-not-leak",
            token: "must-not-leak",
          },
        ],
      }),
    );
    const result = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
    );
    expect(result.capabilities?.["gpt-fixture-capabilities"]).toMatchObject({
      outputModalities: null,
      webSearch: "supported",
    });
    expect(Object.keys(result.capabilities || {})).toEqual(result.models);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("replaces capability metadata on refresh instead of preserving old claims", async () => {
    connect();
    const row = {
      slug: "gpt-fixture-capabilities",
      visibility: "list",
      priority: 0,
    };
    fetchMock.mockResolvedValueOnce(
      json({ models: [{ ...row, web_search_tool_type: "text" }] }),
    );
    const first = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
    );
    expect(first.capabilities?.[row.slug].webSearch).toBe("supported");
    fetchMock.mockResolvedValueOnce(json({ models: [row] }));
    const refreshed = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
      { force: true },
    );
    expect(refreshed.capabilities?.[row.slug]).toMatchObject({
      outputModalities: null,
      webSearch: "unknown",
    });
  });

  it("does not attach verified capabilities to bundled suggestions", async () => {
    const result = await discoverProviderModels("local", "stt", settings, key);
    expect(result.source).toBe("bundled");
    expect(result.capabilities).toBeUndefined();
  });

  it("uses the Cadence account token and versioned Codex endpoint, includes subscription models and hides unlisted rows", async () => {
    connect();
    const result = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
    );
    expect(result).toMatchObject({
      source: "account",
      models: ["gpt-fixture-new", "gpt-fixture-other"],
      defaultModel: "gpt-fixture-new",
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_DISCOVERY_VERSION}`,
    );
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token("account-a")}`,
      "chatgpt-account-id": "account-a",
      originator: "pi",
    });
    expect(init.redirect).toBe("error");
    expect(key).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("account-a");
    expect(JSON.stringify(result)).not.toContain("private-refresh");
  });
  it("never substitutes API credentials or bundled models for a missing ChatGPT connection", async () => {
    const result = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
    );
    expect(result.source).toBe("unavailable");
    expect(result.models).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(key).not.toHaveBeenCalled();
  });
  it("caches briefly, refreshes on force and scopes cache to changed account credentials", async () => {
    connect();
    await discoverProviderModels("openai-codex", "llm", settings, key);
    await discoverProviderModels("openai-codex", "llm", settings, key);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await discoverProviderModels("openai-codex", "llm", settings, key, {
      force: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    connect("account-b");
    await discoverProviderModels("openai-codex", "llm", settings, key);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    delete saved["openai-codex"];
    expect(
      (await discoverProviderModels("openai-codex", "llm", settings, key))
        .source,
    ).toBe("unavailable");
  });
  it("expires account model cache after a minute", async () => {
    vi.useFakeTimers();
    connect();
    await discoverProviderModels("openai-codex", "llm", settings, key);
    vi.advanceTimersByTime(60_001);
    await discoverProviderModels("openai-codex", "llm", settings, key);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("does not expose a stale account catalog after a failed refresh or provider error body", async () => {
    connect();
    await discoverProviderModels("openai-codex", "llm", settings, key);
    fetchMock.mockResolvedValueOnce(
      json({ error: "private account data" }, 401),
    );
    const failed = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
      { force: true },
    );
    expect(failed.source).toBe("unavailable");
    expect(failed.models).toEqual([]);
    expect(failed.message).toContain("HTTP 401");
    expect(failed.message).not.toContain("private account data");
  });
  it("accepts a new account model using Codex response protocol and returned context metadata", async () => {
    connect();
    expect(await generateText("system", "question", settings, key)).toBe(
      "Fixture answer",
    );
    expect(vi.mocked(complete).mock.calls[0][0]).toMatchObject({
      id: "gpt-fixture-new",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      contextWindow: 250000,
      reasoning: true,
    });
  });
  it("rejects an obsolete bundled Codex choice rather than silently aliasing it", async () => {
    connect();
    await expect(
      generateText(
        "system",
        "question",
        { ...settings, llm: { ...settings.llm, model: "gpt-5.1" } },
        key,
      ),
    ).rejects.toThrow("no longer listed");
    expect(complete).not.toHaveBeenCalled();
  });
  it("does not accept a model discovered for a previous account", async () => {
    connect();
    await discoverProviderModels("openai-codex", "llm", settings, key);
    connect("account-b");
    fetchMock.mockResolvedValue(json({ models: [] }));
    await expect(
      generateText("system", "question", settings, key),
    ).rejects.toThrow("no longer listed");
    expect(complete).not.toHaveBeenCalled();
  });
  it("returns only installed Ollama models and isolates custom server URLs", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("11434")
        ? json({ models: [{ name: "installed-model:latest" }] })
        : json({
            data: [{ id: url.includes("1234") ? "model-a" : "model-b" }],
          }),
    );
    expect(
      await discoverProviderModels("ollama", "llm", settings, key),
    ).toMatchObject({ source: "local", models: ["installed-model:latest"] });
    expect(
      (await discoverProviderModels("custom", "llm", settings, key)).models,
    ).toEqual(["model-a"]);
    expect(
      (
        await discoverProviderModels(
          "custom",
          "llm",
          {
            ...settings,
            llm: { ...settings.llm, baseUrl: "http://localhost:4321/v1" },
          },
          key,
        )
      ).models,
    ).toEqual(["model-b"]);
  });
  it.each(["openai", "groq", "mistral", "deepseek", "xai"])(
    "queries %s with its own key and filters speech from text",
    async (provider) => {
      fetchMock.mockResolvedValue(
        json({
          data: [
            { id: "gpt-test-chat", capabilities: { completion_chat: true } },
            { id: "whisper-1", capabilities: { audio_transcription: true } },
            { id: "text-embedding-test" },
          ],
        }),
      );
      const result = await discoverProviderModels(
        provider,
        "llm",
        settings,
        key,
      );
      expect(result).toMatchObject({
        source: "account",
        models: ["gpt-test-chat"],
      });
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
        "Bearer fixture-api-key",
      );
    },
  );
  it.each(["openai", "groq", "mistral"])(
    "queries %s speech models separately",
    async (provider) => {
      fetchMock.mockResolvedValue(
        json({
          data: [
            { id: "gpt-test-chat", capabilities: { completion_chat: true } },
            { id: "whisper-1", capabilities: { audio_transcription: true } },
          ],
        }),
      );
      expect(
        (await discoverProviderModels(provider, "stt", settings, key)).models,
      ).toEqual(["whisper-1"]);
    },
  );
  it("paginates Google models and filters by supported content generation", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("pageToken=next")
        ? json({
            models: [
              {
                name: "models/gemini-new-pro",
                supportedGenerationMethods: ["generateContent"],
              },
            ],
          })
        : json({
            models: [
              {
                name: "models/gemini-new-flash",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/gemini-tts",
                supportedGenerationMethods: ["generateContent"],
              },
              {
                name: "models/embed",
                supportedGenerationMethods: ["embedContent"],
              },
            ],
            nextPageToken: "next",
          }),
    );
    expect(
      (await discoverProviderModels("google", "llm", settings, key)).models,
    ).toEqual(["gemini-new-flash", "gemini-new-pro"]);
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe(
      "fixture-api-key",
    );
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it("paginates Anthropic with API version and key headers", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("after_id")
        ? json({ data: [{ id: "claude-new-2" }], has_more: false })
        : json({
            data: [{ id: "claude-new-1" }],
            has_more: true,
            last_id: "claude-new-1",
          }),
    );
    expect(
      (await discoverProviderModels("anthropic", "llm", settings, key)).models,
    ).toEqual(["claude-new-1", "claude-new-2"]);
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "x-api-key": "fixture-api-key",
      "anthropic-version": "2023-06-01",
    });
  });
  it("labels unsupported or disconnected provider lists as bundled suggestions", async () => {
    expect(
      (await discoverProviderModels("deepgram", "stt", settings, key)).source,
    ).toBe("bundled");
    expect(
      (
        await discoverProviderModels(
          "groq",
          "llm",
          settings,
          async () => undefined,
        )
      ).source,
    ).toBe("bundled");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects malformed discovery without leaking response bodies", async () => {
    connect();
    fetchMock.mockResolvedValue(json({ models: "private wrong format" }));
    const result = await discoverProviderModels(
      "openai-codex",
      "llm",
      settings,
      key,
    );
    expect(result.source).toBe("unavailable");
    expect(result.message).not.toContain("private wrong format");
  });
  it("accepts newly discovered API models and rejects invented IDs", async () => {
    fetchMock.mockResolvedValue(json({ data: [{ id: "gpt-fixture-new" }] }));
    const selected = {
      ...settings,
      llm: { ...settings.llm, provider: "openai" },
    };
    await generateText("system", "question", selected, key);
    expect(vi.mocked(complete).mock.calls[0][0].api).toBe("openai-responses");
    await expect(
      generateText(
        "system",
        "question",
        { ...selected, llm: { ...selected.llm, model: "invented-model" } },
        key,
      ),
    ).rejects.toThrow("no longer listed");
  });
  it.each(["llm", "stt"] as const)(
    "uses OpenRouter's authenticated user-filtered %s catalog",
    async (kind) => {
      fetchMock.mockResolvedValue(
        json({
          data: [
            {
              id: "vendor/future-model",
              architecture: {
                output_modalities: [kind === "llm" ? "text" : "transcription"],
              },
              context_length: 100000,
            },
          ],
        }),
      );
      expect(
        (await discoverProviderModels("openrouter", kind, settings, key))
          .models,
      ).toEqual(["vendor/future-model"]);
      expect(fetchMock.mock.calls[0][0]).toBe(
        `https://openrouter.ai/api/v1/models/user?output_modalities=${kind === "llm" ? "text" : "transcription"}`,
      );
      if (kind === "llm") {
        await generateText(
          "system",
          "question",
          {
            ...settings,
            llm: {
              ...settings.llm,
              provider: "openrouter",
              model: "vendor/future-model",
            },
          },
          key,
        );
        expect(vi.mocked(complete).mock.calls[0][0]).toMatchObject({
          api: "openai-completions",
          contextWindow: 100000,
        });
      }
    },
  );
  it.each([
    ["/responses", "openai-responses"],
    ["/v1/messages", "anthropic-messages"],
    ["/chat/completions", "openai-completions"],
  ])(
    "uses the Copilot account endpoint and declared %s protocol",
    async (endpoint, api) => {
      saved["github-copilot"] = {
        access: "fixture;proxy-ep=proxy.business.githubcopilot.com;",
        refresh: "fixture-refresh",
        expires: Date.now() + 3600000,
      };
      fetchMock.mockResolvedValue(
        json({
          data: [
            {
              id: "new-model",
              model_picker_enabled: true,
              supported_endpoints: [endpoint],
              capabilities: {
                type: "chat",
                limits: {
                  max_context_window_tokens: 150000,
                  max_output_tokens: 16000,
                },
              },
            },
            { id: "unusable", capabilities: { type: "embeddings" } },
            {
              id: "unknown-protocol",
              capabilities: { type: "chat" },
              supported_endpoints: ["/not-supported"],
            },
          ],
        }),
      );
      expect(
        (await discoverProviderModels("github-copilot", "llm", settings, key))
          .models,
      ).toEqual(["new-model"]);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.business.githubcopilot.com/models",
      );
      expect(key).not.toHaveBeenCalled();
      await generateText(
        "system",
        "question",
        {
          ...settings,
          llm: {
            ...settings.llm,
            provider: "github-copilot",
            model: "new-model",
          },
        },
        key,
      );
      expect(vi.mocked(complete).mock.calls[0][0]).toMatchObject({
        api,
        baseUrl: "https://api.business.githubcopilot.com",
        contextWindow: 150000,
        maxTokens: 16000,
      });
    },
  );
  it("uses fresh Codex metadata even for an ID present in the bundled catalog", async () => {
    connect();
    fetchMock.mockResolvedValue(
      json({
        models: [
          { slug: "gpt-5.1", visibility: "list", context_window: 100000 },
        ],
      }),
    );
    await generateText(
      "system",
      "question",
      { ...settings, llm: { ...settings.llm, model: "gpt-5.1" } },
      key,
    );
    expect(vi.mocked(complete).mock.calls[0][0].contextWindow).toBe(100000);
  });
});
