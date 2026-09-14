import { beforeEach, describe, it, expect, vi } from "vitest";
vi.mock("../server/providers", () => ({ generateText: vi.fn() }));
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
