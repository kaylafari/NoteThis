/** Real React/Chromium display checks. Only a local fixture server and synthetic data are used. */
import { test, expect } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { deflateSync } from "node:zlib";

function pixelPng(): Buffer {
  const crc = (bytes: Buffer) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++)
        value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name),
      length = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    sum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 150, 125, 93, 255]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("web sources stay separate from transcript citations and only safe meeting visuals render", async () => {
  const scratch = await mkdtemp(
    path.join(os.tmpdir(), "notethis-enrichment-ui-"),
  );
  try {
    const png = pixelPng();
    const bundle = await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ChatPanel,MeetingVisuals} from './src/App';let root;window.renderEnrichment=props=>{root ||= createRoot(document.getElementById('root'));root.render(React.createElement(React.Fragment,null,React.createElement('p',{className:'summary-copy'},props.insight.summary),React.createElement(MeetingVisuals,{insight:props.insight}),React.createElement(ChatPanel,props.chat)));};`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
    });
    const html = `<!doctype html><meta charset="utf-8"><div id="root"></div><script>${bundle.outputFiles[0].text}</script>`;
    await writeFile(path.join(scratch, "index.html"), html);
    const run = async function (png: string) {
      const w = window as any,
        passed: string[] = [],
        opened: string[] = [],
        seeks: string[] = [];
      let failOpen = false;
      const wait = () => new Promise((resolve) => setTimeout(resolve, 15));
      const check = async (predicate: () => unknown, name: string) => {
        const deadline = performance.now() + 4000;
        while (performance.now() < deadline) {
          try {
            if (predicate()) {
              passed.push(name);
              return;
            }
          } catch {}
          await wait();
        }
        throw new Error(
          name + "; UI=" + document.getElementById("root")!.textContent,
        );
      };
      const dataUrl = "data:image/png;base64," + png;
      const insight: any = {
        summary: "The original summary remains available.",
        decisions: ["Keep the current launch date."],
        actions: [],
        visualError: "Synthetic image generation failed for one diagram.",
        visuals: [
          {
            id: "inline",
            title: "Launch sequence",
            description: "A generated overview of the agreed launch steps.",
            mimeType: "image/png",
            dataUrl,
          },
          {
            id: "stored",
            title: "Stored diagram",
            description: "A diagram loaded from this meeting’s local files.",
            mimeType: "image/png",
            imageUrl: "/api/meetings/m1/visuals/diagram2",
          },
          {
            id: "svg",
            title: "Unsafe SVG",
            description: "Do not display.",
            mimeType: "image/svg+xml",
            dataUrl:
              "data:image/svg+xml;base64," +
              btoa(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>window.unsafe=true</script></svg>',
              ),
          },
          {
            id: "spoof",
            title: "Spoofed PNG",
            description: "Do not display.",
            mimeType: "image/png",
            dataUrl:
              "data:image/png;base64," +
              btoa('<svg onload="window.unsafe=true"></svg>'),
          },
          {
            id: "remote",
            title: "Remote image",
            description: "Do not fetch.",
            mimeType: "image/png",
            imageUrl: "https://example.test/tracker.png",
          },
          {
            id: "traversal",
            title: "Invalid local path",
            description: "Do not load.",
            mimeType: "image/png",
            imageUrl: "/api/meetings/m1/visuals/../private",
          },
          {
            id: "mime",
            title: "Mismatched MIME",
            description: "Do not display.",
            mimeType: "image/jpeg",
            dataUrl,
          },
        ],
      };
      const meeting: any = {
        id: "m1",
        title: "Fixture",
        createdAt: new Date().toISOString(),
        duration: 30,
        status: "ready",
        audioFile: "synthetic.wav",
        segments: [
          {
            id: "seg1",
            start: 12,
            end: 15,
            text: "We will launch on Monday.",
            words: [],
          },
        ],
        messages: [
          {
            id: "answer",
            role: "assistant",
            text: "The transcript says Monday; external context is cited separately.",
            citations: ["seg1"],
            webSearchUsed: true,
            webSources: [
              { title: "Public source", url: "https://example.test/research" },
              {
                title: "Second public source",
                url: "http://example.test/background",
              },
              { title: "Unsafe script", url: "javascript:alert(1)" },
              { title: "Local file", url: "file:///etc/passwd" },
              {
                title: "Credentialed link",
                url: "https://user:secret@example.test/private",
              },
            ],
            createdAt: new Date().toISOString(),
          },
        ],
      };
      w.desktop = {
        isElectron: true,
        openExternal: async (url: string) => {
          opened.push(url);
          return failOpen
            ? { ok: false, error: "Synthetic browser handoff failure" }
            : { ok: true };
        },
      };
      const props = {
        insight,
        chat: {
          meeting,
          onRefresh: async () => {},
          onMessage: () => {},
          onSeek: (id: string) => seeks.push(id),
          llm: "fixture-model",
          webSearchEnabled: true,
          onSettings: () => {},
        },
      };
      w.renderEnrichment(props);
      await check(
        () =>
          document.querySelectorAll(".meeting-visual img").length === 2 &&
          Array.from(
            document.querySelectorAll<HTMLImageElement>(".meeting-visual img"),
          ).every((image) => image.complete && image.naturalWidth === 1),
        "Validated PNG data and exact local visual routes load successfully",
      );
      await check(
        () =>
          document.querySelectorAll(".meeting-visual .visual-heading span")
            .length === 2 &&
          Array.from(
            document.querySelectorAll(".meeting-visual .visual-heading span"),
          ).every((item) => item.textContent === "AI-generated"),
        "Every displayed diagram is labeled AI-generated",
      );
      await check(
        () =>
          document.querySelector(
            'img[alt="A generated overview of the agreed launch steps."]',
          ) &&
          document
            .querySelector("figcaption")
            ?.textContent?.includes("agreed launch steps"),
        "Visual description is available as caption and image alternative text",
      );
      await check(
        () =>
          document.querySelectorAll(".meeting-visual a[download]").length ===
            2 &&
          Array.from(
            document.querySelectorAll<HTMLAnchorElement>(
              ".meeting-visual a[download]",
            ),
          ).every(
            (link) =>
              link.getAttribute("href") === dataUrl ||
              link.getAttribute("href") === "/api/meetings/m1/visuals/diagram2",
          ),
        "Downloads use the validated visual source only",
      );
      await check(
        () =>
          !document.querySelector('img[src^="https:"]') &&
          !document.querySelector('img[src^="data:image/svg"]') &&
          !w.unsafe,
        "Remote, SVG, MIME-spoofed, and path-traversal visuals never render",
      );
      await check(
        () =>
          document.querySelector(".summary-copy")?.textContent ===
            "The original summary remains available." &&
          document
            .querySelector('[aria-label="Meeting visuals"]')
            ?.textContent?.includes("Synthetic image generation failed") &&
          document
            .querySelector('[aria-label="Meeting visuals"]')
            ?.textContent?.includes("couldn’t be displayed"),
        "Nonfatal visual errors retain the summary and explain rejected visuals",
      );
      await check(
        () =>
          document.querySelectorAll(
            '[aria-label="Transcript citations"] button',
          ).length === 1 &&
          document.querySelectorAll('[aria-label="Web sources"] a').length ===
            2,
        "Web sources and transcript timestamps are separate controls",
      );
      await check(
        () =>
          document
            .querySelector('[aria-label="Web sources"]')
            ?.textContent?.includes("Public source") &&
          !document
            .querySelector('[aria-label="Transcript citations"]')
            ?.textContent?.includes("Public source"),
        "Web titles never appear as transcript citations",
      );
      (
        document.querySelector(
          '[aria-label="Transcript citations"] button',
        ) as HTMLButtonElement
      ).click();
      await check(
        () => seeks[0] === "seg1" && opened.length === 0,
        "Transcript citation seeks audio without opening the browser",
      );
      const external = document.querySelector(
        '[aria-label="Web sources"] a',
      ) as HTMLAnchorElement;
      external.click();
      await check(
        () =>
          opened[0] === "https://example.test/research" && seeks.length === 1,
        "Web source uses the secure external-opening helper without seeking audio",
      );
      await check(
        () =>
          document
            .querySelector(".web-search-used")
            ?.textContent?.includes("Web search used") &&
          document
            .querySelector(".compose-bottom")
            ?.textContent?.includes("Meeting + web when supported"),
        "Chat indicates actual search use separately from the configured preference",
      );
      failOpen = true;
      external.click();
      await check(
        () =>
          document
            .querySelector('[role="alert"]')
            ?.textContent?.includes("Synthetic browser handoff failure"),
        "External-source opening failures are visible inside chat",
      );
      w.renderEnrichment({
        ...props,
        chat: { ...props.chat, webSearchEnabled: false },
      });
      await check(
        () =>
          document
            .querySelector(".compose-bottom")
            ?.textContent?.includes("This meeting only") &&
          document.querySelector(".web-search-used"),
        "Turning web preference off keeps historical search attribution",
      );
      const noSearch = {
        ...meeting,
        messages: [
          {
            ...meeting.messages[0],
            webSearchUsed: false,
            webSources: [],
            citations: [],
          },
        ],
      };
      w.renderEnrichment({
        ...props,
        chat: { ...props.chat, meeting: noSearch, webSearchEnabled: false },
        insight: { ...insight, visuals: [], visualError: undefined },
      });
      await check(
        () =>
          !document.querySelector('[aria-label="Web sources"]') &&
          !document.querySelector(".web-search-used") &&
          !document.querySelector('[aria-label="Meeting visuals"]'),
        "Messages without search and notes without diagrams do not gain artificial source or visual sections",
      );
      return { passed };
    };
    const report = path.join(scratch, "result.json");
    const main = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const http=require('node:http');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});app.whenReady().then(async()=>{const server=http.createServer((req,res)=>{if(req.url==='/api/meetings/m1/visuals/diagram2'){res.writeHead(200,{'Content-Type':'image/png'});res.end(Buffer.from(${JSON.stringify(png.toString("base64"))},'base64'));}else if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end(fs.readFileSync(${JSON.stringify(path.join(scratch, "index.html"))}));}else{res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const address='http://127.0.0.1:'+server.address().port;const win=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>done({cancel:!details.url.startsWith(address+'/')}));await win.loadURL(address+'/');const result=await win.webContents.executeJavaScript('('+${JSON.stringify(run.toString())}+')('+${JSON.stringify(JSON.stringify(png.toString("base64")))}+')',true);fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(result));server.close();app.exit(0)}).catch(error=>{console.error(error);app.exit(1)});`;
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
      child.stdout.on("data", (chunk) => (logs += chunk));
      child.stderr.on("data", (chunk) => (logs += chunk));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Enrichment UI timed out: " + logs));
      }, 30000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error("Enrichment UI exited " + code + ": " + logs));
      });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    expect(result.passed.length).toBeGreaterThanOrEqual(14);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45000);
