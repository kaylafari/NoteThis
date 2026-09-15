import { getOAuthApiKey } from "./oauth.js";
import {
  discoverProviderModels,
  resolveDiscoveredModel,
} from "./model-discovery.js";
import {
  supportsImageOutput,
  supportsWebSearch,
} from "../shared/model-features.js";
import type { Settings } from "../shared/types.js";
export {
  supportsImageOutput,
  supportsWebSearch,
} from "../shared/model-features.js";

type GetKey = (provider: string) => Promise<string | undefined>;
type Value = Record<string, unknown>;
export type WebAnswer = {
  text: string;
  webSources: { title: string; url: string }[];
  webSearchUsed: boolean;
};
const record = (value: unknown): Value =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Value)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const string = (value: unknown): string =>
  typeof value === "string" ? value : "";
const WEB_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 12 * 1024 * 1024;
const RASTER_LIMIT = 8 * 1024 * 1024;
const fail = () =>
  new Error(
    "The provider returned an invalid or incomplete response. Try again or choose another model.",
  );

async function credentials(settings: Settings, getKey: GetKey) {
  const { provider, model } = settings.llm;
  const oauth = provider === "openai-codex";
  const key = (
    oauth ? await getOAuthApiKey(provider) : await getKey(provider)
  )?.trim();
  if (!key)
    throw new Error(
      `Connect ${provider} in Settings before using this feature.`,
    );
  await resolveDiscoveredModel(provider, model, settings, async () => key, {
    key,
    oauth,
  });
  return key;
}
async function post(
  url: string,
  body: Value,
  headers: Record<string, string>,
  timeout: number,
) {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(
      "The provider could not be reached or the request timed out. Check connectivity and retry.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `The provider returned HTTP ${response.status}. ${response.status === 401 || response.status === 403 ? "Reconnect or check your API key and model access." : response.status === 429 ? "Check quota or try again later." : "Check model support or try another model."}`,
    );
  }
  return response;
}
async function* boundedChunks(response: Response, max: number) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new Error("The provider response exceeded the supported size.");
  }
  if (!response.body) throw fail();
  const reader = response.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > max)
        throw new Error("The provider response exceeded the supported size.");
      yield item.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
async function jsonResponse(response: Response, max: number): Promise<Value> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of boundedChunks(response, max)) chunks.push(chunk);
    const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.error)
      throw fail();
    return raw;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "The provider response exceeded the supported size."
    )
      throw error;
    throw fail();
  }
}
function sourceFrom(
  value: unknown,
): { title: string; url: string } | undefined {
  const annotation = record(value);
  if (annotation.type !== "url_citation") return;
  const citation = annotation.url_citation
    ? record(annotation.url_citation)
    : annotation;
  const raw = string(citation.url);
  if (!raw || raw.length > 2048 || /[\x00-\x20\x7f]/.test(raw)) return;
  try {
    const url = new URL(raw);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    )
      return;
    return {
      url: url.href,
      title: (string(citation.title).trim() || url.hostname).slice(0, 240),
    };
  } catch {
    return;
  }
}
function sources(values: unknown[]) {
  const byUrl = new Map<string, { title: string; url: string }>();
  for (const value of values) {
    const source = sourceFrom(value);
    if (source && byUrl.size < 30) byUrl.set(source.url, source);
  }
  return [...byUrl.values()];
}
function outputParts(output: unknown[]) {
  const text: string[] = [];
  const annotations: unknown[] = [];
  let searched = false;
  for (const itemValue of output) {
    const item = record(itemValue);
    if (item.type === "web_search_call" && item.status === "completed")
      searched = true;
    if (item.type !== "message") continue;
    for (const partValue of array(item.content)) {
      const part = record(partValue);
      if (part.type === "output_text") {
        text.push(string(part.text));
        annotations.push(...array(part.annotations));
      }
    }
  }
  return { text: text.join("\n"), annotations, searched };
}
/** Responses API's SSE may split UTF-8 code points and event delimiters across chunks. */
async function responseStream(response: Response): Promise<WebAnswer> {
  const decoder = new TextDecoder();
  let pending = "";
  let deltas = "";
  let completed = false;
  let searched = false;
  let finalText = "";
  const annotations: unknown[] = [];
  function event(block: string) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data.trim() === "[DONE]") return;
    let payload: Value;
    try {
      payload = record(JSON.parse(data));
    } catch {
      throw fail();
    }
    const type = payload.type;
    if (
      type === "error" ||
      type === "response.failed" ||
      type === "response.incomplete"
    )
      throw fail();
    if (type === "response.output_text.delta") deltas += string(payload.delta);
    if (deltas.length > 100_000) throw fail();
    if (type === "response.output_text.annotation.added")
      annotations.push(payload.annotation);
    if (type === "response.web_search_call.completed") searched = true;
    if (type === "response.output_item.done") {
      const parsed = outputParts([payload.item]);
      annotations.push(...parsed.annotations);
      searched ||= parsed.searched;
    }
    if (type === "response.completed" || type === "response.done") {
      const final = record(payload.response);
      if (final.error || final.status !== "completed") throw fail();
      const parsed = outputParts(array(final.output));
      finalText = parsed.text;
      annotations.push(...parsed.annotations);
      searched ||= parsed.searched;
      completed = true;
    }
  }
  try {
    for await (const chunk of boundedChunks(response, WEB_LIMIT)) {
      pending += decoder.decode(chunk, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        event(pending.slice(0, boundary.index));
        pending = pending.slice(boundary.index + boundary[0].length);
      }
    }
    pending += decoder.decode();
    if (pending.trim()) event(pending);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "The provider response exceeded the supported size."
    )
      throw error;
    throw fail();
  }
  const text = (finalText || deltas).trim();
  if (!completed || !text || text.length > 100_000) throw fail();
  const webSources = sources(annotations);
  return { text, webSources, webSearchUsed: searched || webSources.length > 0 };
}
function chatMessage(payload: Value) {
  const choice = record(array(payload.choices)[0]);
  if (choice.finish_reason && choice.finish_reason !== "stop") throw fail();
  const message = record(choice.message);
  if (message.refusal || message.error) throw fail();
  return message;
}

