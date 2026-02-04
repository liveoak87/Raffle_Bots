export interface Raffle {
  id: number;
  chat_id: number;
  creator_id: number;
  creator_name: string;
  title: string;
  description: string;
  prize: string;
  /** JSON-encoded array of prizes for each winner position (1st, 2nd, etc.) */
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  ends_at: string | null;
  status: "open" | "closed" | "drawn";
  message_id: number | null;
  /** Chat ID that users must be a member of to enter */
  required_chat_id: number | null;
  /** Display title for the required chat */
  required_chat_title: string | null;
  /** Name of the raffle sponsor (displayed on raffle post) */
  sponsor_name: string | null;
  created_at: string;
  drawn_at: string | null;
}

export interface RaffleEntry {
  id: number;
  raffle_id: number;
  user_id: number;
  user_name: string;
  user_display_name: string;
  entered_at: string;
}

export interface RaffleWinner {
  id: number;
  raffle_id: number;
  user_id: number;
  user_name: string;
  user_display_name: string;
  /** The specific prize this winner received */
  prize: string;
  position: number;
  selected_at: string;
}

export interface CreateRaffleInput {
  chat_id: number;
  creator_id: number;
  creator_name: string;
  title: string;
  description: string;
  prize: string;
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  ends_at: string | null;
  required_chat_id: number | null;
  required_chat_title: string | null;
  sponsor_name: string | null;
}

/** Parsed list of prizes from the prizes JSON field */
export function parsePrizes(raffle: Raffle): string[] {
  if (raffle.prizes) {
    try {
      const parsed = JSON.parse(raffle.prizes);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // fall through
    }
  }
  // Fallback: single prize for all winners
  return [raffle.prize];
}

/** Get the prize for a specific winner position (0-indexed) */
export function getPrizeForPosition(raffle: Raffle, position: number): string {
  const prizes = parsePrizes(raffle);
  if (position < prizes.length) {
    return prizes[position];
  }
  // If more winners than prizes, last prize applies to remaining
  return prizes[prizes.length - 1];
}
