/** Native Chromium verifies the real React renderer with synthetic LaTeX only. */
import { test, expect } from "vitest";
import { build } from "esbuild";
import electron from "electron";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

test("LaTeX notes render formulas, structures and accessible bounded charts without executing document content", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "notethis-latex-ui-"));
  try {
    await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {LatexSummary} from './src/LatexSummary';import 'katex/dist/katex.min.css';import './src/styles.css';const root=createRoot(document.getElementById('root'));window.renderLatex=source=>root.render(React.createElement(LatexSummary,{source}));`,
        resolveDir: process.cwd(),
        loader: "tsx",
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      outfile: path.join(scratch, "app.js"),
      loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
      assetNames: "fonts/[name]-[hash]",
    });
    await writeFile(
      path.join(scratch, "index.html"),
      '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><main style="max-width:760px;margin:24px"><div id="root"></div></main><script src="./app.js"></script>',
    );
    const fixtures = [
      "\\section{Plan and forecast}\nThe \\textbf{launch \\emph{priority}} has rate \\(r=\\frac{a}{b}\\) and cost $x^2+1$.\n\\[\nE = mc^2\n\\]\n\\subsection{Actions}\n\\begin{itemize}\n\\item Review the forecast.\n\\item Confirm \\textit{owner} and \\(d=3\\).\n\\end{itemize}\n\\begin{enumerate}\n\\item First checkpoint.\n\\item Second checkpoint.\n\\end{enumerate}\n\\begin{tabular}{lr}\nTeam & Budget \\\\\nDesign & $x+2$ \\\\\n\\end{tabular}\n\\begin{tikzpicture}\n\\begin{axis}[title={Budget change},xlabel={Month},ylabel={USD},ybar]\n\\addplot coordinates {(1,10) (2,-5) (3,0)};\n\\addlegendentry{Actual}\n\\addplot coordinates {(1,8) (2,-3) (3,4)};\n\\addlegendentry{Planned}\n\\end{axis}\n\\end{tikzpicture}\n\\begin{tikzpicture}\n\\begin{axis}[title={Delivery forecast},xlabel={Week},ylabel={Items}]\n\\addplot coordinates {(1,0) (2,3) (3,6)};\n\\addlegendentry{Completed}\n\\end{axis}\n\\end{tikzpicture}\n",
      '\\section{Untrusted input}\n<img src="https://example.test/tracker" onerror="window.compromised=true"><script>window.compromised=true</script>\n\\[\\href{javascript:window.compromised=true}{click}\\]\n\\[\\includegraphics{https://example.test/image.png}\\]\n\\[\\htmlStyle{background:url(https://example.test/style)}{x}\\]\n\\input{/etc/passwd}\n\\write18{touch /tmp/notethis-should-not-exist}\n\\begin{unknown}Unrecognized notes remain readable.\\end{unknown}\n',
      "\\section{Malformed notes}\nRetain \\textbf{unclosed formatting.\n\\[\\frac{1}{\\]\n\\begin{tabular}{ll}A & B\n",
      "\\begin{tikzpicture}\\begin{axis}[title={Zero baseline},ybar]\\addplot coordinates {(1,0) (2,0)};\\addlegendentry{Zero}\\end{axis}\\end{tikzpicture}",
      "\\begin{tikzpicture}\\begin{axis}[title={Unequal intervals},ybar]\\addplot coordinates {(1,2) (2,3) (100,4)};\\addlegendentry{Observed}\\end{axis}\\end{tikzpicture}",
    ];
    const run = async function (fixtures: string[]) {
      const w = window as any,
        passed: string[] = [];
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
      w.renderLatex(fixtures[0]);
      await check(
        () =>
          document.querySelector("h3")?.textContent === "Plan and forecast" &&
          document.querySelector("h4")?.textContent === "Actions",
        "Document headings render with semantic hierarchy",
      );
      await check(
        () =>
          document.querySelector("strong em")?.textContent === "priority" &&
          document.querySelector("li em")?.textContent === "owner",
        "Bounded nested emphasis renders as text formatting",
      );
      await check(
        () =>
          document.querySelectorAll(".katex").length >= 5 &&
          document.querySelector(".katex .mfrac") &&
          document.querySelector(".katex-display"),
        "Inline and display formulas render as KaTeX rather than raw source",
      );
      await check(
        () =>
          document.querySelector(".katex-mathml math") &&
          !document.querySelector(".latex-math-fallback"),
        "Formulas include accessible MathML",
      );
      await check(
        () =>
          document.querySelectorAll(".latex-summary > ul > li").length === 2 &&
          document.querySelectorAll(".latex-summary > ol > li").length === 2,
        "Ordered and unordered actions remain readable lists",
      );
      await check(
        () =>
          document
            .querySelector(".latex-summary > .latex-table-scroll table")
            ?.textContent?.includes("Design") &&
          document.querySelectorAll(".latex-summary > .latex-table-scroll td")
            .length === 4,
        "Tabular rows and formula cells render as a real table",
      );
      await check(
        () =>
          document.querySelectorAll(".latex-chart svg[role=img]").length ===
            2 &&
          document.querySelectorAll(".latex-chart svg title")[0]
            ?.textContent === "Budget change",
        "Both charts have accessible titles and SVG output",
      );
      const bar = document.querySelector(".latex-chart")!;
      const series = bar.querySelectorAll("g[data-series]");
      const rects = bar.querySelectorAll("rect");
      await check(
        () =>
          rects.length === 6 &&
          series.length === 2 &&
          series[0].querySelector("rect")?.getAttribute("x") !==
            series[1].querySelector("rect")?.getAttribute("x"),
        "Multiple bar series use distinct grouped positions",
      );
      const baseline = Number(
        bar.querySelector(".latex-chart-axis")!.getAttribute("y1"),
      );
      await check(
        () =>
          Number(rects[0].getAttribute("y")) < baseline &&
          Number(rects[1].getAttribute("y")) === baseline &&
          Number(rects[2].getAttribute("height")) === 0 &&
          Number(rects[1].getAttribute("height")) > 0,
        "Positive, negative and zero bars align correctly around zero",
      );
      await check(
        () =>
          !!document.querySelector(".latex-chart polyline") &&
          document.querySelectorAll(".latex-chart circle").length === 3,
        "Line series render numeric points",
      );
      const details = bar.querySelector("details")!;
      (details.querySelector("summary") as HTMLElement).click();
      await check(
        () =>
          details.open &&
          details.querySelectorAll("tbody tr").length === 6 &&
          details.textContent?.includes("-5") &&
          details.textContent?.includes("Planned"),
        "An expandable accessible table exposes every chart value and series",
      );
      await document.fonts.ready;
      await check(
        () =>
          getComputedStyle(
            document.querySelector(".katex")!,
          ).fontFamily.includes("KaTeX") &&
          document.querySelector(".latex-chart svg")!.getBoundingClientRect()
            .width > 200,
        "Bundled fonts and responsive chart styles load locally",
      );
      w.renderLatex(fixtures[1]);
      await check(
        () => document.querySelector("h3")?.textContent === "Untrusted input",
        "Untrusted document replaces the prior render",
      );
      await check(
        () =>
          !document.querySelector(
            ".latex-summary img, .latex-summary script, .latex-summary a, .latex-summary iframe",
          ) &&
          !w.compromised &&
          document
            .querySelector(".latex-summary")
            ?.textContent?.includes("<img"),
        "Raw HTML and unsafe math cannot create executable or remote DOM nodes",
      );
      await check(
        () =>
          document.querySelectorAll(".latex-fallback").length >= 3 &&
          document
            .querySelector(".latex-summary")
            ?.textContent?.includes("Unrecognized notes remain readable") &&
          document
            .querySelector(".latex-summary")
            ?.textContent?.includes("/etc/passwd"),
        "Unsupported and unsafe commands stay visible as non-executing fallback text",
      );
      w.renderLatex(fixtures[2]);
      await check(
        () =>
          document.querySelector("h3")?.textContent === "Malformed notes" &&
          document
            .querySelector(".latex-summary")
            ?.textContent?.includes("unclosed formatting") &&
          document.querySelector(".latex-fallback"),
        "Malformed structures retain readable content without crashing",
      );
      w.renderLatex(fixtures[3]);
      await check(
        () =>
          document
            .querySelector(".latex-chart")
            ?.textContent?.includes("Zero baseline") &&
          [...document.querySelectorAll(".latex-chart rect")].every(
            (rect) =>
              Number.isFinite(Number(rect.getAttribute("y"))) &&
              rect.getAttribute("height") === "0",
          ),
        "An all-zero chart keeps finite coordinates and truthful zero-height bars",
      );
      w.renderLatex(fixtures[4]);
      await check(
        () =>
          document
            .querySelector(".latex-chart")
            ?.textContent?.includes("Unequal intervals") &&
          document.querySelectorAll(".latex-chart rect").length === 3,
        "Unequally spaced numeric bar data renders",
      );
      const unequalBars = [...document.querySelectorAll(".latex-chart rect")];
      const centers = unequalBars.map(
        (rect) =>
          Number(rect.getAttribute("x")) +
          Number(rect.getAttribute("width")) / 2,
      );
      await check(
        () =>
          Math.abs((centers[2] - centers[1]) / (centers[1] - centers[0]) - 98) <
          0.001,
        "Bar positions preserve the numeric interval ratio for x=1,2,100",
      );
      await check(
        () =>
          Number(unequalBars[0].getAttribute("x")) >= 70 &&
          Number(unequalBars[2].getAttribute("x")) +
            Number(unequalBars[2].getAttribute("width")) <=
            618 &&
          Number(unequalBars[0].getAttribute("x")) +
            Number(unequalBars[0].getAttribute("width")) <
            Number(unequalBars[1].getAttribute("x")),
        "Minimum-interval widths and end padding prevent bar overlap or clipping",
      );
      w.renderLatex("A".repeat(20_010));
      await check(
        () =>
          document
            .querySelector(".latex-render-notice")
            ?.textContent?.includes("20,000"),
        "Oversized document preview explains its display limit",
      );
      return { passed };
    };
    const report = path.join(scratch, "result.json");
    const main = `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const requests=[];win.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,done)=>{requests.push(details.url);done({cancel:true})});await win.loadFile(${JSON.stringify(path.join(scratch, "index.html"))});const result=await win.webContents.executeJavaScript('('+${JSON.stringify(run.toString())}+')('+${JSON.stringify(JSON.stringify(fixtures))}+')',true);result.remoteRequests=requests;fs.writeFileSync(${JSON.stringify(report)},JSON.stringify(result));app.exit(0)}).catch(error=>{console.error(error);app.exit(1)});`;
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
        reject(new Error("LaTeX UI timed out: " + logs));
      }, 30000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error("LaTeX UI exited " + code + ": " + logs));
      });
    });
    const result = JSON.parse(await readFile(report, "utf8"));
    expect(result.passed.length).toBeGreaterThanOrEqual(21);
    expect(result.remoteRequests).toEqual([]);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}, 45000);
