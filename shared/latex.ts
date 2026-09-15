import type { Meeting } from "./types.js";
import katex from "katex";

export type LatexBlock =
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "paragraph"; text: string }
  | { type: "math"; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; rows: string[][] }
  | {
      type: "chart";
      title: string;
      xLabel: string;
      yLabel: string;
      kind: "line" | "bar";
      series: { label: string; points: { x: number; y: number }[] }[];
    }
  | { type: "unsupported"; text: string };
const SOURCE_LIMIT = 20_000;
const MATH_LIMIT = 4_000;
const mathCommands = new Set(
  (
    "frac dfrac tfrac sqrt sum prod int iint iiint oint lim min max log ln exp sin cos tan cot sec csc sinh cosh tanh arcsin arccos arctan " +
    "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega " +
    "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega " +
    "infty partial nabla pm mp times div cdot ast circ bullet le leq ge geq ne neq approx sim simeq equiv propto ll gg " +
    "in notin ni subset subseteq supset supseteq cup cap emptyset forall exists neg land lor to rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow mapsto " +
    "mathbb mathcal mathrm mathit mathbf mathsf mathtt boldsymbol text operatorname overline underline vec hat bar dot ddot tilde widehat widetilde " +
    "left right big Big bigg Bigg langle rangle lvert rvert lVert rVert vert Vert lceil rceil lfloor rfloor " +
    "ldots cdots vdots ddots quad qquad displaystyle textstyle binom dbinom tbinom overset underset underbrace overbrace det gcd mod bmod pmod " +
    "begin end"
  ).split(/\s+/),
);
const mathEnvironments = new Set([
  "aligned",
  "gathered",
  "matrix",
  "pmatrix",
  "bmatrix",
  "Bmatrix",
  "vmatrix",
  "Vmatrix",
  "cases",
]);
function group(
  source: string,
  start: number,
  open = "{",
  close = "}",
): { value: string; end: number } | undefined {
  if (source[start] !== open) return;
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === open && ++depth > 16) return;
    if (source[i] === close && --depth === 0)
      return { value: source.slice(start + 1, i), end: i + 1 };
  }
}
function safeMath(source: string): boolean {
  if (
    !source.trim() ||
    source.length > MATH_LIMIT ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f~]|\^\^/.test(source)
  )
    return false;
  let depth = 0;
  const environments: string[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if ("%#$".includes(c)) return false;
    if (c === "{") {
      if (++depth > 16) return false;
    } else if (c === "}") {
      if (--depth < 0) return false;
    } else if (c === "\\") {
      const command = /^\\([A-Za-z]+|[^A-Za-z])/.exec(source.slice(i));
      if (!command) return false;
      const name = command[1];
      if (name.length === 1 && "\\,;:! {}_|%$&#".includes(name)) {
        i += command[0].length - 1;
        continue;
      }
      if (!mathCommands.has(name)) return false;
      i += command[0].length - 1;
      if (name === "begin" || name === "end") {
        const arg = group(source, i + 1);
        if (!arg || !mathEnvironments.has(arg.value)) return false;
        if (name === "begin") environments.push(arg.value);
        else if (environments.pop() !== arg.value) return false;
        i = arg.end - 1;
      }
    }
  }
  if (depth !== 0 || environments.length !== 0) return false;
  try {
    // Validate syntax only. No rendered HTML is retained or evaluated here.
    katex.renderToString(source, {
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 100,
      maxSize: 20,
    });
    return true;
  } catch {
    return false;
  }
}
function escapeText(source: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    $: "\\$",
    "&": "\\&",
    "#": "\\#",
    "%": "\\%",
    _: "\\_",
    "^": "\\textasciicircum{}",
    "~": "\\textasciitilde{}",
  };
  return source
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .replace(/[\\{}$&#%_^~]/g, (c) => replacements[c]);
}
/** Rebuild emphasis and inline math; never return unvalidated source commands. */
function inlineTex(source: string, depth = 0): string | undefined {
  if (depth > 12) return;
  let result = "";
  for (let i = 0; i < source.length;) {
    if (source[i] === "$" || source.startsWith("\\(", i)) {
      const dollar = source[i] === "$";
      const start = i + (dollar ? 1 : 2);
      let end = source.indexOf(dollar ? "$" : "\\)", start);
      if (dollar) {
        end = start;
        while (end < source.length) {
          if (source[end] === "\\") {
            end += 2;
            continue;
          }
          if (source[end] === "$") break;
          end++;
        }
        if (end === source.length) end = -1;
      }
      if (end < 0 || !safeMath(source.slice(start, end))) return;
      result += `\\(${source.slice(start, end)}\\)`;
      i = end + (dollar ? 1 : 2);
      continue;
    }
    if (source[i] === "\\") {
      const command = /^\\(textbf|emph|textit)\b/.exec(source.slice(i));
      if (command) {
        const arg = group(source, i + command[0].length);
        if (!arg) return;
        const inner = inlineTex(arg.value, depth + 1);
        if (inner === undefined) return;
        result += `\\${command[1]}{${inner}}`;
        i = arg.end;
        continue;
      }
      const escaped = source[i + 1];
      if (escaped && "{}$&#%_".includes(escaped)) {
        result += `\\${escaped}`;
        i += 2;
        continue;
      }
      return;
    }
    result += escapeText(source[i]);
    i++;
  }
  return result;
}
function splitTop(source: string, delimiter: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (depth === 0 && source.startsWith(delimiter, i)) {
      parts.push(source.slice(start, i));
      i += delimiter.length - 1;
      start = i + 1;
      continue;
    }
    if (source[i] === "\\") {
      i++;
      continue;
    }
    if (source[i] === "{" && ++depth > 16) return;
    if (source[i] === "}" && --depth < 0) return;
  }
  if (depth !== 0) return;
  parts.push(source.slice(start));
  return parts;
}
function table(body: string): LatexBlock | undefined {
  const alignment = group(body.trimStart(), 0);
  if (!alignment || !/^[lcr| ]+$/.test(alignment.value)) return;
  const columns = alignment.value.replace(/[^lcr]/g, "").length;
  if (columns < 1 || columns > 12) return;
  const rawRows = splitTop(body.trimStart().slice(alignment.end), "\\\\");
  if (!rawRows) return;
  const rows: string[][] = [];
  for (const raw of rawRows) {
    const cleaned = raw
      .replace(/\\(?:toprule|midrule|bottomrule|hline)\b/g, "")
      .trim();
    if (!cleaned) continue;
    const cells = splitTop(cleaned, "&")?.map((cell) => cell.trim());
    if (
      !cells ||
      cells.length !== columns ||
      cells.some((cell) => inlineTex(cell) === undefined)
    )
      return;
    rows.push(cells);
    if (rows.length > 50 || rows.length * columns > 200) return;
  }
  return rows.length ? { type: "table", rows } : undefined;
}
function chart(body: string): LatexBlock | undefined {
  const axis = /^\s*\\begin\{axis\}/.exec(body);
  if (!axis) return;
  let cursor = axis[0].length;
  while (/\s/.test(body[cursor] ?? "") && cursor < body.length) cursor++;
  let title = "",
    xLabel = "",
    yLabel = "";
  let axisBar = false;
  let legendLabels: string[] = [];
  const bare = (text: string) => {
    const trimmed = text.trim();
    const arg = group(trimmed, 0);
    return arg && arg.end === trimmed.length ? arg.value : trimmed;
  };
  if (body[cursor] === "[") {
    const options = group(body, cursor, "[", "]");
    if (!options) return;
    cursor = options.end;
    const parts = splitTop(options.value, ",");
    if (!parts) return;
    for (const raw of parts) {
      const part = raw.trim();
      if (!part) continue;
      if (part === "ybar") {
        axisBar = true;
        continue;
      }
      const match =
        /^(title|xlabel|ylabel|legend entries)\s*=\s*([\s\S]*)$/.exec(part);
      if (match) {
        const value = bare(match[2]);
        if (inlineTex(value) === undefined) return;
        if (match[1] === "title") title = value;
        else if (match[1] === "xlabel") xLabel = value;
        else if (match[1] === "ylabel") yLabel = value;
        else {
          const labels = splitTop(value, ",");
          if (!labels) return;
          legendLabels = labels.map((label) => bare(label));
        }
        continue;
      }
      // Harmless presentation settings are discarded and rebuilt by our renderer.
      if (
        /^(?:width|height)\s*=\s*\d+(?:\.\d+)?(?:cm|mm|in|pt)$/.test(part) ||
        /^(?:grid=(?:major|minor|both|none)|legend pos=(?:north|south) (?:east|west)|axis lines=(?:left|middle|box)|ymajorgrids(?:=true)?)$/.test(
          part,
        )
      )
        continue;
      return;
    }
  }
  const series: Extract<LatexBlock, { type: "chart" }>["series"] = [];
  let count = 0;
  let kind: "line" | "bar" | undefined;
  const numeric = "[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?";
  const coordinate = new RegExp(
    `^\\(\\s*(${numeric})\\s*,\\s*(${numeric})\\s*\\)`,
  );
  while (cursor < body.length) {
    const whitespace = /^\s*/.exec(body.slice(cursor))![0];
    cursor += whitespace.length;
    if (body.startsWith("\\end{axis}", cursor)) {
      cursor += "\\end{axis}".length;
      if (body.slice(cursor).trim()) return;
      break;
    }
    if (body.startsWith("\\addlegendentry", cursor)) {
      const arg = group(body, cursor + "\\addlegendentry".length);
      if (!arg || !series.length || inlineTex(arg.value) === undefined) return;
      series[series.length - 1].label = arg.value;
      cursor = arg.end;
      continue;
    }
    const plot = /^\\addplot\+?\s*/.exec(body.slice(cursor));
    if (!plot) return;
    cursor += plot[0].length;
    let bar = axisBar;
    if (body[cursor] === "[") {
      const options = group(body, cursor, "[", "]");
      if (!options) return;
      cursor = options.end;
      const parts = splitTop(options.value, ",");
      if (!parts) return;
      for (const raw of parts) {
        const part = raw.trim();
        if (part === "ybar") bar = true;
        else if (
          !/^(?:|blue|red|green|black|gray|thick|thin|dashed|dotted|solid|mark=(?:none|\*|o))$/.test(
            part,
          )
        )
          return;
      }
    }
    const prefix = /^\s*coordinates\s*/.exec(body.slice(cursor));
    if (!prefix) return;
    cursor += prefix[0].length;
    const coords = group(body, cursor);
    if (!coords) return;
    cursor = coords.end;
    const terminator = /^\s*;/.exec(body.slice(cursor));
    if (!terminator) return;
    cursor += terminator[0].length;
    const points: { x: number; y: number }[] = [];
    let remaining = coords.value.trim();
    while (remaining) {
      const match = coordinate.exec(remaining);
      if (!match) return;
      const x = Number(match[1]),
        y = Number(match[2]);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        Math.abs(x) > 1e12 ||
        Math.abs(y) > 1e12 ||
        ++count > 200
      )
        return;
      points.push({ x, y });
      remaining = remaining.slice(match[0].length).trim();
    }
    if (
      !points.length ||
      series.length >= 8 ||
      (kind && kind !== (bar ? "bar" : "line"))
    )
      return;
    kind = bar ? "bar" : "line";
    series.push({
      label: legendLabels[series.length] || `Series ${series.length + 1}`,
      points,
    });
  }
  if (
    !body.trimEnd().endsWith("\\end{axis}") ||
    !series.length ||
    legendLabels.length > series.length
  )
    return;
  return { type: "chart", title, xLabel, yLabel, kind: kind!, series };
}
function nextStructural(
  source: string,
  start: number,
): { index: number; token: string; end: number } | undefined {
  for (let i = start; i < source.length; i++) {
    // Inline matrices contain \begin commands but belong to their inline span.
    if (source.startsWith("\\(", i)) {
      const end = source.indexOf("\\)", i + 2);
      if (end < 0) return;
      i = end + 1;
      continue;
    }
    if (source[i] === "$" && !source.startsWith("$$", i)) {
      let end = i + 1;
      for (; end < source.length; end++) {
        if (source[end] === "\\") {
          end++;
          continue;
        }
        if (source[end] === "$") break;
      }
      if (end === source.length) return;
      i = end;
      continue;
    }
    const match =
      /^(?:\\(?:section|subsection|subsubsection)\*?\{|\\begin\{[^}]+\}|\\\[|\$\$)/.exec(
        source.slice(i),
      );
    if (match) return { index: i, token: match[0], end: i + match[0].length };
    if (source[i] === "\\") i++;
  }
}
export function parseLatexSummary(source: string): LatexBlock[] {
  if (typeof source !== "string") return [];
  const truncated = source.length > SOURCE_LIMIT;
  source = source.slice(0, SOURCE_LIMIT).replace(/\r\n?/g, "\n");
  // A wrapping Markdown fence is a transport wrapper, not executable TeX.
  const fence = /^\s*```(?:latex|tex)?\s*\n([\s\S]*?)\n```\s*$/.exec(source);
  if (fence) source = fence[1];
  const blocks: LatexBlock[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    text = text.trim();
    if (text)
      blocks.push({
        type: inlineTex(text) === undefined ? "unsupported" : "paragraph",
        text,
      });
  };
  while (cursor < source.length && blocks.length < 300) {
    const match = nextStructural(source, cursor);
    if (!match) {
      for (const paragraph of source.slice(cursor).split(/\n\s*\n/))
        pushText(paragraph);
      cursor = source.length;
      break;
    }
    for (const paragraph of source.slice(cursor, match.index).split(/\n\s*\n/))
      pushText(paragraph);
    const start = match.index;
    if (match.token.startsWith("\\begin")) {
      const name = match.token.slice(7, -1);
      const endToken = `\\end{${name}}`;
      const end = source.indexOf(endToken, match.end);
      if (end < 0) {
        blocks.push({ type: "unsupported", text: source.slice(start) });
        cursor = source.length;
        break;
      }
      const raw = source.slice(start, end + endToken.length),
        body = source.slice(match.end, end);
      let block: LatexBlock | undefined;
      if (name === "tabular") block = table(body);
      else if (name === "tikzpicture") block = chart(body);
      else if (name === "itemize" || name === "enumerate") {
        const items = body.split(/\\item\b/);
        const prefix = items.shift();
        if (
          !prefix?.trim() &&
          items.length > 0 &&
          items.length <= 80 &&
          items.every(
            (item) =>
              item.trim() &&
              !item.trimStart().startsWith("[") &&
              inlineTex(item.trim()) !== undefined,
          )
        )
          block = {
            type: "list",
            ordered: name === "enumerate",
            items: items.map((item) => item.trim()),
          };
      }
      blocks.push(block ?? { type: "unsupported", text: raw });
      cursor = end + endToken.length;
    } else if (match.token === "\\[" || match.token === "$$") {
      const endToken = match.token === "$$" ? "$$" : "\\]";
      const end = source.indexOf(endToken, match.end);
      if (end < 0) {
        blocks.push({ type: "unsupported", text: source.slice(start) });
        cursor = source.length;
        break;
      }
      const math = source.slice(match.end, end).trim();
      blocks.push(
        safeMath(math)
          ? { type: "math", text: math }
          : {
              type: "unsupported",
              text: source.slice(start, end + endToken.length),
            },
      );
      cursor = end + endToken.length;
    } else {
      const arg = group(source, match.end - 1);
      if (!arg) {
        blocks.push({ type: "unsupported", text: source.slice(start) });
        cursor = source.length;
        break;
      }
      const level = match.token.startsWith("\\subsubsection")
        ? 3
        : match.token.startsWith("\\subsection")
          ? 2
          : 1;
      blocks.push(
        inlineTex(arg.value) !== undefined
          ? { type: "heading", level, text: arg.value }
          : { type: "unsupported", text: source.slice(start, arg.end) },
      );
      cursor = arg.end;
    }
  }
  if (cursor < source.length)
    blocks.push({ type: "unsupported", text: source.slice(cursor) });
  if (truncated)
    blocks.push({
      type: "unsupported",
      text: "[Summary exceeds the 20,000-character limit; remaining content was not rendered or exported.]",
    });
  if (blocks.length > 301) {
    const overflow = blocks.splice(300);
    blocks.push({
      type: "unsupported",
      text:
        "[Preview block limit reached; remaining content follows.]\n" +
        overflow.map(renderBlock).join("\n\n"),
    });
  }
  return blocks;
}
function renderBlock(block: LatexBlock): string {
  const inline = (text: string) => inlineTex(text) ?? escapeText(text);
  if (block.type === "heading")
    return `\\${["section", "subsection", "subsubsection"][block.level - 1]}*{${inline(block.text)}}`;
  if (block.type === "paragraph") return inline(block.text);
  if (block.type === "unsupported")
    return `\\noindent\\textbf{Unrendered source:}\\par\n${escapeText(block.text)}`;
  if (block.type === "math")
    return safeMath(block.text)
      ? `\\[\n${block.text}\n\\]`
      : escapeText(block.text);
  if (block.type === "list") {
    const environment = block.ordered ? "enumerate" : "itemize";
    return `\\begin{${environment}}\n${block.items.map((item) => `\\item ${inline(item)}`).join("\n")}\n\\end{${environment}}`;
  }
  if (block.type === "table")
    return `\\begin{center}\n\\begin{tabular}{${"l".repeat(block.rows[0].length)}}\n\\toprule\n${block.rows.map((row, i) => `${row.map(inline).join(" & ")} \\\\${i === 0 ? "\n\\midrule" : ""}`).join("\n")}\n\\bottomrule\n\\end{tabular}\n\\end{center}`;
  const options = [
    "width=0.92\\linewidth",
    "height=6cm",
    `title={${inline(block.title)}}`,
    `xlabel={${inline(block.xLabel)}}`,
    `ylabel={${inline(block.yLabel)}}`,
    ...(block.kind === "bar" ? ["ybar"] : []),
  ];
  return `\\begin{center}\n\\begin{tikzpicture}\n\\begin{axis}[${options.join(",")} ]\n${block.series.map((series) => `\\addplot coordinates {${series.points.map((point) => `(${point.x},${point.y})`).join(" ")}};\n\\addlegendentry{${inline(series.label)}}`).join("\n")}\n\\end{axis}\n\\end{tikzpicture}\n\\end{center}`;
}
/** Portable source only: this module never loads files, fetches URLs, or executes TeX. */
export function exportLatexMeeting(meeting: Meeting): string {
  const insight = meeting.insight;
  const summary = insight?.summary ?? "No summary is available.";
  const content =
    insight?.summaryFormat === "latex"
      ? parseLatexSummary(summary).map(renderBlock).join("\n\n")
      : escapeText(summary.slice(0, SOURCE_LIMIT)) +
        (summary.length > SOURCE_LIMIT
          ? "\n\n[Summary truncated at 20,000 characters.]"
          : "");
  const decisions = (insight?.decisions ?? [])
    .slice(0, 200)
    .map((text) => `\\item ${escapeText(text)}`);
  const actions = (insight?.actions ?? [])
    .slice(0, 200)
    .map(
      (action) =>
        `\\item ${escapeText(action.done ? "[Done] " : "[Open] ")}${escapeText(action.text)}${action.owner ? ` \\textbf{Owner:} ${escapeText(action.owner)}` : ""}${action.due ? ` \\textbf{Due:} ${escapeText(action.due)}` : ""}`,
    );
  if ((insight?.decisions.length ?? 0) > 200)
    decisions.push(
      "\\item [Additional decisions omitted: export limit is 200.]",
    );
  if ((insight?.actions.length ?? 0) > 200)
    actions.push("\\item [Additional actions omitted: export limit is 200.]");
  return `\\documentclass[11pt]{article}\n\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amsmath,amssymb,booktabs,pgfplots}\n\\pgfplotsset{compat=1.18}\n\\title{${escapeText(meeting.title)}}\n\\author{NoteThis}\n\\date{${escapeText(meeting.createdAt)}}\n\\begin{document}\n\\maketitle\n\n${content}\n\n\\section*{Decisions}\n${decisions.length ? `\\begin{itemize}\n${decisions.join("\n")}\n\\end{itemize}` : "No decisions recorded."}\n\n\\section*{Action items}\n${actions.length ? `\\begin{itemize}\n${actions.join("\n")}\n\\end{itemize}` : "No action items recorded."}\n\\end{document}\n`;
}
