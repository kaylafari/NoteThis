import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { rename, rm, access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Meeting, Health } from '../shared/types.js';
import { Store, type SecretCodec } from './storage.js';
import { providerCatalog, transcribeAudio } from './providers.js';
import { configureOAuthStorage, getOAuthConnections, getOAuthState, startOAuth, submitOAuthInput, disconnectOAuth } from './oauth.js';
import { summarize, answerQuestion } from './intelligence.js';
const exec = promisify(execFile);
export type ServerOptions = { port?: number; dataDir?: string; desktop?: boolean; staticDir?: string; secretCodec?: SecretCodec };
const modelSchema = z.string().trim().min(1).max(200);
const settingsSchema = z.object({ stt: z.object({ provider: modelSchema, model: modelSchema, language: z.string().max(20) }).optional(), llm: z.object({ provider: modelSchema, model: modelSchema, baseUrl: z.string().max(1000) }).optional(), local: z.object({ whisperModel: modelSchema, pythonPath: z.string().min(1).max(1000), ollamaUrl: z.string().url().max(1000) }).optional(), apiKeys: z.record(z.string().max(20000)).optional() }).strict();
async function commandWorks(command: string, args: string[]) { try { await exec(command, args, { timeout: 12000 }); return true; } catch { return false; } }
function safeError(error: unknown) { const message = error instanceof Error ? error.message : 'An unexpected error occurred.'; return message.replace(/(?:sk-|gsk_)[\w-]{8,}/g, '[redacted]').slice(0, 800); }
export async function startServer(options: ServerOptions = {}) {
  const dataDir = options.dataDir || process.env.CADENCE_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Cadence');
  const store = new Store(dataDir, options.secretCodec); await store.init();
  configureOAuthStorage({ read: async () => JSON.parse(await store.getSecret('oauth') || '{}'), write: async (value: unknown) => { await store.setSecret('oauth', JSON.stringify(value)); } });
  const app = express(); app.disable('x-powered-by');
  const allowedHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.hostname)) return res.status(403).json({ error: 'Local requests only.' });
    const origin = req.get('origin');
    if (origin) { try { const url = new URL(origin); if (!allowedHosts.has(url.hostname) || !['http:', 'https:'].includes(url.protocol)) return res.status(403).json({ error: 'Untrusted origin.' }); } catch { return res.status(403).json({ error: 'Untrusted origin.' }); } }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) { res.setHeader('Cache-Control', 'no-store'); if (!['GET', 'HEAD'].includes(req.method) && req.get('X-Meeting-App') !== '1') return res.status(403).json({ error: 'Missing application request header.' }); }
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  const upload = multer({ dest: path.join(dataDir, 'uploads'), limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 3 } });
  const busy = new Set<string>(); let queue: Promise<void> = Promise.resolve();
  const getKey = (provider: string) => store.getSecret(`api:${provider}`);
  const getMeeting = async (id: string) => { const m = await store.get(id); if (!m) throw Object.assign(new Error('Meeting not found.'), { status: 404 }); return m; };
  const idle = (id: string) => { if (busy.has(id)) throw Object.assign(new Error('This meeting is still processing. Please wait.'), { status: 409 }); };
  async function background(id: string, kind: 'transcribing' | 'summarizing') {
    idle(id); let meeting = await getMeeting(id);
    if (kind === 'summarizing' && !meeting.segments.length) throw Object.assign(new Error('Transcribe this meeting first.'), { status: 400 });
    busy.add(id); meeting.status = kind; meeting.progress = 'Queued for processing'; delete meeting.error; await store.save(meeting);
    const work = async () => {
      const settings = await store.getSettings();
      const updateProgress = (progress: string) => { meeting.progress = progress; };
      const timer = setInterval(() => { void store.get(id).then(latest => latest && store.save({ ...latest, progress: meeting.progress })).catch(() => {}); }, 1500);
      try {
        if (kind === 'transcribing') {
          updateProgress('Preparing audio and transcription model');
          const result = await transcribeAudio(path.join(store.audioDir, meeting.audioFile), settings, getKey, updateProgress);
          meeting = { ...meeting, ...result, sttProvider: settings.stt.provider, insight: undefined, messages: [] };
          if (!meeting.segments.length) throw new Error('No speech was detected. Your audio is saved; check it and try another model or language.');
          meeting.status = 'summarizing'; meeting.progress = 'Transcription saved. Creating meeting notes'; await store.save(meeting);
        }
        meeting.insight = await summarize(meeting.segments, settings, getKey, updateProgress); meeting.status = 'ready';
      } catch (error) { meeting.status = 'error'; meeting.error = safeError(error); }
      finally { clearInterval(timer); delete meeting.progress; await store.save(meeting); busy.delete(id); }
    };
    queue = queue.then(work, work).catch(() => { busy.delete(id); });
    return meeting;
  }
  app.get('/api/providers', (_req, res) => res.json(providerCatalog()));
  app.get('/api/settings', async (_req, res) => res.json({ ...await store.getSettings(), oauthConnections: await getOAuthConnections() }));
  app.put('/api/settings', async (req, res) => { const update = settingsSchema.parse(req.body); const catalog = providerCatalog(); if (update.stt && !catalog.stt.some(p => p.id === update.stt!.provider)) throw new Error('Unknown transcription provider.'); if (update.llm && !catalog.llm.some(p => p.id === update.llm!.provider)) throw new Error('Unknown language model provider.'); res.json({ ...await store.updateSettings(update), oauthConnections: await getOAuthConnections() }); });
  app.get('/api/health', async (_req, res) => {
    const settings = await store.getSettings(); let ollama = false; let ollamaModels: string[] = [];
    try { const response = await fetch(`${settings.local.ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(2500) }); if (response.ok) { const value = await response.json() as any; ollamaModels = (value.models || []).map((m: any) => m.name); ollama = true; } } catch {}
    const [ffmpeg, python, whisper] = await Promise.all([commandWorks('ffmpeg', ['-version']), commandWorks(settings.local.pythonPath, ['--version']), commandWorks(settings.local.pythonPath, ['-c', 'import faster_whisper'])]);
    res.json({ ok: true, ffmpeg, python, whisper, ollama, ollamaModels, dataDir, desktop: !!options.desktop } satisfies Health);
  });
  app.get('/api/meetings', async (_req, res) => res.json(await store.list()));
  app.get('/api/meetings/:id', async (req, res) => res.json(await getMeeting(req.params.id)));
  app.post('/api/meetings', upload.single('audio'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an audio file.' });
    let saved = false;
    try {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (!['.wav', '.mp3', '.mp4', '.m4a', '.webm', '.ogg', '.flac', '.aac', '.mpeg', '.mpga', '.opus', '.aiff'].includes(ext)) throw Object.assign(new Error('Unsupported audio format. Choose WAV, MP3, M4A, WebM, OGG, FLAC, AAC, MP4, or AIFF.'), { status: 400 });
      let duration = 0;
      try { const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', req.file.path], { timeout: 20000 }); duration = Number(stdout.trim()); if (!Number.isFinite(duration) || duration < 0) duration = 0; }
      catch { throw Object.assign(new Error('This file could not be read as audio. Install ffmpeg and check the recording.'), { status: 400 }); }
      const id = randomUUID(); const audioFile = `${id}${ext}`; await rename(req.file.path, path.join(store.audioDir, audioFile)); saved = true;
      const meeting: Meeting = { id, title: String(req.body.title || path.basename(req.file.originalname, ext) || 'Untitled meeting').trim().slice(0, 160), createdAt: new Date().toISOString(), duration, status: 'ready', audioFile, segments: [], messages: [] };
      await store.save(meeting); res.status(201).json(meeting);
    } finally { if (!saved) await rm(req.file.path, { force: true }); }
  });
  app.patch('/api/meetings/:id', async (req, res) => { idle(req.params.id); const update = z.object({ title: z.string().trim().min(1).max(160) }).parse(req.body); res.json(await store.save({ ...await getMeeting(req.params.id), ...update })); });
  app.delete('/api/meetings/:id', async (req, res) => { idle(req.params.id); await getMeeting(req.params.id); await store.remove(req.params.id); res.json({ ok: true }); });
  app.get('/api/meetings/:id/audio', async (req, res) => { const m = await getMeeting(req.params.id); res.sendFile(path.join(store.audioDir, path.basename(m.audioFile))); });
  app.post('/api/meetings/:id/transcribe', async (req, res) => res.status(202).json(await background(req.params.id, 'transcribing')));
  app.post('/api/meetings/:id/summarize', async (req, res) => res.status(202).json(await background(req.params.id, 'summarizing')));
  app.patch('/api/meetings/:id/actions/:actionId', async (req, res) => { idle(req.params.id); const { done } = z.object({ done: z.boolean() }).parse(req.body); const m = await getMeeting(req.params.id); const action = m.insight?.actions.find(a => a.id === req.params.actionId); if (!action) return res.status(404).json({ error: 'Action not found.' }); action.done = done; res.json(await store.save(m)); });
  app.post('/api/meetings/:id/chat', async (req, res) => {
    const { message } = z.object({ message: z.string().trim().min(1).max(4000) }).parse(req.body); idle(req.params.id); const meeting = await getMeeting(req.params.id);
    if (!meeting.segments.length) return res.status(400).json({ error: 'Transcribe the audio before asking questions.' });
    busy.add(meeting.id);
    try { const reply = await answerQuestion(meeting.segments, message, meeting.messages, await store.getSettings(), getKey); meeting.messages.push({ id: randomUUID(), role: 'user', text: message, createdAt: new Date().toISOString() }, reply); await store.save(meeting); res.json(reply); } finally { busy.delete(meeting.id); }
  });
  app.post('/api/oauth/:provider/start', (req, res) => res.json(startOAuth(req.params.provider)));
  app.get('/api/oauth/session/:id', (req, res) => { const state = getOAuthState(req.params.id); if (!state) return res.status(404).json({ error: 'Login session expired.' }); res.json(state); });
  app.post('/api/oauth/session/:id/input', async (req, res) => { const { text } = z.object({ text: z.string().min(1).max(8000) }).parse(req.body); await submitOAuthInput(req.params.id, text); res.json(getOAuthState(req.params.id)); });
  app.delete('/api/oauth/:provider', async (req, res) => { await disconnectOAuth(req.params.provider); res.json({ ok: true }); });
  app.get('/api/meetings/:id/export', async (req, res) => { const m = await getMeeting(req.params.id); res.setHeader('Content-Disposition', `attachment; filename="meeting-${m.id}.md"`); res.type('text/markdown').send(`# ${m.title}\n\n${m.insight?.summary || ''}\n\n## Actions\n${m.insight?.actions.map(a => `- [${a.done ? 'x' : ' '}] ${a.text}${a.owner ? ' — ' + a.owner : ''}${a.due ? ' (' + a.due + ')' : ''}`).join('\n') || ''}\n\n## Transcript\n${m.segments.map(s => `[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, '0')}] ${s.text}`).join('\n\n')}`); });
  const staticDir = options.staticDir || path.resolve('dist');
  try { await access(path.join(staticDir, 'index.html')); app.use(express.static(staticDir)); app.get('/', (_req, res) => res.sendFile(path.join(staticDir, 'index.html'))); } catch {}
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const status = error instanceof z.ZodError ? 400 : error instanceof multer.MulterError ? 413 : error.status || 500; res.status(status).json({ error: error instanceof z.ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : safeError(error) }); });
  const server = await new Promise<import('node:http').Server>((resolve, reject) => { const instance = app.listen(options.port ?? Number(process.env.PORT || 4318), '127.0.0.1', () => resolve(instance)); instance.on('error', reject); });
  return { port: (server.address() as import('node:net').AddressInfo).port, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer().then(({ port }) => console.log(`Cadence listening at http://127.0.0.1:${port}`)).catch(error => { console.error(safeError(error)); process.exitCode = 1; });
