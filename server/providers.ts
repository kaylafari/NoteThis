import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  complete,
  getModels,
  getProviders,
  type Api,
  type KnownProvider,
  type Model,
} from "@mariozechner/pi-ai";
import { getOAuthProviders } from "@mariozechner/pi-ai/oauth";
import { getOAuthApiKey, getOAuthModel } from "./oauth.js";
import type {
  ProviderCatalog,
  ProviderOption,
  Segment,
  Settings,
  Word,
} from "../shared/types.js";

type GetKey = (provider: string) => Promise<string | undefined>;
type Transcript = {
  segments: Segment[];
  duration: number;
  timing: "word" | "segment" | "estimated";
};
type RecordValue = Record<string, unknown>;
const obj = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string =>
  typeof value === "string" ? value : "";
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const STT: ProviderOption[] = [
  {
    id: "local",
    name: "Whisper · on this Mac",
    models: ["base", "tiny", "small", "medium", "large-v3", "turbo"],
    auth: "none",
    description:
      "Open-source faster-whisper. Private CPU transcription; downloads weights on first use.",
    supportsWords: true,
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      "whisper-1",
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "gpt-4o-transcribe-diarize",
    ],
    auth: "api-key",
    description:
      "Whisper provides word timing. GPT transcription uses estimated timing; diarize provides speaker segments.",
    supportsWords: true,
  },
  {
    id: "groq",
    name: "Groq",
    models: ["whisper-large-v3-turbo", "whisper-large-v3"],
    auth: "api-key",
    description: "Hosted Whisper with word timestamps.",
    supportsWords: true,
  },
  {
    id: "deepgram",
    name: "Deepgram",
    models: ["nova-3", "nova-2"],
    auth: "api-key",
    description: "Word timestamps and detected speakers.",
    supportsWords: true,
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    models: ["scribe_v2", "scribe_v1"],
    auth: "api-key",
    description:
      "Scribe speech recognition with word timing and detected speakers.",
    supportsWords: true,
  },
  {
    id: "mistral",
    name: "Mistral",
    models: ["voxtral-mini-latest"],
    auth: "api-key",
    description:
      "Voxtral with segment timing in automatic language mode; explicit language uses estimated timing.",
  },
  {
    id: "google",
    name: "Google Gemini",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    auth: "api-key",
    description: "Gemini audio understanding. Playback timing is estimated.",
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    models: ["openai/whisper-large-v3-turbo", "openai/whisper-large-v3"],
    auth: "api-key",
    description:
      "OpenClaw-compatible hosted Whisper. Timing depends on response.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    models: ["openai/whisper-large-v3-turbo"],
    auth: "api-key",
    description: "OpenRouter speech endpoint. Playback timing is estimated.",
  },
  {
    id: "senseaudio",
    name: "SenseAudio",
    models: ["senseaudio-asr-pro-1.5-260319"],
    auth: "api-key",
    description: "SenseAudio recognition. Playback timing depends on response.",
  },
  {
    id: "xai",
    name: "xAI",
    models: ["grok-stt"],
    auth: "api-key",
    description: "xAI native speech endpoint with word timestamps.",
    supportsWords: true,
  },
];
export function providerCatalog(): ProviderCatalog {
  const oauth = new Map(getOAuthProviders().map((p) => [p.id, p.name]));
  // These need infrastructure/identity configuration beyond a single API key.
  const excluded = new Set([
    "amazon-bedrock",
    "google-vertex",
    "azure-openai-responses",
    "cloudflare-ai-gateway",
    "cloudflare-workers-ai",
  ]);
  const popular = [
    "openai",
    "anthropic",
    "google",
    "openai-codex",
    "github-copilot",
    "groq",
    "mistral",
    "openrouter",
    "deepseek",
    "xai",
  ];
  const llm: ProviderOption[] = getProviders()
    .filter((p) => !excluded.has(p))
    .map((provider) => ({
      id: provider,
      name: oauth.get(provider) ?? provider,
      models: getModels(provider).map((m) => m.id),
      auth: oauth.has(provider)
        ? provider === "anthropic"
          ? "api-key-or-oauth"
          : "oauth"
        : "api-key",
      description: oauth.has(provider)
        ? "Browser sign-in using the pi-ai OAuth adapter used by OpenClaw."
        : "Model catalog and API adapter from pi-ai, used by OpenClaw.",
    }));
  llm.sort((a, b) => {
    const rank = (id: string) =>
      popular.includes(id) ? popular.indexOf(id) : 100;
    return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
  });
  llm.unshift({
    id: "ollama",
    name: "Ollama · on this Mac",
    models: ["qwen3:0.6b", "qwen3:4b", "llama3.2:3b", "gemma3:4b"],
    auth: "none",
    description:
      "Local open models. Pull your selected model in Ollama before use. Small models are a lightweight starting point.",
  });
  llm.push({
    id: "custom",
    name: "OpenAI-compatible server",
    models: [],
    auth: "api-key",
    description:
      "Custom model ID and /v1 endpoint; supports local LM Studio or self-hosted servers.",
  });
  return { stt: STT.map((p) => ({ ...p, models: [...p.models] })), llm };
}

