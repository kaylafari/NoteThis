/** Ollama treats an omitted tag as :latest, including names with a registry port. */
export function sameOllamaModel(a: string, b: string): boolean {
  const tagged = (value: string) => {
    const name = value.trim();
    return name.lastIndexOf(":") > name.lastIndexOf("/")
      ? name
      : `${name}:latest`;
  };
  return tagged(a) === tagged(b);
}

export function missingOllamaModelMessage(
  model: string,
  server: string,
): string {
  let bundled = false;
  try {
    const url = new URL(server);
    bundled =
      model === "qwen3:0.6b" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.port === "11434" &&
      ["", "/"].includes(url.pathname);
  } catch {
    /* Invalid endpoints are handled by the provider validator. */
  }
  return `Ollama could not find the selected notes model “${model}”. ${
    bundled
      ? "Open Settings → Local setup and use Prepare local AI (or Verify & repair local AI) to download the default model, or choose an installed model in Settings → AI models."
      : "Install this model on your configured Ollama server, or choose an installed model in Settings → AI models. Local preparation only installs the default model on this computer."
  } Then retry generating notes.`;
}
