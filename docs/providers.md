# Speech and language models

AIM Meeting Notes keeps recordings and transcripts on this computer by default. The default speech recognizer is **faster-whisper / base**, running on CPU with real word timestamps. The default language model is **Ollama / qwen3:0.6b**; this small open model makes the initial download practical, but the larger Qwen, Llama, or Gemma options generally give stronger summaries. Models must be installed before local use. Whisper downloads its selected weights on its first transcription.

Choosing a cloud speech provider sends that recording's audio to that provider. Choosing a cloud language model sends the relevant transcript and question to that provider. Browser LLM login does not grant access to paid speech APIs. No existing OpenClaw, browser, shell-environment, or Codex credentials are imported.

## OpenClaw compatibility

The speech provider list follows the [OpenClaw media support matrix](https://github.com/openclaw/openclaw/blob/main/docs/nodes/media-understanding.md) inspected September 14, 2026. These are real protocol adapters, not labels routing everything to OpenAI. Model names are a selectable starting catalog; provider availability and account entitlements can change.

| Provider | Models offered | Authentication | Alignment |
| --- | --- | --- | --- |
| Local | base, tiny, small, medium, large-v3, turbo | None | Word |
| OpenAI | whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe, gpt-4o-transcribe-diarize | API key | Whisper words; GPT text estimated; diarize segments |
| Groq | whisper-large-v3-turbo, whisper-large-v3 | API key | Word |
| Deepgram | nova-3, nova-2 | API key | Word and speakers |
| ElevenLabs | scribe_v2, scribe_v1 | API key | Word and speakers |
| Mistral | voxtral-mini-latest | API key | Segment with auto language; estimated with explicit language |
| Google | gemini-2.5-flash, gemini-2.5-pro | API key | Estimated |
| DeepInfra | openai/whisper-large-v3-turbo, openai/whisper-large-v3 | API key | Returned timestamps, otherwise estimated |
| OpenRouter | openai/whisper-large-v3-turbo | API key | Estimated |
| SenseAudio | senseaudio-asr-pro-1.5-260319 | API key | Returned timestamps, otherwise estimated |
| xAI | grok-stt (native speech service) | API key | Word and speakers |

Cloud requests normalize audio to mono 16 kHz WAV in five-minute chunks, approximately 9.6 MB each. Chunk timestamps are offset back into the original recording timeline. Chunk boundaries can split words, and detected speaker IDs are labeled per part because the app cannot establish that a provider's “speaker 0” is the same person across independent requests. Local Whisper runs as one transcription and preserves its native timestamps. Temporary cloud chunk files are removed after processing, including on failure. Original audio remains available for playback.

Mistral currently does not accept timestamps together with an explicit language, so its automatic-language mode requests segment times while an explicit language uses text-only estimated alignment. Media decoders are restricted to local file and pipe protocols to prevent uploaded playlists from loading network content.

The maximum supported recording is eight hours. CPU transcription can take longer than the recording duration. The server gives local transcription at least 30 minutes and up to 15 times the audio duration before cancelling a stuck process. Each cloud chunk has a ten-minute request deadline. No transcript is silently substituted if a request fails, and cloud errors omit response bodies to avoid displaying keys or account information.

**Alignment has three explicit levels:** `word` means the provider supplied individual word times; `segment` means only phrase boundaries are available; `estimated` means words are spread across the chunk duration because the provider supplied plain text. Estimated karaoke is approximate and cannot locate exact speech or silence. Whisper, Groq, Deepgram, ElevenLabs, and xAI are the recommended options when precise playback navigation matters.

## Language models and browser login

The installed `@mariozechner/pi-ai` dependency supplies the language-model catalog and provider protocols used by OpenClaw, including OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, DeepSeek, xAI, Cerebras, Fireworks, Hugging Face, and others. The app includes every catalog provider that can operate with its API-key/browser settings. AWS Bedrock, Google Vertex, Azure, and Cloudflare infrastructure-specific providers are omitted because they require additional project, deployment, or identity configuration.

The current pi-ai OAuth registry supplies these browser flows:

- ChatGPT Plus/Pro (OpenAI Codex provider).
- Anthropic Claude Pro/Max.
- GitHub Copilot, including an optional enterprise domain prompt.

Browser flows use pi-ai's own provider-specific PKCE, callback, or device-code implementation. Credentials belong to this app's configured secret store. Refresh tokens are persisted after refresh; disconnect removes the app's saved credentials. Public polling responses contain only sign-in progress, URLs, and instructions. Sessions expire after ten minutes. The app allows one active browser flow at a time to avoid local callback port conflicts.

Account access and provider policy still determine whether a subscription can be used with each adapter. These flows are not a claim that every OpenClaw auth plugin is supported: OpenClaw adds provider-specific integrations beyond pi-ai, and those extra integrations are not copied into this app. Google here uses an API key, not an invented Google OAuth flow.

For Ollama, pull the model you select, e.g. `ollama pull qwen3:0.6b`. For LM Studio or another local server, select **OpenAI-compatible server**, supply the full `/v1` base URL and model ID, and leave the key empty if the server does not require authentication. HTTP is allowed only on loopback; remote custom endpoints require HTTPS. OAuth credentials cannot be sent to arbitrary custom endpoints.

## Source references

- [OpenClaw batch media provider matrix](https://github.com/openclaw/openclaw/blob/main/docs/nodes/media-understanding.md)
- [OpenClaw OpenRouter audio request implementation](https://github.com/openclaw/openclaw/blob/main/extensions/openrouter/media-understanding-provider.ts)
- [OpenClaw DeepInfra speech defaults](https://github.com/openclaw/openclaw/blob/main/extensions/deepinfra/media-models.ts)
- [OpenClaw SenseAudio endpoint and model](https://github.com/openclaw/openclaw/blob/main/extensions/senseaudio/media-understanding-provider.ts)
- [OpenClaw ElevenLabs speech adapter](https://github.com/openclaw/openclaw/blob/main/extensions/elevenlabs/media-understanding-provider.ts)
- [OpenClaw Mistral speech adapter](https://github.com/openclaw/openclaw/blob/main/extensions/mistral/media-understanding-provider.ts)
- [OpenClaw Google inline audio adapter](https://github.com/openclaw/openclaw/blob/main/extensions/google/media-understanding-provider.ts)
- [xAI native speech API and multipart ordering](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
- [faster-whisper implementation and word timestamps](https://github.com/SYSTRAN/faster-whisper)
- [pi-ai package and source repository](https://www.npmjs.com/package/@mariozechner/pi-ai)

The application code is an independent integration. OpenClaw was read as a protocol reference; its application code and user state were not copied.
