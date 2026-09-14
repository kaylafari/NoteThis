import { describe, expect, it, vi, afterEach } from "vitest";
import {
  externalUrl,
  launchExternal,
  registerExternalLinks,
  OPEN_EXTERNAL_CHANNEL,
} from "../desktop/external-links";
import { openExternalLink } from "../src/external-links";
afterEach(() => vi.unstubAllGlobals());
describe("external browser bridge", () => {
  it.each([
    "https://auth.openai.com/oauth/authorize?state=private",
    "https://claude.ai/oauth/authorize",
    "https://github.com/login/device",
    "http://localhost:1455/auth/callback",
  ])("accepts supported login URL %s", (url) =>
    expect(externalUrl(url).href).toBe(url),
  );
  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://example.com",
    "https://user:password@example.com",
    "not a url",
  ])("rejects unsafe link %s", (url) =>
    expect(() => externalUrl(url)).toThrow(),
  );
  it("awaits OS launch and only logs the hostname", async () => {
    const launch = vi.fn(async () => {}),
      report = vi.fn();
    expect(
      await launchExternal(
        "https://auth.openai.com/authorize?code=SECRET",
        launch,
        report,
      ),
    ).toEqual({ ok: true });
    expect(launch).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith({
      event: "browser-open-succeeded",
      host: "auth.openai.com",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain("SECRET");
  });
  it("surfaces launch errors without leaking the URL or raw OS error", async () => {
    const report = vi.fn();
    const result = await launchExternal(
      "https://auth.openai.com/?token=SECRET",
      async () => {
        throw new Error("SECRET");
      },
      report,
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify([result, report.mock.calls])).not.toContain("SECRET");
  });
  it("rejects IPC from an untrusted frame", async () => {
    let handler: any;
    const launch = vi.fn();
    registerExternalLinks(
      {
        handle: ((channel: string, listener: any) => {
          expect(channel).toBe(OPEN_EXTERNAL_CHANNEL);
          handler = listener;
        }) as any,
      },
      () => false,
      launch,
      vi.fn(),
    );
    expect((await handler({}, "https://auth.openai.com")).ok).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
  it("uses the native operation and propagates failures", async () => {
    const openExternal = vi.fn(async () => ({
      ok: false,
      error: "Browser unavailable",
    }));
    vi.stubGlobal("window", { desktop: { isElectron: true, openExternal } });
    await expect(openExternalLink("https://auth.openai.com")).rejects.toThrow(
      "Browser unavailable",
    );
    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com");
  });
  it("detects browser popup blockers", async () => {
    vi.stubGlobal("window", { open: () => null });
    await expect(openExternalLink("https://auth.openai.com")).rejects.toThrow(
      "blocked",
    );
  });
  it("severs opener access before browser navigation", async () => {
    const popup = { opener: {}, location: { href: "about:blank" } };
    vi.stubGlobal("window", { open: () => popup });
    await openExternalLink("https://auth.openai.com");
    expect(popup.opener).toBeNull();
    expect(popup.location.href).toBe("https://auth.openai.com");
  });
});
