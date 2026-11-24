import type { Api } from "grammy";

const GROUPKEEPER_USERNAME = "thegroupkeeperbot";

type Administrator = {
  status: string;
  user: {
    is_bot: boolean;
    username?: string;
  };
};

type BotAwareAdministratorApi = {
  getChatAdministrators(input: {
    chat_id: number;
    return_bots: true;
  }): Promise<Administrator[]>;
};

/** Detect GroupKeeper without depending on another bot's updates. */
export async function hasGroupKeeperAdministrator(
  api: Api,
  chatId: number
): Promise<boolean> {
  const raw = api.raw as unknown as BotAwareAdministratorApi;
  const administrators = await raw.getChatAdministrators({
    chat_id: chatId,
    return_bots: true,
  });

  return administrators.some((member) =>
    member.user.is_bot &&
    member.user.username?.toLowerCase() === GROUPKEEPER_USERNAME
  );
}