function runProcess(
  command: string,
  args: string[],
  timeout: number,
  progress?: (s: string) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let errorTail = "";
    let timedOut = false;
    let tooLarge = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    timer.unref();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 32 * 1024 * 1024) {
        tooLarge = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      errorTail = (errorTail + chunk.toString()).slice(-1500);
      // Only our own progress lines are forwarded, never arbitrary dependency stderr.
      for (const line of chunk.toString().split("\n"))
        if (
          /^(Transcribed \d+ of \d+ seconds|Loading Whisper model)/.test(line)
        )
          progress?.(line.trim());
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          `Cannot start ${path.basename(command)}. Install the local dependencies and check Settings.`,
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut)
        reject(
          new Error(
            "Audio processing timed out. Try a shorter recording or a smaller local model.",
          ),
        );
      else if (tooLarge)
        reject(
          new Error(
            "Transcript exceeded the supported size. Split the recording into smaller files.",
          ),
        );
      else if (code !== 0)
        reject(
          new Error(
            errorTail.includes("Install local transcription:")
              ? "Local Whisper is not installed. Run the local setup command and select its Python executable in Settings."
              : `${path.basename(command)} could not process the recording. Check the audio format, local dependencies, model download connectivity, and free disk space.`,
          ),
        );
      else resolve(stdout);
    });
  });
}
export async function probeAudioDuration(filePath: string): Promise<number> {
  const result = await runProcess(
    "ffprobe",
    [
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "wav,mp3,mov,matroska,webm,ogg,flac,aac,mpeg,aiff",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    60_000,
  );
  let duration = Number(result.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    // MediaRecorder WebM often lacks a duration header. Decode audio to a null sink
    // and use ffmpeg's final media clock, without writing a large temporary file.
    const decoded = await runProcess(
      "ffmpeg",
      [
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "wav,mp3,mov,matroska,webm,ogg,flac,aac,mpeg,aiff",
        "-v",
        "error",
        "-i",
        filePath,
        "-map",
        "0:a:0",
        "-vn",
        "-f",
        "null",
        "-",
        "-progress",
        "pipe:1",
        "-nostats",
      ],
      10 * 60_000,
    );
    const clocks = [...decoded.matchAll(/^out_time_us=(\d+)$/gm)].map(
      (m) => Number(m[1]) / 1_000_000,
    );
    duration = Math.max(0, ...clocks);
  }
  if (!Number.isFinite(duration) || duration <= 0)
    throw new Error(
      "Could not read this audio recording’s duration. Convert it to WAV or MP3 and upload again.",
    );
  return duration;
}

function cleanWords(
  values: unknown[],
  duration: number,
): (Word & { speaker?: string })[] {
  return values
    .map((value) => {
      const w = obj(value);
      const text = (
        str(w.punctuated_word) ||
        str(w.word) ||
        str(w.text)
      ).trim();
      if (
        !text ||
        !finite(w.start) ||
        !finite(w.end) ||
        w.end < w.start ||
        w.end < 0 ||
        w.start > duration ||
        w.type === "audio_event"
      )
        return undefined;
      const speaker = w.speaker_id ?? w.speaker;
      return {
        text,
        start: Math.max(0, w.start),
        end: Math.min(duration, w.end),
        ...(typeof speaker === "string" || finite(speaker)
          ? { speaker: `Speaker ${speaker}` }
          : {}),
      };
    })
    .filter((v): v is Word & { speaker?: string } => !!v)
    .sort((a, b) => a.start - b.start);
}
function groupWords(words: (Word & { speaker?: string })[]): Segment[] {
  const groups: Segment[] = [];
  let group: typeof words = [];
  const flush = () => {
    if (!group.length) return;
    groups.push({
      id: `seg-${groups.length}`,
      start: group[0].start,
      end: Math.max(...group.map((w) => w.end)),
      text: group.map((w) => w.text).join(" "),
      words: group.map(({ text, start, end }) => ({ text, start, end })),
      ...(group[0].speaker ? { speaker: group[0].speaker } : {}),
    });
    group = [];
  };
  for (const word of words) {
    if (
      group.length &&
      (word.start - group.at(-1)!.end > 1.2 ||
        word.speaker !== group[0].speaker ||
        group.length >= 24 ||
        word.end - group[0].start > 15)
    )
      flush();
    group.push(word);
    if (group.length >= 6 && /[.!?]$/.test(word.text)) flush();
  }
  flush();
  return groups;
}
/** Preserve only timestamps actually returned by a provider. Text-only fallback is explicitly estimated. */
export function normalizeTranscript(
  payload: unknown,
  duration: number,
): Transcript {
  const data = obj(payload);
  const alternative = obj(
    arr(obj(arr(obj(data.results).channels)[0]).alternatives)[0],
  );
  const words = cleanWords(
    arr(data.words).length ? arr(data.words) : arr(alternative.words),
    duration,
  );
  if (words.length)
    return { segments: groupWords(words), duration, timing: "word" };
  const segments = arr(data.segments)
    .map((value) => {
      const s = obj(value);
      const text = str(s.text).trim();
      if (
        !text ||
        !finite(s.start) ||
        !finite(s.end) ||
        s.end < s.start ||
        s.start > duration
      )
        return undefined;
      const speaker = s.speaker_id ?? s.speaker;
      return {
        id: "",
        start: Math.max(0, s.start),
        end: Math.min(duration, Math.max(0, s.end)),
        text,
        words: cleanWords(arr(s.words), duration),
        ...(typeof speaker === "string" || finite(speaker)
          ? { speaker: `Speaker ${speaker}` }
          : {}),
      } as Segment;
    })
    .filter((s): s is Segment => !!s)
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ ...s, id: `seg-${i}` }));
  if (segments.length)
    return {
      segments,
      duration,
      timing: segments.every((s) => s.words.length > 0) ? "word" : "segment",
    };
  const text = (str(data.text) || str(alternative.transcript)).trim();
  if (!text) return { segments: [], duration, timing: "segment" };
  const tokens = text.split(/\s+/);
  const estimated = tokens.map((text, i) => ({
    text,
    start: (i / tokens.length) * duration,
    end: ((i + 1) / tokens.length) * duration,
  }));
  return { segments: groupWords(estimated), duration, timing: "estimated" };
}

