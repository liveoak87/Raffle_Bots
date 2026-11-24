import { describe, expect, it, vi } from "vitest";
import {
  classifyTelegramCommand,
  filterAndCleanRaffleCommands,
  parseTelegramCommand,
} from "../src/commandRegistry";

const RAFFLE_BOT_USERNAME = "centralperkrafflebot";

function groupContext(text: string) {
  return {
    message: { text },
    chat: { type: "supergroup" },
    me: { username: RAFFLE_BOT_USERNAME },
    deleteMessage: vi.fn(async () => true),
  };
}

describe("raffle command filtering and cleanup", () => {
  it.each([
    "/brew@centralperkcoffeebot",
    "/mybrew@centralperkcoffeebot",
    "/setup@centralperkcoffeebot",
    "/anything@someotherbot",
  ])("ignores %s without deleting or processing it", async (text) => {
    const ctx = groupContext(text);
    const next = vi.fn(async () => {});

    await filterAndCleanRaffleCommands(ctx, next);

    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("does not delete normal text", async () => {
    const ctx = groupContext("Coffee Blitz starts in five minutes");
    const next = vi.fn(async () => {});

    await filterAndCleanRaffleCommands(ctx, next);

    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
  });

  it("processes and cleans up a valid unqualified raffle command", async () => {
    const ctx = groupContext("/newraffle Weekly drawing");
    const next = vi.fn(async () => {});

    await filterAndCleanRaffleCommands(ctx, next);

    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
    expect(
      classifyTelegramCommand(ctx.message.text, ctx.me.username)
    ).toMatchObject({ kind: "raffle_command", command: { name: "newraffle" } });
  });

  it("processes and cleans up a valid command addressed to the raffle bot", async () => {
    const ctx = groupContext(
      "/newraffle@CentralPerkRaffleBot Weekly drawing"
    );
    const next = vi.fn(async () => {});

    await filterAndCleanRaffleCommands(ctx, next);

    expect(ctx.deleteMessage).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledOnce();
  });

  it("ignores a raffle command addressed to a different bot", async () => {
    const ctx = groupContext("/newraffle@someotherbot Weekly drawing");
    const next = vi.fn(async () => {});

    await filterAndCleanRaffleCommands(ctx, next);

    expect(ctx.deleteMessage).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it("parses only the first token as /command or /command@botusername", () => {
    expect(parseTelegramCommand("/draw 42")).toEqual({
      name: "draw",
      botUsername: null,
    });
    expect(parseTelegramCommand("/draw@CentralPerkRaffleBot 42")).toEqual({
      name: "draw",
      botUsername: "centralperkrafflebot",
    });
    expect(parseTelegramCommand("hello /draw")).toBeNull();
  });
});
