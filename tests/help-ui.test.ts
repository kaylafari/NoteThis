/** Synthetic local servers share onboarding state across random ports. No real downloads or device access. */
import { expect, test } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("first-launch guidance persists across ports, remains in settings, and prepares local AI only on request", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notethis-help-ui-"));
  try {
    const settings = {
      stt: { provider: "local", model: "base", language: "" },
      llm: { provider: "ollama", model: "qwen3:0.6b", baseUrl: "" },
      local: {
        whisperModel: "base",
        pythonPath: "python3",
        ollamaUrl: "http://localhost:11434",
      },
      configuredKeys: [],
      oauthConnections: [],
    };
    const catalog = {
      stt: [
        {
          id: "local",
          name: "Local Whisper",
          models: ["base"],
          auth: "none",
          description: "Local speech",
        },
      ],
      llm: [
        {
          id: "ollama",
          name: "Ollama",
          models: ["qwen3:0.6b"],
          auth: "none",
          description: "Local language models",
        },
      ],
    };
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {OnboardingWelcome,SettingsModal} from './src/App';let root;window.completedRequests=[];const realFetch=window.fetch.bind(window);window.fetch=async(...args)=>{const response=await realFetch(...args);window.completedRequests.push(String(args[0]));return response;};window.mountHelp=(mode)=>{root?.unmount();root=createRoot(document.getElementById('root'));const props=mode==='welcome'?{}:{settings:${JSON.stringify(settings)},catalog:${JSON.stringify(catalog)},health:null,onClose:()=>{root.unmount();root=null;},onSave:()=>{},onRefresh:async()=>{window.refreshes=(window.refreshes||0)+1;}};root.render(React.createElement(mode==='welcome'?OnboardingWelcome:SettingsModal,props));};`,
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
    const first = async function () {
      const w = window as any,
        passed: string[] = [];
      const text = () => document.getElementById("root")!.textContent || "";
      const until = async (predicate: () => unknown, name: string) => {
        const deadline = performance.now() + 6500;
        while (performance.now() < deadline) {
          if (predicate()) {
            passed.push(name);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(name + "; UI=" + text());
      };
      const button = (name: string) =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (item) => item.textContent?.trim() === name,
        )!;
      const stats = async () => (await fetch("/fixture/stats")).json();
      w.mountHelp("welcome");
      await until(
        () =>
          document.querySelector(
            '[role="dialog"][aria-label="Welcome to NoteThis"]',
          ),
        "First launch opens welcome",
      );
      await until(
        () =>
          button("Prepare local AI") && !button("Prepare local AI").disabled,
        "Local preparation status loads",
      );
      for (const phrase of [
        "Record a call or upload audio",
        "Save, then let the notes arrive",
        "karaoke",
        "LaTeX",
        "Ask this meeting",
        "Privacy & Security",
        "API key",
        "first use",
        "Connect your own ChatGPT account",
        "gpt-6.1-sol",
        "if that model appears",
        "Open secure sign-in",
        "Allow web search",
      ]) {
        await until(() => text().includes(phrase), "Guide explains " + phrase);
      }
      if ((await stats()).starts !== 0)
        throw new Error("Downloads started without a click");
      passed.push("Opening welcome does not start downloads");
      button("Prepare local AI").click();
      await until(
        () =>
          document
            .querySelector('[data-state="running"]')
            ?.textContent?.includes("Downloading"),
        "Preparation progress appears",
      );
      await until(
        () => button("Preparing local AI…")?.disabled,
        "Duplicate preparation starts are disabled",
      );
      await until(
        () =>
          document
            .querySelector('[data-state="error"]')
            ?.textContent?.includes("Synthetic network interruption"),
        "Preparation failure is visible",
      );
      button("Retry preparation").click();
      await until(
        () =>
          document
            .querySelector('[data-state="ready"]')
            ?.textContent?.includes("Local AI is ready"),
        "Retry reaches ready state",
      );
      const readyGets = (await stats()).setupGets;
      await new Promise((resolve) => setTimeout(resolve, 1800));
      if ((await stats()).setupGets !== readyGets)
        throw new Error("Ready status kept polling");
      passed.push("Polling stops when preparation finishes");
      button("Get started").click();
      await until(
        () =>
          document
            .querySelector('[role="alert"]')
            ?.textContent?.includes("Synthetic preference write failure"),
        "Failed welcome persistence is visible and retryable",
      );
      if (!document.querySelector('[aria-label="Welcome to NoteThis"]'))
        throw new Error("Failed preference save dismissed welcome");
      button("Get started").click();
      await until(
        () => !document.querySelector('[aria-label="Welcome to NoteThis"]'),
        "Successful completion dismisses welcome",
      );
      if (!(await stats()).completed)
        throw new Error("Completion was not persisted on the backend");
      return passed;
    };
    const second = async function () {
      const w = window as any,
        passed: string[] = [];
      const text = () => document.getElementById("root")!.textContent || "";
      const until = async (predicate: () => unknown, name: string) => {
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          if (predicate()) {
            passed.push(name);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error(name + "; UI=" + text());
      };
      const button = (name: string) =>
        [...document.querySelectorAll<HTMLButtonElement>("button")].find(
          (item) => item.textContent?.trim() === name,
        )!;
      w.mountHelp("welcome");
      await until(
        () => w.completedRequests.includes("/api/onboarding"),
        "New origin checks persisted onboarding state",
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (document.querySelector('[aria-label="Welcome to NoteThis"]'))
        throw new Error("Welcome reopened after a port change");
      passed.push("Completion survives a different localhost port");
      w.mountHelp("settings");
      await until(
        () => document.querySelectorAll(".settings-tabs button").length === 3,
        "Settings has three tabs",
      );
      const tabs = [...document.querySelectorAll(".settings-tabs button")].map(
        (item) => item.textContent?.trim(),
      );
      if (
        JSON.stringify(tabs) !==
        JSON.stringify(["AI models", "Local setup", "Help & tips"])
      )
        throw new Error("Help tab order is wrong");
      passed.push("Help follows AI models and Local setup");
      button("Help & tips").click();
      await until(
        () =>
          text().includes("Record a call or upload audio") &&
          text().includes("Ask this meeting"),
        "The permanent help tab reuses the welcome guide",
      );
      await until(
        () => button("Check local AI"),
        "Help reconnects to preparation state",
      );
      if (button("Save preferences"))
        throw new Error("Help should not require saving settings");
      button("Open AI models").click();
      await until(
        () =>
          text().includes("Meeting intelligence") &&
          !text().includes("Connect your own ChatGPT account"),
        "The guide opens AI model settings without changing preferences",
      );
      if (
        (
          document.querySelector(
            '[aria-label="Language model provider"]',
          ) as HTMLSelectElement
        ).value !== "ollama"
      )
        throw new Error("Guide changed provider without user selection");
      button("Local setup").click();
      await until(
        () => button("Check local AI") && text().includes("Python executable"),
        "Local setup exposes the same preparation control",
      );
      const python = [...document.querySelectorAll("label")]
        .find((label) => label.textContent?.includes("Python executable"))!
        .querySelector("input")!;
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(python, "/custom/python");
      python.dispatchEvent(new Event("input", { bubbles: true }));
      button("Help & tips").click();
      button("Local setup").click();
      await until(
        () =>
          [...document.querySelectorAll<HTMLInputElement>("input")].some(
            (input) => input.value === "/custom/python",
          ),
        "Visiting help preserves unsaved local preferences",
      );
      (
        document.querySelector(
          '[aria-label="Close dialog"]',
        ) as HTMLButtonElement
      ).click();
      await until(
        () => !document.querySelector('[role="dialog"]'),
        "Settings closes normally",
      );
      w.mountHelp("settings");
      button("Help & tips")?.click();
      await until(() => button("Help & tips"), "Settings reopens");
      button("Help & tips").click();
      await until(
        () => text().includes("When macOS asks for permission"),
        "Help stays available after reopening settings",
      );
      await fetch("/fixture/onboarding-unavailable", { method: "POST" });
      w.mountHelp("welcome");
      const requests = w.completedRequests.filter(
        (url: string) => url === "/api/onboarding",
      ).length;
      await until(
        () =>
          w.completedRequests.filter((url: string) => url === "/api/onboarding")
            .length > requests,
        "Unavailable onboarding request resolves",
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      if (document.querySelector('[aria-label="Welcome to NoteThis"]'))
        throw new Error(
          "Unavailable onboarding API produced an unsolicited popup",
        );
      passed.push("Unavailable onboarding skips the popup safely");
      return passed;
    };
    const report = path.join(scratch, "result.json");
    const main = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const http=require('node:http');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});app.whenReady().then(async()=>{let completed=false,failCompletion=true,unavailable=false,starts=0,setupGets=0,polls=0,setupState='idle';let mutations=[];const handler=(req,res)=>{const json=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});return res.end(fs.readFileSync(${JSON.stringify(path.join(scratch, "index.html"))}));}if(req.url==='/fixture/stats')return json({completed,starts,setupGets});if(req.url==='/fixture/onboarding-unavailable'){unavailable=true;return json({ok:true});}if(req.method==='POST'&&req.url.startsWith('/api/')){mutations.push({url:req.url,header:req.headers['x-meeting-app']});}if(req.url==='/api/onboarding'){if(unavailable)return json({error:'Unavailable'},404);if(req.method==='POST'){if(failCompletion){failCompletion=false;return json({error:'Synthetic preference write failure'},500);}completed=true;}return json({completed});}if(req.url==='/api/local-setup'){if(req.method==='POST'){starts++;setupState='running';polls=0;}else{setupGets++;if(setupState==='running'&&++polls>=2)setupState=starts===1?'error':'ready';}return json({state:setupState,stage:setupState,message:setupState==='running'?'Downloading local model files':setupState==='error'?'Synthetic network interruption':setupState==='ready'?'Local AI is ready.':'Ready to prepare local models.'});}if(req.url.startsWith('/api/providers/')&&req.url.endsWith('/models')){const provider=req.url.split('/')[3];return json({provider,kind:provider==='local'?'stt':'llm',source:'local',models:provider==='local'?['base']:['qwen3:0.6b'],message:'Synthetic installed models'});}return json({error:'Not found'},404);};const servers=[http.createServer(handler),http.createServer(handler)];for(const server of servers)await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const addresses=servers.map(server=>'http://127.0.0.1:'+server.address().port);const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});let remoteRequests=0;win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{const allowed=addresses.some(address=>details.url.startsWith(address+'/'));if(!allowed)remoteRequests++;done({cancel:!allowed});});await win.loadURL(addresses[0]);const first=await win.webContents.executeJavaScript('('+${JSON.stringify(first.toString())}+')()',true);await win.loadURL(addresses[1]);const second=await win.webContents.executeJavaScript('('+${JSON.stringify(second.toString())}+')()',true);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({passed:[...first,...second],portsDiffer:addresses[0]!==addresses[1],mutations,remoteRequests,starts}));for(const server of servers)server.close();app.exit(0)}).catch(error=>{console.error(error);app.exit(1)});`;
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
        reject(new Error("Help UI timed out: " + logs));
      }, 35000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error("Help UI exited " + code + ": " + logs));
      });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    expect(result.passed.length).toBeGreaterThanOrEqual(25);
    expect(result.portsDiffer).toBe(true);
    expect(result.remoteRequests).toBe(0);
    expect(result.starts).toBe(2);
    expect(result.mutations.every((call: any) => call.header === "1")).toBe(
      true,
    );
    expect(
      result.mutations.some((call: any) => call.url === "/api/settings"),
    ).toBe(false);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45000);
