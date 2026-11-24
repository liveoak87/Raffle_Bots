import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, Server, ServerResponse } from "http";

describe("admin HTTP server", () => {
  let server: Server;

  beforeEach(async () => {
    vi.resetModules();
    const db = await import("../src/database");
    db.initDatabase(":memory:");
    db.upsertBotGroup(-1001, "Audit Group", "administrator");
    const { createAdminServer } = await import("../src/adminServer");
    server = createAdminServer("0123456789abcdef");
  });

  function request(path: string, key?: string, method = "GET") {
    let status = 0;
    let body = "";
    const headers: Record<string, string> = {};
    const req = {
      method,
      url: path,
      headers: key ? { "x-admin-key": key } : {},
    } as unknown as IncomingMessage;
    const res = {
      setHeader: (name: string, value: string) => { headers[name.toLowerCase()] = value; },
      writeHead: (code: number, values?: Record<string, string>) => {
        status = code;
        for (const [name, value] of Object.entries(values || {})) {
          headers[name.toLowerCase()] = value;
        }
        return res;
      },
      end: (value?: string) => { body = value || ""; return res; },
    } as unknown as ServerResponse;
    const handler = server.listeners("request")[0] as (
      req: IncomingMessage,
      res: ServerResponse
    ) => void;
    handler(req, res);
    return { status, body: JSON.parse(body), headers };
  }

  it.each(["/health", "/admin/health"])(
    "exposes only the minimal liveness response publicly at %s",
    (path) => {
      const response = request(path);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  );

  it("does not accept non-GET health probes", () => {
    const response = request("/health", undefined, "POST");
    expect(response.status).toBe(404);
  });

  it("fails health probes and the dashboard when Telegram polling stalls", async () => {
    const { createAdminServer } = await import("../src/adminServer");
    server = createAdminServer("0123456789abcdef", () => false);
    expect(request("/health")).toMatchObject({ status: 503, body: { ok: false } });
    expect(request("/admin/health").status).toBe(503);
    expect(request("/admin/summary", "0123456789abcdef").body.healthy).toBe(false);
  });

  it("rejects protected routes without the admin key", () => {
    expect(request("/admin/summary").status).toBe(403);
    expect(request("/admin/groups").status).toBe(403);
  });

  it("returns authenticated group summaries", () => {
    const response = request("/admin/groups", "0123456789abcdef");
    expect(response.status).toBe(200);
    expect(response.body.count).toBe(1);
    expect(response.body.groups[0].title).toBe("Audit Group");
  });

  it("does not report false healthy/error values", async () => {
    const db = await import("../src/database");
    db.getDb().prepare(
      "INSERT INTO jobs (type, payload, status) VALUES ('broken', '{}', 'failed')"
    ).run();
    const response = request("/admin/summary", "0123456789abcdef");
    expect(response.status).toBe(200);
    expect(response.body.healthy).toBe(false);
    expect(response.body.errors_24h).toBeNull();
    expect(response.body.usage["Failed jobs"]).toBe(1);
  });
});
