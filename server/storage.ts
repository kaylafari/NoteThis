import {
  mkdir,
  readFile,
  writeFile,
  rename,
  readdir,
  rm,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import { decodeVisual, visualFilename } from "./visual-storage.js";
import type { Meeting, Settings, SettingsUpdate } from "../shared/types.js";

export type SecretCodec = {
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
};
export const defaultSettings: Settings = {
  stt: { provider: "local", model: "base", language: "" },
  llm: {
    provider: "ollama",
    model: "qwen3:0.6b",
    baseUrl: "",
    webSearch: false,
    summaryDiagrams: false,
  },
  local: {
    whisperModel: "base",
    pythonPath: ".venv/bin/python",
    ollamaUrl: "http://127.0.0.1:11434",
  },
  configuredKeys: [],
  oauthConnections: [],
};
export async function atomicJson(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, file);
}
async function json<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}
export class Store {
  readonly meetingsDir: string;
  readonly audioDir: string;
  readonly visualsDir: string;
  private settings!: Settings;
  private secrets: Record<string, string> = {};
  private key!: Buffer;
  private secretQueue: Promise<void> = Promise.resolve();
  constructor(
    readonly dataDir: string,
    private codec?: SecretCodec,
  ) {
    this.meetingsDir = path.join(dataDir, "meetings");
    this.audioDir = path.join(dataDir, "audio");
    this.visualsDir = path.join(dataDir, "visuals");
  }
  async init() {
    for (const dir of [
      this.dataDir,
      this.meetingsDir,
      this.audioDir,
      this.visualsDir,
      path.join(this.dataDir, "uploads"),
    ]) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700);
    }
    this.settings = {
      ...structuredClone(defaultSettings),
      ...(await json<Partial<Settings>>(
        path.join(this.dataDir, "settings.json"),
        {},
      )),
    };
    this.settings.llm = { ...defaultSettings.llm, ...this.settings.llm };
    this.normalizeFeatureConsent();
    this.secrets = await json(path.join(this.dataDir, "secrets.json"), {});
    const keyPath = path.join(this.dataDir, "secret.key");
    try {
      this.key = await readFile(keyPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.key = randomBytes(32);
      await writeFile(keyPath, this.key, { mode: 0o600, flag: "wx" });
    }
    for (const meeting of await this.list())
      if (["transcribing", "summarizing"].includes(meeting.status)) {
        meeting.status = "error";
        meeting.error =
          "Processing was interrupted when the app closed. Your audio is safe; retry processing.";
        delete meeting.progress;
        await this.save(meeting);
      }
  }
  async list(): Promise<Meeting[]> {
    const files = (await readdir(this.meetingsDir)).filter((f) =>
      f.endsWith(".json"),
    );
    const results = await Promise.all(
      files.map(async (f) => {
        try {
          const meeting = await json<Meeting | null>(
            path.join(this.meetingsDir, f),
            null,
          );
          return meeting ? this.withVisualUrls(meeting) : null;
        } catch {
          return null;
        }
      }),
    );
    return results
      .filter((m): m is Meeting => !!m)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private file(id: string) {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid meeting ID");
    return path.join(this.meetingsDir, `${id}.json`);
  }
  private withVisualUrls(meeting: Meeting): Meeting {
    for (const visual of meeting.insight?.visuals || []) {
      delete visual.imageUrl;
      try {
        if (visual.imageFile === visualFilename(meeting.id, visual))
          visual.imageUrl = `/api/meetings/${meeting.id}/visuals/${visual.id}`;
      } catch {
        delete visual.imageUrl;
      }
    }
    return meeting;
  }
  async get(id: string) {
    const meeting = await json<Meeting | null>(this.file(id), null);
    return meeting ? this.withVisualUrls(meeting) : null;
  }
  async save(meeting: Meeting) {
    const previous = await this.get(meeting.id);
    const visuals = meeting.insight?.visuals || [];
    if (visuals.length > 1)
      throw new Error("Only one summary diagram is supported per meeting.");
    for (const visual of visuals) {
      const filename = visualFilename(meeting.id, visual);
      if (visual.dataUrl) {
        const buffer = decodeVisual(visual);
        const temporary = path.join(
          this.visualsDir,
          `${filename}.${randomUUID()}.tmp`,
        );
        await writeFile(temporary, buffer, { mode: 0o600 });
        await rename(temporary, path.join(this.visualsDir, filename));
        visual.imageFile = filename;
        delete visual.dataUrl;
      } else if (visual.imageFile !== filename)
        throw new Error("Invalid summary image file.");
      delete visual.imageUrl;
    }
    await atomicJson(this.file(meeting.id), meeting);
    const retained = new Set(visuals.map((visual) => visual.imageFile));
    for (const visual of previous?.insight?.visuals || []) {
      try {
        const filename = visualFilename(meeting.id, visual);
        if (visual.imageFile === filename && !retained.has(filename))
          await rm(path.join(this.visualsDir, filename), { force: true });
      } catch {
        /* Keep a malformed old reference from preventing a save. */
      }
    }
    return this.withVisualUrls(meeting);
  }
  async getVisual(id: string, visualId: string) {
    const meeting = await this.get(id);
    const visual = meeting?.insight?.visuals?.find(
      (item) => item.id === visualId,
    );
    if (!visual || visual.imageFile !== visualFilename(id, visual)) return null;
    try {
      return {
        data: await readFile(path.join(this.visualsDir, visual.imageFile)),
        mimeType: visual.mimeType,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async remove(id: string) {
    const m = await this.get(id);
    for (const visual of m?.insight?.visuals || []) {
      const filename = visualFilename(id, visual);
      if (visual.imageFile === filename)
        await rm(path.join(this.visualsDir, filename), { force: true });
    }
    if (m)
      await rm(path.join(this.audioDir, path.basename(m.audioFile)), {
        force: true,
      });
    await rm(this.file(id), { force: true });
  }
  private normalizeFeatureConsent() {
    const llm = this.settings.llm;
    if (
      llm.webSearch !== true ||
      llm.webSearchConsentProvider !== llm.provider
    ) {
      llm.webSearch = false;
      delete llm.webSearchConsentProvider;
    }
    if (
      llm.summaryDiagrams !== true ||
      llm.summaryDiagramsConsentProvider !== llm.provider
    ) {
      llm.summaryDiagrams = false;
      delete llm.summaryDiagramsConsentProvider;
    }
  }
  async getSettings(): Promise<Settings> {
    return {
      ...structuredClone(this.settings),
      configuredKeys: Object.keys(this.secrets)
        .filter((k) => k.startsWith("api:"))
        .map((k) => k.slice(4)),
      oauthConnections: [],
    };
  }
  async updateSettings(update: SettingsUpdate) {
    if (update.apiKeys)
      for (const [provider, value] of Object.entries(update.apiKeys))
        await this.setSecret(`api:${provider}`, value);
    this.settings = {
      ...this.settings,
      ...(update.stt ? { stt: update.stt } : {}),
      ...(update.llm ? { llm: { ...this.settings.llm, ...update.llm } } : {}),
      ...(update.local ? { local: update.local } : {}),
    };
    this.normalizeFeatureConsent();
    await atomicJson(path.join(this.dataDir, "settings.json"), {
      stt: this.settings.stt,
      llm: this.settings.llm,
      local: this.settings.local,
    });
    return this.getSettings();
  }
  async getSecret(name: string): Promise<string | undefined> {
    const value = this.secrets[name];
    if (!value) return undefined;
    if (value.startsWith("os:")) {
      if (!this.codec)
        throw new Error(
          "This credential is protected by the desktop app. Open NoteThis desktop to use it.",
        );
      return this.codec.decrypt(value.slice(3));
    }
    const [iv, tag, data] = value
      .slice(4)
      .split(":")
      .map((x) => Buffer.from(x, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  }
  async setSecret(name: string, value: string) {
    const work = this.secretQueue.then(async () => {
      if (!value) delete this.secrets[name];
      else if (this.codec)
        this.secrets[name] = `os:${this.codec.encrypt(value)}`;
      else {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const data = Buffer.concat([
          cipher.update(value, "utf8"),
          cipher.final(),
        ]);
        this.secrets[name] =
          `aes:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
      }
      await atomicJson(path.join(this.dataDir, "secrets.json"), this.secrets);
    });
    this.secretQueue = work.catch(() => {});
    return work;
  }
}
