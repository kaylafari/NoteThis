import { randomUUID } from "node:crypto";
import {
  getOAuthProvider,
  getOAuthProviders,
  getOAuthApiKey as resolveOAuthKey,
  type OAuthCredentials,
} from "@mariozechner/pi-ai/oauth";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { OAuthState } from "../shared/types.js";

type Credentials = Record<string, OAuthCredentials>;
type Storage = {
  read: () => Promise<Credentials>;
  write: (value: Credentials) => Promise<void>;
};
let storage: Storage | undefined;
let mutation: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutation.then(fn, fn);
  mutation = next.catch(() => undefined);
  return next;
}
function getStorage(): Storage {
  if (!storage) throw new Error("OAuth credential storage is not ready.");
  return storage;
}
export function configureOAuthStorage(adapter: Storage) {
  storage = adapter;
}
type Login = {
  state: OAuthState;
  controller: AbortController;
  input?: {
    resolve: (s: string) => void;
    reject: (e: Error) => void;
    allowEmpty: boolean;
  };
  timer?: ReturnType<typeof setTimeout>;
};
const logins = new Map<string, Login>();
export function startOAuth(provider: string): OAuthState {
  getStorage();
  const adapter = getOAuthProvider(provider);
  if (!adapter)
    throw new Error("This provider does not support browser sign-in.");
  if (
    [...logins.values()].some(
      (l) => l.state.status === "pending" || l.state.status === "prompt",
    )
  )
    throw new Error("Finish or cancel the current browser sign-in first.");
  // Keep only a small recent history. Never retain codes or credentials in public states.
  if (logins.size > 20) logins.delete(logins.keys().next().value!);
  const login: Login = {
    state: { id: randomUUID(), provider, status: "pending" },
    controller: new AbortController(),
  };
  logins.set(login.state.id, login);
  const ask = (prompt: string, allowEmpty = false) =>
    new Promise<string>((resolve, reject) => {
      if (login.controller.signal.aborted) {
        reject(new Error("Cancelled"));
        return;
      }
      login.input = { resolve, reject, allowEmpty };
      login.state.status = "prompt";
      login.state.prompt = prompt;
    });
  login.timer = setTimeout(() => cancelOAuth(login.state.id), 10 * 60_000);
  login.timer.unref();
  void adapter
    .login({
      signal: login.controller.signal,
      onAuth: ({ url, instructions }) => {
        if (login.controller.signal.aborted) return;
        const parsed = new URL(url);
        if (!["https:", "http:"].includes(parsed.protocol))
          throw new Error("Invalid sign-in URL");
        login.state.url = url;
        login.state.instructions = instructions;
        if (!login.input) login.state.status = "pending";
      },
      onPrompt: ({ message, allowEmpty }) => ask(message, allowEmpty),
      onManualCodeInput: () =>
        ask(
          "If sign-in does not return automatically, paste the full callback URL or authorization code here.",
        ),
      onProgress: () => {
        /* Some SDK progress messages contain account identifiers; keep them private. */
      },
    })
    .then(async (credentials) => {
      if (login.controller.signal.aborted) return;
      await serialize(async () => {
        if (login.controller.signal.aborted) return;
        const saved = await getStorage().read();
        saved[provider] = credentials;
        await getStorage().write(saved);
      });
      if (login.controller.signal.aborted) return;
      login.state = { id: login.state.id, provider, status: "complete" };
    })
    .catch(() => {
      if (!login.controller.signal.aborted)
        login.state = {
          id: login.state.id,
          provider,
          status: "error",
          error:
            "Browser sign-in failed. Check your account access and try again.",
        };
    })
    .finally(() => {
      clearTimeout(login.timer);
      login.input = undefined;
    });
  return { ...login.state };
}
export function getOAuthState(id: string): OAuthState | undefined {
  const value = logins.get(id);
  return value ? { ...value.state } : undefined;
}
export function submitOAuthInput(id: string, text: string): void {
  const login = logins.get(id);
  if (!login?.input) throw new Error("This sign-in is not waiting for input.");
  if (!text.trim() && !login.input.allowEmpty)
    throw new Error("Enter the authorization code or callback URL.");
  if (text.length > 16_384) throw new Error("Sign-in input is too long.");
  const { resolve } = login.input;
  login.input = undefined;
  login.state.status = "pending";
  delete login.state.prompt;
  resolve(text.trim());
}
export function cancelOAuth(id: string): void {
  const login = logins.get(id);
  if (!login || ["complete", "error"].includes(login.state.status)) return;
  login.controller.abort();
  login.input?.reject(new Error("Cancelled"));
  login.input = undefined;
  clearTimeout(login.timer);
  login.state = {
    id,
    provider: login.state.provider,
    status: "error",
    error: "Sign-in cancelled or expired.",
  };
}
export async function getOAuthConnections(): Promise<string[]> {
  const saved = await getStorage().read();
  return getOAuthProviders()
    .filter((p) => !!saved[p.id])
    .map((p) => p.id);
}
export async function disconnectOAuth(provider: string): Promise<void> {
  for (const [id, login] of logins)
    if (login.state.provider === provider) cancelOAuth(id);
  await serialize(async () => {
    const saved = await getStorage().read();
    delete saved[provider];
    await getStorage().write(saved);
  });
}
export async function getOAuthApiKey(
  provider: string,
): Promise<string | undefined> {
  if (!getOAuthProvider(provider)) return undefined;
  return serialize(async () => {
    const saved = await getStorage().read();
    if (!saved[provider]) return undefined;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const resolved = await Promise.race([
        resolveOAuthKey(provider, saved),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Refresh timed out")),
            45_000,
          );
          timer.unref();
        }),
      ]).finally(() => clearTimeout(timer));
      if (!resolved) return undefined;
      if (resolved.newCredentials !== saved[provider]) {
        saved[provider] = resolved.newCredentials;
        await getStorage().write(saved);
      }
      return resolved.apiKey;
    } catch {
      throw new Error(
        "Browser credentials expired or could not refresh. Reconnect this provider in Settings.",
      );
    }
  });
}
export async function getOAuthModel(model: Model<Api>): Promise<Model<Api>> {
  const adapter = getOAuthProvider(model.provider);
  if (!adapter?.modifyModels) return model;
  const saved = await getStorage().read();
  const credentials = saved[model.provider];
  return credentials
    ? (adapter.modifyModels([model], credentials)[0] ?? model)
    : model;
}
