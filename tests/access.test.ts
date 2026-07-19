import { beforeEach, describe, expect, it, vi } from "vitest";

describe("group management access", () => {
  let db: typeof import("../src/database");
  let access: typeof import("../src/access");

  beforeEach(async () => {
    vi.resetModules();
    db = await import("../src/database");
    db.initDatabase(":memory:");
    access = await import("../src/access");
  });

  function apiWithStatus(status: "creator" | "administrator" | "member") {
    return {
      getChatMember: vi.fn().mockResolvedValue({ status }),
    } as never;
  }

  it("allows every administrator by default", async () => {
    const result = await access.getGroupManagementAccess(
      apiWithStatus("administrator"),
      -1001,
      20
    );
    expect(result).toEqual({ allowed: true, isAdmin: true, isOwner: false });
  });

  it("always allows the Telegram group owner", async () => {
    db.setGroupAccessMode(-1001, "owner_only");
    const result = await access.getGroupManagementAccess(
      apiWithStatus("creator"),
      -1001,
      10
    );
    expect(result).toEqual({ allowed: true, isAdmin: true, isOwner: true });
  });

  it("denies ordinary admins in owner-only mode", async () => {
    db.setGroupAccessMode(-1001, "owner_only");
    expect(
      await access.canManageGroup(apiWithStatus("administrator"), -1001, 20)
    ).toBe(false);
  });

  it("allows only approved admins in selected-admin mode", async () => {
    db.setGroupAccessMode(-1001, "selected_admins");
    const api = apiWithStatus("administrator");
    expect(await access.canManageGroup(api, -1001, 20)).toBe(false);

    db.setSelectedGroupAdmin(-1001, 20, true, 10);
    expect(await access.canManageGroup(api, -1001, 20)).toBe(true);
  });

  it("never allows a regular member", async () => {
    db.setSelectedGroupAdmin(-1001, 20, true, 10);
    expect(await access.canManageGroup(apiWithStatus("member"), -1001, 20)).toBe(false);
  });
});
