export const RAFFLE_COMMAND_NAMES = [
  "start",
  "help",
  "manage",
  "newraffle",
  "setraffletopic",
  "raffles",
  "draw",
  "cancelraffle",
  "myentries",
  "rafflehistory",
  "exportentries",
  "rerun",
  "savetemplate",
  "templates",
  "deletetemplate",
  "usetemplate",
  "recurring",
  "editraffle",
  "language",
  "timezone",
  "stats",
  "health",
  "metrics",
  "active",
  "referralstats",
  "groupstats",
  "defaults",
  "setupcheck",
  "referrals",
  "bugreport",
] as const;

export type RaffleCommandName = (typeof RAFFLE_COMMAND_NAMES)[number];

const RAFFLE_COMMAND_NAME_SET = new Set<string>(RAFFLE_COMMAND_NAMES);

export interface ParsedTelegramCommand {
  name: string;
  botUsername: string | null;
}

export type CommandClassification =
  | { kind: "not_command" }
  | { kind: "foreign_command"; command: ParsedTelegramCommand }
  | { kind: "unknown_command"; command: ParsedTelegramCommand }
  | {
      kind: "raffle_command";
      command: ParsedTelegramCommand & { name: RaffleCommandName };
    };

/** Parse Telegram's first command token: /command or /command@botusername. */
export function parseTelegramCommand(text: string | undefined): ParsedTelegramCommand | null {
  if (!text) return null;
  const firstWhitespace = text.search(/\s/);
  const firstToken = firstWhitespace === -1 ? text : text.slice(0, firstWhitespace);
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?$/.exec(firstToken);
  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    botUsername: match[2]?.toLowerCase() ?? null,
  };
}

export function classifyTelegramCommand(
  text: string | undefined,
  raffleBotUsername: string
): CommandClassification {
  const command = parseTelegramCommand(text);
  if (!command) return { kind: "not_command" };

  if (
    command.botUsername !== null &&
    command.botUsername !== raffleBotUsername.toLowerCase()
  ) {
    return { kind: "foreign_command", command };
  }

  if (!RAFFLE_COMMAND_NAME_SET.has(command.name)) {
    return { kind: "unknown_command", command };
  }

  return {
    kind: "raffle_command",
    command: {
      ...command,
      name: command.name as RaffleCommandName,
    },
  };
}

interface CommandContextLike {
  message?: { text?: string };
  chat?: { type?: string };
  me: { username: string };
  deleteMessage(): Promise<unknown>;
}

/**
 * Ignore commands addressed to another bot and clean up only this bot's
 * explicitly registered commands in group chats.
 */
export async function filterAndCleanRaffleCommands(
  ctx: CommandContextLike,
  next: () => Promise<void>
): Promise<void> {
  const classification = classifyTelegramCommand(
    ctx.message?.text,
    ctx.me.username
  );

  if (classification.kind === "foreign_command") return;

  const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
  if (isGroup && classification.kind === "raffle_command") {
    try {
      await ctx.deleteMessage();
    } catch {
      // The bot may not have permission to delete messages in this chat.
    }
  }

  await next();
}
