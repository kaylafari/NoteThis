import { describe, expect, it } from "vitest";
import { parseLatexSummary, exportLatexMeeting } from "../shared/latex.js";
import type { Meeting } from "../shared/types.js";
const meeting: Meeting = {
  id: "fixture",
  title: "Budget & Growth_2026: 10%",
  createdAt: "2026-09-15",
  duration: 60,
  status: "ready",
  audioFile: "",
  segments: [],
  messages: [],
  insight: {
    summaryFormat: "latex",
    summary: "",
    decisions: ["Keep $5 & 10% in reserve."],
    actions: [
      {
        id: "a",
        text: "Prepare report_1",
        owner: "Mia & Lee",
        due: "Friday",
        done: false,
      },
    ],
  },
};
const line = String.raw`\begin{tikzpicture}
\begin{axis}[title={Revenue},xlabel={Week},ylabel={USD}]
\addplot coordinates {(1,10) (2,-5) (3,0)};
\addlegendentry{Actual}
\addplot[dashed] coordinates {(1,8) (2,12) (3,16)};
\addlegendentry{Forecast}
\end{axis}
\end{tikzpicture}`;
const bar = String.raw`\begin{tikzpicture}\begin{axis}[ybar,title={Costs},xlabel={Team},ylabel={USD},legend entries={Actual,Plan}]
\addplot coordinates {(1,10) (2,20)};
\addplot coordinates {(1,15) (2,25)};
\end{axis}\end{tikzpicture}`;
describe("bounded LaTeX summary parsing", () => {
  it("parses headings and retains inline emphasis and formulas", () => {
    expect(
      parseLatexSummary(String.raw`\section{Overview}
A \textbf{clear} result with \emph{caution} and $x_1=2$.

\subsection{Next}
\subsubsection{Details}`),
    ).toEqual([
      { type: "heading", level: 1, text: "Overview" },
      {
        type: "paragraph",
        text: String.raw`A \textbf{clear} result with \emph{caution} and $x_1=2$.`,
      },
      { type: "heading", level: 2, text: "Next" },
      { type: "heading", level: 3, text: "Details" },
    ]);
  });
  it("supports both display delimiters, fractions, percentages, Greek and aligned equations", () => {
    expect(
      parseLatexSummary(String.raw`\[\frac{a}{b}=20\%\]
$$\alpha+\beta=\sqrt{4}$$
\[\begin{aligned} x&=1\\ y&=2\end{aligned}\]`).map((block) => block.type),
    ).toEqual(["math", "math", "math"]);
  });
  it("keeps inline matrix environments inside their math span", () => {
    for (const raw of [
      String.raw`Matrix \(\begin{pmatrix}1&2\\3&4\end{pmatrix}\) is invertible.`,
      String.raw`Matrix $\begin{matrix}1&2\\3&4\end{matrix}$ is invertible.`,
      String.raw`Rates $x=20\%+\$5+\#1$ remain unchanged.`,
    ]) {
      expect(parseLatexSummary(raw)).toEqual([
        { type: "paragraph", text: raw },
      ]);
      const tex = exportLatexMeeting({
        ...meeting,
        insight: { ...meeting.insight!, summary: raw },
      });
      expect(tex).not.toContain("Unrendered source:");
    }
    expect(
      parseLatexSummary(String.raw`\[\begin{bmatrix}1&2\\3&4\end{bmatrix}\]`),
    ).toEqual([
      { type: "math", text: String.raw`\begin{bmatrix}1&2\\3&4\end{bmatrix}` },
    ]);
  });
  it("bounds many paragraphs while retaining a visible remainder", () => {
    const parsed = parseLatexSummary(
      Array.from({ length: 400 }, (_, i) => `Paragraph ${i}`).join("\n\n"),
    );
    expect(parsed.length).toBeLessThanOrEqual(301);
    expect(parsed.at(-1)).toMatchObject({
      type: "unsupported",
      text: expect.stringContaining("Paragraph 399"),
    });
  });
  it("parses itemize and enumerate without dropping item text", () => {
    expect(
      parseLatexSummary(String.raw`\begin{itemize}\item One \textbf{item}\item Two\end{itemize}
\begin{enumerate}\item First\item Second\end{enumerate}`),
    ).toEqual([
      {
        type: "list",
        ordered: false,
        items: [String.raw`One \textbf{item}`, "Two"],
      },
      { type: "list", ordered: true, items: ["First", "Second"] },
    ]);
  });
  it("parses booktabs rows and escaped ampersands", () => {
    expect(
      parseLatexSummary(String.raw`\begin{tabular}{lr}\toprule
Team & Budget\\\midrule
R\&D & $\frac{20}{2}$\\
Sales & 15\\\bottomrule\end{tabular}`),
    ).toEqual([
      {
        type: "table",
        rows: [
          ["Team", "Budget"],
          [String.raw`R\&D`, String.raw`$\frac{20}{2}$`],
          ["Sales", "15"],
        ],
      },
    ]);
  });
  it("parses negative/zero line chart points and multiple labeled series", () => {
    expect(parseLatexSummary(line)).toEqual([
      {
        type: "chart",
        title: "Revenue",
        xLabel: "Week",
        yLabel: "USD",
        kind: "line",
        series: [
          {
            label: "Actual",
            points: [
              { x: 1, y: 10 },
              { x: 2, y: -5 },
              { x: 3, y: 0 },
            ],
          },
          {
            label: "Forecast",
            points: [
              { x: 1, y: 8 },
              { x: 2, y: 12 },
              { x: 3, y: 16 },
            ],
          },
        ],
      },
    ]);
  });
  it("parses grouped numeric bars with legend entries", () => {
    const parsed = parseLatexSummary(bar)[0];
    expect(parsed).toMatchObject({
      type: "chart",
      kind: "bar",
      series: [{ label: "Actual" }, { label: "Plan" }],
    });
  });
  it("accepts finite scientific numeric coordinates but no expressions", () => {
    expect(
      parseLatexSummary(line.replace("(1,10)", "(1e-2,-2.5e+3)"))[0],
    ).toMatchObject({
      type: "chart",
      series: [
        {
          points: [
            { x: 0.01, y: -2500 },
            { x: 2, y: -5 },
            { x: 3, y: 0 },
          ],
        },
        { points: expect.any(Array) },
      ],
    });
    const raw = line.replace("(1,10)", "(1,{sin(2)})");
    expect(parseLatexSummary(raw)).toEqual([
      { type: "unsupported", text: raw },
    ]);
  });
  it.each([
    String.raw`\input{private}`,
    String.raw`\href{https://example.com}{Link}`,
    String.raw`\unknown{Keep this text}`,
    String.raw`\begin{unknown}Visible body\end{unknown}`,
    String.raw`\section{Broken`,
    String.raw`\[x+1`,
  ])("keeps unsupported source visible: %s", (raw) => {
    expect(parseLatexSummary(raw)).toEqual([
      { type: "unsupported", text: raw },
    ]);
  });
  it.each([
    String.raw`\[\input{private}\]`,
    String.raw`\[\csname input\endcsname{private}\]`,
    String.raw`\[\write18{command}\]`,
    String.raw`\[\begin{document}x\end{document}\]`,
    String.raw`\[^^5cinput{private}\]`,
    String.raw`\[x%hidden\]`,
  ])("rejects executable or obfuscated math: %s", (raw) => {
    expect(parseLatexSummary(raw)).toEqual([
      { type: "unsupported", text: raw },
    ]);
  });
  it.each([
    String.raw`\[\frac{1}\]`,
    String.raw`$\sqrt$`,
    String.raw`\[x&=1\]`,
  ])(
    "keeps malformed formulas literal so export stays compilable: %s",
    (raw) => {
      expect(parseLatexSummary(raw)).toEqual([
        { type: "unsupported", text: raw },
      ]);
      const tex = exportLatexMeeting({
        ...meeting,
        insight: { ...meeting.insight!, summary: raw },
      });
      expect(tex).toContain("Unrendered source:");
    },
  );
  it("does not interpret unsupported commands hidden inside safe emphasis", () => {
    const raw = String.raw`A \textbf{\input{file}} value.`;
    expect(parseLatexSummary(raw)).toEqual([
      { type: "unsupported", text: raw },
    ]);
  });
  it("does not silently drop labels or unknown options from plots", () => {
    for (const raw of [
      line.replace("title={Revenue}", "title={Revenue},unknown=value"),
      line.replace("coordinates {(1,10) (2,-5) (3,0)}", "table {private.csv}"),
      line.replace("title={Revenue}", String.raw`title={\input{file}}`),
    ])
      expect(parseLatexSummary(raw)).toEqual([
        { type: "unsupported", text: raw },
      ]);
  });
  it("bounds chart points, series, numeric magnitude and table cells with visible fallback", () => {
    const many = line.replace(
      "(1,10) (2,-5) (3,0)",
      Array.from({ length: 201 }, (_, i) => `(${i},1)`).join(" "),
    );
    expect(parseLatexSummary(many)[0].type).toBe("unsupported");
    expect(
      parseLatexSummary(line.replace("(1,10)", "(1e999,10)"))[0].type,
    ).toBe("unsupported");
    const table =
      String.raw`\begin{tabular}{lllll}` +
      Array.from({ length: 41 }, () => String.raw`1&2&3&4&5\\`).join("\n") +
      String.raw`\end{tabular}`;
    expect(parseLatexSummary(table)).toEqual([
      { type: "unsupported", text: table },
    ]);
  });
  it("preserves an entire inconsistent table instead of dropping columns", () => {
    const raw = String.raw`\begin{tabular}{ll}A&B\\C&D&E\\\end{tabular}`;
    expect(parseLatexSummary(raw)).toEqual([
      { type: "unsupported", text: raw },
    ]);
  });
  it("rejects oversized source with an explicit truncation marker", () => {
    const parsed = parseLatexSummary("a".repeat(20001));
    expect(parsed.at(-1)).toMatchObject({
      type: "unsupported",
      text: expect.stringContaining("20,000-character"),
    });
    expect(JSON.stringify(parsed).length).toBeLessThan(21000);
  });
  it("unwraps only a complete outer latex code fence", () => {
    expect(parseLatexSummary("```latex\n\\section{One}\n``` ")).toEqual([
      { type: "heading", level: 1, text: "One" },
    ]);
  });
});
describe("safe portable LaTeX export", () => {
  it("reconstructs a complete document with equations, tables and numeric charts", () => {
    const summary =
      String.raw`\section{Results}
Net growth is \textbf{positive}: $g=\frac{12}{100}$.
\[\sum_{i=1}^{3} x_i = 25\]
\begin{tabular}{lr}Team&Amount\\A&10\\B&15\\\end{tabular}` +
      "\n" +
      line +
      "\n" +
      bar;
    const tex = exportLatexMeeting({
      ...meeting,
      insight: { ...meeting.insight!, summary },
    });
    expect(tex).toContain(
      String.raw`\usepackage{amsmath,amssymb,booktabs,pgfplots}`,
    );
    expect(tex).toContain(String.raw`\frac{12}{100}`);
    expect(tex).toContain(
      String.raw`\addplot coordinates {(1,10) (2,-5) (3,0)};`,
    );
    expect(tex).toContain("ybar");
    expect(tex).toContain(String.raw`\end{document}`);
  });
  it("escapes all plain metadata, decisions and action fields", () => {
    const tex = exportLatexMeeting({
      ...meeting,
      title: String.raw`Bad \input{secret} & 20% $5_1 # ~ ^`,
      insight: { ...meeting.insight!, summary: "Safe" },
    });
    expect(tex).toContain(
      String.raw`Bad \textbackslash{}input\{secret\} \& 20\% \$5\_1 \# \textasciitilde{} \textasciicircum{}`,
    );
    expect(tex).toContain(String.raw`Keep \$5 \& 10\%`);
    expect(tex).toContain(String.raw`Prepare report\_1`);
    expect(tex).toContain(String.raw`Mia \& Lee`);
    expect(tex).not.toContain(String.raw`\input{secret}`);
  });
  it("escapes legacy plain notes instead of executing apparent TeX", () => {
    const tex = exportLatexMeeting({
      ...meeting,
      insight: {
        ...meeting.insight!,
        summaryFormat: undefined,
        summary: String.raw`\section{Legacy} \write18{curl} 50%`,
      },
    });
    expect(tex).toContain(String.raw`\textbackslash{}section\{Legacy\}`);
    expect(tex).toContain(String.raw`\textbackslash{}write18\{curl\}`);
    expect(tex).not.toContain(String.raw`\write18{curl}`);
  });
  it.each([
    String.raw`\input{file}`,
    String.raw`\include{file}`,
    String.raw`\write18{shell}`,
    String.raw`\href{https://example.com}{title}`,
    String.raw`\htmlClass{unsafe}{text}`,
    String.raw`\[\text{\input{file}}\]`,
    line.replace(
      "coordinates {(1,10) (2,-5) (3,0)}",
      String.raw`gnuplot {system('cmd')}`,
    ),
  ])("escapes rejected constructs without losing their text", (summary) => {
    const tex = exportLatexMeeting({
      ...meeting,
      insight: { ...meeting.insight!, summary },
    });
    expect(tex).toContain("Unrendered source:");
    expect(tex).not.toContain(summary);
    expect(tex).toContain("\\textbackslash{}");
  });
  it("rejects attempts to end the document through emphasis or chart labels", () => {
    const summary = String.raw`\textbf{\end{document}\input{file}}`;
    const tex = exportLatexMeeting({
      ...meeting,
      insight: { ...meeting.insight!, summary },
    });
    expect(tex.match(/\\end\{document\}/g)).toHaveLength(1);
    expect(tex).not.toContain(String.raw`\input{file}`);
  });
});