async function requestJson(
  url: string,
  init: RequestInit,
  provider: string,
  timeout = 10 * 60_000,
): Promise<RecordValue> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new Error(
      `${provider} could not be reached or the request timed out. Check connectivity and provider settings.`,
    );
  }
  if (!response.ok) {
    const tip =
      response.status === 401 || response.status === 403
        ? "Check your API key or account access."
        : response.status === 429
          ? "Provider rate limit or quota reached. Try again later."
          : response.status === 413
            ? "Audio chunk is larger than this provider accepts."
            : response.status === 400 || response.status === 404
              ? "Check that this model supports the selected API and your account has access."
              : "Try again or choose another provider.";
    await response.body?.cancel();
    throw new Error(`${provider} returned HTTP ${response.status}. ${tip}`);
  }
  const raw = await response.text();
  if (raw.length > 16 * 1024 * 1024)
    throw new Error(`${provider} returned an oversized response.`);
  try {
    return obj(JSON.parse(raw));
  } catch {
    throw new Error(`${provider} returned an invalid JSON response.`);
  }
}
export async function transcribeCloudChunk(
  filePath: string,
  duration: number,
  settings: Settings,
  key: string,
): Promise<Transcript> {
  const { provider, model, language } = settings.stt;
  const audio = await readFile(filePath);
  const form = new FormData();
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  let endpoint = "";
  if (provider === "google") {
    const payload = await requestJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Transcribe all speech in this recording verbatim${language ? ` in language ${language}` : " in its original language"}. Return only the transcript, no analysis or markdown. If no speech is audible, return an empty string.`,
                },
                {
                  inline_data: {
                    mime_type: "audio/wav",
                    data: audio.toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: { temperature: 0 },
        }),
      },
      provider,
    );
    const candidate = obj(arr(payload.candidates)[0]);
    const text = arr(obj(candidate.content).parts)
      .map((p) => str(obj(p).text))
      .join("\n");
    if (
      obj(payload.promptFeedback).blockReason ||
      candidate.finishReason === "SAFETY"
    )
      throw new Error(
        "Google could not transcribe this recording because its content filter blocked the request.",
      );
    return normalizeTranscript({ text }, duration);
  }
  if (provider === "openrouter") {
    return normalizeTranscript(
      await requestJson(
        "https://openrouter.ai/api/v1/audio/transcriptions",
        {
          method: "POST",
          headers: {
            ...headers,
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "AIM Meeting Notes",
          },
          body: JSON.stringify({
            model,
            input_audio: { data: audio.toString("base64"), format: "wav" },
            ...(language ? { language } : {}),
          }),
        },
        provider,
      ),
      duration,
    );
  }
  if (provider === "deepgram") {
    const query = new URLSearchParams({
      model,
      smart_format: "true",
      punctuate: "true",
      diarize: "true",
      utterances: "true",
    });
    if (language) query.set("language", language);
    else query.set("detect_language", "true");
    return normalizeTranscript(
      await requestJson(
        `https://api.deepgram.com/v1/listen?${query}`,
        {
          method: "POST",
          headers: {
            Authorization: `Token ${key}`,
            "Content-Type": "audio/wav",
          },
          body: new Uint8Array(audio),
        },
        provider,
      ),
      duration,
    );
  }
  if (provider === "elevenlabs") {
    endpoint = "https://api.elevenlabs.io/v1/speech-to-text";
    delete headers.Authorization;
    headers["xi-api-key"] = key;
    form.set("model_id", model);
    form.set("timestamps_granularity", "word");
    form.set("diarize", "true");
    form.set("tag_audio_events", "false");
    if (language) form.set("language_code", language);
  } else if (provider === "xai") {
    endpoint = "https://api.x.ai/v1/stt";
    form.set("format", "true");
    form.set("diarize", "true");
    if (language) form.set("language", language);
  } else {
    const bases: Record<string, string> = {
      openai: "https://api.openai.com/v1",
      groq: "https://api.groq.com/openai/v1",
      mistral: "https://api.mistral.ai/v1",
      deepinfra: "https://api.deepinfra.com/v1/openai",
      senseaudio: "https://api.senseaudio.cn/v1",
    };
    if (!bases[provider]) throw new Error("Unsupported speech provider.");
    endpoint = `${bases[provider]}/audio/transcriptions`;
    form.set("model", model);
    if (language) form.set("language", language);
    if (
      provider === "groq" ||
      (provider === "openai" && model === "whisper-1")
    ) {
      form.set("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
    } else if (provider === "openai" && model.includes("diarize")) {
      form.set("response_format", "diarized_json");
      form.set("chunking_strategy", "auto");
    } else if (provider === "mistral") {
      if (!language) form.set("timestamp_granularities", "segment");
    } else form.set("response_format", "json");
  }
  // xAI requires file to follow option fields. Apply the same order everywhere.
  form.set(
    "file",
    new Blob([new Uint8Array(audio)], { type: "audio/wav" }),
    "recording.wav",
  );
  return normalizeTranscript(
    await requestJson(
      endpoint,
      { method: "POST", headers, body: form },
      provider,
    ),
    duration,
  );
}

