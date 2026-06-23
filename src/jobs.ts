/**
 * Persistent background job queue (SQLite-backed).
 *
 * Solves the "fire-and-forget Promise died with the process" problem:
 * tasks like "DM the winners" or "revoke referral invite links" need to
 * complete even if the bot restarts mid-execution.
 *
 * Design:
 *   - One table (`jobs`), tiny schema
 *   - Worker loop polls for pending jobs every N seconds
 *   - Handlers registered by job type, must be idempotent
 *   - Failures retry with exponential backoff up to max_attempts
 *   - Jobs visible via /health and /metrics
 *
 * Handlers are pure: they take a payload and either succeed or throw.
 * The queue handles retry/persistence/observability.
 */

import * as db from "./database";
import { logger } from "./logger";
import { metrics } from "./metrics";

const log = logger.child({ component: "jobs" });

export interface Job {
  id: number;
  type: string;
  payload: string;
  status: "pending" | "running" | "done" | "failed";
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_after: string;
  created_at: string;
  updated_at: string;
}

type JobHandler = (payload: unknown) => Promise<void>;
const handlers = new Map<string, JobHandler>();

export function registerHandler(type: string, handler: JobHandler): void {
  if (handlers.has(type)) {
    log.warn({ type }, "Overwriting existing job handler");
  }
  handlers.set(type, handler);
}

export function enqueue(
  type: string,
  payload: unknown,
  options: { runAfter?: Date; maxAttempts?: number } = {}
): number {
  const runAfter = options.runAfter
    ? options.runAfter.toISOString().replace("T", " ").replace("Z", "").split(".")[0]
    : null;
  const maxAttempts = options.maxAttempts ?? 5;

  const sql = runAfter
    ? "INSERT INTO jobs (type, payload, run_after, max_attempts) VALUES (?, ?, ?, ?)"
    : "INSERT INTO jobs (type, payload, max_attempts) VALUES (?, ?, ?)";
  const params = runAfter ? [type, JSON.stringify(payload), runAfter, maxAttempts] : [type, JSON.stringify(payload), maxAttempts];

  const info = db.getDb().prepare(sql).run(...params);
  const id = Number(info.lastInsertRowid);
  metrics.recordEvent(`job_enqueued:${type}`);
  log.debug({ job_id: id, type }, "Job enqueued");
  return id;
}

/** Mark a job as running and bump its attempt count. Returns the locked row. */
function claimNext(): Job | null {
  const dbi = db.getDb();
  const tx = dbi.transaction(() => {
    const row = dbi
      .prepare(
        `SELECT * FROM jobs
         WHERE status = 'pending'
           AND run_after <= datetime('now')
         ORDER BY id ASC
         LIMIT 1`
      )
      .get() as Job | undefined;
    if (!row) return null;
    const result = dbi
      .prepare(
        `UPDATE jobs
         SET status = 'running', attempts = attempts + 1, updated_at = datetime('now')
         WHERE id = ?
           AND status = 'pending'
           AND run_after <= datetime('now')`
      )
      .run(row.id);
    if (result.changes !== 1) return null;
    row.attempts++;
    row.status = "running";
    return row;
  });
  return tx();
}

function complete(jobId: number): void {
  db.getDb()
    .prepare("UPDATE jobs SET status = 'done', updated_at = datetime('now') WHERE id = ?")
    .run(jobId);
}

function fail(jobId: number, errMessage: string, job: Job): void {
  // Exponential backoff: 30s, 60s, 2m, 4m, 8m, 16m...
  const delaySec = Math.min(30 * Math.pow(2, job.attempts - 1), 3600);
  const runAfter = new Date(Date.now() + delaySec * 1000)
    .toISOString()
    .replace("T", " ")
    .replace("Z", "")
    .split(".")[0];

  if (job.attempts >= job.max_attempts) {
    db.getDb()
      .prepare(
        "UPDATE jobs SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .run(errMessage, jobId);
    log.error({ job_id: jobId, type: job.type, attempts: job.attempts }, "Job permanently failed");
    metrics.recordEvent(`job_failed_permanent:${job.type}`);
  } else {
    db.getDb()
      .prepare(
        `UPDATE jobs
         SET status = 'pending', last_error = ?, run_after = ?, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(errMessage, runAfter, jobId);
    log.warn(
      { job_id: jobId, type: job.type, attempts: job.attempts, retry_in_sec: delaySec },
      "Job failed, scheduled retry"
    );
    metrics.recordEvent(`job_retry:${job.type}`);
  }
}

/**
 * Process up to BATCH_SIZE pending jobs. Designed to be called from a setInterval
 * with re-entry guard. Each job is run in sequence so the queue acts as a
 * natural throttle on resource-heavy operations.
 */
const BATCH_SIZE = 10;

export async function processJobs(): Promise<void> {
  for (let i = 0; i < BATCH_SIZE; i++) {
    const job = claimNext();
    if (!job) return;

    const handler = handlers.get(job.type);
    if (!handler) {
      const msg = `No handler registered for type '${job.type}'`;
      log.error({ job_id: job.id, type: job.type }, msg);
      fail(job.id, msg, job);
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      const msg = "Invalid JSON payload";
      log.error({ job_id: job.id, type: job.type }, msg);
      fail(job.id, msg, job);
      continue;
    }

    const startedAt = Date.now();
    try {
      await handler(payload);
      complete(job.id);
      metrics.recordEvent(`job_done:${job.type}`);
      log.debug(
        { job_id: job.id, type: job.type, elapsed_ms: Date.now() - startedAt },
        "Job completed"
      );
    } catch (err) {
      const msg = String((err as Error).message || err);
      fail(job.id, msg, job);
    }
  }
}

/** Counts for /health and /metrics. */
export function getJobStats(): {
  pending: number;
  running: number;
  failed: number;
  doneLast24h: number;
} {
  const dbi = db.getDb();
  const pending = (dbi.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='pending'").get() as { c: number }).c;
  const running = (dbi.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='running'").get() as { c: number }).c;
  const failed = (dbi.prepare("SELECT COUNT(*) as c FROM jobs WHERE status='failed'").get() as { c: number }).c;
  const doneLast24h = (
    dbi
      .prepare(
        "SELECT COUNT(*) as c FROM jobs WHERE status='done' AND updated_at >= datetime('now', '-24 hours')"
      )
      .get() as { c: number }
  ).c;
  return { pending, running, failed, doneLast24h };
}

/** Purge completed jobs older than X days to keep the table small. */
export function purgeOldJobs(retentionDays = 7): void {
  const result = db
    .getDb()
    .prepare(
      `DELETE FROM jobs WHERE status = 'done' AND updated_at <= datetime('now', '-' || ? || ' days')`
    )
    .run(retentionDays);
  if (result.changes > 0) {
    log.info({ deleted: result.changes }, "Purged old completed jobs");
  }
}

/**
 * Reset any jobs stuck in 'running' state (e.g. from a crash mid-execution).
 * Called once at startup so they get retried.
 */
export function recoverOrphanedJobs(): number {
  const result = db
    .getDb()
    .prepare(
      `UPDATE jobs
       SET status = 'pending', last_error = 'recovered from running state on startup', updated_at = datetime('now')
       WHERE status = 'running'`
    )
    .run();
  if (result.changes > 0) {
    log.info({ recovered: result.changes }, "Recovered orphaned 'running' jobs at startup");
  }
  return result.changes;
}
