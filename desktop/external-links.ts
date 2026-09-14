import type { IpcMain, IpcMainInvokeEvent } from "electron";
export const OPEN_EXTERNAL_CHANNEL = "cadence:open-external";
export type OpenExternalResult = { ok: true } | { ok: false; error: string };
export function externalUrl(value: unknown): URL {
  if (typeof value !== "string" || value.length > 16384)
    throw new Error("Invalid browser link.");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "Only secure web links or local sign-in callbacks can be opened.",
    );
  return url;
}
export async function launchExternal(
  value: unknown,
  launch: (url: string) => Promise<void>,
  report: (event: { event: string; host?: string }) => void,
): Promise<OpenExternalResult> {
  let url: URL;
  try {
    url = externalUrl(value);
  } catch {
    return {
      ok: false,
      error: "This browser link is invalid or uses an unsupported address.",
    };
  }
  try {
    await launch(url.href);
    report({ event: "browser-open-succeeded", host: url.hostname });
    return { ok: true };
  } catch {
    // Never log URL queries, authorization codes, tokens, or raw OS errors.
    report({ event: "browser-open-failed", host: url.hostname });
    return {
      ok: false,
      error:
        "Your browser could not be opened. Copy the sign-in link below and paste it into your browser.",
    };
  }
}
export function registerExternalLinks(
  ipc: Pick<IpcMain, "handle">,
  trusted: (event: IpcMainInvokeEvent) => boolean,
  launch: (url: string) => Promise<void>,
  report: (event: { event: string; host?: string }) => void,
) {
  ipc.handle(
    OPEN_EXTERNAL_CHANNEL,
    async (event, url: unknown): Promise<OpenExternalResult> => {
      if (!trusted(event))
        return {
          ok: false,
          error: "Browser links must be opened from the Cadence window.",
        };
      return launchExternal(url, launch, report);
    },
  );
}
