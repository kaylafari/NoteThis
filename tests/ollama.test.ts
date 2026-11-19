import { describe, expect, it } from "vitest";
import { sameOllamaModel, missingOllamaModelMessage } from "../shared/ollama";

describe("Ollama recording readiness", () => {
  it("recognizes an implicit latest tag without confusing other versions", () => {
    expect(sameOllamaModel("qwen3", "qwen3:latest")).toBe(true);
    expect(sameOllamaModel("qwen3", "qwen3:0.6b")).toBe(false);
    expect(sameOllamaModel("qwen3:0.6b", "qwen3:0.6b")).toBe(true);
    expect(
      sameOllamaModel(
        "localhost:5000/models/qwen",
        "localhost:5000/models/qwen:latest",
      ),
    ).toBe(true);
  });
  it("offers built-in preparation only for the bundled default on the local server", () => {
    expect(
      missingOllamaModelMessage("qwen3:0.6b", "http://127.0.0.1:11434"),
    ).toContain("Verify & repair local AI");
    expect(
      missingOllamaModelMessage("qwen3:0.6b", "http://localhost:11434/"),
    ).toContain("Prepare local AI");
    expect(
      missingOllamaModelMessage("custom:8b", "http://localhost:11434"),
    ).not.toContain("Prepare local AI");
    expect(
      missingOllamaModelMessage("qwen3:0.6b", "http://localhost:12345"),
    ).not.toContain("Prepare local AI");
    expect(
      missingOllamaModelMessage("qwen3:0.6b", "https://remote.example"),
    ).toContain("configured Ollama server");
  });
});