export async function transcribeAudio(
  filePath: string,
  settings: Settings,
  getKey: GetKey,
  onProgress?: (s: string) => void,
): Promise<Transcript> {
  if (!STT.some((p) => p.id === settings.stt.provider))
    throw new Error("Choose a supported speech provider in Settings.");
  const info = await stat(filePath);
  if (!info.isFile() || info.size === 0)
    throw new Error("This audio file is empty or unavailable.");
  const duration = await probeAudioDuration(filePath);
  if (duration > 8 * 3600)
    throw new Error(
      "Recordings may be up to eight hours long. Split this recording before uploading.",
    );
  if (settings.stt.provider === "local") {
    const python = settings.local.pythonPath || "python3";
    const script = process.env.CADENCE_RESOURCE_DIR
      ? path.join(process.env.CADENCE_RESOURCE_DIR, "scripts/transcribe.py")
      : fileURLToPath(new URL("../scripts/transcribe.py", import.meta.url));
    const raw = await runProcess(
      python,
      [
        script,
        filePath,
        "--model",
        settings.stt.model || settings.local.whisperModel || "base",
        "--language",
        settings.stt.language || "",
      ],
      Math.max(30 * 60_000, duration * 15_000),
      onProgress,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Local Whisper returned an invalid transcript.");
    }
    return normalizeTranscript(parsed, duration);
  }
  const key = await getKey(settings.stt.provider);
  if (!key)
    throw new Error(
      `Add an API key for ${settings.stt.provider} in Settings. Browser LLM sign-in does not authorize speech transcription.`,
    );
  const work = await mkdtemp(path.join(tmpdir(), "aim-transcribe-"));
  try {
    const all: Segment[] = [];
    let timing: Transcript["timing"] = "word";
    const count = Math.ceil(duration / 300);
    for (let index = 0; index < count; index++) {
      const offset = index * 300;
      const length = Math.min(300, duration - offset);
      const chunk = path.join(work, "chunk.wav");
      onProgress?.(`Preparing audio ${index + 1} of ${count}…`);
      await runProcess(
        "ffmpeg",
        [
          "-nostdin",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "wav,mp3,mov,matroska,webm,ogg,flac,aac,mpeg,aiff",
          "-v",
          "error",
          "-y",
          "-ss",
          String(offset),
          "-i",
          filePath,
          "-t",
          String(length),
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          chunk,
        ],
        5 * 60_000,
      );
      onProgress?.(
        `Transcribing audio ${index + 1} of ${count} with ${settings.stt.provider}…`,
      );
      const result = await transcribeCloudChunk(chunk, length, settings, key);
      if (
        result.timing === "estimated" ||
        (result.timing === "segment" && timing === "word")
      )
        timing = result.timing;
      for (const s of result.segments)
        all.push({
          ...s,
          id: `seg-${all.length}`,
          start: s.start + offset,
          end: s.end + offset,
          words: s.words.map((w) => ({
            ...w,
            start: w.start + offset,
            end: w.end + offset,
          })),
          ...(s.speaker && count > 1
            ? { speaker: `${s.speaker} · part ${index + 1}` }
            : {}),
        });
    }
    return { segments: all, duration, timing };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function validateEndpoint(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Enter a valid model server URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    parsed.hostname,
  );
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
  )
    throw new Error(
      "Use HTTPS for remote model servers, or HTTP on localhost. Put credentials in the API key field.",
    );
  if (parsed.search || parsed.hash)
    throw new Error(
      "The model server URL must not contain query parameters or a fragment.",
    );
  return value.replace(/\/+$/, "");
}
export type GenerationOptions = { jsonSchema?: Record<string, unknown> };

