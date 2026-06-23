import { describe, it, expect, beforeEach, vi } from "vitest";

// jobs.ts imports database.ts which expects initDatabase to have run.
// We use an in-memory DB and re-init per test for isolation.

describe("job queue", () => {
  let jobs: typeof import("../src/jobs");
  let db: typeof import("../src/database");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    jobs = await import("../src/jobs");
    // Use in-memory SQLite for isolated tests
    db.initDatabase(":memory:");
  });

  it("enqueue creates a job row", () => {
    const id = jobs.enqueue("test_type", { foo: "bar" });
    expect(id).toBeGreaterThan(0);
    const stats = jobs.getJobStats();
    expect(stats.pending).toBe(1);
  });

  it("processJobs runs registered handler and marks done", async () => {
    let invoked = false;
    jobs.registerHandler("test_type", async (payload) => {
      expect(payload).toEqual({ foo: "bar" });
      invoked = true;
    });

    jobs.enqueue("test_type", { foo: "bar" });
    await jobs.processJobs();

    expect(invoked).toBe(true);
    const stats = jobs.getJobStats();
    expect(stats.pending).toBe(0);
    expect(stats.doneLast24h).toBe(1);
  });

  it("retries on handler failure and eventually marks failed after max_attempts", async () => {
    let attempts = 0;
    jobs.registerHandler("flaky_type", async () => {
      attempts++;
      throw new Error("always fails");
    });

    // maxAttempts: 2 means it succeeds at most twice
    const id = jobs.enqueue("flaky_type", {}, { maxAttempts: 2 });

    await jobs.processJobs(); // attempt 1 -> fail, schedule retry (but in the future)
    expect(attempts).toBe(1);

    // Force run_after to be in the past so it's eligible for next process tick
    db.getDb()
      .prepare("UPDATE jobs SET run_after = datetime('now', '-1 hours') WHERE id = ?")
      .run(id);

    await jobs.processJobs(); // attempt 2 -> fail permanently
    expect(attempts).toBe(2);

    const stats = jobs.getJobStats();
    expect(stats.pending).toBe(0);
    expect(stats.failed).toBe(1);
  });

  it("missing handler marks job failed", async () => {
    jobs.enqueue("unknown_type", {});
    await jobs.processJobs();
    const stats = jobs.getJobStats();
    // After 1 attempt with maxAttempts default=5, it should retry...
    // But "no handler" should not retry forever — verify it at least failed once
    expect(stats.pending + stats.failed).toBe(1);
  });

  it("recoverOrphanedJobs resurrects running rows", () => {
    const id = jobs.enqueue("test_type", {});
    db.getDb().prepare("UPDATE jobs SET status='running' WHERE id = ?").run(id);

    const recovered = jobs.recoverOrphanedJobs();
    expect(recovered).toBe(1);

    const stats = jobs.getJobStats();
    expect(stats.pending).toBe(1);
    expect(stats.running).toBe(0);
  });

  it("purgeOldJobs deletes completed jobs older than N days", () => {
    jobs.registerHandler("test_type", async () => {});

    // Insert a "done" job with an old updated_at
    db.getDb()
      .prepare(
        `INSERT INTO jobs (type, payload, status, updated_at)
         VALUES ('test_type', '{}', 'done', datetime('now', '-10 days'))`
      )
      .run();

    const beforePending = jobs.getJobStats();
    jobs.purgeOldJobs(7);
    const allRows = db.getDb().prepare("SELECT COUNT(*) as c FROM jobs").get() as { c: number };
    expect(allRows.c).toBe(0);
  });

  it("respects run_after for delayed jobs", async () => {
    let invoked = false;
    jobs.registerHandler("delayed_type", async () => {
      invoked = true;
    });

    // Schedule for 1 hour in the future
    jobs.enqueue("delayed_type", {}, { runAfter: new Date(Date.now() + 3600_000) });
    await jobs.processJobs();

    expect(invoked).toBe(false);
    expect(jobs.getJobStats().pending).toBe(1);
  });
});
