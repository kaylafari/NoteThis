import type {
  Meeting,
  Settings,
  SettingsUpdate,
  ProviderCatalog,
  Health,
  OAuthState,
  ChatMessage,
} from "../shared/types";

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("X-Meeting-App", "1");
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.error || body.message || `Request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}
export const api = {
  meetings: () => request<Meeting[]>("/meetings"),
  meeting: (id: string) => request<Meeting>(`/meetings/${id}`),
  upload: (file: File, title: string) => {
    const body = new FormData();
    body.append("audio", file);
    body.append("title", title);
    return request<Meeting>("/meetings", { method: "POST", body });
  },
  rename: (id: string, title: string) =>
    request<Meeting>(`/meetings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  remove: (id: string) =>
    request<void>(`/meetings/${id}`, { method: "DELETE" }),
  transcribe: (id: string) =>
    request<Meeting>(`/meetings/${id}/transcribe`, { method: "POST" }),
  summarize: (id: string) =>
    request<Meeting>(`/meetings/${id}/summarize`, { method: "POST" }),
  action: (id: string, actionId: string, done: boolean) =>
    request<Meeting>(`/meetings/${id}/actions/${actionId}`, {
      method: "PATCH",
      body: JSON.stringify({ done }),
    }),
  chat: (id: string, message: string) =>
    request<ChatMessage>(`/meetings/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  providers: () => request<ProviderCatalog>("/providers"),
  settings: () => request<Settings>("/settings"),
  saveSettings: (data: SettingsUpdate) =>
    request<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  health: () => request<Health>("/health"),
  demo: () => request<Meeting>("/demo", { method: "POST" }),
  oauth: (provider: string) =>
    request<OAuthState>(`/oauth/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    }),
  disconnectOAuth: (provider: string) =>
    request<{ ok: boolean }>(`/oauth/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    }),
  cancelOAuth: (id: string) =>
    request<{ ok: boolean }>(`/oauth/session/${id}`, { method: "DELETE" }),
  oauthSession: (id: string) => request<OAuthState>(`/oauth/session/${id}`),
  oauthInput: (id: string, text: string) =>
    request<OAuthState>(`/oauth/session/${id}/input`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
};
