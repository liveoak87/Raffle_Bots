import type { Context } from "grammy";
import * as db from "./database";

export interface GroupManagementAccess {
  allowed: boolean;
  isAdmin: boolean;
  isOwner: boolean;
}

export async function getGroupManagementAccess(
  api: Context["api"],
  chatId: number,
  userId: number
): Promise<GroupManagementAccess> {
  try {
    const member = await api.getChatMember(chatId, userId);
    const isOwner = member.status === "creator";
    const isAdmin = isOwner || member.status === "administrator";

    if (!isAdmin) {
      db.forgetUserAdminGroup(userId, chatId);
      return { allowed: false, isAdmin: false, isOwner: false };
    }

    db.rememberUserAdminGroup(
      userId,
      chatId,
      isOwner ? "creator" : "administrator"
    );

    if (isOwner) return { allowed: true, isAdmin: true, isOwner: true };

    const mode = db.getGroupAccessMode(chatId);
    const allowed =
      mode === "all_admins" ||
      (mode === "selected_admins" && db.isSelectedGroupAdmin(chatId, userId));
    return { allowed, isAdmin: true, isOwner: false };
  } catch {
    return { allowed: false, isAdmin: false, isOwner: false };
  }
}

export async function canManageGroup(
  api: Context["api"],
  chatId: number,
  userId: number
): Promise<boolean> {
  return (await getGroupManagementAccess(api, chatId, userId)).allowed;
}

export async function isGroupOwner(
  api: Context["api"],
  chatId: number,
  userId: number
): Promise<boolean> {
  return (await getGroupManagementAccess(api, chatId, userId)).isOwner;
}
