export type Word = { text: string; start: number; end: number };
export type Segment = {
  id: string;
  start: number;
  end: number;
  text: string;
  speaker?: string;
  words: Word[];
};
export type ActionItem = {
  id: string;
  text: string;
  owner?: string;
  due?: string;
  done: boolean;
  segmentId?: string;
};
export type SummaryVisual = {
  id: string;
  title: string;
  description: string;
  mimeType: string;
  dataUrl?: string;
  imageFile?: string;
  imageUrl?: string;
};
export type Insight = {
  summary: string;
  /** Absent on older, plain-text summaries. */
  summaryFormat?: "latex";
  decisions: string[];
  actions: ActionItem[];
  visuals?: SummaryVisual[];
  visualError?: string;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: string[];
  webSources?: { title: string; url: string }[];
  webSearchUsed?: boolean;
  createdAt: string;
};
export type Meeting = {
  id: string;
  title: string;
  createdAt: string;
  duration: number;
  status: "ready" | "transcribing" | "summarizing" | "error";
  error?: string;
  audioFile: string;
  segments: Segment[];
  insight?: Insight;
  messages: ChatMessage[];
  sttProvider?: string;
  timing?: "word" | "segment" | "estimated";
  progress?: string;
};
export type ProviderOption = {
  id: string;
  name: string;
  models: string[];
  auth: "none" | "api-key" | "oauth" | "api-key-or-oauth";
  description: string;
  supportsWords?: boolean;
};
export type Settings = {
  stt: { provider: string; model: string; language: string };
  llm: {
    provider: string;
    model: string;
    baseUrl: string;
    webSearch?: boolean;
    webSearchConsentProvider?: string;
    summaryDiagrams?: boolean;
    summaryDiagramsConsentProvider?: string;
  };
  local: { whisperModel: string; pythonPath: string; ollamaUrl: string };
  configuredKeys: string[];
  oauthConnections: string[];
};
export type SettingsUpdate = Partial<
  Omit<Settings, "configuredKeys" | "oauthConnections">
> & { apiKeys?: Record<string, string> };
export type ProviderCatalog = { stt: ProviderOption[]; llm: ProviderOption[] };
export type Health = {
  ok: boolean;
  ffmpeg: boolean;
  python: boolean;
  whisper: boolean;
  ollama: boolean;
  ollamaModels: string[];
  dataDir: string;
  desktop: boolean;
};
export type OAuthState = {
  id: string;
  provider: string;
  status: "pending" | "prompt" | "complete" | "error";
  url?: string;
  instructions?: string;
  prompt?: string;
  error?: string;
};

export type ModelCapabilities = {
  /** Null means the connected provider did not report output modalities. */
  outputModalities: string[] | null;
  webSearch: "supported" | "unsupported" | "unknown";
  webSearchNote?: string;
  appWebSearch?: boolean;
  appImageOutput?: boolean;
};

export type ProviderModels = {
  provider: string;
  kind: "llm" | "stt";
  models: string[];
  source: "account" | "local" | "bundled" | "unavailable";
  message: string;
  checkedAt?: string;
  defaultModel?: string;
  capabilities?: Record<string, ModelCapabilities>;
};
