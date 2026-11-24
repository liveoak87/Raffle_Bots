import { getDb } from "./database";

/** Persist accepted deliveries so retries do not resend to successful recipients. */
export async function deliverOnce(
  raffleId: number, kind: string, target: string, send: () => Promise<unknown>
): Promise<void> {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM delivery_receipts WHERE raffle_id=? AND kind=? AND target=?").get(raffleId, kind, target)) return;
  let outcome = "sent";
  try {
    await send();
  } catch (error) {
    const err = error as { error_code?: number; description?: string };
    const unavailable = err.error_code === 403 ||
      (err.error_code === 400 && /chat not found|user is deactivated|invite.*(?:expired|invalid|revoked)|INVITE_HASH_(?:EXPIRED|INVALID)/i.test(err.description || ""));
    if (!unavailable) throw error;
    outcome = "unreachable";
  }
  db.prepare("INSERT OR IGNORE INTO delivery_receipts (raffle_id,kind,target,outcome) VALUES (?,?,?,?)").run(raffleId, kind, target, outcome);
}
