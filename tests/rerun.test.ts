import { describe, expect, it, vi } from "vitest";
import {
  decodeRerunDestination,
  encodeRerunDestination,
  resolveRerunThread,
  sendWithGeneralFallback,
} from "../src/rerun";

describe("rerun destination routing", () => {
  it("round-trips source, General, and topic destinations", () => {
    expect(decodeRerunDestination(encodeRerunDestination({ kind: "source" })))
      .toEqual({ kind: "source" });
    expect(decodeRerunDestination(encodeRerunDestination({ kind: "general" })))
      .toEqual({ kind: "general" });
    expect(decodeRerunDestination(encodeRerunDestination({ kind: "topic", threadId: 13803 })))
      .toEqual({ kind: "topic", threadId: 13803 });
  });

  it("uses the source thread only when no destination was selected", () => {
    expect(resolveRerunThread({ kind: "source" }, 13803)).toBe(13803);
    expect(resolveRerunThread({ kind: "general" }, 13803)).toBeNull();
    expect(resolveRerunThread({ kind: "topic", threadId: 14000 }, 13803)).toBe(14000);
  });

  it("falls back to General when the preferred topic rejects the post", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(500);

    await expect(sendWithGeneralFallback(send, 13803)).resolves.toEqual({
      messageId: 500,
      threadId: null,
    });
    expect(send).toHaveBeenNthCalledWith(1, 13803);
    expect(send).toHaveBeenNthCalledWith(2, null);
  });

  it("does not retry General when General was already selected", async () => {
    const send = vi.fn().mockResolvedValue(null);
    await expect(sendWithGeneralFallback(send, null)).resolves.toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });
});
