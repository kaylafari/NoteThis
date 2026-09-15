# Model discovery

Cadence's original picker came from the installed pi-ai model registry. That registry describes integration defaults; it does not establish which models a connected account can currently use. Updating the registry alone would not resolve account-specific availability.

The settings panel now queries the selected source using the credentials saved in Cadence. Model discovery runs on the local server; keys and subscription tokens are never returned to the renderer. The panel refreshes after connecting or changing credentials and offers a manual refresh button. It distinguishes account results, installed local models, bundled defaults, and failed discovery.

Live results replace the bundled suggestions. A previously selected model remains visible as a selection that needs attention when the current account no longer lists it; refresh does not silently change saved preferences. Providers without a supported listing endpoint show a labeled fallback rather than claiming account availability.

The request adapter accepts supported model IDs returned by discovery, including IDs absent from the bundled registry. Codex subscription requests verify the selected ID against the authenticated Codex catalog. Discovery caches are scoped to provider, endpoint, and credential identity and expire promptly; manual refresh bypasses cached results.

Discovery confirms a source's catalog response. It does not guarantee sufficient quota or that every request will succeed. ChatGPT subscription model availability and an OpenAI API-key catalog are distinct and are queried with their corresponding credentials.

## Observed verification

On September 14, 2026, the packaged app queried the connected ChatGPT account successfully and returned six models: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, and `gpt-5.3-codex-spark`. None of the obsolete GPT-5.1 picker entries appeared. This is a dated verification record, not an application model list. The saved local-model preference and existing account connection were preserved, and no meeting content was sent by the discovery check.

Protocol references: [official Codex model endpoint](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs), [model response schema](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs), and [Codex model/list guidance](https://learn.chatgpt.com/docs/app-server).

The full regression suite passed 176 tests across 13 files for this release. Tests cover credential-scoped caches, forced refresh, obsolete selections, unsupported fallbacks, late-response races, newly discovered IDs, and actual Codex request serialization/SSE parsing with isolated transport fixtures. Additional discovery support includes GitHub Copilot, OpenRouter's user-filtered list, major API providers, Ollama, and custom servers. Anthropic browser-only connections retain an explicitly unverified fallback where the login scopes do not establish model-list support.

Additional protocol references: [OpenRouter API schema](https://openrouter.ai/openapi.json), [Copilot endpoint selection](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/common/endpointProvider.ts), and [Copilot model metadata](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/node/modelMetadataFetcher.ts).


## Model capabilities

The selected model also shows output formats and provider-reported web-search support when its discovery response exposes those fields. Missing data is **Unknown (not reported)**; bundled suggestions do not establish verified capabilities. Metadata is scoped to the same credentials and refreshed alongside the model list. A removed model cannot keep displaying old capability claims.

These are distinct from what Cadence enables. Meeting summaries and questions currently produce text, and Cadence does not attach a web-search tool. A provider reporting search support does not grant active web access, guarantee account entitlement to the tool, or initiate a search. No test prompts or meeting content are sent to discover capabilities.

Codex's input modalities are not output modalities. Its explicit web-search tool type can establish reported search-tool support; tool calling or generic tool-search support alone cannot. OpenRouter reports output modalities in its architecture metadata and can advertise web-search configuration in supported parameters. Providers that omit these fields remain unknown rather than being guessed from model names or a static model registry.

References: [OpenAI web-search tool configuration](https://developers.openai.com/api/docs/guides/tools-web-search), [Codex model-list input modalities](https://learn.chatgpt.com/docs/app-server).

Capability-display verification (September 15, 2026): **241 tests passed across 16 files**, including malformed/unknown provider metadata, authenticated discovery refresh, removed model selections, and real Chromium settings interactions. These are protocol-fixture and UI tests; no paid capability probes or live searches were run.
