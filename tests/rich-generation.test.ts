import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../server/oauth.js", () => ({ getOAuthApiKey: vi.fn() }));
vi.mock("../server/model-discovery.js", () => ({
  resolveDiscoveredModel: vi.fn(),
  discoverProviderModels: vi.fn(),
}));
import { getOAuthApiKey } from "../server/oauth.js";
import {
  discoverProviderModels,
  resolveDiscoveredModel,
} from "../server/model-discovery.js";
import {
  generateWebAnswer,
  generateSummaryImage,
  supportsWebSearch,
  supportsImageOutput,
} from "../server/rich-generation.js";
import type { Settings } from "../shared/types.js";
const settings: Settings = {
  llm: {
    provider: "openai-codex",
    model: "fixture-new-model",
    baseUrl: "https://untrusted.example/v1",
    webSearch: true,
    webSearchConsentProvider: "openai-codex",
    summaryDiagrams: true,
    summaryDiagramsConsentProvider: "openai-codex",
  },
  stt: { provider: "local", model: "base", language: "" },
  local: { pythonPath: "", whisperModel: "base", ollamaUrl: "" },
  configuredKeys: [],
  oauthConnections: [],
};
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status });
const selected = (provider: string): Settings => ({
  ...settings,
  llm: {
    ...settings.llm,
    provider,
    webSearchConsentProvider: provider,
    summaryDiagramsConsentProvider: provider,
  },
});
const result = (
  text = "Answer",
  annotations: unknown[] = [],
  search = false,
) => ({
  type: "response.completed",
  response: {
    status: "completed",
    output: [
      ...(search ? [{ type: "web_search_call", status: "completed" }] : []),
      {
        type: "message",
        content: [{ type: "output_text", text, annotations }],
      },
    ],
  },
});
const annotation = (url = "https://example.com/page", title = "Source") => ({
  type: "url_citation",
  url,
  title,
});
const sse = (events: unknown[], slice = 4096) => {
  const bytes = new TextEncoder().encode(
    events.map((e) => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""),
  );
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += slice)
          controller.enqueue(bytes.slice(i, i + slice));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
};
let fetchMock: ReturnType<typeof vi.fn>;
const getKey = vi.fn(async () => " fixture-api-key ");
beforeEach(() => {
  vi.mocked(getOAuthApiKey).mockReset();
  vi.mocked(getOAuthApiKey).mockResolvedValue(token);
  vi.mocked(resolveDiscoveredModel).mockReset();
  vi.mocked(resolveDiscoveredModel).mockResolvedValue({
    id: "fixture-new-model",
  } as any);
  vi.mocked(discoverProviderModels).mockReset();
  vi.mocked(discoverProviderModels).mockResolvedValue({
    provider: "openrouter",
    kind: "llm",
    models: ["fixture-new-model"],
    source: "account",
    message: "fixture",
    capabilities: {
      "fixture-new-model": {
        outputModalities: ["text", "image"],
        webSearch: "supported",
      },
    },
  });
  fetchMock = vi.fn(async () => sse([result("Answer", [annotation()], true)]));
  vi.stubGlobal("fetch", fetchMock);
  getKey.mockClear();
});
afterEach(() => vi.unstubAllGlobals());
describe("provider feature adapters", () => {
  it("advertises only implemented provider integrations", () => {
    for (const provider of ["openai-codex", "openai", "openrouter"])
      expect(supportsWebSearch(provider)).toBe(true);
    expect(supportsImageOutput("openrouter")).toBe(true);
    for (const provider of [
      "custom",
      "ollama",
      "anthropic",
      "github-copilot",
    ]) {
      expect(supportsWebSearch(provider)).toBe(false);
      expect(supportsImageOutput(provider)).toBe(false);
    }
  });
  it("uses only the saved Codex OAuth token and fixed trusted endpoint for live web search", async () => {
    expect(
      await generateWebAnswer("System", "Question", settings, getKey),
    ).toEqual({
      text: "Answer",
      webSources: [{ title: "Source", url: "https://example.com/page" }],
      webSearchUsed: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${token}`,
      "chatgpt-account-id": "fixture-account",
      originator: "pi",
    });
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "fixture-new-model",
      store: false,
      stream: true,
      instructions: "System",
      tools: [{ type: "web_search", external_web_access: true }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Question" }] },
      ],
    });
    expect(JSON.parse(init.body)).not.toHaveProperty("max_output_tokens");
    expect(getKey).not.toHaveBeenCalled();
    expect(resolveDiscoveredModel).toHaveBeenCalledWith(
      "openai-codex",
      "fixture-new-model",
      settings,
      expect.any(Function),
      { key: token, oauth: true },
    );
  });
  it("uses the OpenAI Responses web tool with the provider API key", async () => {
    await generateWebAnswer("System", "Question", selected("openai"), getKey);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers.Authorization).toBe("Bearer fixture-api-key");
    expect(JSON.parse(init.body).max_output_tokens).toBe(4096);
    expect(getOAuthApiKey).not.toHaveBeenCalled();
  });
  it("parses split UTF-8, CRLF SSE boundaries, output deltas, and annotation events", async () => {
    fetchMock.mockResolvedValue(
      sse(
        [
          { type: "response.output_text.delta", delta: "Café ☕" },
          {
            type: "response.output_text.annotation.added",
            annotation: annotation(),
          },
          { type: "response.web_search_call.completed" },
          {
            type: "response.done",
            response: { status: "completed", output: [] },
          },
        ],
        1,
      ),
    );
    expect(await generateWebAnswer("s", "p", settings, getKey)).toMatchObject({
      text: "Café ☕",
      webSearchUsed: true,
      webSources: [{ url: "https://example.com/page", title: "Source" }],
    });
  });
  it("does not claim search was used just because its tool was enabled", async () => {
    fetchMock.mockResolvedValue(sse([result("General answer", [], false)]));
    expect(await generateWebAnswer("s", "p", settings, getKey)).toMatchObject({
      webSearchUsed: false,
      webSources: [],
    });
  });
  it("counts a completed web search even when no URL citation was returned", async () => {
    fetchMock.mockResolvedValue(sse([result("Searched", [], true)]));
    expect(await generateWebAnswer("s", "p", settings, getKey)).toMatchObject({
      webSearchUsed: true,
      webSources: [],
    });
  });
  it("uses only safe provider citation annotations and deduplicates URLs", async () => {
    fetchMock.mockResolvedValue(
      sse([
        result(
          "https://invented.example is not an annotation",
          [
            annotation(),
            annotation(),
            annotation("javascript:alert(1)"),
            annotation("file:///secret"),
            annotation("https://user:pass@example.com"),
            annotation("https://example.com/\n"),
            { type: "made-up", url: "https://invalid.example" },
          ],
          true,
        ),
      ]),
    );
    expect(
      (await generateWebAnswer("s", "p", settings, getKey)).webSources,
    ).toEqual([{ title: "Source", url: "https://example.com/page" }]);
  });
  it.each(["response.failed", "response.incomplete", "error"])(
    "rejects %s SSE events without exposing provider details",
    async (type) => {
      fetchMock.mockResolvedValue(
        sse([{ type, error: { message: "fixture-secret" } }]),
      );
      await expect(
        generateWebAnswer("s", "p", settings, getKey),
      ).rejects.toThrow("invalid or incomplete");
    },
  );
  it("rejects truncated SSE even if text was produced", async () => {
    fetchMock.mockResolvedValue(
      sse([{ type: "response.output_text.delta", delta: "Partial answer" }]),
    );
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "incomplete",
    );
  });
  it("rejects malformed SSE JSON", async () => {
    fetchMock.mockResolvedValue(new Response("data: {private-malformed}\n\n"));
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "invalid",
    );
  });
  it("bounds response bytes as they arrive and cancels the stream", async () => {
    const cancel = vi.fn();
    fetchMock.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
    );
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "exceeded",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([401, 403, 429, 500])("sanitizes HTTP %i errors", async (status) => {
    fetchMock.mockResolvedValue(
      json({ error: { message: "private-token" } }, status),
    );
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      `HTTP ${status}`,
    );
  });
  it("sanitizes network exceptions", async () => {
    fetchMock.mockRejectedValue(new Error("fixture-secret failed URL"));
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "could not be reached",
    );
  });
  it("does not substitute API credentials for a disconnected Codex account", async () => {
    vi.mocked(getOAuthApiKey).mockResolvedValue(undefined);
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "Connect",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getKey).not.toHaveBeenCalled();
  });
  it("rejects unsupported providers and removed account models before sending content", async () => {
    await expect(
      generateWebAnswer("s", "p", selected("custom"), getKey),
    ).rejects.toThrow("not implemented");
    expect(getKey).not.toHaveBeenCalled();
    vi.mocked(resolveDiscoveredModel).mockRejectedValue(
      new Error("no longer listed"),
    );
    await expect(generateWebAnswer("s", "p", settings, getKey)).rejects.toThrow(
      "no longer listed",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("enables the OpenRouter web plugin and parses nested native URL annotations", async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "Web answer",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: {
                    url: "https://example.com",
                    title: "Example",
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    expect(
      await generateWebAnswer("s", "p", selected("openrouter"), getKey),
    ).toEqual({
      text: "Web answer",
      webSources: [{ url: "https://example.com/", title: "Example" }],
      webSearchUsed: true,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body)).toMatchObject({
      stream: false,
      plugins: [{ id: "web", max_results: 5 }],
      messages: [
        { role: "system", content: "s" },
        { role: "user", content: "p" },
      ],
    });
  });
  it("does not report OpenRouter search as used without citation evidence", async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: { content: "Answer", annotations: [] },
          },
        ],
      }),
    );
    expect(
      (await generateWebAnswer("s", "p", selected("openrouter"), getKey))
        .webSearchUsed,
    ).toBe(false);
  });
  it.each(["length", "content_filter", "tool_calls"])(
    "rejects incomplete OpenRouter finish %s",
    async (finish_reason) => {
      fetchMock.mockResolvedValue(
        json({ choices: [{ finish_reason, message: { content: "Partial" } }] }),
      );
      await expect(
        generateWebAnswer("s", "p", selected("openrouter"), getKey),
      ).rejects.toThrow("incomplete");
    },
  );
});
describe("inline summary image generation", () => {
  beforeEach(() =>
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              images: [{ image_url: { url: `data:image/png;base64,${png}` } }],
            },
          },
        ],
      }),
    ),
  );
  it("requests explicitly advertised image output and validates a bounded PNG", async () => {
    expect(
      await generateSummaryImage(
        "Draw a diagram",
        selected("openrouter"),
        getKey,
      ),
    ).toEqual({
      dataUrl: `data:image/png;base64,${png}`,
      mimeType: "image/png",
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      model: "fixture-new-model",
      modalities: ["image", "text"],
      messages: [{ role: "user", content: "Draw a diagram" }],
    });
  });
  it("requires live account image metadata and never infers it from the model name", async () => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      provider: "openrouter",
      kind: "llm",
      models: ["fixture-new-model"],
      source: "account",
      message: "fixture",
      capabilities: {
        "fixture-new-model": {
          outputModalities: ["text"],
          webSearch: "unknown",
        },
      },
    });
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("does not currently report image");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    "https://untrusted.example/image.png",
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:text/html;base64,PHNjcmlwdC8+",
  ])(
    "rejects unsafe image location or type %s without fetching it",
    async (url) => {
      fetchMock.mockResolvedValue(
        json({
          choices: [
            {
              finish_reason: "stop",
              message: { images: [{ image_url: { url } }] },
            },
          ],
        }),
      );
      await expect(
        generateSummaryImage("draw", selected("openrouter"), getKey),
      ).rejects.toThrow("inline data");
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );
  it("rejects image bytes that do not match the claimed MIME type", async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            message: {
              images: [{ image_url: { url: `data:image/jpeg;base64,${png}` } }],
            },
          },
        ],
      }),
    );
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("invalid or oversized");
  });
  it("rejects excessive raster dimensions", async () => {
    const data = Buffer.from(png, "base64");
    data.writeUInt32BE(100000, 16);
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            message: {
              images: [
                {
                  image_url: {
                    url: `data:image/png;base64,${data.toString("base64")}`,
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("oversized");
  });
  it("rejects missing images and provider error envelopes", async () => {
    fetchMock
      .mockResolvedValueOnce(
        json({ choices: [{ message: { content: "No image" } }] }),
      )
      .mockResolvedValueOnce(json({ error: { message: "private details" } }));
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("missing");
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("invalid");
  });
  it("rejects oversized response headers without allocating image data", async () => {
    fetchMock.mockResolvedValue(
      new Response("", {
        headers: { "content-length": String(13 * 1024 * 1024) },
      }),
    );
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("exceeded");
  });
  it("rejects providers with no image adapter before consulting credentials", async () => {
    await expect(
      generateSummaryImage("draw", settings, getKey),
    ).rejects.toThrow("not implemented");
    expect(getOAuthApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("raster response bounds", () => {
  it("accepts a real tiny JPEG fixture with matching MIME and dimensions", async () => {
    const jpeg =
      "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAHAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAAgACAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8Av4AP/9k=";
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              images: [
                { image_url: { url: `data:image/jpeg;base64,${jpeg}` } },
              ],
            },
          },
        ],
      }),
    );
    expect(
      await generateSummaryImage("draw", selected("openrouter"), getKey),
    ).toEqual({
      dataUrl: `data:image/jpeg;base64,${jpeg}`,
      mimeType: "image/jpeg",
    });
  });
  it("rejects decoded images larger than the 8 MiB storage bound", async () => {
    const tooLarge = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              images: [
                { image_url: { url: `data:image/png;base64,${tooLarge}` } },
              ],
            },
          },
        ],
      }),
    );
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("invalid image data");
  });
  it("rejects noncanonical base64 encoding before checking raster signatures", async () => {
    fetchMock.mockResolvedValue(
      json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              images: [{ image_url: { url: "data:image/webp;base64,AAAAA" } }],
            },
          },
        ],
      }),
    );
    await expect(
      generateSummaryImage("draw", selected("openrouter"), getKey),
    ).rejects.toThrow("invalid image data");
  });
});

describe("provider-specific runtime consent", () => {
  it.each([
    { webSearch: false, webSearchConsentProvider: "openai-codex" },
    { webSearch: true, webSearchConsentProvider: undefined },
    { webSearch: true, webSearchConsentProvider: "openrouter" },
    { webSearch: undefined, webSearchConsentProvider: undefined },
  ])(
    "blocks web discovery, credentials and generation before consent: %j",
    async (flags) => {
      await expect(
        generateWebAnswer(
          "private system",
          "private question",
          { ...settings, llm: { ...settings.llm, ...flags } },
          getKey,
        ),
      ).rejects.toThrow("confirm sharing");
      expect(getKey).not.toHaveBeenCalled();
      expect(getOAuthApiKey).not.toHaveBeenCalled();
      expect(resolveDiscoveredModel).not.toHaveBeenCalled();
      expect(discoverProviderModels).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each([
    { summaryDiagrams: false, summaryDiagramsConsentProvider: "openrouter" },
    { summaryDiagrams: true, summaryDiagramsConsentProvider: undefined },
    { summaryDiagrams: true, summaryDiagramsConsentProvider: "openai-codex" },
    { summaryDiagrams: undefined, summaryDiagramsConsentProvider: undefined },
  ])(
    "blocks image discovery, credentials and generation before consent: %j",
    async (flags) => {
      const config = selected("openrouter");
      await expect(
        generateSummaryImage(
          "private diagram prompt",
          { ...config, llm: { ...config.llm, ...flags } },
          getKey,
        ),
      ).rejects.toThrow("confirm sharing");
      expect(getKey).not.toHaveBeenCalled();
      expect(getOAuthApiKey).not.toHaveBeenCalled();
      expect(resolveDiscoveredModel).not.toHaveBeenCalled();
      expect(discoverProviderModels).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("web-search capability enforcement", () => {
  it.each(["unknown", "unsupported"] as const)(
    "rejects %s model web capability before POST",
    async (webSearch) => {
      vi.mocked(discoverProviderModels).mockResolvedValue({
        provider: "openai-codex",
        kind: "llm",
        models: ["fixture-new-model"],
        source: "account",
        message: "fixture",
        capabilities: {
          "fixture-new-model": { outputModalities: null, webSearch },
        },
      });
      await expect(
        generateWebAnswer("system", "question", settings, getKey),
      ).rejects.toThrow("does not currently report web-search support");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it.each(["bundled", "unavailable"] as const)(
    "rejects %s discovery even with a positive capability",
    async (source) => {
      vi.mocked(discoverProviderModels).mockResolvedValue({
        provider: "openai-codex",
        kind: "llm",
        models: ["fixture-new-model"],
        source,
        message: "fixture",
        capabilities: {
          "fixture-new-model": {
            outputModalities: null,
            webSearch: "supported",
          },
        },
      });
      await expect(
        generateWebAnswer("system", "question", settings, getKey),
      ).rejects.toThrow("does not currently report web-search support");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
  it("rejects a removed selected model despite a stale positive capability record", async () => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      provider: "openai-codex",
      kind: "llm",
      models: [],
      source: "account",
      message: "fixture",
      capabilities: {
        "fixture-new-model": { outputModalities: null, webSearch: "supported" },
      },
    });
    await expect(
      generateWebAnswer("system", "question", settings, getKey),
    ).rejects.toThrow("does not currently report web-search support");
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects missing capability metadata before POST", async () => {
    vi.mocked(discoverProviderModels).mockResolvedValue({
      provider: "openai-codex",
      kind: "llm",
      models: ["fixture-new-model"],
      source: "account",
      message: "fixture",
    });
    await expect(
      generateWebAnswer("system", "question", settings, getKey),
    ).rejects.toThrow("does not currently report web-search support");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