/** Official Codex hosted_spec.rs / tool_spec.rs: live hosted web_search tool. */
export async function generateWebAnswer(
  system: string,
  prompt: string,
  settings: Settings,
  getKey: GetKey,
): Promise<WebAnswer> {
  const { provider, model } = settings.llm;
  if (
    settings.llm.webSearch !== true ||
    settings.llm.webSearchConsentProvider !== provider
  )
    throw new Error(
      "Enable web search and confirm sharing this question and relevant meeting excerpts with the selected provider in Settings.",
    );
  if (!supportsWebSearch(provider))
    throw new Error(
      "Web search is not implemented for this provider. Choose a supported provider in Settings.",
    );
  const key = await credentials(settings, getKey);
  const discovery = await discoverProviderModels(
    provider,
    "llm",
    settings,
    async () => key,
  );
  if (
    !["account", "local"].includes(discovery.source) ||
    !discovery.models.includes(model) ||
    discovery.capabilities?.[model]?.webSearch !== "supported"
  )
    throw new Error(
      "This model does not currently report web-search support. Refresh models and choose a supported model.",
    );
  if (provider === "openrouter") {
    // https://openrouter.ai/docs/guides/features/plugins/web-search
    const response = await post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model,
        stream: false,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
        plugins: [{ id: "web", max_results: 5 }],
        max_tokens: 4096,
      },
      { Authorization: `Bearer ${key}`, "X-OpenRouter-Title": "NoteThis" },
      120_000,
    );
    const message = chatMessage(await jsonResponse(response, WEB_LIMIT));
    const text = (
      typeof message.content === "string"
        ? message.content
        : array(message.content)
            .filter((p) => record(p).type === "text")
            .map((p) => string(record(p).text))
            .join("\n")
    ).trim();
    if (!text || text.length > 100_000) throw fail();
    const webSources = sources(array(message.annotations));
    // Plugin enablement alone is not evidence a search actually ran.
    return { text, webSources, webSearchUsed: webSources.length > 0 };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    Accept: "text/event-stream",
  };
  if (provider === "openai-codex") {
    let account = "";
    try {
      account = string(
        record(
          JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString())[
            "https://api.openai.com/auth"
          ],
        ).chatgpt_account_id,
      );
    } catch {
      /* Report a generic reconnect error. */
    }
    if (!account)
      throw new Error("Reconnect ChatGPT in Settings before using web search.");
    headers["chatgpt-account-id"] = account;
    headers.originator = "pi";
    headers["OpenAI-Beta"] = "responses=experimental";
  }
  const response = await post(
    provider === "openai-codex"
      ? "https://chatgpt.com/backend-api/codex/responses"
      : "https://api.openai.com/v1/responses",
    {
      model,
      store: false,
      stream: true,
      instructions: system,
      input: [
        { role: "user", content: [{ type: "input_text", text: prompt }] },
      ],
      tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: "auto",
      ...(provider === "openai" ? { max_output_tokens: 4096 } : {}),
    },
    headers,
    120_000,
  );
  return responseStream(response);
}

