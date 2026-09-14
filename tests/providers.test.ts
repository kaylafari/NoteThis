import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeTranscript, providerCatalog, transcribeCloudChunk, validateEndpoint, generateText } from '../server/providers.js';
import { configureOAuthStorage, startOAuth, submitOAuthInput, getOAuthState, getOAuthConnections, getOAuthApiKey, cancelOAuth, disconnectOAuth } from '../server/oauth.js';
import { registerOAuthProvider, unregisterOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth';
import type { Settings } from '../shared/types.js';
const settings: Settings = { stt: { provider: 'openai', model: 'whisper-1', language: '' }, llm: { provider: 'ollama', model: 'qwen3:0.6b', baseUrl: '' }, local: { whisperModel: 'base', pythonPath: 'python3', ollamaUrl: 'http://127.0.0.1:11434' }, configuredKeys: [], oauthConnections: [] };
const pause = () => new Promise(resolve => setTimeout(resolve, 10));
afterEach(() => { vi.unstubAllGlobals(); });

describe('timestamp integrity', () => {
  it('preserves word times, punctuation, pauses and detected speaker boundaries', () => {
    const result = normalizeTranscript({ results: { channels: [{ alternatives: [{ words: [
      { word: 'hello', punctuated_word: 'Hello,', start: 0.3, end: 0.8, speaker: 0 },
      { word: 'team', punctuated_word: 'team.', start: 0.8, end: 1.1, speaker: 0 },
      { word: 'yes', punctuated_word: 'Yes.', start: 2, end: 2.4, speaker: 1 },
    ] }] }] } }, 5);
    expect(result.timing).toBe('word'); expect(result.segments).toHaveLength(2);
    expect(result.segments[0]).toMatchObject({ start: 0.3, end: 1.1, text: 'Hello, team.', speaker: 'Speaker 0' });
    expect(result.segments[1].words[0].start).toBe(2);
  });
  it('keeps segment-only timestamps without inventing word alignment', () => {
    const result = normalizeTranscript({ segments: [{ start: 4, end: 8, text: 'A short meeting', speaker: 'A' }] }, 10);
    expect(result.timing).toBe('segment'); expect(result.segments[0].words).toEqual([]); expect(result.segments[0].start).toBe(4);
  });
  it('labels text-only timing estimated and keeps it inside duration', () => {
    const result = normalizeTranscript({ text: 'One two three four' }, 8);
    expect(result.timing).toBe('estimated'); expect(result.segments[0].words[2]).toEqual({ text: 'three', start: 4, end: 6 });
  });
  it('rejects malformed timestamps and bounds valid words', () => {
    const result = normalizeTranscript({ words: [{ word: 'valid', start: -1, end: 12 }, { word: 'wrong', start: 8, end: 2 }, { word: 'nan', start: NaN, end: 4 }] }, 10);
    expect(result.segments[0].words).toEqual([{ text: 'valid', start: 0, end: 10 }]);
  });
  it('returns no hallucinated transcript for empty/silent responses', () => {
    expect(normalizeTranscript({ text: '' }, 10).segments).toEqual([]);
  });
  it('preserves local Whisper segment words', () => {
    const result = normalizeTranscript({ segments: [{ start: 0, end: 2, text: 'Hello', words: [{ text: 'Hello', start: 0.4, end: 0.8 }] }] }, 5);
    expect(result.timing).toBe('word'); expect(result.segments[0].words[0].start).toBe(0.4);
  });
});

describe('catalog and endpoint validation', () => {
  it('contains every current OpenClaw batch speech provider and real browser flows', () => {
    const catalog = providerCatalog();
    expect(catalog.stt.map(p => p.id)).toEqual(expect.arrayContaining(['local', 'openai', 'groq', 'deepgram', 'elevenlabs', 'mistral', 'google', 'deepinfra', 'openrouter', 'senseaudio', 'xai']));
    expect(catalog.llm.find(p => p.id === 'openai-codex')?.auth).toBe('oauth');
    expect(catalog.llm.find(p => p.id === 'ollama')?.models).toContain('qwen3:0.6b');
  });
  it('accepts local HTTP and remote HTTPS; rejects credential URLs and remote cleartext', () => {
    expect(validateEndpoint('http://127.0.0.1:11434/')).toBe('http://127.0.0.1:11434');
    expect(validateEndpoint('https://models.example.com/v1')).toBe('https://models.example.com/v1');
    for (const url of ['http://models.example.com', 'https://user:secret@example.com', 'file:///etc/passwd', 'https://example.com?key=secret']) expect(() => validateEndpoint(url)).toThrow();
  });
});

describe('speech adapter wire formats', () => {
  let directory: string; let audio: string; let mock: ReturnType<typeof vi.fn>;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'aim-provider-test-')); audio = path.join(directory, 'sample.wav'); await writeFile(audio, new Uint8Array([82, 73, 70, 70])); mock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: 'test', words: [{ word: 'test', start: 1, end: 2 }] }), { status: 200 })); vi.stubGlobal('fetch', mock); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
  it('requests Whisper verbose JSON plus native word and segment timestamps', async () => {
    await transcribeCloudChunk(audio, 3, settings, 'test-secret');
    const [url, request] = mock.mock.calls[0]; const form = request.body as FormData;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions'); expect(form.get('response_format')).toBe('verbose_json'); expect(form.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
  });
  it('does not request unsupported Whisper timestamps from GPT transcription', async () => {
    await transcribeCloudChunk(audio, 3, { ...settings, stt: { provider: 'openai', model: 'gpt-4o-transcribe', language: 'en' } }, 'key');
    const form = mock.mock.calls[0][1].body as FormData; expect(form.get('response_format')).toBe('json'); expect(form.has('timestamp_granularities[]')).toBe(false);
  });
  it('sends xAI options before the file with native endpoint and no invented model parameter', async () => {
    await transcribeCloudChunk(audio, 3, { ...settings, stt: { provider: 'xai', model: 'grok-stt', language: 'en' } }, 'key');
    const [url, request] = mock.mock.calls[0]; const keys = [...(request.body as FormData).keys()]; expect(url).toBe('https://api.x.ai/v1/stt'); expect(keys.at(-1)).toBe('file'); expect(keys).not.toContain('model');
  });
  it('uses Mistral native timestamp field only when no explicit language is supplied', async () => {
    await transcribeCloudChunk(audio, 3, { ...settings, stt: { provider: 'mistral', model: 'voxtral-mini-latest', language: '' } }, 'key');
    expect((mock.mock.calls[0][1].body as FormData).get('timestamp_granularities')).toBe('segment');
    mock.mockResolvedValue(new Response(JSON.stringify({ text: 'test' })));
    await transcribeCloudChunk(audio, 3, { ...settings, stt: { provider: 'mistral', model: 'voxtral-mini-latest', language: 'en' } }, 'key');
    expect((mock.mock.calls[1][1].body as FormData).has('timestamp_granularities')).toBe(false);
  });
  it('uses OpenRouter JSON/base64 audio rather than a multipart OpenAI request', async () => {
    await transcribeCloudChunk(audio, 3, { ...settings, stt: { provider: 'openrouter', model: 'openai/whisper-large-v3-turbo', language: '' } }, 'key');
    const [url, request] = mock.mock.calls[0]; expect(url).toContain('/api/v1/audio/transcriptions'); expect(JSON.parse(request.body).input_audio).toEqual({ data: 'UklGRg==', format: 'wav' });
  });
  it('redacts provider error bodies and keys', async () => {
    mock.mockResolvedValue(new Response('test-secret is rejected, private account info', { status: 401 }));
    await expect(transcribeCloudChunk(audio, 3, settings, 'test-secret')).rejects.toThrow('HTTP 401');
    try { await transcribeCloudChunk(audio, 3, settings, 'test-secret'); } catch (e) { expect(String(e)).not.toContain('test-secret'); expect(String(e)).not.toContain('private account'); }
  });
  it('uses local Ollama without reading cloud credentials', async () => {
    mock.mockResolvedValue(new Response(JSON.stringify({ message: { content: 'Local answer.' } })));
    const getKey = vi.fn(); expect(await generateText('system', 'question', settings, getKey)).toBe('Local answer.'); expect(getKey).not.toHaveBeenCalled(); expect(JSON.parse(mock.mock.calls[0][1].body).think).toBe(false);
  });
});

