import { describe, expect, it } from "vitest";
import { discoverModelCapabilities } from "../server/model-capabilities.js";

describe("provider-reported model capabilities", () => {
  it("keeps Codex input and hosted web-search result modalities separate from model outputs", () => {
    expect(
      discoverModelCapabilities("openai-codex", {
        slug: "arbitrary-future-model",
        input_modalities: ["text", "image", "audio"],
        web_search_tool_type: "text_and_image",
        supports_search_tool: false,
      }),
    ).toMatchObject({ outputModalities: null, webSearch: "supported" });
  });
  it.each(["text", "text_and_image"])(
    "recognizes explicit Codex %s web tool metadata",
    (value) => {
      expect(
        discoverModelCapabilities("openai-codex", {
          web_search_tool_type: value,
        }).webSearch,
      ).toBe("supported");
    },
  );
  it.each([
    {},
    { supports_search_tool: true },
    { experimental_supported_tools: ["tools", "search"] },
    { web_search_tool_type: null },
    { web_search_tool_type: "disabled" },
    { web_search_tool_type: {} },
    { web_search_tool_type: ["text"] },
  ])(
    "leaves unreported or unrecognized Codex web metadata unknown: %j",
    (row) => {
      expect(discoverModelCapabilities("openai-codex", row).webSearch).toBe(
        "unknown",
      );
    },
  );
  it("reads OpenRouter output architecture without borrowing input modalities", () => {
    expect(
      discoverModelCapabilities("openrouter", {
        architecture: {
          input_modalities: ["text", "image"],
          output_modalities: ["text", "audio"],
        },
        supported_parameters: ["web_search_options"],
      }),
    ).toMatchObject({
      outputModalities: ["text", "audio"],
      webSearch: "supported",
    });
  });
  it("does not count OpenRouter tool calling as model-level web search", () => {
    const result = discoverModelCapabilities("openrouter", {
      architecture: { output_modalities: ["text"] },
      supported_parameters: ["tools", "tool_choice", "parallel_tool_calls"],
    });
    expect(result.webSearch).toBe("unknown");
    expect(result.webSearchNote).toMatch(
      /separate web plugin.*does not enable/,
    );
  });
  it("does not infer OpenRouter web support from a model name, description, or zero search price", () => {
    expect(
      discoverModelCapabilities("openrouter", {
        id: "model:online",
        description: "search engine",
        pricing: { web_search: "0" },
      }).webSearch,
    ).toBe("unknown");
  });
  it("does not combine OpenRouter top-level or input fields with its explicit architecture", () => {
    expect(
      discoverModelCapabilities("openrouter", {
        output_modalities: ["image"],
        architecture: { input_modalities: ["image"] },
      }).outputModalities,
    ).toBeNull();
  });
  it("leaves Copilot chat, vision, tool calls and protocol metadata unclassified", () => {
    expect(
      discoverModelCapabilities("github-copilot", {
        capabilities: {
          type: "chat",
          supports: { vision: true, tool_calls: true, thinking: true },
        },
        supported_endpoints: ["/responses"],
      }),
    ).toEqual({ outputModalities: null, webSearch: "unknown" });
  });
  it("does not mistake Claude citations, image inputs or structured outputs for modalities/search", () => {
    expect(
      discoverModelCapabilities("anthropic", {
        capabilities: {
          citations: { supported: true },
          image_input: { supported: true },
          structured_outputs: { supported: true },
        },
      }),
    ).toEqual({ outputModalities: null, webSearch: "unknown" });
  });
  it("does not derive Google output or grounding from generation methods or limits", () => {
    expect(
      discoverModelCapabilities("google", {
        supportedGenerationMethods: ["generateContent"],
        outputTokenLimit: 32768,
        thinking: true,
      }),
    ).toEqual({ outputModalities: null, webSearch: "unknown" });
  });
  it.each(["openai", "groq", "mistral", "xai", "deepseek", "ollama", "custom"])(
    "preserves unknown for sparse %s metadata",
    (provider) => {
      expect(
        discoverModelCapabilities(provider, {
          id: "audio-image-search-model",
          capabilities: { completion_chat: true, vision: true, tools: true },
        }),
      ).toEqual({ outputModalities: null, webSearch: "unknown" });
    },
  );
  it("preserves explicit output modality extensions with normalization and no mutation", () => {
    const row = {
      output_modalities: [" TEXT ", "audio", "text", "future_format"],
    };
    expect(discoverModelCapabilities("custom", row).outputModalities).toEqual([
      "text",
      "audio",
      "future_format",
    ]);
    expect(row.output_modalities).toEqual([
      " TEXT ",
      "audio",
      "text",
      "future_format",
    ]);
  });
  it.each([
    undefined,
    null,
    [],
    "text",
    {},
    ["text", null],
    ["text", 3],
    ["text", {}],
    [""],
    ["<script>"],
    Array(33).fill("text"),
  ])("leaves malformed/missing output modalities unknown: %j", (value) => {
    expect(
      discoverModelCapabilities("custom", { output_modalities: value })
        .outputModalities,
    ).toBeNull();
  });
  it.each([true, false])(
    "honors explicit boolean web-search capability %s",
    (supported) => {
      const expected = supported ? "supported" : "unsupported";
      expect(
        discoverModelCapabilities("custom", { supports_web_search: supported })
          .webSearch,
      ).toBe(expected);
      expect(
        discoverModelCapabilities("custom", {
          capabilities: { web_search: { supported } },
        }).webSearch,
      ).toBe(expected);
    },
  );
  it.each([null, "false", 0, {}, []])(
    "does not coerce a malformed web flag %j to unsupported",
    (supported) => {
      expect(
        discoverModelCapabilities("custom", {
          supports_web_search: supported,
          capabilities: { web_search: { supported } },
        }).webSearch,
      ).toBe("unknown");
    },
  );
  it("treats contradictory explicit flags as unknown", () => {
    expect(
      discoverModelCapabilities("custom", {
        supports_web_search: false,
        capabilities: { web_search: { supported: true } },
      }),
    ).toMatchObject({
      webSearch: "unknown",
      webSearchNote: expect.stringContaining("conflicting"),
    });
  });
  it("never changes application feature enablement or returns provider configuration", () => {
    const row = {
      supports_web_search: true,
      enabled: true,
      apiKey: "private",
      plugins: [{ id: "web" }],
    };
    const result = discoverModelCapabilities("custom", row);
    expect(result.webSearchNote).toContain("does not enable");
    expect(result).not.toHaveProperty("enabled");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(row.enabled).toBe(true);
  });
});
