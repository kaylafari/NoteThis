/** Real React/Chromium settings interactions. All HTTP/auth/key data is synthetic. */
import { test, expect } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { providerCatalog } from "../server/providers";

test("provider settings, native handoff feedback, and OAuth lifecycle work in real React", async () => {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "cadence-settings-test-"),
  );
  try {
    const catalog = providerCatalog();
    const settings = {
      stt: { provider: "local", model: "base", language: "" },
      llm: { provider: "ollama", model: "qwen3:0.6b", baseUrl: "" },
      local: {
        whisperModel: "base",
        pythonPath: "/test/python",
        ollamaUrl: "http://localhost:11434",
      },
      configuredKeys: ["openai"],
      oauthConnections: [],
    };
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {SettingsModal} from './src/App'; window.renderSettings = (props) => createRoot(document.getElementById('root')).render(React.createElement(SettingsModal, props));`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
    });
    await writeFile(
      path.join(scratch, "index.html"),
      `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`,
    );
    const run = async function (catalog: any, initialSettings: any) {
      const w = window as any;
      const passed: string[] = [];
      const calls: { url: string; method: string; body: any }[] = [];
      let persisted = structuredClone(initialSettings);
      let auth: any = null;
      let sessionCounter = 0;
      let openFails = true;
      let openCalls = 0;
      let copied = "";
      let closed = 0;
      let failSave = false;
      let blockPoll = false;
      const discoveryOverrides = new Map<string, any>();
      let deferModelsFor = "";
      let releaseModels: ((value: any) => void) | null = null;
      let releasePoll: ((value: any) => void) | null = null;
      const wait = (ms = 15) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const until = async (condition: () => unknown, name: string) => {
        const deadline = performance.now() + 4000;
        let cause = "";
        while (performance.now() < deadline) {
          try {
            if (condition()) return;
          } catch (error) {
            cause = String(error);
          }
          await wait();
        }
        throw new Error(name + (cause ? ": " + cause : ""));
      };
      const check = async (condition: () => unknown, name: string) => {
        await until(condition, name);
        passed.push(name);
      };
      const text = () => document.getElementById("root")!.textContent || "";
      const button = (label: string): HTMLButtonElement => {
        const item = Array.from(document.querySelectorAll("button")).find(
          (el) => el.textContent?.trim() === label,
        );
        if (!item)
          throw new Error(
            `Missing button: ${label}; UI=${text().slice(-1700)}`,
          );
        return item;
      };
      const click = async (label: string) => {
        await until(
          () => !button(label).disabled,
          "Button becomes enabled: " + label,
        );
        button(label).click();
        await wait();
        await until(
          () => !button("Save preferences").disabled,
          "Settings operation finishes: " + label,
        );
      };
      const input = (label: string) =>
        document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
      const field = (label: string) => {
        const element = Array.from(document.querySelectorAll("label")).find(
          (el) => el.textContent?.trim().startsWith(label),
        );
        if (!element) throw new Error(`Missing field ${label}`);
        return element.querySelector("input")!;
      };
      const set = async (
        el: HTMLInputElement | HTMLSelectElement,
        value: string,
      ) => {
        const prototype =
          el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(
          el,
          value,
        );
        el.dispatchEvent(
          new Event(el instanceof HTMLSelectElement ? "change" : "input", {
            bubbles: true,
          }),
        );
        await wait();
      };
      const response = (data: any, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const originalInterval = window.setInterval.bind(window);
      window.setInterval = ((handler: any, ms?: number) =>
        originalInterval(handler, ms === 1600 ? 45 : ms)) as any;
      w.desktop = {
        isElectron: true,
        openExternal: async () => {
          openCalls++;
          return openFails
            ? { ok: false, error: "Synthetic native browser launch failure" }
            : { ok: true };
        },
      };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            copied = value;
          },
        },
      });
      window.fetch = (async (url: string, options: any = {}) => {
        const method = options.method || "GET";
        const body = options.body ? JSON.parse(options.body) : undefined;
        calls.push({ url, method, body });
        if (url.startsWith("/api/providers/") && url.endsWith("/models")) {
          const provider = decodeURIComponent(url.split("/")[3]);
          const kind = body.kind;
          if (deferModelsFor === provider)
            return await new Promise((resolve) => {
              releaseModels = (value) => resolve(response(value));
            });
          const entry = catalog[kind].find((item: any) => item.id === provider);
          const connected = persisted.oauthConnections.includes(provider);
          const models = connected
            ? [`account-model-${sessionCounter}`]
            : entry?.models || [];
          return response({
            provider,
            kind,
            models,
            source: connected
              ? "account"
              : provider === "ollama"
                ? "local"
                : "bundled",
            message: connected
              ? "Synthetic authenticated account response"
              : "Synthetic bundled suggestions; account access unverified",
            checkedAt: new Date().toISOString(),
            ...(connected
              ? {
                  capabilities: {
                    [`account-model-${sessionCounter}`]: {
                      outputModalities: ["text", "audio"],
                      webSearch: "supported",
                      webSearchNote: "Synthetic provider search metadata",
                    },
                    [entry.models[0]]: {
                      outputModalities: ["image"],
                      webSearch: "supported",
                      webSearchNote: "Stale catalog capability metadata",
                    },
                  },
                }
              : {}),
            ...discoveryOverrides.get(`${kind}:${provider}`),
          });
        }
        if (url === "/api/settings" && method === "PUT") {
          if (failSave)
            return response({ error: "Synthetic save failure" }, 500);
          persisted = {
            ...persisted,
            ...Object.fromEntries(
              Object.entries(body).filter(([key]) => key !== "apiKeys"),
            ),
          };
          for (const [provider, key] of Object.entries(body.apiKeys || {}))
            persisted.configuredKeys = key
              ? [...new Set([...persisted.configuredKeys, provider])]
              : persisted.configuredKeys.filter(
                  (id: string) => id !== provider,
                );
          return response(persisted);
        }
        if (url.endsWith("/start")) {
          const provider = url.split("/")[3];
          auth = {
            id: `synthetic-session-${++sessionCounter}`,
            provider,
            status: "pending",
            url: "https://example.test/sign-in?state=synthetic",
          };
          return response(auth);
        }
        if (url.endsWith("/input")) {
          auth = { ...auth, status: "complete" };
          persisted.oauthConnections = [auth.provider];
          return response(auth);
        }
        if (url.includes("/oauth/session/") && method === "DELETE") {
          auth = null;
          return response({ ok: true });
        }
        if (url.includes("/oauth/session/")) {
          if (blockPoll)
            return await new Promise((resolve) => {
              releasePoll = (value) => resolve(response(value));
            });
          return response(auth);
        }
        if (url.includes("/oauth/") && method === "DELETE") {
          persisted.oauthConnections = [];
          return response({ ok: true });
        }
        throw new Error(`Unexpected API call ${method} ${url}`);
      }) as any;
      w.renderSettings({
        settings: initialSettings,
        catalog,
        health: null,
        onClose: () => {
          closed++;
        },
        onSave: () => {},
        onRefresh: async () => {},
      });
      await wait(80);

      await check(
        () =>
          document
            .querySelector('[aria-label="language model availability"]')
            ?.textContent?.includes("Local model list"),
        "Settings opening discovers installed local models",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="speech model availability"]')
            ?.textContent?.includes("Bundled suggestions"),
        "Bundled model suggestions explicitly mark unverified access",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          document
            .querySelector('[aria-label="Selected model web search"]')
            ?.textContent?.includes("Unknown (not reported)"),
        "Missing provider capability metadata is unknown rather than inferred",
      );
      await check(
        () =>
          text().includes(
            "Web access in NoteThis: not available for this model.",
          ) && text().includes("Chat answers remain text"),
        "Model capability display reports unavailable app adapters without claiming provider tools are enabled",
      );
      const webToggle = () =>
        document.querySelector(
          '[role="switch"][aria-label="Allow web search"]',
        ) as HTMLButtonElement;
      await check(
        () =>
          webToggle().getAttribute("aria-checked") === "false" &&
          webToggle().disabled,
        "Web search defaults off and cannot be enabled without an implemented verified adapter",
      );
      const diagramsToggle = () =>
        document.querySelector(
          '[role="switch"][aria-label="Generate summary diagrams"]',
        ) as HTMLButtonElement;
      await check(
        () =>
          diagramsToggle().getAttribute("aria-checked") === "false" &&
          diagramsToggle().disabled,
        "Summary diagram generation defaults off without an available adapter",
      );
      for (const provider of catalog.stt) {
        await set(input("Speech provider"), provider.id);
        await check(
          () => input("Speech model").value === (provider.models[0] || ""),
          `Speech selection updates model: ${provider.id}`,
        );
        await check(
          () =>
            document.querySelectorAll("input[type=password]").length ===
            (provider.auth === "none" ? 0 : 1),
          `Speech credential field matches provider: ${provider.id}`,
        );
      }
      for (const provider of catalog.llm) {
        await set(input("Language model provider"), provider.id);
        await check(
          () => input("Language model").value === (provider.models[0] || ""),
          `LLM selection updates model: ${provider.id}`,
        );
      }
      for (const provider of catalog.llm.filter(
        (p: any) => p.auth === "oauth" || p.auth === "api-key-or-oauth",
      )) {
        await set(input("Language model provider"), provider.id);
        await click("Sign in");
        await check(
          () => auth.provider === provider.id,
          `Browser login routes to selected provider: ${provider.id}`,
        );
        await click("Cancel sign-in");
      }
      await set(input("Speech provider"), "openai");
      await set(input("Language model provider"), "ollama");
      const removal = document.querySelector(
        '[aria-label="Remove saved OpenAI API key"]',
      ) as HTMLButtonElement;
      removal.click();
      await wait();
      await check(
        () => calls.some((call) => call.body?.apiKeys?.openai === ""),
        "Explicit key removal sends empty key only",
      );
      await check(
        () =>
          !document.querySelector('[aria-label="Remove saved OpenAI API key"]'),
        "Removed key badge disappears",
      );
      await set(field("OpenAI"), "  synthetic-key  ");
      await set(input("Speech model"), " whisper-1 ");
      await click("Save preferences");
      const saved = calls
        .filter((call) => call.url === "/api/settings")
        .at(-1)!;
      await check(
        () =>
          saved.body.apiKeys.openai === "synthetic-key" &&
          saved.body.stt.model === "whisper-1",
        "Save trims model and API key",
      );
      await check(
        () => text().includes("Preferences saved"),
        "Save success is visible",
      );
      await set(field("Language"), "en");
      await check(
        () => !text().includes("Preferences saved"),
        "Editing settings clears saved status",
      );
      failSave = true;
      await click("Save preferences");
      failSave = false;
      await check(
        () => text().includes("Synthetic save failure"),
        "Save failure stays inside settings modal",
      );
      await set(input("Language model provider"), "custom");
      await set(input("Language model"), "local-custom-model");
      await set(field("API base URL"), "http://remote.example/v1");
      const beforeInvalid = calls.filter(
        (call) => call.url === "/api/settings",
      ).length;
      await click("Save preferences");
      await check(
        () => text().includes("must use HTTPS"),
        "Custom insecure remote URL is explained",
      );
      await check(
        () =>
          calls.filter((call) => call.url === "/api/settings").length ===
          beforeInvalid,
        "Invalid endpoint never reaches settings API",
      );
      await set(field("API base URL"), "http://localhost:1234/v1");
      await check(
        () => text().includes("Server URL changed"),
        "Edited custom endpoint requires explicit discovery",
      );
      await check(
        () =>
          !calls.some(
            (call) =>
              call.url.endsWith("/models") &&
              call.body.baseUrl === "http://localhost:1234/v1",
          ),
        "Edited endpoint receives no automatic credentialed lookup",
      );
      await click("Save preferences");
      await check(
        () =>
          calls.filter((call) => call.url === "/api/settings").at(-1)!.body.llm
            .baseUrl === "http://localhost:1234/v1",
        "Local custom endpoint saves",
      );
      await click("Local setup");
      await set(field("Python executable"), " /custom/python ");
      await set(field("Ollama server URL"), "http://localhost:11435");
      await click("Save preferences");
      await check(
        () =>
          calls.filter((call) => call.url === "/api/settings").at(-1)!.body
            .local.pythonPath === "/custom/python",
        "Local Python field is trimmed and saved",
      );
      await check(
        () =>
          calls.filter((call) => call.url === "/api/settings").at(-1)!.body
            .local.ollamaUrl === "http://localhost:11435",
        "Ollama endpoint saves",
      );
      await click("AI models");

      const oauthProvider = catalog.llm.find(
        (provider: any) => provider.auth === "oauth",
      );
      if (!oauthProvider)
        throw new Error("Missing OAuth provider in real catalog");
      await set(input("Language model provider"), oauthProvider.id);
      const priorStarts = calls.filter((call) =>
        call.url.endsWith("/start"),
      ).length;
      button("Sign in").click();
      button("Sign in").click();
      await wait();
      await check(
        () =>
          calls.filter((call) => call.url.endsWith("/start")).length ===
          priorStarts + 1,
        "Double-click starts only one sign-in session",
      );
      await click("Open secure sign-in");
      await check(() => openCalls === 1, "Sign-in invokes native bridge");
      const panel = document.querySelector(
        '[aria-label="Browser sign-in status"]',
      )!;
      await check(
        () =>
          panel.textContent!.includes(
            "Synthetic native browser launch failure",
          ),
        "Native launch failure appears beside sign-in controls",
      );
      await check(
        () => input("Sign-in URL").value.includes("example.test"),
        "Selectable sign-in URL remains available",
      );
      await click("Copy sign-in link");
      await check(
        () => copied === auth.url,
        "Fallback copy uses exact sign-in URL",
      );
      openFails = false;
      await click("Open secure sign-in");
      await check(
        () => openCalls === 2 && text().includes("Opened your browser"),
        "Successful native launch shows handoff status",
      );
      blockPoll = true;
      await wait(80);
      const stale = { ...auth };
      await click("Cancel sign-in");
      if (releasePoll) (releasePoll as (value: any) => void)(stale);
      await wait();
      blockPoll = false;
      await check(
        () => !document.querySelector('[aria-label="Sign-in URL"]'),
        "Late poll cannot resurrect canceled sign-in",
      );
      await check(
        () => !button("Sign in").disabled,
        "Cancel re-enables sign-in",
      );
      await click("Sign in");
      auth = {
        ...auth,
        status: "prompt",
        prompt: "Domain (leave empty for github.com)",
      };
      await wait(90);
      await check(
        () => !button("Continue").disabled,
        "Optional empty authorization prompt can continue",
      );
      field("Domain (leave empty").dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      await wait();
      await check(
        () =>
          calls.some(
            (call) => call.url.endsWith("/input") && call.body.text === "",
          ),
        "Optional domain prompt sends empty input",
      );
      await check(
        () =>
          text().includes("Browser account connected") &&
          text().includes("You’re connected."),
        "Input completion immediately updates connection badge",
      );
      const discoveredModel = `account-model-${sessionCounter}`;
      await check(
        () =>
          Array.from(document.querySelectorAll("#llm-models option")).some(
            (option) => (option as HTMLOptionElement).value === discoveredModel,
          ),
        "OAuth completion refreshes models absent from bundled catalog",
      );
      await check(
        () =>
          input("Language model").value !== discoveredModel &&
          text().includes("selected model is not in the current account list"),
        "Live discovery preserves old selection and explains missing access",
      );
      await check(
        () =>
          !!document.querySelector(
            `select[aria-label="Language model"] option[value="${discoveredModel}"]`,
          ) && input("Language model").value !== discoveredModel,
        "Account picker exposes new IDs while obsolete current model remains selected",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          !text().includes("Stale catalog capability metadata"),
        "Capabilities for a selected ID absent from the current model list are never reused",
      );
      const beforeUnsupportedSave = calls.filter(
        (call) => call.url === "/api/settings",
      ).length;
      await click("Save preferences");
      await check(
        () =>
          text().includes(
            "Choose a language model from the current account list before saving.",
          ),
        "Authoritative account mismatch blocks saving",
      );
      await check(
        () =>
          calls.filter((call) => call.url === "/api/settings").length ===
          beforeUnsupportedSave,
        "Unsupported account model is not persisted",
      );
      await set(input("Language model"), discoveredModel);
      await check(
        () =>
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("text, audio (provider-reported)"),
        "Selecting an available model displays its provider-reported output modalities",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="Selected model web search"]')
            ?.textContent?.includes("Provider-supported") &&
          text().includes("Synthetic provider search metadata"),
        "Provider-supported web search displays its source note",
      );
      await check(
        () =>
          webToggle().disabled &&
          text().includes(
            "Web access in NoteThis: not available for this model.",
          ),
        "Provider search support alone does not enable an unimplemented app adapter",
      );
      discoveryOverrides.set(`llm:${oauthProvider.id}`, {
        capabilities: {
          [discoveredModel]: {
            outputModalities: ["text", "image"],
            webSearch: "supported",
            appWebSearch: true,
            appImageOutput: true,
          },
        },
      });
      (
        document.querySelector(
          '[aria-label="Refresh language models"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () =>
          !webToggle().disabled &&
          text().includes(
            "Web access in NoteThis: available; currently off.",
          ) &&
          text().includes(
            "Summary visuals in NoteThis: available; currently off",
          ),
        "Verified implemented adapters expose optional web search and summary visuals",
      );
      await check(
        () =>
          text().includes(
            `Send your question, recent conversation, and relevant transcript excerpts to ${oauthProvider.name} for ${discoveredModel}`,
          ) &&
          text().includes(
            `Send transcript-derived diagram descriptions and supporting excerpts to ${oauthProvider.name} for ${discoveredModel}`,
          ),
        "Feature opt-ins name the actual selected provider, model, and outgoing data",
      );
      diagramsToggle().click();
      await check(
        () =>
          diagramsToggle().getAttribute("aria-checked") === "true" &&
          webToggle().getAttribute("aria-checked") === "false",
        "Summary diagrams can be explicitly enabled independently from web search",
      );
      webToggle().click();
      await check(
        () =>
          webToggle().getAttribute("aria-checked") === "true" &&
          text().includes("Web access in NoteThis: enabled for this model."),
        "Web search can be explicitly enabled for a supported model",
      );
      await set(input("Language model provider"), "ollama");
      await check(
        () =>
          webToggle().getAttribute("aria-checked") === "false" &&
          diagramsToggle().getAttribute("aria-checked") === "false",
        "Changing providers resets both feature opt-ins",
      );
      await click("Save preferences");
      await check(
        () =>
          persisted.llm.webSearch === false &&
          persisted.llm.summaryDiagrams === false &&
          !persisted.llm.webSearchConsentProvider &&
          !persisted.llm.summaryDiagramsConsentProvider,
        "Provider change clears persisted consent bindings",
      );
      await set(input("Language model provider"), oauthProvider.id);
      await until(
        () =>
          !!document.querySelector(
            `select[aria-label="Language model"] option[value="${discoveredModel}"]`,
          ),
        "Account model choices return",
      );
      await set(input("Language model"), discoveredModel);
      await until(
        () => !webToggle().disabled && !diagramsToggle().disabled,
        "Adapters become available again",
      );
      webToggle().click();
      diagramsToggle().click();
      await click("Save preferences");
      await check(
        () =>
          persisted.llm.webSearch === true &&
          persisted.llm.summaryDiagrams === true &&
          persisted.llm.webSearchConsentProvider === oauthProvider.id &&
          persisted.llm.summaryDiagramsConsentProvider === oauthProvider.id &&
          persisted.llm.model === discoveredModel &&
          persisted.local.pythonPath === "/custom/python",
        "Saving web-search preference preserves selected model and other settings",
      );
      await check(
        () => persisted.llm.model === discoveredModel,
        "New account model ID can be saved even absent from bundled catalog",
      );
      discoveryOverrides.set(`llm:${oauthProvider.id}`, {
        source: "unavailable",
        models: [],
        message: "Synthetic account model endpoint unavailable",
      });
      (
        document.querySelector(
          '[aria-label="Refresh language models"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () =>
          text().includes("Synthetic account model endpoint unavailable") &&
          document.querySelectorAll("#llm-models option").length === 0,
        "Unavailable account refresh shows error and removes old choices",
      );
      await check(
        () => input("Language model").value === discoveredModel,
        "Unavailable discovery preserves manually selected model",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          !text().includes("Synthetic provider search metadata"),
        "Unavailable discovery clears previously reported model capabilities",
      );
      await check(
        () =>
          webToggle().getAttribute("aria-checked") === "true" &&
          !webToggle().disabled &&
          text().includes("Web search is saved as on"),
        "Saved-on but unavailable web search is explained and can still be disabled",
      );
      const settingsBeforeDisable = JSON.stringify({
        stt: persisted.stt,
        local: persisted.local,
        model: persisted.llm.model,
        provider: persisted.llm.provider,
      });
      webToggle().click();
      await check(
        () =>
          webToggle().getAttribute("aria-checked") === "false" &&
          webToggle().disabled,
        "Unsupported saved preference can be turned off without re-enabling it",
      );
      await check(
        () =>
          diagramsToggle().getAttribute("aria-checked") === "true" &&
          !diagramsToggle().disabled &&
          text().includes("Summary diagrams are saved as on"),
        "Unavailable diagram preference remains independently switchable off",
      );
      diagramsToggle().click();
      await click("Save preferences");
      await check(
        () =>
          persisted.llm.webSearch === false &&
          persisted.llm.summaryDiagrams === false &&
          !persisted.llm.webSearchConsentProvider &&
          !persisted.llm.summaryDiagramsConsentProvider &&
          JSON.stringify({
            stt: persisted.stt,
            local: persisted.local,
            model: persisted.llm.model,
            provider: persisted.llm.provider,
          }) === settingsBeforeDisable,
        "Turning off unavailable web search preserves all unrelated preferences",
      );
      discoveryOverrides.set(`llm:${oauthProvider.id}`, {
        source: "bundled",
        models: ["fallback-suggestion", "no-capability-metadata"],
        message: "No account enumeration supported",
        capabilities: {
          "fallback-suggestion": {
            outputModalities: ["text"],
            webSearch: "unsupported",
            webSearchNote: "Synthetic provider reports no search support",
            appWebSearch: true,
            appImageOutput: true,
          },
        },
      });
      (
        document.querySelector(
          '[aria-label="Refresh language models"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () =>
          document
            .querySelector('[aria-label="language model availability"]')
            ?.textContent?.includes(
              "Bundled suggestions · access not verified",
            ),
        "Bundled fallback never claims account entitlement",
      );
      await check(
        () =>
          Array.from(document.querySelectorAll("#llm-models option")).some(
            (option) =>
              (option as HTMLOptionElement).value === "fallback-suggestion",
          ),
        "Refresh replaces choices with explicitly marked fallback",
      );
      await set(input("Language model"), "fallback-suggestion");
      await check(
        () =>
          document
            .querySelector('[aria-label="Selected model web search"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          !text().includes("Synthetic provider reports no search support"),
        "Unexpected capabilities on a bundled response are not presented as provider verified",
      );
      await check(
        () =>
          webToggle().disabled &&
          text().includes(
            "Summary visuals in NoteThis: not available for this model.",
          ),
        "Bundled metadata cannot activate web or image adapters",
      );
      discoveryOverrides.set(`llm:${oauthProvider.id}`, {
        source: "account",
        models: ["fallback-suggestion", "no-capability-metadata"],
        message: "Synthetic live capability response",
        capabilities: {
          "fallback-suggestion": {
            outputModalities: ["text"],
            webSearch: "unsupported",
            webSearchNote: "Synthetic provider reports no search support",
          },
        },
      });
      (
        document.querySelector(
          '[aria-label="Refresh language models"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () =>
          document
            .querySelector('[aria-label="Selected model web search"]')
            ?.textContent?.includes("Not supported (provider-reported)") &&
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("text (provider-reported)"),
        "Explicit negative web capability is distinct from unknown metadata",
      );
      await set(input("Language model"), "no-capability-metadata");
      await check(
        () =>
          document
            .querySelector('[aria-label="Selected model web search"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          document
            .querySelector('[aria-label="language model output formats"]')
            ?.textContent?.includes("Unknown (not reported)") &&
          !text().includes("Synthetic provider reports no search support"),
        "Switching to a listed model without metadata does not inherit previous capabilities",
      );
      discoveryOverrides.delete(`llm:${oauthProvider.id}`);
      await click("Reconnect");
      await check(
        () => !!document.querySelector('[aria-label="Sign-in URL"]'),
        "Reconnect starts a fresh flow",
      );
      auth = {
        ...auth,
        status: "prompt",
        prompt: "Complete replacement account",
      };
      await until(
        () => !!button("Continue"),
        "Replacement account prompt arrives",
      );
      await click("Continue");
      await check(
        () =>
          Array.from(document.querySelectorAll("#llm-models option")).some(
            (option) =>
              (option as HTMLOptionElement).value ===
              `account-model-${sessionCounter}`,
          ),
        "Reconnecting an already-connected provider reloads the replacement account models",
      );
      await check(
        () =>
          calls
            .filter(
              (call) =>
                call.url === `/api/providers/${oauthProvider.id}/models` &&
                call.body.kind === "llm",
            )
            .at(-1)?.body.force === true,
        "Same-provider OAuth reconnection bypasses cached model list",
      );
      await click("Reconnect");
      await click("Cancel sign-in");
      await click("Disconnect");
      await check(
        () =>
          text().includes("Use your existing account") &&
          !text().includes("Browser account connected"),
        "Disconnect clears connected state",
      );
      await set(input("Speech provider"), "openai");
      discoveryOverrides.set("stt:openai", {
        source: "account",
        models: ["speech-account-new"],
        message: "Synthetic new API key account models",
      });
      const beforeKeyDiscovery = calls.filter(
        (call) =>
          call.url === "/api/providers/openai/models" &&
          call.body.kind === "stt",
      ).length;
      await set(field("OpenAI"), "synthetic-replacement-key");
      (
        document.querySelector(
          '[aria-label="Save OpenAI API key"]',
        ) as HTMLButtonElement
      ).click();
      await check(
        () =>
          calls.filter(
            (call) =>
              call.url === "/api/providers/openai/models" &&
              call.body.kind === "stt",
          ).length > beforeKeyDiscovery,
        "Replacing an already-configured API key refreshes its model list",
      );
      await check(
        () =>
          Array.from(document.querySelectorAll("#stt-models option")).some(
            (option) =>
              (option as HTMLOptionElement).value === "speech-account-new",
          ),
        "Credential refresh replaces speech suggestions with account results",
      );
      await check(
        () =>
          calls
            .filter(
              (call) =>
                call.url === "/api/providers/openai/models" &&
                call.body.kind === "stt",
            )
            .at(-1)?.body.force === true,
        "Credential replacement bypasses stale discovery cache",
      );
      const otherProvider = catalog.llm.find(
        (provider: any) =>
          provider.id !== oauthProvider.id &&
          provider.id !== "ollama" &&
          provider.auth === "api-key",
      );
      deferModelsFor = otherProvider.id;
      await set(input("Language model provider"), otherProvider.id);
      await until(() => !!releaseModels, "Delayed provider request started");
      await set(input("Language model provider"), "ollama");
      await check(
        () =>
          document
            .querySelector('[aria-label="language model availability"]')
            ?.textContent?.includes("Local model list"),
        "Switching providers shows newly selected provider models",
      );
      (releaseModels as unknown as (value: any) => void)({
        provider: otherProvider.id,
        kind: "llm",
        models: ["stale-provider-model"],
        source: "account",
        message: "Stale delayed response",
      });
      await wait(30);
      await check(
        () =>
          !Array.from(document.querySelectorAll("#llm-models option")).some(
            (option) =>
              (option as HTMLOptionElement).value === "stale-provider-model",
          ),
        "Late model response cannot overwrite another provider selection",
      );
      deferModelsFor = "";
      await set(input("Language model provider"), oauthProvider.id);
      await click("Sign in");
      (
        document.querySelector(
          '[aria-label="Close dialog"]',
        ) as HTMLButtonElement
      ).click();
      await wait();
      await check(
        () => closed === 1 && auth === null,
        "Closing settings cancels pending login before closing",
      );
      return { passed, calls: calls.length };
    };
    const report = path.join(scratch, "result.json");
    const main = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});await win.loadFile(${JSON.stringify(path.join(scratch, "index.html"))});const value=await win.webContents.executeJavaScript('('+${JSON.stringify(run.toString())}+')('+${JSON.stringify(JSON.stringify(catalog))}+','+${JSON.stringify(JSON.stringify(settings))}+')',true);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(value));app.exit(0);}).catch(error=>{console.error(error);app.exit(1)});`;
    await writeFile(path.join(scratch, "main.cjs"), main);
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        electron as unknown as string,
        [path.join(scratch, "main.cjs")],
        { env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let logs = "";
      child.stdout.on("data", (chunk) => {
        logs += chunk;
      });
      child.stderr.on("data", (chunk) => {
        logs += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Settings UI test timed out: ${logs}`));
      }, 45000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error(`Settings UI exited ${code}: ${logs}`));
      });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    expect(result.passed.length).toBeGreaterThan(
      catalog.stt.length + catalog.llm.length + 20,
    );
    console.log(
      `Settings UI: ${result.passed.length} real Chromium assertions passed across ${catalog.stt.length} speech and ${catalog.llm.length} language providers.`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 60000);