describe('app-owned OAuth lifecycle', () => {
  let saved: Record<string, OAuthCredentials>;
  beforeEach(() => {
    saved = {}; configureOAuthStorage({ read: async () => structuredClone(saved), write: async value => { saved = structuredClone(value); } });
    registerOAuthProvider({ id: 'test-oauth', name: 'Test', login: async callbacks => { callbacks.onAuth({ url: 'https://provider.example/login', instructions: 'Use browser.' }); await callbacks.onPrompt({ message: 'Paste code' }); return { access: 'private-token', refresh: 'private-refresh', expires: Date.now() + 60_000 }; }, refreshToken: async credentials => ({ ...credentials, access: 'refreshed-token', expires: Date.now() + 60_000 }), getApiKey: credentials => credentials.access });
  });
  afterEach(() => { unregisterOAuthProvider('test-oauth'); });
  it('publishes only login progress, stores tokens, refreshes, then disconnects', async () => {
    const state = startOAuth('test-oauth'); expect(getOAuthState(state.id)?.status).toBe('prompt'); submitOAuthInput(state.id, 'authorization-code'); await pause();
    expect(getOAuthState(state.id)?.status).toBe('complete'); expect(JSON.stringify(getOAuthState(state.id))).not.toContain('private'); expect(await getOAuthConnections()).toContain('test-oauth'); expect(await getOAuthApiKey('test-oauth')).toBe('private-token');
    saved['test-oauth'].expires = 1; expect(await getOAuthApiKey('test-oauth')).toBe('refreshed-token'); expect(saved['test-oauth'].access).toBe('refreshed-token');
    await disconnectOAuth('test-oauth'); expect(await getOAuthConnections()).not.toContain('test-oauth');
  });
  it('cancels pending flows and rejects empty codes', async () => {
    const state = startOAuth('test-oauth'); expect(() => submitOAuthInput(state.id, '')).toThrow(); cancelOAuth(state.id); await pause(); expect(getOAuthState(state.id)?.status).toBe('error'); expect(saved).toEqual({});
  });
});
