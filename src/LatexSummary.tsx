import React, { useId, useMemo } from "react";
import katex from "katex";
import { parseLatexSummary, type LatexBlock } from "../shared/latex";

const MAX_SOURCE = 20_000;
const MAX_INLINE_DEPTH = 6;

function MathText({
  source,
  display = false,
}: {
  source: string;
  display?: boolean;
}) {
  const html = useMemo(() => {
    if (source.length > 4096) return null;
    try {
      return katex.renderToString(source, {
        displayMode: display,
        output: "htmlAndMathml",
        throwOnError: true,
        trust: false,
        strict: "error",
        maxExpand: 200,
        maxSize: 12,
        macros: {},
      });
    } catch {
      return null;
    }
  }, [source, display]);
  if (html === null)
    return (
      <code
        className="latex-fallback latex-math-fallback"
        title="This formula could not be rendered safely"
      >
        {source}
      </code>
    );
  // Only KaTeX-produced HTML enters the DOM. Model text is never treated as HTML.
  return (
    <span
      className={display ? "latex-math latex-display" : "latex-math"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function isEscaped(source: string, index: number) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i--) slashes++;
  return slashes % 2 === 1;
}

function closingBrace(source: string, start: number) {
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (isEscaped(source, index)) continue;
    if (source[index] === "{") depth++;
    if (source[index] === "}") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** A small inline grammar; unknown commands remain text instead of being executed. */
function inline(source: string, depth = 0): React.ReactNode[] {
  if (depth >= MAX_INLINE_DEPTH) return [source];
  const nodes: React.ReactNode[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      nodes.push(plain);
      plain = "";
    }
  };
  for (let index = 0; index < source.length;) {
    const tail = source.slice(index);
    const emphasis = /^\\(textbf|emph|textit)\s*\{/.exec(tail);
    if (emphasis) {
      const opening = index + emphasis[0].length - 1;
      const closing = closingBrace(source, opening);
      if (closing >= 0) {
        flush();
        const contents = inline(source.slice(opening + 1, closing), depth + 1);
        nodes.push(
          emphasis[1] === "textbf" ? (
            <strong key={index}>{contents}</strong>
          ) : (
            <em key={index}>{contents}</em>
          ),
        );
        index = closing + 1;
        continue;
      }
    }
    const bracketMath = tail.startsWith("\\(");
    const dollarMath = source[index] === "$" && !isEscaped(source, index);
    if (bracketMath || dollarMath) {
      const start = index + (bracketMath ? 2 : 1);
      const delimiter = bracketMath ? "\\)" : "$";
      let end = source.indexOf(delimiter, start);
      while (end >= 0 && isEscaped(source, end))
        end = source.indexOf(delimiter, end + delimiter.length);
      if (end > start) {
        flush();
        nodes.push(<MathText key={index} source={source.slice(start, end)} />);
        index = end + delimiter.length;
        continue;
      }
    }
    if (source[index] === "\\" && /[&%$#_{}]/.test(source[index + 1] || " ")) {
      plain += source[index + 1];
      index += 2;
    } else {
      plain += source[index++];
    }
  }
  flush();
  return nodes;
}

const numberLabel = (value: number) =>
  Math.abs(value) >= 1e6 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(1)
    : Number(value.toPrecision(4)).toLocaleString("en-US");
const chartColors = [
  "#68513d",
  "#353539",
  "#817366",
  "#565e68",
  "#78614f",
  "#77777b",
  "#4c4035",
  "#5f6467",
];

function SummaryChart({
  block,
}: {
  block: Extract<LatexBlock, { type: "chart" }>;
}) {
  const id = useId();
  const series = block.series.slice(0, 8).map((entry) => ({
    ...entry,
    points: entry.points
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .slice(0, 200),
  }));
  const all = series.flatMap((entry) => entry.points);
  if (!all.length)
    return (
      <p className="latex-fallback">
        {block.title || "Chart"}: no numeric data to display.
      </p>
    );
  const width = 640,
    height = 300,
    left = 70,
    right = 22,
    top = 22,
    bottom = 66;
  const plotWidth = width - left - right,
    plotHeight = height - top - bottom;
  // Normalize before subtracting to keep even very large finite values in range.
  const xScale = Math.max(...all.map((point) => Math.abs(point.x))) || 1;
  const yScale = Math.max(...all.map((point) => Math.abs(point.y))) || 1;
  const uniqueX = [...new Set(all.map((point) => point.x))].sort(
    (a, b) => a - b,
  );
  let xMin = uniqueX[0] / xScale,
    xMax = uniqueX[uniqueX.length - 1] / xScale;
  let yMin = Math.min(0, ...all.map((point) => point.y / yScale)),
    yMax = Math.max(0, ...all.map((point) => point.y / yScale));
  const normalizedGaps = uniqueX
    .slice(1)
    .map((value, index) => (value - uniqueX[index]) / xScale)
    .filter((gap) => gap > 0);
  const minimumGap = normalizedGaps.length ? Math.min(...normalizedGaps) : 1;
  // Bars keep numeric spacing. Half a minimum interval at each end contains
  // the grouped bars without turning uneven numeric positions into categories.
  if (block.kind === "bar") {
    xMin -= minimumGap / 2;
    xMax += minimumGap / 2;
  } else if (xMin === xMax) {
    xMin -= 0.5;
    xMax += 0.5;
  }
  if (yMin === yMax) {
    yMin = -1;
    yMax = 1;
  }
  const groupWidth = (plotWidth * minimumGap) / (xMax - xMin);
  const x = (value: number) =>
    left + ((value / xScale - xMin) / (xMax - xMin)) * plotWidth;
  const y = (value: number) =>
    top + (1 - (value / yScale - yMin) / (yMax - yMin)) * plotHeight;
  const baseline = y(0);
  const ticks = Array.from(
    { length: 5 },
    (_, index) => yMin + ((yMax - yMin) * index) / 4,
  );
  const xTicks = uniqueX.filter(
    (_, index) =>
      index % Math.max(1, Math.ceil(uniqueX.length / 6)) === 0 ||
      index === uniqueX.length - 1,
  );
  const barWidth = Math.min(
    40,
    (groupWidth * 0.76) / Math.max(1, series.length),
  );
  const title = block.title || "Meeting chart";
  return (
    <figure className="latex-chart">
      <figcaption>{inline(title)}</figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-description`}
      >
        <title id={`${id}-title`}>{title}</title>
        <desc id={`${id}-description`}>
          {block.kind === "bar" ? "Grouped bar chart" : "Line chart"}.{" "}
          {block.xLabel || "X"} versus {block.yLabel || "Y"}.{" "}
          {series
            .map((entry, index) => entry.label || `Series ${index + 1}`)
            .join(", ")}
          . Full values are in the chart data table below.
        </desc>
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              x1={left}
              x2={width - right}
              y1={top + (1 - index / 4) * plotHeight}
              y2={top + (1 - index / 4) * plotHeight}
              className="latex-chart-grid"
            />
            <text
              x={left - 9}
              y={top + (1 - index / 4) * plotHeight + 4}
              textAnchor="end"
            >
              {numberLabel(tick * yScale)}
            </text>
          </g>
        ))}
        <line
          x1={left}
          x2={width - right}
          y1={baseline}
          y2={baseline}
          className="latex-chart-axis"
        />
        <line
          x1={left}
          x2={left}
          y1={top}
          y2={height - bottom}
          className="latex-chart-axis"
        />
        {xTicks.map((value) => (
          <text
            key={value}
            x={x(value)}
            y={height - bottom + 20}
            textAnchor="middle"
          >
            {numberLabel(value)}
          </text>
        ))}
        <text
          x={left + plotWidth / 2}
          y={height - 12}
          textAnchor="middle"
          className="latex-axis-label"
        >
          {block.xLabel || "X"}
        </text>
        <text
          transform={`translate(15 ${top + plotHeight / 2}) rotate(-90)`}
          textAnchor="middle"
          className="latex-axis-label"
        >
          {block.yLabel || "Y"}
        </text>
        {series.map((entry, seriesIndex) => (
          <g
            key={seriesIndex}
            data-series={entry.label || `Series ${seriesIndex + 1}`}
          >
            {block.kind === "line" && (
              <polyline
                fill="none"
                stroke={chartColors[seriesIndex]}
                strokeWidth="2"
                strokeDasharray={
                  seriesIndex % 3 === 1
                    ? "7 4"
                    : seriesIndex % 3 === 2
                      ? "2 4"
                      : undefined
                }
                points={[...entry.points]
                  .sort((a, b) => a.x - b.x)
                  .map((point) => `${x(point.x)},${y(point.y)}`)
                  .join(" ")}
              />
            )}
            {entry.points.map((point, index) =>
              block.kind === "bar" ? (
                <rect
                  key={index}
                  x={
                    x(point.x) -
                    (series.length * barWidth) / 2 +
                    seriesIndex * barWidth
                  }
                  y={Math.min(y(point.y), baseline)}
                  width={barWidth - Math.min(1, barWidth * 0.08)}
                  height={Math.abs(y(point.y) - baseline)}
                  fill={chartColors[seriesIndex]}
                >
                  <title>
                    {entry.label || `Series ${seriesIndex + 1}`}: {point.x},{" "}
                    {point.y}
                  </title>
                </rect>
              ) : (
                <circle
                  key={index}
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r={3}
                  fill={chartColors[seriesIndex]}
                >
                  <title>
                    {entry.label || `Series ${seriesIndex + 1}`}: {point.x},{" "}
                    {point.y}
                  </title>
                </circle>
              ),
            )}
          </g>
        ))}
      </svg>
      <ul className="latex-chart-legend">
        {series.map((entry, index) => (
          <li key={index}>
            <span style={{ background: chartColors[index] }} />
            {inline(entry.label || `Series ${index + 1}`)}
          </li>
        ))}
      </ul>
      <details className="latex-chart-data">
        <summary>View chart data</summary>
        <div className="latex-table-scroll">
          <table>
            <caption>{title} — data</caption>
            <thead>
              <tr>
                <th scope="col">Series</th>
                <th scope="col">{inline(block.xLabel || "X")}</th>
                <th scope="col">{inline(block.yLabel || "Y")}</th>
              </tr>
            </thead>
            <tbody>
              {series.flatMap((entry, seriesIndex) =>
                entry.points.map((point, index) => (
                  <tr key={`${seriesIndex}-${index}`}>
                    <th scope="row">
                      {inline(entry.label || `Series ${seriesIndex + 1}`)}
                    </th>
                    <td>{point.x}</td>
                    <td>{point.y}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function LatexSummary({ source }: { source: string }) {
  const blocks = useMemo(
    () => parseLatexSummary(source.slice(0, MAX_SOURCE)),
    [source],
  );
  return (
    <div className="latex-summary">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const Tag = `h${block.level + 2}` as "h3" | "h4" | "h5";
            return <Tag key={index}>{inline(block.text)}</Tag>;
          }
          case "paragraph":
            return <p key={index}>{inline(block.text)}</p>;
          case "math":
            return (
              <div className="latex-display-container" key={index}>
                <MathText source={block.text} display />
              </div>
            );
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return (
              <Tag key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          case "table":
            return (
              <div className="latex-table-scroll" key={index}>
                <table>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, columnIndex) => (
                          <td key={columnIndex}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "chart":
            return <SummaryChart block={block} key={index} />;
          case "unsupported":
            return (
              <pre
                className="latex-fallback"
                key={index}
                aria-label="Unrendered LaTeX"
              >
                {block.text}
              </pre>
            );
        }
      })}
      {source.length > MAX_SOURCE && (
        <p className="latex-render-notice">
          This preview is limited to 20,000 characters. The complete saved
          source remains available in the export.
        </p>
      )}
    </div>
  );
}
