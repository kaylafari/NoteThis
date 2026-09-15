# Formatted meeting notes

New summaries are returned by the selected language model as a LaTeX document body inside the existing structured notes response. NoteThis renders the supported parts locally: section headings, paragraphs, emphasis, lists, tables, inline/display equations, and simple numeric line/bar charts. Decisions and action items retain their existing plain-text format.

Open **Summary** to read the formatted notes. **View LaTeX source** reveals the model's original summary, and **Export LaTeX (.tex)** downloads an editable, self-contained document containing the supported summary content, decisions, and actions. An existing plain-text summary remains unchanged until **Regenerate** is used. Regeneration uses the selected language provider just like an ordinary summary request.

## Supported formatting

- Headings: `\section`, `\subsection`, `\subsubsection`.
- Inline emphasis: `\textbf`, `\emph`, `\textit`.
- Lists: `itemize` and `enumerate` environments.
- Tables: simple `tabular` rows and columns.
- Mathematics: `\(...\)` inline and `\[...\]` display math; the renderer also handles dollar delimiters. Math rendering uses KaTeX with bundled local fonts.
- Charts: a bounded subset of PGFPlots `tikzpicture`/`axis` with `\addplot coordinates`, numeric x/y values, titles/axis labels, and optional `ybar`. Other TikZ drawing programs are not executed.

The model is instructed to include formulas and chart values only when supported by the transcript, and preserve symbols, units, and numerical evidence when condensing a long meeting. The small default model can choose plain paragraphs instead of equations or charts; richer formatting depends on the selected model following the prompt. These instructions do not guarantee factual accuracy: verify formulas and labels against the recording. Rich text charts are separate from optional AI-generated raster diagrams and do not need image-output support or web search.

## Export and rendering boundaries

The app does not execute a TeX compiler or download external resources to display notes. KaTeX is configured with untrusted-input restrictions and finite size/expansion limits. Unrecognized or malformed content remains visible as a fallback instead of disappearing. The `.tex` export reconstructs supported structures and escapes unsupported material; it does not pass arbitrary model-written commands to a TeX compiler. It includes the required mathematics and chart packages for compilation in a separate LaTeX editor. Optional AI-generated raster images remain separate downloads.

The original summary source and the exported document can differ because the export adds a document wrapper and safely reconstructs supported formatting. Plain-text metadata, decisions, and actions are escaped so their punctuation cannot become LaTeX commands.

Reference: [KaTeX rendering options](https://katex.org/docs/options), [KaTeX security guidance](https://katex.org/docs/security).
