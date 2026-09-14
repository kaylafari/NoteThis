import { afterEach, it, expect, vi } from "vitest";
import { complete } from "@mariozechner/pi-ai";
import {
  clearModelDiscoveryCache,
  resolveDiscoveredModel,
} from "../server/model-discovery.js";
import type { Settings } from "../shared/types.js";
afterEach(() => vi.unstubAllGlobals());
it("sends a discovered ID through the actual pi-ai Codex adapter and parses its response", async () => {
  clearModelDiscoveryCache();
  const key = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
  const settings: Settings = {
    llm: { provider: "openai-codex", model: "gpt-new-fixture", baseUrl: "" },
    stt: { provider: "local", model: "base", language: "" },
    local: { pythonPath: "", whisperModel: "base", ollamaUrl: "" },
    configuredKeys: [],
    oauthConnections: [],
  };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/models?"))
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-new-fixture",
              visibility: "list",
              context_window: 128000,
            },
          ],
        }),
      );
    expect(url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe(
      "fixture-account",
    );
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-new-fixture");
    expect(body.stream).toBe(true);
    expect(body.instructions).toBe("Fixture system");
    expect(body.input[0].content[0].text).toBe("Fixture question");
    const events = [
      { type: "response.created", response: { id: "fixture-response" } },
      {
        type: "response.output_item.added",
        item: {
          type: "message",
          id: "fixture-message",
          role: "assistant",
          content: [],
        },
      },
      {
        type: "response.content_part.added",
        part: { type: "output_text", text: "", annotations: [] },
      },
      { type: "response.output_text.delta", delta: "Fixture response" },
      {
        type: "response.completed",
        response: {
          id: "fixture-response",
          status: "completed",
          usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
        },
      },
    ];
    return new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const model = await resolveDiscoveredModel(
    "openai-codex",
    "gpt-new-fixture",
    settings,
    async () => undefined,
    { key, oauth: true },
  );
  // Explicit SSE keeps this integration fixture entirely inside mocked HTTP.
  const result = await complete(
    model,
    {
      systemPrompt: "Fixture system",
      messages: [{ role: "user", content: "Fixture question", timestamp: 0 }],
    },
    { apiKey: key, transport: "sse", signal: AbortSignal.timeout(2000) },
  );
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual(
    expect.objectContaining({ type: "text", text: "Fixture response" }),
  );
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
