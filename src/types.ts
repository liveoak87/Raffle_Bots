export interface Raffle {
  id: number;
  chat_id: number;
  creator_id: number;
  creator_name: string;
  title: string;
  description: string;
  prize: string;
  max_entries: number | null;
  max_winners: number;
  ends_at: string | null;
  status: "open" | "closed" | "drawn";
  message_id: number | null;
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
  selected_at: string;
}

export interface CreateRaffleInput {
  chat_id: number;
  creator_id: number;
  creator_name: string;
  title: string;
  description: string;
  prize: string;
  max_entries: number | null;
  max_winners: number;
  ends_at: string | null;
}
