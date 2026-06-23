/**
 * In-memory metrics counters.
 *
 * Tracks bot activity that's invisible from logs alone: API call volume,
 * error rates, command frequency, etc. Exposed via /metrics (owner only).
 *
 * Counters are cumulative since process start. /metrics resets nothing —
 * the bot can restart to "reset" by virtue of being a fresh process.
 *
 * Memory footprint is tiny (a few maps with low cardinality keys). No
 * external dependencies. If we ever want to push to Prometheus/Grafana,
 * the shape here maps cleanly onto that model.
 */

interface MetricsSnapshot {
  uptimeSec: number;
  startedAt: string;

  // API call activity
  apiCalls: Record<string, number>; // method -> count
  apiErrors: Record<string, number>; // "<method>:<error_code>" -> count

  // Command activity
  commands: Record<string, number>; // command name (e.g. "newraffle") -> count

  // Internal events
  events: Record<string, number>; // free-form event name -> count

  // Latency tracking (recent samples for percentile compute)
  apiLatencyMs: { method: string; ms: number }[];

  // Rate limit hits
  rateLimitHits: number;

  // Stuck-raffle alerts sent to owner
  ownerAlertsSent: number;
}

const startedAt = new Date();
const apiCalls = new Map<string, number>();
const apiErrors = new Map<string, number>();
const commands = new Map<string, number>();
const events = new Map<string, number>();
const apiLatencyMs: { method: string; ms: number }[] = [];
const MAX_LATENCY_SAMPLES = 200;

let rateLimitHits = 0;
let ownerAlertsSent = 0;

function inc(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) || 0) + by);
}

export const metrics = {
  recordApiCall(method: string, latencyMs?: number): void {
    inc(apiCalls, method);
    if (typeof latencyMs === "number") {
      apiLatencyMs.push({ method, ms: latencyMs });
      if (apiLatencyMs.length > MAX_LATENCY_SAMPLES) apiLatencyMs.shift();
    }
  },

  recordApiError(method: string, errorCode: number | string): void {
    inc(apiErrors, `${method}:${errorCode}`);
  },

  recordCommand(name: string): void {
    inc(commands, name);
  },

  recordEvent(name: string, by = 1): void {
    inc(events, name, by);
  },

  recordRateLimitHit(): void {
    rateLimitHits++;
  },

  recordOwnerAlert(): void {
    ownerAlertsSent++;
  },

  snapshot(): MetricsSnapshot {
    return {
      uptimeSec: Math.floor((Date.now() - startedAt.getTime()) / 1000),
      startedAt: startedAt.toISOString(),
      apiCalls: Object.fromEntries(apiCalls),
      apiErrors: Object.fromEntries(apiErrors),
      commands: Object.fromEntries(commands),
      events: Object.fromEntries(events),
      apiLatencyMs: [...apiLatencyMs],
      rateLimitHits,
      ownerAlertsSent,
    };
  },
};

/** Compute median + p95 latency for each API method from the recent sample buffer. */
export function computeLatencyStats(samples: { method: string; ms: number }[]): Record<string, { p50: number; p95: number; count: number }> {
  const byMethod = new Map<string, number[]>();
  for (const s of samples) {
    if (!byMethod.has(s.method)) byMethod.set(s.method, []);
    byMethod.get(s.method)!.push(s.ms);
  }
  const result: Record<string, { p50: number; p95: number; count: number }> = {};
  for (const [method, arr] of byMethod) {
    arr.sort((a, b) => a - b);
    const p50 = arr[Math.floor(arr.length * 0.5)];
    const p95 = arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.95))];
    result[method] = { p50, p95, count: arr.length };
  }
  return result;
}
