import { describe, it, expect } from "vitest";
import { chunkMessage } from "../src/commands";

describe("chunkMessage", () => {
  it("returns single chunk when under limit", () => {
    const result = chunkMessage("short message", 1000);
    expect(result).toEqual(["short message"]);
  });

  it("splits long messages", () => {
    const longText = "a".repeat(5000);
    const result = chunkMessage(longText, 1000);
    expect(result.length).toBeGreaterThan(1);
    // Total content should be preserved
    expect(result.join("").length).toBe(5000);
  });

  it("prefers splitting at blank lines", () => {
    const text =
      "section 1 line 1\nsection 1 line 2\n\nsection 2 line 1\nsection 2 line 2\n\nsection 3";
    const result = chunkMessage(text, 50);
    // Each chunk should be a coherent section
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("falls back to newline split when no blank lines", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const result = chunkMessage(text, 100);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("handles edge case at exactly the limit", () => {
    const text = "x".repeat(1000);
    const result = chunkMessage(text, 1000);
    expect(result).toEqual([text]);
  });

  it("hard-splits as last resort", () => {
    // A single line longer than maxLen with no newline
    const text = "x".repeat(2000);
    const result = chunkMessage(text, 500);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(500);
    }
  });

  it("preserves no content for empty input", () => {
    expect(chunkMessage("")).toEqual([""]);
  });
});
