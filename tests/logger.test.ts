import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logger: typeof import("../src/logger").logger;

  beforeEach(async () => {
    // Reset module so env changes take effect
    vi.resetModules();
    delete process.env.LOG_PRETTY;
    process.env.LOG_LEVEL = "debug";
    logger = (await import("../src/logger")).logger;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("emits JSON with required fields", () => {
    logger.info({ user_id: 123 }, "hello");
    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line);
    expect(obj.level).toBe("info");
    expect(obj.msg).toBe("hello");
    expect(obj.user_id).toBe(123);
    expect(obj.t).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("sends warn/error to stderr", () => {
    logger.warn({}, "uh oh");
    logger.error({}, "broken");
    expect(errSpy).toHaveBeenCalledTimes(2);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("flattens Error objects", () => {
    const err = new Error("kaboom");
    logger.error({ err }, "something went wrong");
    const line = errSpy.mock.calls[0][0] as string;
    const obj = JSON.parse(line);
    expect(obj.err.name).toBe("Error");
    expect(obj.err.message).toBe("kaboom");
    expect(obj.err.stack).toContain("Error");
  });

  it("child logger merges context fields", () => {
    const child = logger.child({ component: "test", chat_id: -100 });
    child.info({ user_id: 42 }, "event");
    const obj = JSON.parse(logSpy.mock.calls[0][0] as string);
    expect(obj.component).toBe("test");
    expect(obj.chat_id).toBe(-100);
    expect(obj.user_id).toBe(42);
  });

  it("filters below configured level", async () => {
    vi.resetModules();
    process.env.LOG_LEVEL = "warn";
    const { logger: filteredLogger } = await import("../src/logger");
    const filteredSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    filteredLogger.info({}, "should be dropped");
    filteredLogger.debug({}, "also dropped");
    expect(filteredSpy).not.toHaveBeenCalled();
    filteredSpy.mockRestore();
  });
});