function rasterDimensions(
  bytes: Buffer,
  mime: string,
): [number, number] | undefined {
  if (mime === "image/png") {
    if (
      bytes.length < 45 ||
      !bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString("ascii", 12, 16) !== "IHDR" ||
      bytes.toString("ascii", bytes.length - 8, bytes.length - 4) !== "IEND"
    )
      return;
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mime === "image/jpeg") {
    if (
      bytes.length < 4 ||
      bytes.readUInt16BE(0) !== 0xffd8 ||
      bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
    )
      return;
    let cursor = 2;
    while (cursor + 4 <= bytes.length) {
      if (bytes[cursor++] !== 0xff) return;
      while (bytes[cursor] === 0xff) cursor++;
      const marker = bytes[cursor++];
      if (marker === 0xda || marker === 0xd9) return;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (cursor + 2 > bytes.length) return;
      const length = bytes.readUInt16BE(cursor);
      if (length < 2 || cursor + length > bytes.length) return;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      ) {
        if (length < 8) return;
        return [bytes.readUInt16BE(cursor + 5), bytes.readUInt16BE(cursor + 3)];
      }
      cursor += length;
    }
    return;
  }
  if (mime === "image/webp") {
    if (
      bytes.length < 30 ||
      bytes.toString("ascii", 0, 4) !== "RIFF" ||
      bytes.toString("ascii", 8, 12) !== "WEBP" ||
      bytes.readUInt32LE(4) !== bytes.length - 8
    )
      return;
    const type = bytes.toString("ascii", 12, 16);
    if (type === "VP8X")
      return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (
      type === "VP8 " &&
      bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    )
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (type === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return [1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff)];
    }
  }
}
function validateImage(value: unknown) {
  const dataUrl = string(value);
  if (!dataUrl || dataUrl.length > Math.ceil(RASTER_LIMIT / 3) * 4 + 64)
    throw new Error(
      "The image response is missing or exceeds the supported size.",
    );
  const match =
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match)
    throw new Error(
      "The provider must return a PNG, JPEG, or WebP image as inline data. Remote image URLs and SVG are not accepted.",
    );
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > RASTER_LIMIT || bytes.toString("base64") !== match[2])
    throw new Error("The provider returned invalid image data.");
  const size = rasterDimensions(bytes, match[1]);
  if (
    !size ||
    size.some((n) => n < 1 || n > 8192) ||
    size[0] * size[1] > 25_000_000
  )
    throw new Error(
      "The provider returned invalid or oversized raster image data.",
    );
  return { dataUrl, mimeType: match[1] };
}
/** OpenRouter's ChatRequest.modalities / ChatAssistantImages in its OpenAPI schema. */
export async function generateSummaryImage(
  prompt: string,
  settings: Settings,
  getKey: GetKey,
): Promise<{ dataUrl: string; mimeType: string }> {
  const { provider, model } = settings.llm;
  if (
    settings.llm.summaryDiagrams !== true ||
    settings.llm.summaryDiagramsConsentProvider !== provider
  )
    throw new Error(
      "Enable summary diagrams and confirm sharing the diagram prompt derived from meeting notes with the selected provider in Settings.",
    );
  if (!supportsImageOutput(provider))
    throw new Error(
      "Image output is not implemented for this provider. Choose an image-capable OpenRouter model.",
    );
  const key = await credentials(settings, getKey);
  const discovery = await discoverProviderModels(
    provider,
    "llm",
    settings,
    async () => key,
  );
  const outputs = discovery.capabilities?.[model]?.outputModalities;
  if (discovery.source !== "account" || !outputs?.includes("image"))
    throw new Error(
      "This model does not currently report image output. Refresh models and choose an image-capable model.",
    );
  const response = await post(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      model,
      stream: false,
      messages: [{ role: "user", content: prompt }],
      modalities: outputs.includes("text") ? ["image", "text"] : ["image"],
    },
    { Authorization: `Bearer ${key}`, "X-OpenRouter-Title": "NoteThis" },
    180_000,
  );
  const message = chatMessage(await jsonResponse(response, IMAGE_LIMIT));
  return validateImage(record(record(array(message.images)[0]).image_url).url);
}
