import { createHash } from "node:crypto";
import {
  getModels,
  type Api,
  type KnownProvider,
  type Model,
} from "@mariozechner/pi-ai";
import { getOAuthApiKey, getOAuthModel } from "./oauth.js";
import { providerCatalog, validateEndpoint } from "./providers.js";
import { discoverModelCapabilities } from "./model-capabilities.js";
import type { ProviderModels, Settings } from "../shared/types.js";

type GetKey = (provider: string) => Promise<string | undefined>;
type Item = Record<string, unknown>;
type Credential = { key?: string; oauth: boolean };
type Entry = {
  result: ProviderModels;
  metadata: Map<string, Item>;
  expires: number;
};
const cache = new Map<string, Entry>();
const TTL = 60_000;
// Public protocol reference: openai/codex codex-rs/codex-api/src/endpoint/models.rs.
// Version tracks its rust-v0.154.0 release; originator matches pi-ai's generation adapter.
export const CODEX_DISCOVERY_VERSION = "0.154.0";
const record = (v: unknown): Item =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Item) : {};
const text = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const validId = (id: string) =>
  id.length > 0 && id.length <= 200 && !/[\s\x00-\x1f]/.test(id);
export function clearModelDiscoveryCache() {
  cache.clear();
}

async function credentialFor(
  provider: string,
  kind: "llm" | "stt",
  getKey: GetKey,
): Promise<Credential> {
  const option = providerCatalog()[kind].find((p) => p.id === provider);
  if (option?.auth === "none") return { oauth: false };
  const key =
    option?.auth === "oauth" ? undefined : (await getKey(provider))?.trim();
  if (key) return { key, oauth: false };
  if (
    kind === "llm" &&
    ["oauth", "api-key-or-oauth"].includes(option?.auth ?? "")
  )
    return { key: await getOAuthApiKey(provider), oauth: true };
  return { oauth: false };
}
function codexAccount(key: string): string {
  try {
    const claims = JSON.parse(
      Buffer.from(key.split(".")[1], "base64url").toString(),
    );
    return text(
      record(claims["https://api.openai.com/auth"]).chatgpt_account_id,
    );
  } catch {
    return "";
  }
}
const bases: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  mistral: "https://api.mistral.ai/v1",
  deepseek: "https://api.deepseek.com",
  xai: "https://api.x.ai/v1",
};
async function endpointFor(
  provider: string,
  kind: "llm" | "stt",
  settings: Settings,
  auth: Credential,
) {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (auth.key) headers.Authorization = `Bearer ${auth.key}`;
  if (provider === "ollama")
    return {
      url: `${validateEndpoint(settings.local.ollamaUrl || "http://127.0.0.1:11434")}/api/tags`,
      headers,
    };
  if (provider === "custom")
    return { url: `${validateEndpoint(settings.llm.baseUrl)}/models`, headers };
  if (provider === "openai-codex") {
    const account = codexAccount(auth.key || "");
    if (!account)
      throw new Error(
        "Reconnect ChatGPT in Settings to refresh its account identity.",
      );
    headers["chatgpt-account-id"] = account;
    headers.originator = "pi";
    return {
      url: `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_DISCOVERY_VERSION}`,
      headers,
    };
  }
  if (provider === "github-copilot") {
    const adapted = await getOAuthModel(getModels("github-copilot")[0]);
    Object.assign(headers, adapted.headers);
    headers["X-GitHub-Api-Version"] = "2025-04-01";
    return { url: `${validateEndpoint(adapted.baseUrl)}/models`, headers };
  }
  if (provider === "openrouter")
    return {
      url: `https://openrouter.ai/api/v1/models/user?output_modalities=${kind === "llm" ? "text" : "transcription"}`,
      headers,
    };
  if (provider === "anthropic" && !auth.oauth) {
    delete headers.Authorization;
    headers["x-api-key"] = auth.key!;
    headers["anthropic-version"] = "2023-06-01";
    return { url: "https://api.anthropic.com/v1/models?limit=1000", headers };
  }
  if (provider === "google") {
    delete headers.Authorization;
    headers["x-goog-api-key"] = auth.key!;
    return {
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      headers,
    };
  }
  // These speech services don't expose the same discovery API as their text service.
  if (kind === "stt" && ["xai", "deepseek"].includes(provider))
    return undefined;
  if (bases[provider]) return { url: `${bases[provider]}/models`, headers };
  return undefined;
}
async function fetchPage(
  url: string,
  headers: Record<string, string>,
): Promise<Item> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Model discovery could not reach the provider. Check connectivity and refresh.",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Model discovery returned HTTP ${response.status}. ${[401, 403].includes(response.status) ? "Reconnect or check the saved API key." : "Try Refresh models again later."}`,
    );
  }
  const raw = await response.text();
  if (raw.length > 4 * 1024 * 1024)
    throw new Error("Model discovery returned an oversized response.");
  try {
    const value = JSON.parse(raw);
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      value.error
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "Model discovery returned an invalid response. Try Refresh models again later.",
    );
  }
}
function rowsFor(
  provider: string,
  kind: "llm" | "stt",
  data: Item,
): [string, Item][] {
  const raw =
    provider === "ollama" ||
    provider === "google" ||
    provider === "openai-codex"
      ? data.models
      : data.data;
  if (!Array.isArray(raw))
    throw new Error(
      "Model discovery returned an unsupported model-list format.",
    );
  return raw
    .map(record)
    .filter((row) => {
      const id = text(row.slug || row.id || row.name || row.model).replace(
        /^models\//,
        "",
      );
      if (!validId(id) || row.active === false) return false;
      if (provider === "openai-codex") return row.visibility === "list";
      if (provider === "google")
        return (
          list(row.supportedGenerationMethods).includes("generateContent") &&
          /^gemini-/.test(id) &&
          !/image|tts|live|audio|robotics|computer-use/.test(id)
        );
      if (provider === "github-copilot")
        return (
          record(row.capabilities).type === "chat" &&
          row.model_picker_enabled !== false &&
          (list(row.supported_endpoints).some((path) =>
            ["/chat/completions", "/responses", "/v1/messages"].includes(
              String(path),
            ),
          ) ||
            getModels("github-copilot").some((model) => model.id === id))
        );
      if (provider === "openrouter")
        return list(record(row.architecture).output_modalities).includes(
          kind === "llm" ? "text" : "transcription",
        );
      if (provider === "ollama" || provider === "custom")
        return !/embed|rerank/.test(id);
      const speech = /whisper|transcrib|voxtral.*mini/.test(id);
      if (kind === "stt") {
        if (provider === "mistral")
          return record(row.capabilities).audio_transcription === true;
        return speech;
      }
      if (
        speech ||
        /embedding|moderation|dall-e|image|tts|realtime|audio|sora|rerank|guard/i.test(
          id,
        )
      )
        return false;
      if (provider === "mistral")
        return record(row.capabilities).completion_chat === true;
      if (provider === "openai") return /^(gpt-|chatgpt-|o[1-9])/.test(id);
      return true;
    })
    .map(
      (row) =>
        [
          text(row.slug || row.id || row.name || row.model).replace(
            /^models\//,
            "",
          ),
          row,
        ] as [string, Item],
    );
}
async function discover(
  provider: string,
  kind: "llm" | "stt",
  settings: Settings,
  getKey: GetKey,
  force: boolean,
  suppliedAuth?: Credential,
): Promise<Entry> {
  const option = providerCatalog()[kind].find((p) => p.id === provider);
  if (!option) throw new Error("Choose a supported model provider.");
  const fallback = (message: string, unavailable = false): Entry => ({
    result: {
      provider,
      kind,
      models: unavailable ? [] : [...option.models],
      source: unavailable ? "unavailable" : "bundled",
      message,
    },
    metadata: new Map(),
    expires: 0,
  });
  if (provider === "local")
    return fallback(
      "Bundled Whisper sizes; weights download when first used. This is not a list of installed models.",
    );
  let auth: Credential;
  try {
    auth = suppliedAuth ?? (await credentialFor(provider, kind, getKey));
  } catch {
    return fallback(
      "Browser credentials could not refresh. Reconnect in Settings; bundled suggestions are not account availability.",
      provider === "openai-codex",
    );
  }
  if (!auth.key && !["ollama", "custom"].includes(provider))
    return fallback(
      `Connect ${option.name} to discover models. Bundled suggestions are not verified for your account.`,
      provider === "openai-codex",
    );
  let endpoint: Awaited<ReturnType<typeof endpointFor>>;
  try {
    endpoint = await endpointFor(provider, kind, settings, auth);
  } catch (error) {
    return fallback(
      error instanceof Error
        ? error.message
        : "Check model discovery settings.",
      true,
    );
  }
  if (!endpoint)
    return fallback(
      "This connection has no supported model-list API in Cadence. Bundled suggestions are not verified account availability.",
    );
  // Never persist credentials or account identifiers in the model cache.
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        provider,
        kind,
        endpoint.url,
        auth.key ?? "",
        auth.oauth,
      ]),
    )
    .digest("hex");
  const cached = cache.get(scope);
  if (!force && cached && cached.expires > Date.now()) return cached;
  try {
    const metadata = new Map<string, Item>();
    let url: string | undefined = endpoint.url;
    for (let page = 0; url && page < 10; page++) {
      const data = await fetchPage(url, endpoint.headers);
      for (const [id, row] of rowsFor(provider, kind, data))
        metadata.set(id, row);
      const next = new URL(endpoint.url);
      if (provider === "google" && text(data.nextPageToken))
        next.searchParams.set("pageToken", text(data.nextPageToken));
      else if (
        provider === "anthropic" &&
        data.has_more === true &&
        text(data.last_id)
      )
        next.searchParams.set("after_id", text(data.last_id));
      else {
        url = undefined;
        break;
      }
      if (next.toString() === url)
        throw new Error(
          "Model discovery returned an invalid pagination cursor.",
        );
      url = next.toString();
    }
    if (url)
      throw new Error(
        "Model discovery exceeded its page limit. Try again later.",
      );
    let models = [...metadata.keys()];
    if (provider === "openai-codex")
      models.sort(
        (a, b) =>
          Number(metadata.get(a)?.priority ?? 999) -
          Number(metadata.get(b)?.priority ?? 999),
      );
    else models.sort((a, b) => a.localeCompare(b));
    const result: ProviderModels = {
      provider,
      kind,
      models,
      capabilities: Object.fromEntries(
        models.map((id) => [
          id,
          discoverModelCapabilities(provider, metadata.get(id)!),
        ]),
      ),
      source:
        provider === "ollama" ||
        (provider === "custom" && new URL(endpoint.url).protocol === "http:")
          ? "local"
          : "account",
      checkedAt: new Date().toISOString(),
      message: models.length
        ? provider === "ollama"
          ? "Installed models reported by your Ollama server."
          : "Models returned by the connected provider. Access can depend on your plan, region, and quota."
        : "The connected provider returned no compatible models.",
      ...(models[0] ? { defaultModel: models[0] } : {}),
    };
    const entry = { result, metadata, expires: Date.now() + TTL };
    if (cache.size >= 80) cache.delete(cache.keys().next().value!);
    cache.set(scope, entry);
    return entry;
  } catch (error) {
    cache.delete(scope);
    // Do not pass obsolete account results off as a successful refresh.
    return fallback(
      `${error instanceof Error ? error.message : "Model discovery failed."}${provider === "openai-codex" ? "" : " Showing bundled suggestions; account access is unverified."}`,
      provider === "openai-codex" ||
        provider === "custom" ||
        provider === "ollama",
    );
  }
}
export async function discoverProviderModels(
  provider: string,
  kind: "llm" | "stt",
  settings: Settings,
  getKey: GetKey,
  options: { force?: boolean } = {},
): Promise<ProviderModels> {
  return structuredClone(
    (await discover(provider, kind, settings, getKey, options.force === true))
      .result,
  );
}
/** Resolve only IDs actually returned by this credential's discovery endpoint. */
export async function resolveDiscoveredModel(
  provider: string,
  id: string,
  settings: Settings,
  getKey: GetKey,
  credential: Credential,
): Promise<Model<Api>> {
  const entry = await discover(
    provider,
    "llm",
    settings,
    getKey,
    false,
    credential,
  );
  if (entry.result.source !== "account" && entry.result.source !== "local")
    throw new Error(
      `${entry.result.message} Open Settings and refresh models before using this selection.`,
    );
  const row = entry.metadata.get(id);
  if (!row)
    throw new Error(
      "The selected model is no longer listed for this connection. Open Settings, refresh models, and select an available model.",
    );
  const existing = getModels(provider as KnownProvider).find(
    (m) => m.id === id,
  );
  if (existing && provider !== "openai-codex") return existing;
  const adapters: Record<string, { api: Api; baseUrl: string }> = {
    "openai-codex": {
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    openai: { api: "openai-responses", baseUrl: bases.openai },
    anthropic: {
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
    },
    google: {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    groq: { api: "openai-completions", baseUrl: bases.groq },
    mistral: {
      api: "mistral-conversations",
      baseUrl: "https://api.mistral.ai",
    },
    deepseek: { api: "openai-completions", baseUrl: bases.deepseek },
    openrouter: {
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
    },
    xai: { api: "openai-completions", baseUrl: bases.xai },
  };
  const adapter =
    provider === "github-copilot"
      ? (() => {
          const endpoints = list(row.supported_endpoints);
          const api: Api | undefined = endpoints.includes("/responses")
            ? "openai-responses"
            : endpoints.includes("/v1/messages")
              ? "anthropic-messages"
              : endpoints.includes("/chat/completions")
                ? "openai-completions"
                : undefined;
          return api
            ? { api, baseUrl: "https://api.individual.githubcopilot.com" }
            : undefined;
        })()
      : adapters[provider];
  if (!adapter)
    throw new Error(
      "This discovered model needs a newer provider adapter. Choose a bundled model or update Cadence.",
    );
  const positive = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : fallback;
  // Protocol selection is explicit, not inherited from an unrelated model. Missing
  // capability metadata stays conservative; the app only submits text, no tools.
  const limits = record(record(row.capabilities).limits);
  return {
    id,
    name: text(row.display_name || row.name) || id,
    provider,
    ...adapter,
    ...(provider === "github-copilot"
      ? { headers: getModels("github-copilot")[0].headers }
      : {}),
    reasoning: list(row.supported_reasoning_levels).length > 0,
    input: ["text"],
    contextWindow: positive(
      row.context_window ||
        row.inputTokenLimit ||
        row.max_context_length ||
        row.context_length ||
        limits.max_context_window_tokens,
      32768,
    ),
    maxTokens: positive(
      row.outputTokenLimit ||
        row.max_output_tokens ||
        limits.max_output_tokens ||
        record(row.top_provider).max_completion_tokens,
      4096,
    ),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
