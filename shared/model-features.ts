/** Provider transports implemented by NoteThis; metadata must ALSO permit use. */
export function supportsWebSearch(provider: string): boolean {
  return ["openai-codex", "openrouter", "openai"].includes(provider);
}
export function supportsImageOutput(provider: string): boolean {
  return provider === "openrouter";
}
