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
  /** When the raffle opens for entry (null = immediately) */
  starts_at: string | null;
  /**
   * Timezone to display times in on this raffle's posts (e.g. "America/New_York").
   * NULL means fall back to the chat's timezone (which defaults to UTC).
   * Set when the user picks a timezone in the schedule wizard.
   */
  display_timezone: string | null;
  status: "open" | "closed" | "drawn";
  message_id: number | null;
  /** Forum topic/thread ID (null = general/main thread) */
  thread_id: number | null;
  /** Chat ID that users must be a member of to enter */
  required_chat_id: number | null;
  /** Display title for the required chat */
  required_chat_title: string | null;
  /** Name of the raffle sponsor (displayed on raffle post) */
  sponsor_name: string | null;
  /** Whether entry list is hidden until draw (0 = visible, 1 = hidden) */
  anonymous: number;
  /** Telegram file_id for the raffle banner image */
  image_file_id: string | null;
  /** Whether to auto-pin the raffle message in the group */
  auto_pin: number;
  /** Minimum Telegram account age in days (0 = no restriction) */
  min_account_age_days: number;
  /** Whether a Telegram username is required to enter (0 = no, 1 = yes) */
  require_username: number;
  /** Exclude users who won within the last N raffles in this chat (0 = disabled) */
  winner_cooldown: number;
  /** Whether to show the wheel spin animation when drawing (0 = no, 1 = yes) */
  show_animation: number;
  /** Whether referral entries are enabled (0 = no, 1 = yes) */
  referral_enabled: number;
  /** Maximum bonus entries a user can earn via referrals (0 = unlimited) */
  max_referral_entries: number;
  /** Whether to revoke referral invite links when raffle ends (0 = no, 1 = yes) */
  revoke_referral_links: number;
  created_at: string;
  drawn_at: string | null;
  /** Whether the winner announcement was successfully posted (0 = no, 1 = yes) */
  announced: number;
  /** How many times we've tried to send the winner announcement */
  announce_attempts: number;
  /** ISO timestamp of the most recent announce attempt */
  last_announce_at: string | null;
  /** Whether announcement has been permanently abandoned after repeated failures */
  announce_failed: number;
  /** Whether we've already DM'd the owner about this raffle being stuck */
  owner_alerted: number;
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
  thread_id: number | null;
  creator_id: number;
  creator_name: string;
  title: string;
  description: string;
  prize: string;
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  ends_at: string | null;
  starts_at: string | null;
  /** Per-raffle display timezone (e.g. picked in wizard). Null = use chat default. */
  display_timezone: string | null;
  required_chat_id: number | null;
  required_chat_title: string | null;
  sponsor_name: string | null;
  anonymous: number;
  image_file_id: string | null;
  auto_pin: number;
  min_account_age_days: number;
  require_username: number;
  winner_cooldown: number;
  show_animation: number;
  referral_enabled: number;
  max_referral_entries: number;
  revoke_referral_links: number;
}

export interface RaffleTemplate {
  id: number;
  chat_id: number;
  thread_id: number | null;
  creator_id: number;
  name: string;
  title: string;
  description: string;
  prize: string;
  prizes: string | null;
  max_entries: number | null;
  max_winners: number;
  /** Duration in minutes (used to compute ends_at when creating from template) */
  duration_minutes: number | null;
  /** Delayed start offset in minutes from template use time (null = open immediately) */
  starts_after_minutes: number | null;
  display_timezone: string | null;
  required_chat_id: number | null;
  required_chat_title: string | null;
  sponsor_name: string | null;
  anonymous: number;
  image_file_id: string | null;
  auto_pin: number;
  min_account_age_days: number;
  require_username: number;
  winner_cooldown: number;
  show_animation: number;
  referral_enabled: number;
  max_referral_entries: number;
  revoke_referral_links: number;
  /** Recurring interval in minutes (null = not recurring) */
  recurring_interval_minutes: number | null;
  recurring_active: number;
  next_run_at: string | null;
  created_at: string;
}

export interface GroupDefaults {
  chat_id: number;
  /** Default forum topic for new raffles started from Command Central. */
  thread_id: number | null;
  max_entries: number | null;
  max_winners: number | null;
  duration_minutes: number | null;
  sponsor_name: string | null;
  anonymous: number | null;
  auto_pin: number | null;
  min_account_age_days: number | null;
  require_username: number | null;
  winner_cooldown: number | null;
  show_animation: number | null;
  referral_enabled: number | null;
  max_referral_entries: number | null;
  revoke_referral_links: number | null;
  required_chat_id: number | null;
  required_chat_title: string | null;
  updated_at: string;
}

export interface ReferralLink {
  id: number;
  raffle_id: number;
  user_id: number;
  user_display_name: string;
  chat_id: number;
  invite_link: string;
  bonus_entries: number;
  created_at: string;
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
