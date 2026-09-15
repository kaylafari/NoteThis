import { beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../server/providers", () => ({ generateText: vi.fn() }));
vi.mock("../server/model-discovery", () => ({
  discoverProviderModels: vi.fn(),
}));
vi.mock("../server/rich-generation", () => ({
  generateWebAnswer: vi.fn(),
  generateSummaryImage: vi.fn(),
  supportsWebSearch: vi.fn(),
  supportsImageOutput: vi.fn(),
}));
import {
  MAX_MODEL_INPUT_BYTES,
  insightSchema,
  summarize,
  answerQuestion,
  transcriptText,
  parseInsight,
  relevantSegments,
  splitTranscript,
} from "../server/intelligence";
import { generateText } from "../server/providers";
import { discoverProviderModels } from "../server/model-discovery";
import {
  generateWebAnswer,
  generateSummaryImage,
  supportsWebSearch,
  supportsImageOutput,
} from "../server/rich-generation";
import type { Segment, Settings } from "../shared/types";
const segments: Segment[] = [
  {
    id: "s1",
    start: 0,
    end: 4,
    text: "Maya will send the proposal on Friday.",
    words: [],
  },
  { id: "s2", start: 4, end: 8, text: "We approved the launch.", words: [] },
];
describe("transcript grounded notes", () => {
  it("keeps valid evidence and strips invented segment references", () => {
    const notes = parseInsight(
      '```json\n{"summary":"Launch planning","decisions":["Approved"],"actions":[{"text":"Send proposal","owner":"Maya","segmentId":"s1"},{"text":"Other","segmentId":"madeup"}]}\n```',
      segments,
    );
    expect(notes.actions[0].segmentId).toBe("s1");
    expect(notes.actions[1].segmentId).toBeUndefined();
    expect(notes.actions[0].done).toBe(false);
  });
  it("does not retain owner or deadline metadata absent from its cited source", () => {
    const notes = parseInsight(
      JSON.stringify({
        summary: "A meeting",
        decisions: [],
        actions: [
          {
            text: "Send proposal",
            owner: "Team",
            due: "next month",
            segmentId: "s1",
          },
          {
            text: "Send proposal",
            owner: "Maya",
            due: "Friday",
            segmentId: "s1",
          },
        ],
      }),
      segments,
    );
    const substring = parseInsight(
      JSON.stringify({
        summary: "Meeting",
        decisions: [],
        actions: [
          { text: "Send proposal", owner: "May", due: "day", segmentId: "s1" },
        ],
      }),
      segments,
    );
    expect(substring.actions[0].owner).toBeUndefined();
    expect(substring.actions[0].due).toBeUndefined();
    expect(notes.actions[0].owner).toBeUndefined();
    expect(notes.actions[0].due).toBeUndefined();
    expect(notes.actions[1].owner).toBe("Maya");
    expect(notes.actions[1].due).toBe("Friday");
  });
  it("rejects prose-only and malformed note responses", () => {
    expect(() => parseInsight("Here are notes", segments)).toThrow(
      "structured",
    );
    expect(() => parseInsight('{"summary":"Hello"}', segments)).toThrow(
      "incomplete",
    );
  });
  it("preserves chronological evidence across chunk boundaries", () => {
    const chunks = splitTranscript(segments, 65);
    expect(chunks).toHaveLength(2);
    expect(chunks.flat()).toEqual(segments);
  });
  it("retrieves matching material from the end of long meetings", () => {
    const long = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      start: i * 4,
      end: i * 4 + 4,
      text:
        i === 499
          ? "The zephyr budget is approved."
          : "Routine conversation and many unrelated details.".repeat(4),
      words: [],
    }));
    expect(
      relevantSegments(long, "What about zephyr?", 1000).some(
        (s) => s.id === "s499",
      ),
    ).toBe(true);
  });
});

