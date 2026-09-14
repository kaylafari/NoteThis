import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@mariozechner/pi-ai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mariozechner/pi-ai")>()),
  complete: vi.fn(),
}));
import { complete } from "@mariozechner/pi-ai";
import { configureOAuthStorage } from "../server/oauth.js";
import { generateText, providerCatalog } from "../server/providers.js";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
import type { Settings } from "../shared/types.js";
const settings: Settings = {
  stt: { provider: "local", model: "base", language: "" },
  llm: { provider: "openai", model: "", baseUrl: "" },
  local: {
    pythonPath: "python3",
    whisperModel: "base",
    ollamaUrl: "http://127.0.0.1:11434",
  },
  configuredKeys: [],
  oauthConnections: [],
};
const completeMock = vi.mocked(complete);
let credentials: Record<string, OAuthCredentials>;
beforeEach(() => {
  credentials = {};
  configureOAuthStorage({
    read: async () => structuredClone(credentials),
    write: async (value) => {
      credentials = structuredClone(value);
    },
  });
  completeMock.mockReset();
  completeMock.mockResolvedValue({
    content: [{ type: "text", text: "Fixture answer" }],
    stopReason: "stop",
  } as Awaited<ReturnType<typeof complete>>);
});
const advertised = providerCatalog().llm.filter(
  (p) => !["ollama", "custom"].includes(p.id),
);
describe("every advertised hosted language-model dispatch", () => {
  it.each(advertised)(
    "$id uses its own model and appropriate credential path",
    async (option) => {
      const browserOnly = option.auth === "oauth";
      if (browserOnly)
        credentials[option.id] = {
          access: "fixture-oauth-token",
          refresh: "fixture-refresh",
          expires: Date.now() + 60_000,
        };
      const getKey = vi.fn().mockResolvedValue("  fixture-api-key\n");
      await expect(
        generateText(
          "system",
          "question",
          {
            ...settings,
            llm: { provider: option.id, model: option.models[0], baseUrl: "" },
          },
          getKey,
        ),
      ).resolves.toBe("Fixture answer");
      expect(completeMock.mock.calls[0][0]).toMatchObject({
        provider: option.id,
        id: option.models[0],
      });
      expect(completeMock.mock.calls[0][2]?.apiKey).toBe(
        browserOnly ? "fixture-oauth-token" : "fixture-api-key",
      );
      if (browserOnly) expect(getKey).not.toHaveBeenCalled();
      else expect(getKey).toHaveBeenCalledWith(option.id);
    },
  );
  it("uses Anthropic browser credentials only when no explicit API key is saved", async () => {
    credentials.anthropic = {
      access: "fixture-browser-key",
      refresh: "fixture-refresh",
      expires: Date.now() + 60_000,
    };
    const option = advertised.find((p) => p.id === "anthropic")!;
    await generateText(
      "system",
      "question",
      {
        ...settings,
        llm: { provider: option.id, model: option.models[0], baseUrl: "" },
      },
      async () => undefined,
    );
    expect(completeMock.mock.calls[0][2]?.apiKey).toBe("fixture-browser-key");
  });
  it("uses the authenticated Copilot proxy endpoint from its own token", async () => {
    credentials["github-copilot"] = {
      access: "fixture;proxy-ep=proxy.business.githubcopilot.com;",
      refresh: "fixture-refresh",
      expires: Date.now() + 60_000,
    };
    const option = advertised.find((p) => p.id === "github-copilot")!;
    await generateText(
      "system",
      "question",
      {
        ...settings,
        llm: { provider: option.id, model: option.models[0], baseUrl: "" },
      },
      async () => "wrong-api-key",
    );
    expect(completeMock.mock.calls[0][0].baseUrl).toBe(
      "https://api.business.githubcopilot.com",
    );
  });
  it.each(["openai-codex", "github-copilot"])(
    "%s does not substitute an API key for a missing browser login",
    async (provider) => {
      const option = advertised.find((p) => p.id === provider)!;
      await expect(
        generateText(
          "system",
          "question",
          {
            ...settings,
            llm: { provider, model: option.models[0], baseUrl: "" },
          },
          async () => "unrelated-api-key",
        ),
      ).rejects.toThrow(`Connect ${provider}`);
      expect(completeMock).not.toHaveBeenCalled();
    },
  );
  it("validates model selection before accessing credentials", async () => {
    const getKey = vi.fn();
    await expect(
      generateText(
        "system",
        "question",
        {
          ...settings,
          llm: {
            provider: "openai",
            model: "not-a-catalog-model",
            baseUrl: "",
          },
        },
        getKey,
      ),
    ).rejects.toThrow("not in the installed catalog");
    expect(getKey).not.toHaveBeenCalled();
  });
  it("uses custom local servers without borrowing other providers' tokens", async () => {
    await generateText(
      "system",
      "question",
      {
        ...settings,
        llm: {
          provider: "custom",
          model: "local-model",
          baseUrl: "http://127.0.0.1:1234/v1",
        },
      },
      async () => undefined,
    );
    expect(completeMock.mock.calls[0][0]).toMatchObject({
      provider: "custom",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(completeMock.mock.calls[0][2]?.apiKey).toBe("local-no-key");
  });
  it("sanitizes SDK failures and empty completions", async () => {
    const option = advertised.find((p) => p.id === "openai")!;
    completeMock.mockRejectedValue(
      new Error("fixture-api-key private-account-info"),
    );
    await expect(
      generateText(
        "system",
        "question",
        {
          ...settings,
          llm: { provider: option.id, model: option.models[0], baseUrl: "" },
        },
        async () => "fixture-api-key",
      ),
    ).rejects.toThrow("could not generate an answer");
  });
});
