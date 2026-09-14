import { mkdir, readFile, writeFile, rename, readdir, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import type { Meeting, Settings, SettingsUpdate } from '../shared/types.js';

export type SecretCodec = { encrypt: (value: string) => string; decrypt: (value: string) => string };
export const defaultSettings: Settings = { stt: { provider: 'local', model: 'base', language: '' }, llm: { provider: 'ollama', model: 'qwen3:0.6b', baseUrl: '' }, local: { whisperModel: 'base', pythonPath: '.venv/bin/python', ollamaUrl: 'http://127.0.0.1:11434' }, configuredKeys: [], oauthConnections: [] };
export async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error; }
}
export class Store {
  readonly meetingsDir: string;
  readonly audioDir: string;
  private settings!: Settings;
  private secrets: Record<string, string> = {};
  private key!: Buffer;
  private secretQueue: Promise<void> = Promise.resolve();
  constructor(readonly dataDir: string, private codec?: SecretCodec) { this.meetingsDir = path.join(dataDir, 'meetings'); this.audioDir = path.join(dataDir, 'audio'); }
  async init() {
    for (const dir of [this.dataDir, this.meetingsDir, this.audioDir, path.join(this.dataDir, 'uploads')]) { await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700); }
    this.settings = { ...structuredClone(defaultSettings), ...await json<Partial<Settings>>(path.join(this.dataDir, 'settings.json'), {}) };
    this.secrets = await json(path.join(this.dataDir, 'secrets.json'), {});
    const keyPath = path.join(this.dataDir, 'secret.key');
    try { this.key = await readFile(keyPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.key = randomBytes(32); await writeFile(keyPath, this.key, { mode: 0o600, flag: 'wx' }); }
    for (const meeting of await this.list()) if (['transcribing', 'summarizing'].includes(meeting.status)) { meeting.status = 'error'; meeting.error = 'Processing was interrupted when the app closed. Your audio is safe; retry processing.'; delete meeting.progress; await this.save(meeting); }
  }
  async list(): Promise<Meeting[]> {
    const files = (await readdir(this.meetingsDir)).filter(f => f.endsWith('.json'));
    const results = await Promise.all(files.map(async f => { try { return await json<Meeting | null>(path.join(this.meetingsDir, f), null); } catch { return null; } }));
    return results.filter((m): m is Meeting => !!m).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private file(id: string) { if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('Invalid meeting ID'); return path.join(this.meetingsDir, `${id}.json`); }
  async get(id: string) { return json<Meeting | null>(this.file(id), null); }
  async save(meeting: Meeting) { await atomicJson(this.file(meeting.id), meeting); return meeting; }
  async remove(id: string) { const m = await this.get(id); if (m) await rm(path.join(this.audioDir, path.basename(m.audioFile)), { force: true }); await rm(this.file(id), { force: true }); }
  async getSettings(): Promise<Settings> { return { ...structuredClone(this.settings), configuredKeys: Object.keys(this.secrets).filter(k => k.startsWith('api:')).map(k => k.slice(4)), oauthConnections: [] }; }
  async updateSettings(update: SettingsUpdate) {
    if (update.apiKeys) for (const [provider, value] of Object.entries(update.apiKeys)) await this.setSecret(`api:${provider}`, value);
    this.settings = { ...this.settings, ...(update.stt ? { stt: update.stt } : {}), ...(update.llm ? { llm: update.llm } : {}), ...(update.local ? { local: update.local } : {}) };
    await atomicJson(path.join(this.dataDir, 'settings.json'), { stt: this.settings.stt, llm: this.settings.llm, local: this.settings.local });
    return this.getSettings();
  }
  async getSecret(name: string): Promise<string | undefined> {
    const value = this.secrets[name]; if (!value) return undefined;
    if (value.startsWith('os:')) { if (!this.codec) throw new Error('This credential is protected by the desktop app. Open Cadence desktop to use it.'); return this.codec.decrypt(value.slice(3)); }
    const [iv, tag, data] = value.slice(4).split(':').map(x => Buffer.from(x, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
  async setSecret(name: string, value: string) {
    const work = this.secretQueue.then(async () => {
      if (!value) delete this.secrets[name];
      else if (this.codec) this.secrets[name] = `os:${this.codec.encrypt(value)}`;
      else { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); this.secrets[name] = `aes:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`; }
      await atomicJson(path.join(this.dataDir, 'secrets.json'), this.secrets);
    });
    this.secretQueue = work.catch(() => {}); return work;
  }
}