export async function generateText(
  system: string,
  prompt: string,
  settings: Settings,
  getKey: GetKey,
  options: GenerationOptions = {},
): Promise<string> {
  const { provider, model: modelId } = settings.llm;
  if (!modelId.trim()) throw new Error("Choose a language model in Settings.");
  if (provider === "ollama") {
    const base = validateEndpoint(
      settings.local.ollamaUrl || "http://127.0.0.1:11434",
    );
    let data: RecordValue;
    try {
      data = await requestJson(
        `${base}/api/chat`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: modelId,
            stream: false,
            think: false,
            ...(options.jsonSchema ? { format: options.jsonSchema } : {}),
            messages: [
              { role: "system", content: system },
              { role: "user", content: prompt },
            ],
            options: {
              temperature: options.jsonSchema ? 0 : 0.2,
              num_ctx: 16384,
              num_predict: 4096,
            },
          }),
        },
        "Ollama",
        10 * 60_000,
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404"))
        throw new Error(
          `Ollama could not find the selected model. Run ollama pull ${modelId} on the Ollama server, then try again.`,
        );
      throw error;
    }
    const result = str(obj(data.message).content).trim();
    if (!result)
      throw new Error(
        "Ollama returned an empty answer. Check that the selected model is installed.",
      );
    return result;
  }
  const key = (await getKey(provider)) || (await getOAuthApiKey(provider));
  let model: Model<Api> | undefined;
  if (provider === "custom") {
    const baseUrl = validateEndpoint(settings.llm.baseUrl);
    model = {
      id: modelId,
      name: modelId,
      provider: "custom",
      api: "openai-completions",
      baseUrl,
      reasoning: false,
      input: ["text"],
      contextWindow: 32768,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  } else {
    if (
      !getProviders().includes(provider as KnownProvider) ||
      !providerCatalog().llm.some((p) => p.id === provider)
    )
      throw new Error("Choose a supported language-model provider.");
    model = getModels(provider as KnownProvider).find((m) => m.id === modelId);
    if (!model)
      throw new Error(
        "This model is not in the installed catalog. Choose a listed model or use a custom OpenAI-compatible server.",
      );
    model = await getOAuthModel(model);
  }
  if (!key && provider !== "custom")
    throw new Error(
      `Connect ${provider} in Settings using an API key or supported browser sign-in.`,
    );
  try {
    const answer = await complete(
      model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey: key || "local-no-key",
        maxTokens: Math.min(4096, model.maxTokens),
        signal: AbortSignal.timeout(5 * 60_000),
        timeoutMs: 5 * 60_000,
        maxRetries: 1,
      },
    );
    if (answer.stopReason === "error" || answer.stopReason === "aborted")
      throw new Error("Provider failure");
    const text = answer.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("Empty response");
    return text;
  } catch {
    throw new Error(
      `${provider} could not generate an answer. Check your selected model, credentials, quota, and connectivity, then try again.`,
    );
  }
}
