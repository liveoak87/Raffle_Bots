/**
 * Lightweight structured JSON logger.
 *
 * Outputs one JSON object per line to stdout/stderr, designed to be:
 *   - greppable: `docker logs raffle-bot | grep '"level":"error"'`
 *   - queryable via jq: `docker logs raffle-bot | jq 'select(.raffle_id == 939)'`
 *   - cheap: zero dependencies, no allocation overhead beyond JSON.stringify
 *
 * Falls back to pretty plain-text output when LOG_PRETTY=1 (useful for dev).
 *
 * Existing `console.log` calls continue to work alongside this — they just
 * produce plain lines instead of JSON. Migrate over time.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const PRETTY = process.env.LOG_PRETTY === "1";

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[MIN_LEVEL];
}

function emit(level: LogLevel, fields: Record<string, unknown>, msg: string): void {
  if (!shouldLog(level)) return;

  if (PRETTY) {
    const fieldStr = Object.keys(fields).length > 0 ? " " + JSON.stringify(fields) : "";
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}${fieldStr}`;
    if (level === "error" || level === "warn") {
      console.error(line);
    } else {
      console.log(line);
    }
    return;
  }

  // JSON output — one line per record
  const record: Record<string, unknown> = {
    t: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };

  // Pull Error objects out into a flat shape so jq can target them
  if (record.err instanceof Error) {
    const err = record.err;
    const errAsRecord = err as unknown as Record<string, unknown>;
    record.err = {
      name: err.name,
      message: err.message,
      stack: err.stack,
      // grammY errors have these extra fields
      ...(errAsRecord.description !== undefined && {
        description: errAsRecord.description,
      }),
      ...(errAsRecord.error_code !== undefined && {
        error_code: errAsRecord.error_code,
      }),
    };
  }

  const out = JSON.stringify(record);
  if (level === "error" || level === "warn") {
    console.error(out);
  } else {
    console.log(out);
  }
}

export const logger = {
  debug: (fields: Record<string, unknown>, msg: string) => emit("debug", fields, msg),
  info: (fields: Record<string, unknown>, msg: string) => emit("info", fields, msg),
  warn: (fields: Record<string, unknown>, msg: string) => emit("warn", fields, msg),
  error: (fields: Record<string, unknown>, msg: string) => emit("error", fields, msg),

  /**
   * Create a child logger with a fixed set of context fields automatically
   * included on every record. Use for component-scoped logging.
   */
  child(context: Record<string, unknown>) {
    return {
      debug: (fields: Record<string, unknown>, msg: string) => emit("debug", { ...context, ...fields }, msg),
      info: (fields: Record<string, unknown>, msg: string) => emit("info", { ...context, ...fields }, msg),
      warn: (fields: Record<string, unknown>, msg: string) => emit("warn", { ...context, ...fields }, msg),
      error: (fields: Record<string, unknown>, msg: string) => emit("error", { ...context, ...fields }, msg),
    };
  },
};
