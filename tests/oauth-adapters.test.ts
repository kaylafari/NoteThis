import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const serverFixtures: any[] = [];
let createServerSpy: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  // pi-ai is externalized by Vitest, so replace the actual Node export as well
  // as its ESM binding. No callback ports are opened by these fixtures.
  createServerSpy = vi.spyOn(http, "createServer").mockImplementation(((
    handler: unknown,
  ) => {
    const fixture: any = {
      handler,
      close: vi.fn(),
      listen: vi.fn(),
      on: vi.fn(),
    };
    fixture.listen.mockImplementation(
      (_port: number, _host: string, ready: () => void) => {
        queueMicrotask(ready);
        return fixture;
      },
    );
    fixture.on.mockReturnValue(fixture);
    serverFixtures.push(fixture);
    return fixture;
  }) as typeof http.createServer);
  syncBuiltinESMExports();
});
afterAll(() => {
  createServerSpy.mockRestore();
  syncBuiltinESMExports();
});
import {
  startOAuth,
  cancelOAuth,
  configureOAuthStorage,
  getOAuthState,
  getOAuthConnections,
  getOAuthApiKey,
  submitOAuthInput,
} from "../server/oauth.js";
import type { OAuthCredentials } from "@mariozechner/pi-ai/oauth";
let saved: Record<string, OAuthCredentials>;
let active: string[];
let fetchMock: ReturnType<typeof vi.fn>;
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const codexToken = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64")}.fixture`;
beforeEach(async () => {
  saved = {};
  active = [];
  serverFixtures.length = 0;
  configureOAuthStorage({
    read: async () => structuredClone(saved),
    write: async (value) => {
      saved = structuredClone(value);
    },
  });
  fetchMock = vi.fn(async () => {
    throw new Error(
      "Unexpected request: all external traffic is blocked by this fixture",
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  // The dependency lazily loads its Node callback APIs.
  await new Promise((resolve) => setTimeout(resolve, 0));
});
afterEach(async () => {
  active.forEach(cancelOAuth);
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
});
function start(provider: string) {
  const state = startOAuth(provider);
  active.push(state.id);
  return state.id;
}
async function ready(id: string) {
  await vi.waitFor(() => expect(getOAuthState(id)?.url).toBeTruthy());
  return getOAuthState(id)!;
}
async function finished(id: string) {
  await vi.waitFor(() => expect(getOAuthState(id)?.status).toBe("complete"), {
    timeout: 4000,
  });
}

describe("real pi-ai browser adapters with isolated callback and token fixtures", () => {
  it("completes ChatGPT PKCE manual callback flow without exposing tokens", async () => {
    fetchMock.mockImplementation(async (url, request) => {
      expect(url).toBe("https://auth.openai.com/oauth/token");
      expect(request.body.get("grant_type")).toBe("authorization_code");
      expect(request.body.get("code")).toBe("fixture-code");
      expect(request.body.get("code_verifier")).toBeTruthy();
      return response({
        access_token: codexToken,
        refresh_token: "fixture-refresh",
        expires_in: 3600,
      });
    });
    const id = start("openai-codex");
    const state = await ready(id);
    const auth = new URL(state.url!);
    expect(auth.origin).toBe("https://auth.openai.com");
    expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
    const callback = new URL(auth.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "fixture-code");
    callback.searchParams.set("state", auth.searchParams.get("state")!);
    submitOAuthInput(id, callback.toString());
    await finished(id);
    expect(saved["openai-codex"].accountId).toBe("fixture-account");
    expect(await getOAuthApiKey("openai-codex")).toBe(codexToken);
    expect(JSON.stringify(getOAuthState(id))).not.toContain("fixture-refresh");
    expect(serverFixtures[0].close).toHaveBeenCalled();
  });
  it("rejects a ChatGPT callback with mismatched state before exchanging credentials", async () => {
    const id = start("openai-codex");
    await ready(id);
    submitOAuthInput(
      id,
      "http://localhost:1455/auth/callback?code=fixture-code&state=wrong",
    );
    await vi.waitFor(() => expect(getOAuthState(id)?.status).toBe("error"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saved).toEqual({});
    expect(serverFixtures[0].close).toHaveBeenCalled();
  });
  it("completes Claude browser callback flow and validates callback state", async () => {
    fetchMock.mockImplementation(async (url, request) => {
      expect(url).toBe("https://platform.claude.com/v1/oauth/token");
      const body = JSON.parse(request.body);
      expect(body.code).toBe("fixture-code");
      expect(body.code_verifier).toBe(body.state);
      return response({
        access_token: "fixture-claude-access",
        refresh_token: "fixture-claude-refresh",
        expires_in: 3600,
      });
    });
    const id = start("anthropic");
    const state = await ready(id);
    const auth = new URL(state.url!);
    expect(auth.origin).toBe("https://claude.ai");
    const fakeResponse = { writeHead: vi.fn(), end: vi.fn() };
    serverFixtures[0].handler(
      { url: "/callback?code=fixture-code&state=wrong" },
      fakeResponse,
    );
    expect(fakeResponse.writeHead).toHaveBeenCalledWith(400, expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
    serverFixtures[0].handler(
      {
        url: `/callback?code=fixture-code&state=${encodeURIComponent(auth.searchParams.get("state")!)}`,
      },
      fakeResponse,
    );
    await finished(id);
    expect(await getOAuthApiKey("anthropic")).toBe("fixture-claude-access");
    expect(serverFixtures[0].close).toHaveBeenCalled();
  });
  it("completes ordinary GitHub device login with a blank enterprise field", async () => {
    fetchMock.mockImplementation(async (url, request) => {
      if (url === "https://github.com/login/device/code")
        return response({
          device_code: "fixture-device",
          user_code: "ABCD-1234",
          verification_uri: "https://github.com/login/device",
          interval: 1,
          expires_in: 120,
        });
      if (url === "https://github.com/login/oauth/access_token") {
        expect(request.body.get("device_code")).toBe("fixture-device");
        return response({ access_token: "fixture-github-access" });
      }
      if (url === "https://api.github.com/copilot_internal/v2/token") {
        expect(request.headers.Authorization).toBe(
          "Bearer fixture-github-access",
        );
        return response({
          token: "fixture;proxy-ep=proxy.individual.githubcopilot.com;",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        });
      }
      if (
        String(url).startsWith(
          "https://api.individual.githubcopilot.com/models/",
        ) &&
        String(url).endsWith("/policy")
      )
        return response({});
      throw new Error("Unexpected fixture URL");
    });
    const id = start("github-copilot");
    expect(getOAuthState(id)?.prompt).toContain("blank for github.com");
    submitOAuthInput(id, "");
    const state = await ready(id);
    expect(state.url).toBe("https://github.com/login/device");
    expect(state.instructions).toContain("ABCD-1234");
    await finished(id);
    expect(await getOAuthConnections()).toContain("github-copilot");
    expect(saved["github-copilot"].refresh).toBe("fixture-github-access");
  });
  it.each(["openai-codex", "anthropic"])(
    "cancelling %s closes the callback listener",
    async (provider) => {
      const id = start(provider);
      await ready(id);
      cancelOAuth(id);
      await vi.waitFor(() =>
        expect(serverFixtures[0].close).toHaveBeenCalled(),
      );
      expect(saved).toEqual({});
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOAuthState(id)?.status).toBe("error");
    },
  );
  it("cancels Copilot while waiting for browser authorization", async () => {
    fetchMock.mockResolvedValue(
      response({
        device_code: "fixture-device",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 5,
        expires_in: 120,
      }),
    );
    const id = start("github-copilot");
    submitOAuthInput(id, "");
    await ready(id);
    cancelOAuth(id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saved).toEqual({});
  });
  it("does not publish upstream token-exchange errors or credentials", async () => {
    fetchMock.mockResolvedValue(
      response({ error: "fixture-sensitive-token account@example.test" }, 401),
    );
    const id = start("openai-codex");
    await ready(id);
    submitOAuthInput(id, "fixture-code");
    await vi.waitFor(() => expect(getOAuthState(id)?.status).toBe("error"));
    expect(JSON.stringify(getOAuthState(id))).not.toMatch(
      /sensitive|account@example/,
    );
    expect(saved).toEqual({});
  });
});