const settings: Settings = {
  stt: { provider: "local", model: "base", language: "" },
  llm: { provider: "ollama", model: "qwen3:0.6b", baseUrl: "" },
  local: {
    whisperModel: "base",
    pythonPath: "python3",
    ollamaUrl: "http://127.0.0.1:11434",
  },
  configuredKeys: [],
  oauthConnections: [],
};
const model = vi.mocked(generateText);
const getKey = async () => undefined;
beforeEach(() => {
  model.mockReset();
  vi.mocked(discoverProviderModels).mockReset();
  vi.mocked(generateWebAnswer).mockReset();
  vi.mocked(generateSummaryImage).mockReset();
  vi.mocked(supportsWebSearch).mockReset().mockReturnValue(false);
  vi.mocked(supportsImageOutput).mockReset().mockReturnValue(false);
});
function assertBudgets() {
  for (const [system, prompt] of model.mock.calls)
    expect(Buffer.byteLength(system + prompt, "utf8")).toBeLessThanOrEqual(
      MAX_MODEL_INPUT_BYTES,
    );
}
describe("bounded long-meeting intelligence", () => {
  it("splits a single oversized multilingual segment without losing text or source IDs", () => {
    const original = {
      id: "unicode",
      start: 0,
      end: 100,
      text: "漢字🙂".repeat(8_000),
      words: [],
    };
    const chunks = splitTranscript([original], 1_000);
    expect(
      chunks
        .flat()
        .map((s) => s.text)
        .join(""),
    ).toBe(original.text);
    expect(chunks.flat().every((s) => s.id === "unicode")).toBe(true);
    expect(
      chunks.every(
        (chunk) => Buffer.byteLength(transcriptText(chunk), "utf8") <= 1_000,
      ),
    ).toBe(true);
  });
  it("reduces every section into bounded final evidence and preserves late action references", async () => {
    const long = Array.from({ length: 120 }, (_, i) => ({
      id: `s${i}`,
      start: i * 10,
      end: i * 10 + 10,
      text: `Section ${i}: ` + "Meeting evidence and context. ".repeat(40),
      words: [],
    }));
    const seen = new Set<string>();
    let reductions = 0;
    let finalEvidence = "";
    model.mockImplementation(async (_system, prompt) => {
      const ids = [...new Set(prompt.match(/\[s\d+\]/g) || [])];
      if (prompt.includes("TRANSCRIPT SECTION:")) {
        ids.forEach((id) => seen.add(id));
        return ids.join(" ") + " detail".repeat(500);
      }
      if (prompt.includes("ALL NOTES IN THIS GROUP:")) {
        reductions++;
        return ids.join(" ") + " condensed".repeat(60);
      }
      finalEvidence = prompt;
      return JSON.stringify({
        summary: "All sections reviewed",
        decisions: [],
        actions: [{ text: "Final section action", segmentId: "s119" }],
      });
    });
    const notes = await summarize(long, settings, getKey, () => {});
    expect(seen.size).toBe(120);
    expect(reductions).toBeGreaterThan(1);
    for (let i = 0; i < 120; i++) expect(finalEvidence).toContain(`[s${i}]`);
    expect(notes.actions[0].segmentId).toBe("s119");
    expect(model.mock.calls.at(-1)?.[4]?.jsonSchema).toEqual(insightSchema);
    expect(
      model.mock.calls.slice(0, -1).every((call) => !call[4]?.jsonSchema),
    ).toBe(true);
    assertBudgets();
    expect(model.mock.calls.length).toBeLessThan(100);
  });
  it("fails explicitly if a model refuses to shorten partial notes instead of truncating sections", async () => {
    const long = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`,
      start: i,
      end: i + 1,
      text: "Evidence. ".repeat(150),
      words: [],
    }));
    model.mockImplementation(async (_system, prompt) =>
      prompt.includes("TRANSCRIPT SECTION:")
        ? "Repeated notes. ".repeat(1_000)
        : prompt.split("ALL NOTES IN THIS GROUP:\n")[1],
    );
    await expect(summarize(long, settings, getKey, () => {})).rejects.toThrow(
      "no transcript sections were discarded",
    );
    assertBudgets();
  });
  it("does not silently omit a section whose extraction returns no content", async () => {
    model.mockResolvedValue("");
    const long = [{ ...segments[0], text: "Evidence. ".repeat(2_000) }];
    await expect(summarize(long, settings, getKey, () => {})).rejects.toThrow(
      "empty section notes",
    );
  });
  it("bounds long chat history and retrieves the previous topic for a follow-up question", async () => {
    const long = Array.from({ length: 500 }, (_, i) => ({
      id: `s${i}`,
      start: i,
      end: i + 1,
      text:
        i === 499
          ? "Maya will deliver the zephyr proposal on Friday."
          : "Routine unrelated meeting discussion. ".repeat(10),
      words: [],
    }));
    const history = [
      { role: "assistant", text: "Older answer. ".repeat(10_000) },
      { role: "user", text: "Who owns the zephyr proposal?" },
      {
        role: "assistant",
        text: "Maya owns it. [s499] " + "Other context. ".repeat(10_000),
      },
    ];
    model.mockResolvedValue("The zephyr proposal is due Friday. [s499]");
    const answer = await answerQuestion(
      long,
      "When is it due?",
      history,
      settings,
      getKey,
    );
    const prompt = model.mock.calls[0][1];
    expect(prompt).toContain(
      "Maya will deliver the zephyr proposal on Friday.",
    );
    expect(prompt).toContain("QUESTION: When is it due?");
    expect(prompt).toContain("[truncated]");
    expect(answer.citations).toEqual(["s499"]);
    assertBudgets();
  });
  it("rejects questions that leave no evidence budget instead of truncating the user's question", async () => {
    await expect(
      answerQuestion(segments, "漢".repeat(4_000), [], settings, getKey),
    ).rejects.toThrow("too long");
    expect(model).not.toHaveBeenCalled();
  });
});

const richSettings = (): Settings => ({
  ...settings,
  llm: {
    ...settings.llm,
    provider: "openrouter",
    model: "synthetic-image-model",
    webSearch: true,
    summaryDiagrams: true,
    webSearchConsentProvider: "openrouter",
    summaryDiagramsConsentProvider: "openrouter",
  },
});
function liveCapabilities(overrides: Record<string, unknown> = {}) {
  vi.mocked(supportsWebSearch).mockReturnValue(true);
  vi.mocked(supportsImageOutput).mockReturnValue(true);
  vi.mocked(discoverProviderModels).mockResolvedValue({
    provider: "openrouter",
    kind: "llm",
    source: "account",
    models: ["synthetic-image-model"],
    message: "Synthetic account metadata",
    capabilities: {
      "synthetic-image-model": {
        outputModalities: ["text", "image"],
        webSearch: "supported",
      },
    },
    ...overrides,
  });
}
const diagramSegments: Segment[] = [
  {
    id: "flow",
    start: 0,
    end: 10,
    text: "The request flows from the client to the queue and then to the worker.",
    words: [],
  },
];
const plan = () => ({
  title: "Request flow",
  description: "Client → queue → worker",
  evidence: [{ segmentId: "flow", quote: diagramSegments[0].text }],
});
const notesResponse = (visualPlans: unknown[] = []) =>
  JSON.stringify({
    summary: "The team described the request flow.",
    decisions: [],
    actions: [],
    visualPlans,
  });

describe("consented capability-gated rich intelligence", () => {
  it("never discovers or calls web/image adapters when both opt-ins are off", async () => {
    liveCapabilities();
    const config = richSettings();
    config.llm.webSearch = false;
    config.llm.summaryDiagrams = false;
    model.mockResolvedValue(notesResponse([plan()]));
    await summarize(diagramSegments, config, getKey, () => {});
    await answerQuestion(
      diagramSegments,
      "What is the flow?",
      [],
      config,
      getKey,
    );
    expect(discoverProviderModels).not.toHaveBeenCalled();
    expect(generateSummaryImage).not.toHaveBeenCalled();
    expect(generateWebAnswer).not.toHaveBeenCalled();
  });
  it("requires consent bound to the selected provider even when flags and capabilities permit rich output", async () => {
    liveCapabilities();
    const config = richSettings();
    config.llm.webSearchConsentProvider = "different-provider";
    config.llm.summaryDiagramsConsentProvider = undefined;
    await expect(
      answerQuestion(segments, "Question", [], config, getKey),
    ).rejects.toThrow("Confirm web search");
    model.mockResolvedValue(notesResponse([plan()]));
    const notes = await summarize(diagramSegments, config, getKey, () => {});
    expect(notes.visuals).toBeUndefined();
    expect(discoverProviderModels).not.toHaveBeenCalled();
    expect(generateSummaryImage).not.toHaveBeenCalled();
    expect(generateWebAnswer).not.toHaveBeenCalled();
  });
  it("rejects enabled web search when no adapter or verified model capability is available", async () => {
    await expect(
      answerQuestion(segments, "Question", [], richSettings(), getKey),
    ).rejects.toThrow("no supported web-search adapter");
    liveCapabilities({ source: "bundled" });
    await expect(
      answerQuestion(segments, "Question", [], richSettings(), getKey),
    ).rejects.toThrow("could not be verified");
    liveCapabilities({ models: ["different-model"] });
    await expect(
      answerQuestion(segments, "Question", [], richSettings(), getKey),
    ).rejects.toThrow("could not be verified");
    liveCapabilities({
      capabilities: {
        "synthetic-image-model": {
          outputModalities: ["text"],
          webSearch: "unknown",
        },
      },
    });
    await expect(
      answerQuestion(segments, "Question", [], richSettings(), getKey),
    ).rejects.toThrow("could not be verified");
    expect(generateWebAnswer).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  });
  it("keeps web findings separate, preserves actual usage and citations, and bounds multilingual prompts", async () => {
    liveCapabilities();
    const sources = [
      { title: "Public documentation", url: "https://example.com/docs" },
    ];
    vi.mocked(generateWebAnswer).mockResolvedValue({
      text: "Meeting evidence: Maya owns the proposal. [s1]\nExternal web findings: documentation.",
      webSources: sources,
      webSearchUsed: true,
    });
    const long = [
      ...segments,
      {
        id: "long",
        start: 20,
        end: 30,
        text: "漢字🙂".repeat(10_000),
        words: [],
      },
    ];
    const answer = await answerQuestion(
      long,
      "Who owns the proposal and what does public documentation say?",
      [{ role: "assistant", text: "History ".repeat(10_000) }],
      richSettings(),
      getKey,
    );
    expect(answer.citations).toEqual(["s1"]);
    expect(answer.webSources).toEqual(sources);
    expect(answer.webSearchUsed).toBe(true);
    const [system, prompt] = vi.mocked(generateWebAnswer).mock.calls[0];
    expect(system).toContain(
      "separate Meeting evidence from External web findings",
    );
    expect(system).not.toContain("Use only what the transcript supports");
    expect(Buffer.byteLength(system + prompt)).toBeLessThanOrEqual(
      MAX_MODEL_INPUT_BYTES,
    );
    expect(model).not.toHaveBeenCalled();
    vi.mocked(generateWebAnswer).mockResolvedValue({
      text: "Meeting answer [s1]",
      webSources: [],
      webSearchUsed: false,
    });
    expect(
      (
        await answerQuestion(
          segments,
          "Who owns it?",
          [],
          richSettings(),
          getKey,
        )
      ).webSearchUsed,
    ).toBe(false);
  });
  it("generates at most one grounded diagram and never uses web search for summaries", async () => {
    liveCapabilities();
    model.mockResolvedValue(notesResponse([plan(), plan()]));
    vi.mocked(generateSummaryImage).mockResolvedValue({
      dataUrl: "data:image/png;base64,c3ludGhldGlj",
      mimeType: "image/png",
    });
    const result = await summarize(
      diagramSegments,
      richSettings(),
      getKey,
      () => {},
    );
    expect(result.visuals).toHaveLength(1);
    expect(result.visuals?.[0]).toMatchObject({
      title: "Request flow",
      mimeType: "image/png",
    });
    expect(generateSummaryImage).toHaveBeenCalledOnce();
    expect(vi.mocked(generateSummaryImage).mock.calls[0][0]).toContain(
      diagramSegments[0].text,
    );
    expect(model.mock.calls[0][1]).toContain("Do not force a visual");
    expect(generateWebAnswer).not.toHaveBeenCalled();
    assertBudgets();
  });
  it("skips unnecessary visuals and unverified image capabilities without interrupting notes", async () => {
    liveCapabilities();
    model.mockResolvedValue(notesResponse());
    expect(
      (await summarize(segments, richSettings(), getKey, () => {})).visuals,
    ).toBeUndefined();
    liveCapabilities({ source: "bundled" });
    model.mockResolvedValue(notesResponse([plan()]));
    await summarize(diagramSegments, richSettings(), getKey, () => {});
    vi.mocked(discoverProviderModels).mockRejectedValue(new Error("offline"));
    expect(
      (await summarize(diagramSegments, richSettings(), getKey, () => {}))
        .summary,
    ).toContain("request flow");
    expect(generateSummaryImage).not.toHaveBeenCalled();
  });
  it("rejects invented diagram source IDs and quotes while retaining notes", async () => {
    liveCapabilities();
    for (const evidence of [
      [{ segmentId: "invented", quote: diagramSegments[0].text }],
      [
        {
          segmentId: "flow",
          quote: "The worker guarantees a million requests per second.",
        },
      ],
    ]) {
      model.mockResolvedValue(notesResponse([{ ...plan(), evidence }]));
      const result = await summarize(
        diagramSegments,
        richSettings(),
        getKey,
        () => {},
      );
      expect(result.summary).toContain("request flow");
      expect(result.visualError).toContain("evidence absent");
    }
    expect(generateSummaryImage).not.toHaveBeenCalled();
  });
  it("retains summary and action items when the image provider fails", async () => {
    liveCapabilities();
    model.mockResolvedValue(notesResponse([plan()]));
    vi.mocked(generateSummaryImage).mockRejectedValue(
      new Error("Image service unavailable"),
    );
    const result = await summarize(
      diagramSegments,
      richSettings(),
      getKey,
      () => {},
    );
    expect(result.summary).toContain("request flow");
    expect(result.actions).toEqual([]);
    expect(result.visualError).toContain("Image service unavailable");
  });
  it("budgets visual schema overhead while preserving every long-meeting section", async () => {
    liveCapabilities();
    const long = Array.from({ length: 80 }, (_, i) => ({
      id: `s${i}`,
      start: i,
      end: i + 1,
      text: "漢字🙂 Meeting evidence. ".repeat(100),
      words: [],
    }));
    const seen = new Set<string>();
    model.mockImplementation(async (_system, prompt) => {
      const ids = [...new Set(prompt.match(/\[s\d+\]/g) || [])];
      if (prompt.includes("TRANSCRIPT SECTION:")) {
        ids.forEach((id) => seen.add(id));
        return ids.join(" ") + " detail".repeat(200);
      }
      if (prompt.includes("ALL NOTES IN THIS GROUP:"))
        return ids.join(" ") + " reduced".repeat(20);
      for (let i = 0; i < 80; i++) expect(prompt).toContain(`[s${i}]`);
      return notesResponse();
    });
    await summarize(long, richSettings(), getKey, () => {});
    expect(seen.size).toBe(80);
    assertBudgets();
  });
});

describe("LaTeX summary generation", () => {
  it("requests a constrained LaTeX body with correctly escaped JSON, while keeping actions plain", async () => {
    const summary = String.raw`\section{Measurements}
\textbf{Force} is \(F = 12\,N\).
\[F = ma\]
\begin{tikzpicture}\begin{axis}[title={Measurements},xlabel={Time},ylabel={Force},ybar]\addplot coordinates {(1,12) (2,24)};\end{axis}\end{tikzpicture}`;
    model.mockResolvedValue(
      JSON.stringify({
        summary,
        decisions: ["Keep the measurements"],
        actions: [
          {
            text: "Send proposal",
            owner: "Maya",
            due: "Friday",
            segmentId: "s1",
          },
        ],
      }),
    );
    const result = await summarize(
      [
        ...segments,
        {
          id: "measurements",
          start: 10,
          end: 20,
          text: "Force F = ma. Force is 12 N at time 1 and 24 N at time 2.",
          words: [],
        },
      ],
      settings,
      getKey,
      () => {},
    );
    const prompt = model.mock.calls.at(-1)![1];
    for (const directive of [
      "LaTeX document BODY only",
      "no preamble",
      String.raw`\section{...}`,
      String.raw`\subsection{...}`,
      String.raw`\textbf{...}`,
      String.raw`\emph{...}`,
      "itemize/enumerate",
      "tabular",
      String.raw`\(...\)`,
      String.raw`\[...\]`,
      String.raw`\begin{tikzpicture}\begin{axis}`,
      String.raw`\addplot coordinates {(x,y) ...};`,
      "optional ybar",
      "require explicit numerical data in the transcript",
      "never invent values",
      "only when supported by the meeting evidence",
      "Keep decisions and all action fields as plain text",
    ])
      expect(prompt).toContain(directive);
    expect(prompt).toContain(
      "One LaTeX token encoded as a JSON string: " +
        JSON.stringify(String.raw`\textbf{...}`),
    );
    expect(prompt).not.toContain(
      "JSON escaping example (format only, not meeting evidence)",
    );
    expect(prompt).toContain(
      "actual meeting facts, numerical values, and tasks",
    );
    expect(prompt).toContain(
      "Extract every explicit task commitment into actions",
    );
    expect(result.summary).toBe(summary);
    expect(result.summaryFormat).toBe("latex");
    expect(result.decisions).toEqual(["Keep the measurements"]);
    expect(result.actions[0]).toMatchObject({
      text: "Send proposal",
      owner: "Maya",
      due: "Friday",
    });
    assertBudgets();
  });

  it("does not relabel imported or legacy summaries as LaTeX", () => {
    for (const summary of [
      "Plain meeting notes",
      String.raw`\section{Looks like LaTeX}`,
    ]) {
      const result = parseInsight(
        JSON.stringify({
          summary,
          decisions: [],
          actions: [],
          summaryFormat: "latex",
        }),
        segments,
      );
      expect(result.summary).toBe(summary);
      expect(result.summaryFormat).toBeUndefined();
    }
  });

  it("preserves quantitative evidence and every source through bounded long-meeting reductions", async () => {
    const count = 40;
    const quantitative = (i: number) =>
      `[s${i}] F${i} = ${i} N; (${i},${i * 2})`;
    const long = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      start: i,
      end: i + 1,
      text:
        `F${i} = ${i} N; (${i},${i * 2}). ` +
        "Recorded technical context. ".repeat(100),
      words: [],
    }));
    const seen = new Set<number>();
    let reductions = 0;
    model.mockImplementation(async (_system, prompt) => {
      const ids = [
        ...new Set(
          [...prompt.matchAll(/\[s(\d+)\]/g)].map((match) => Number(match[1])),
        ),
      ];
      if (prompt.includes("TRANSCRIPT SECTION:")) {
        expect(prompt).toContain(
          "Preserve exact formulas, symbols, units, numerical data, coordinate pairs",
        );
        ids.forEach((id) => seen.add(id));
        return ids.map(quantitative).join("\n") + " detail".repeat(250);
      }
      if (prompt.includes("ALL NOTES IN THIS GROUP:")) {
        reductions++;
        expect(prompt).toContain(
          "Do not alter values, infer missing measurements, or invent formulas",
        );
        return ids.map(quantitative).join("\n");
      }
      for (let i = 0; i < count; i++) expect(prompt).toContain(quantitative(i));
      return JSON.stringify({
        summary: String.raw`\section{Measurements}Evidence retained.`,
        decisions: [],
        actions: [],
      });
    });
    const result = await summarize(long, settings, getKey, () => {});
    expect(seen.size).toBe(count);
    expect(reductions).toBeGreaterThan(0);
    expect(result.summaryFormat).toBe("latex");
    assertBudgets();
  });
});
