export type RerunDestination =
  | { kind: "source" }
  | { kind: "general" }
  | { kind: "topic"; threadId: number };

export function encodeRerunDestination(destination: RerunDestination): string {
  switch (destination.kind) {
    case "general":
      return "g";
    case "topic":
      return `t${destination.threadId}`;
    default:
      return "s";
  }
}

export function decodeRerunDestination(token?: string): RerunDestination {
  if (token === "g") return { kind: "general" };
  if (token?.startsWith("t")) {
    const threadId = Number(token.slice(1));
    if (Number.isSafeInteger(threadId) && threadId > 0) {
      return { kind: "topic", threadId };
    }
  }
  return { kind: "source" };
}

export function resolveRerunThread(
  destination: RerunDestination,
  sourceThreadId: number | null
): number | null {
  if (destination.kind === "general") return null;
  if (destination.kind === "topic") return destination.threadId;
  return sourceThreadId;
}

export async function sendWithGeneralFallback(
  send: (threadId: number | null) => Promise<number | null>,
  preferredThreadId: number | null
): Promise<{ messageId: number; threadId: number | null } | null> {
  const preferredMessageId = await send(preferredThreadId);
  if (preferredMessageId !== null) {
    return { messageId: preferredMessageId, threadId: preferredThreadId };
  }

  if (preferredThreadId === null) return null;

  const generalMessageId = await send(null);
  return generalMessageId === null
    ? null
    : { messageId: generalMessageId, threadId: null };
}
