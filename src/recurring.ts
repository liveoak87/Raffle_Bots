import * as db from "./database";
import type { RaffleTemplate } from "./types";

interface RecurringFailureApi {
  sendMessage(chatId: number, text: string): Promise<unknown>;
}

export function buildRecurringFailureMessage(
  templateName: string,
  destinationName: string
): string {
  return (
    `⚠️ Recurring raffle paused\n\n` +
    `“${templateName}” could not be posted to ${destinationName}. ` +
    `The failed raffle was removed and this recurring template was paused.\n\n` +
    `Check that the saved topic is open, update the group’s raffle destination if needed, ` +
    `then restart recurring from Templates.`
  );
}

/** Clean up one failed occurrence, stop repeated failures, and alert its creator. */
export async function handleRecurringPostFailure(
  api: RecurringFailureApi,
  template: RaffleTemplate,
  raffleId: number,
  destinationName: string
): Promise<boolean> {
  db.deleteRaffle(raffleId);
  db.setRecurringActive(template.id, false, null);

  try {
    await api.sendMessage(
      template.creator_id,
      buildRecurringFailureMessage(template.name, destinationName)
    );
    return true;
  } catch {
    return false;
  }
}
