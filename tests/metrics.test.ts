import { describe, it, expect, beforeEach, vi } from "vitest";

describe("metrics", () => {
  let metrics: typeof import("../src/metrics").metrics;
  let computeLatencyStats: typeof import("../src/metrics").computeLatencyStats;

  beforeEach(async () => {
    // Reset module for isolated counter state per test
    vi.resetModules();
    const mod = await import("../src/metrics");
    metrics = mod.metrics;
    computeLatencyStats = mod.computeLatencyStats;
  });

  it("starts with empty counters", () => {
    const snap = metrics.snapshot();
    expect(snap.apiCalls).toEqual({});
    expect(snap.apiErrors).toEqual({});
    expect(snap.commands).toEqual({});
    expect(snap.rateLimitHits).toBe(0);
    expect(snap.ownerAlertsSent).toBe(0);
  });

  it("counts API calls per method", () => {
    metrics.recordApiCall("sendMessage", 50);
    metrics.recordApiCall("sendMessage", 60);
    metrics.recordApiCall("editMessageText", 30);
    const snap = metrics.snapshot();
    expect(snap.apiCalls.sendMessage).toBe(2);
    expect(snap.apiCalls.editMessageText).toBe(1);
  });

  it("counts API errors by method:code", () => {
    metrics.recordApiError("sendMessage", 403);
    metrics.recordApiError("sendMessage", 403);
    metrics.recordApiError("sendMessage", 429);
    const snap = metrics.snapshot();
    expect(snap.apiErrors["sendMessage:403"]).toBe(2);
    expect(snap.apiErrors["sendMessage:429"]).toBe(1);
  });

  it("counts commands", () => {
    metrics.recordCommand("newraffle");
    metrics.recordCommand("newraffle");
    metrics.recordCommand("stats");
    const snap = metrics.snapshot();
    expect(snap.commands.newraffle).toBe(2);
    expect(snap.commands.stats).toBe(1);
  });

  it("tracks rate limit hits", () => {
    metrics.recordRateLimitHit();
    metrics.recordRateLimitHit();
    metrics.recordRateLimitHit();
    expect(metrics.snapshot().rateLimitHits).toBe(3);
  });

  it("caps latency sample buffer to prevent memory growth", () => {
    for (let i = 0; i < 300; i++) {
      metrics.recordApiCall("sendMessage", i);
    }
    const snap = metrics.snapshot();
    expect(snap.apiLatencyMs.length).toBeLessThanOrEqual(200);
    // Should keep the most recent samples
    expect(snap.apiLatencyMs[snap.apiLatencyMs.length - 1].ms).toBe(299);
  });

  it("computeLatencyStats returns p50 and p95 per method", () => {
    const samples = [];
    for (let i = 1; i <= 100; i++) samples.push({ method: "sendMessage", ms: i });
    const stats = computeLatencyStats(samples);
    expect(stats.sendMessage.count).toBe(100);
    expect(stats.sendMessage.p50).toBe(51); // median
    expect(stats.sendMessage.p95).toBe(96); // p95
  });

  it("computeLatencyStats handles single-sample input", () => {
    const stats = computeLatencyStats([{ method: "sendPhoto", ms: 42 }]);
    expect(stats.sendPhoto.count).toBe(1);
    expect(stats.sendPhoto.p50).toBe(42);
    expect(stats.sendPhoto.p95).toBe(42);
  });

  it("computeLatencyStats returns empty object for empty input", () => {
    expect(computeLatencyStats([])).toEqual({});
  });

  it("uptimeSec increases over time", async () => {
    const snap1 = metrics.snapshot();
    await new Promise((r) => setTimeout(r, 1100));
    const snap2 = metrics.snapshot();
    expect(snap2.uptimeSec).toBeGreaterThan(snap1.uptimeSec);
  });
});
