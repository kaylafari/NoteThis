import type { ModelCapabilities } from "../shared/types.js";

type Metadata = Record<string, unknown>;
function object(value: unknown): Metadata {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Metadata)
    : {};
}
function modalities(value: unknown): string[] | null {
  // Unknown/malformed metadata must not become an empty "unsupported" list.
  // Accept future modality names, but never stringify arbitrary provider objects.
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 32 ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        /^[a-z][a-z0-9_-]{0,63}$/i.test(item.trim()),
    )
  )
    return null;
  return [...new Set(value.map((item: string) => item.trim().toLowerCase()))];
}

/**
 * Never infer capabilities from model names, input modalities, tool calling,
 * token limits, endpoint names, or an absent flag. This function cannot enable
 * search: callers must display Cadence's own enabled/disabled state separately.
 *
 * Sources:
 * - https://openrouter.ai/openapi.json (ModelArchitecture, Parameter)
 * - https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs
 * - https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/spec_plan.rs
 * - https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/common/endpointProvider.ts
 * - https://platform.claude.com/docs/en/api/models/list
 * - https://ai.google.dev/api/models
 */
export function discoverModelCapabilities(
  provider: string,
  row: Metadata,
): ModelCapabilities {
  // OpenRouter's architecture describes inputs and outputs separately. Other
  // providers may report an explicit top-level output_modalities extension.
  // Codex's input_modalities and Copilot's supports.vision are NOT output data.
  const outputModalities = modalities(
    provider === "openrouter"
      ? object(row.architecture).output_modalities
      : row.output_modalities,
  );
  const result: ModelCapabilities = {
    outputModalities,
    webSearch: "unknown",
  };

  // Explicit, typed capability extensions can communicate a positive or a
  // negative result. Do not treat null, "false", {}, or missing values as false.
  // They are only metadata claims, not proof of account access or tool enablement.
  const explicit = [
    row.supports_web_search,
    object(object(row.capabilities).web_search).supported,
  ].filter((value): value is boolean => typeof value === "boolean");
  if (explicit.length) {
    if (explicit.some((value) => value !== explicit[0])) {
      result.webSearchNote =
        "Provider metadata contains conflicting web-search capability flags.";
      return result;
    }
    result.webSearch = explicit[0] ? "supported" : "unsupported";
    result.webSearchNote =
      "Reported by an explicit provider web-search capability flag; this does not enable web search in Cadence.";
    return result;
  }

  if (provider === "openai-codex") {
    // The official enum contains these two values. The Rust client defaults a
    // missing value to Text, but a missing wire field is unknown in our UI.
    // supports_search_tool is namespace/tool discovery, not web search.
    if (
      typeof row.web_search_tool_type === "string" &&
      ["text", "text_and_image"].includes(row.web_search_tool_type)
    ) {
      result.webSearch = "supported";
      result.webSearchNote =
        "Codex advertises a hosted web-search tool; Cadence does not enable that tool.";
    }
    return result;
  }

  if (provider === "openrouter") {
    if (
      Array.isArray(row.supported_parameters) &&
      row.supported_parameters.includes("web_search_options")
    ) {
      result.webSearch = "supported";
      result.webSearchNote =
        "OpenRouter advertises web-search support for this model; Cadence does not enable web search.";
    } else {
      // https://openrouter.ai/docs/guides/features/plugins/web-search documents
      // its provider-wide web plugin. That does not establish native capability
      // for this particular model or imply the plugin is active in Cadence.
      result.webSearchNote =
        "Model-level web search is not reported. OpenRouter offers a separate web plugin, which Cadence does not enable.";
    }
  }
  return result;
}
