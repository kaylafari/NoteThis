import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { startServer } from "../dist-server/index.mjs";
const dir = await mkdtemp(path.join(os.tmpdir(), "cadence-local-smoke-"));
const server = await startServer({ port: 0, dataDir: dir });
const base = `http://127.0.0.1:${server.port}/api`;
const headers = { "X-Meeting-App": "1", "Content-Type": "application/json" };
const request = async (route, init) => {
  const response = await fetch(base + route, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
};
try {
  await request("/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      local: {
        whisperModel: "base",
        pythonPath: path.resolve(".venv/bin/python"),
        ollamaUrl: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
      },
    }),
  });
  const form = new FormData();
  form.set(
    "audio",
    new Blob([await readFile("assets/sample-meeting.wav")], {
      type: "audio/wav",
    }),
    "sample.wav",
  );
  form.set("title", "Synthetic integration test");
  const created = await request("/meetings", {
    method: "POST",
    headers: { "X-Meeting-App": "1" },
    body: form,
  });
  await request(`/meetings/${created.id}/transcribe`, {
    method: "POST",
    headers,
  });
  let meeting;
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastProgress = "";
  do {
    meeting = await request(`/meetings/${created.id}`);
    if (meeting.progress && meeting.progress !== lastProgress) {
      console.log(meeting.progress);
      lastProgress = meeting.progress;
    }
    if (!["transcribing", "summarizing"].includes(meeting.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } while (Date.now() < deadline);
  assert.equal(
    meeting.status,
    "ready",
    meeting.error || "Processing did not finish",
  );
  assert.equal(meeting.timing, "word");
  assert.ok(meeting.segments.some((s) => s.text.includes("Maya")));
  assert.ok(meeting.insight.summary.length > 10);
  assert.ok(
    meeting.insight.actions.some((a) =>
      a.text.toLowerCase().includes("proposal"),
    ),
    "Summary missed explicit proposal action",
  );
  const reply = await request(`/meetings/${created.id}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: "What was the agreed budget? Cite the transcript.",
    }),
  });
  assert.ok(
    reply.text.replace(/[$,]/g, "").includes("5000"),
    "Budget answer is incorrect",
  );
  assert.ok(
    reply.citations.length,
    "Answer did not cite a real transcript segment",
  );
  assert.ok(
    reply.citations.some((id) => {
      const source =
        meeting.segments.find((segment) => segment.id === id)?.text || "";
      return (
        source.toLowerCase().includes("budget") &&
        source.replace(/[$,]/g, "").includes("5000")
      );
    }),
    "Budget answer cited an existing segment that does not support the budget claim",
  );
  for (const action of meeting.insight.actions) {
    if (!action.owner) continue;
    const source =
      meeting.segments.find((segment) => segment.id === action.segmentId)
        ?.text || "";
    assert.ok(
      source.toLowerCase().includes(action.owner.toLowerCase()),
      "Action owner is absent from the cited source",
    );
  }

  const range = await fetch(`${base}/meetings/${created.id}/audio`, {
    headers: { Range: "bytes=0-43" },
  });
  assert.equal(range.status, 206);
  console.log(
    JSON.stringify(
      {
        passed: true,
        duration: meeting.duration,
        segments: meeting.segments.length,
        words: meeting.segments.flatMap((s) => s.words).length,
        summary: meeting.insight.summary,
        actions: meeting.insight.actions,
        answer: reply.text,
        citations: reply.citations,
      },
      null,
      2,
    ),
  );
} finally {
  await server.close();
  await rm(dir, { recursive: true, force: true });
}
