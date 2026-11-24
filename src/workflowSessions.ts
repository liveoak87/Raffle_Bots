import { randomBytes } from "node:crypto";
import type { Api, Context, NextFunction } from "grammy";
import { parseTelegramCommand } from "./commandRegistry";
import { logger } from "./logger";

export type WorkflowKind = "raffle" | "edit" | "template" | "bug";
export interface WorkflowState { userId: number; createdAt: number; }
type Prompt = { text: string; options: Parameters<Api["sendMessage"]>[2] };
interface Session {
  id: string;
  kind: WorkflowKind;
  state: WorkflowState;
  api: Api;
  checkpoint: Record<string, unknown>;
  prompt?: Prompt;
  revision: number;
  controls: Map<string, string>;
  controlMessageId?: number;
  controlStep?: string;
  keyboardMessages: Set<number>;
  deliveryFailed: boolean;
  recovering: boolean;
  cleanup?: () => Promise<void>;
  track?: (message: { message_id: number; chat: { id: number } }) => Promise<void>;
  recover?: (ctx: Context) => Promise<unknown>;
}

const sessions = new Map<number, Session>();
const bindings = new WeakMap<Api, Session>();
const installed = new WeakSet<Api>();
export const WORKFLOW_TIMEOUT_MS = 30 * 60_000;

export function workflowUpdateKeys(ctx: Context): string[] {
  const keys: string[] = [];
  if (ctx.chat) keys.push(`chat:${ctx.chat.id}`);
  if (ctx.from) keys.push(`user:${ctx.from.id}`);
  return keys;
}

function snapshot(state: WorkflowState): Record<string, unknown> {
  return Object.fromEntries(Object.entries(state).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]));
}
function step(session: Session): string {
  const state = session.state as WorkflowState & { step?: string; editingField?: string | null };
  return state.step ?? state.editingField ?? "menu";
}
function fields(session: Session) {
  const state = session.state as WorkflowState & { targetChatId?: number; chatId?: number; fromChatId?: number };
  return { session_id: session.id, user_id: state.userId, group_id: state.targetChatId ?? state.chatId ?? state.fromChatId, workflow: session.kind, step: step(session) };
}
function controlKind(data: string): WorkflowKind | undefined {
  if (/^(wiz_|wsc:|wotz:)/.test(data)) return "raffle";
  if (data.startsWith("edit_") && !data.startsWith("edit_pick_")) return "edit";
  if (data.startsWith("twiz_")) return "template";
  if (data === "bugreport_skip") return "bug";
}

async function retire(session: Session, reason: string): Promise<void> {
  if (sessions.get(session.state.userId) === session) sessions.delete(session.state.userId);
  logger.info(fields(session), `Workflow ${reason}`);
  try {
    if (session.cleanup) await session.cleanup();
    else for (const messageId of session.keyboardMessages) {
      try { await session.api.editMessageReplyMarkup(session.state.userId, messageId, { reply_markup: { inline_keyboard: [] } }); } catch {}
    }
  } catch {
    logger.warn(fields(session), "Workflow cleanup failed");
  }
}

export function getWorkflow(userId: number): Session | undefined {
  const session = sessions.get(userId);
  if (session && Date.now() - session.state.createdAt >= WORKFLOW_TIMEOUT_MS) {
    void retire(session, "expired");
    return undefined;
  }
  return session;
}
export function getWorkflowState<T extends WorkflowState>(userId: number, kind: WorkflowKind): T | undefined {
  const session = getWorkflow(userId);
  return session?.kind === kind ? session.state as T : undefined;
}
/** Preserve an explicit, authorized change made outside the DM input router. */
export function checkpointWorkflowState(userId: number): void {
  const session = getWorkflow(userId);
  if (session) session.checkpoint = snapshot(session.state);
}
export async function endWorkflow(userId: number, reason = "cancelled", expected?: WorkflowState): Promise<boolean> {
  const session = sessions.get(userId);
  if (!session || (expected && session.state !== expected)) return false;
  await retire(session, reason);
  return true;
}
export async function expireWorkflows(): Promise<void> {
  const now = Date.now();
  // Bound cleanup concurrency when many idle sessions expire together.
  const expired = [...sessions.values()].filter(session => now - session.state.createdAt >= WORKFLOW_TIMEOUT_MS);
  for (let offset = 0; offset < expired.length; offset += 8) {
    await Promise.all(expired.slice(offset, offset + 8).map(session => retire(session, "expired")));
  }
}

/** Install on the per-update API object, not the bot's shared global API. */
function observePrompts(api: Api): void {
  if (installed.has(api)) return;
  installed.add(api);
  api.config.use(async (prev, method, payload, signal) => {
    const session = bindings.get(api);
    const p = payload as unknown as Record<string, any>;
    const isPrompt = session && sessions.get(session.state.userId) === session
      && p.chat_id === session.state.userId && (method === "sendMessage" || method === "editMessageText");
    if (!isPrompt) return prev(method, payload, signal);

    const controls = new Map<string, string>();
    const revision = ++session.revision;
    if (p.reply_markup?.inline_keyboard) {
      p.reply_markup = { ...p.reply_markup, inline_keyboard: p.reply_markup.inline_keyboard.map((row: Array<Record<string, any>>) => row.map(button => {
        if (typeof button.callback_data !== "string" || controlKind(button.callback_data) !== session.kind) return button;
        const token = `wf:${session.id}:${revision}:${controls.size}`;
        controls.set(token, button.callback_data);
        return { ...button, callback_data: token };
      })) };
    }
    try {
      const response = await prev(method, payload, signal);
      if (!response.ok) {
        session.deliveryFailed = true;
        return response;
      }
      const result = response.result as unknown as { message_id?: number; chat?: { id: number } };
      const messageId = result?.message_id ?? p.message_id;
      if (method === "sendMessage" && result?.message_id && result.chat) await session.track?.({ message_id: result.message_id, chat: result.chat });
      if (sessions.get(session.state.userId) !== session) return response;
      session.deliveryFailed = false;
      session.checkpoint = snapshot(session.state);
      // Store original callbacks, so replay generates fresh tokens and bindings.
      const markup = p.reply_markup?.inline_keyboard ? {
        inline_keyboard: p.reply_markup.inline_keyboard.map((row: Array<Record<string, any>>) => row.map(button => ({ ...button, ...(controls.has(button.callback_data) ? { callback_data: controls.get(button.callback_data) } : {}) }))),
      } : undefined;
      session.prompt = { text: p.text, options: { parse_mode: p.parse_mode, entities: p.entities, link_preview_options: p.link_preview_options, reply_markup: markup } };
      session.controls = controls;
      session.controlMessageId = messageId;
      session.controlStep = step(session);
      if (controls.size && messageId) session.keyboardMessages.add(messageId);
      return response;
    } catch (err) {
      session.deliveryFailed = true;
      throw err;
    }
  });
}

export async function beginWorkflow(
  kind: WorkflowKind, state: WorkflowState, api: Api,
  sendPrompt: () => Promise<unknown>,
  options: Pick<Session, "cleanup" | "track" | "recover"> = {}
): Promise<void> {
  observePrompts(api);
  const previous = getWorkflow(state.userId);
  const session: Session = { id: randomBytes(6).toString("hex"), kind, state, api,
    checkpoint: snapshot(state), revision: 0, controls: new Map(), keyboardMessages: new Set(), deliveryFailed: false, recovering: false, ...options };
  sessions.set(state.userId, session);
  bindings.set(api, session);
  try {
    await sendPrompt();
  } catch (err) {
    if (sessions.get(state.userId) === session) {
      if (previous && Date.now() - previous.state.createdAt < WORKFLOW_TIMEOUT_MS) sessions.set(state.userId, previous);
      else sessions.delete(state.userId);
    }
    await retire(session, "start_failed");
    throw err;
  }
  logger.info(fields(session), "Workflow started");
  if (previous) await retire(previous, "replaced");
}

async function recoverPrompt(ctx: Context, session: Session): Promise<void> {
  session.recovering = true;
  session.deliveryFailed = false;
  if (session.kind !== "edit") {
    for (const key of Object.keys(session.state)) delete (session.state as unknown as Record<string, unknown>)[key];
    Object.assign(session.state, session.checkpoint, { createdAt: Date.now() });
  }
  bindings.set(ctx.api, session);
  try {
    try { await workflowHint(ctx, "Delivery was interrupted. Continue from the setup prompt below."); } catch {}
    if (session.recover && (session.kind === "edit" || step(session) === "options")) await session.recover(ctx);
    else if (session.prompt) await ctx.api.sendMessage(session.state.userId, session.prompt.text, session.prompt.options);
    else throw new Error("Missing workflow prompt");
    session.recovering = false;
  } catch {
    logger.warn(fields(session), "Workflow prompt recovery pending");
  }
}

export async function workflowHint(ctx: Context, message: string): Promise<void> {
  const session = bindings.get(ctx.api);
  bindings.delete(ctx.api);
  try {
    const sent = await ctx.reply(message);
    await session?.track?.(sent);
  } finally {
    if (session) bindings.set(ctx.api, session);
  }
}

/** Called only once the router has selected workflow input, not a forward/menu. */
export function prepareWorkflowInput(ctx: Context): void {
  if (!ctx.from) return;
  const session = getWorkflow(ctx.from.id);
  if (session) {
    bindings.set(ctx.api, session);
    session.state.createdAt = Date.now();
  }
}

/** Cancellation, navigation, stale-control validation, and prompt recovery. */
export async function workflowMiddleware(ctx: Context, next: NextFunction): Promise<void> {
  observePrompts(ctx.api);
  if (!ctx.from) return next();
  const userId = ctx.from.id;
  const command = parseTelegramCommand(ctx.message?.text);
  if (command?.botUsername && command.botUsername !== ctx.me.username.toLowerCase()) return;
  const data = ctx.callbackQuery?.data;
  const privateChat = ctx.chat?.type === "private";
  if (privateChat && command?.name === "cancel") {
    const active = getWorkflow(userId);
    const ending = endWorkflow(userId);
    await ctx.reply(active ? "Setup cancelled. You can start a new workflow from the main menu." : "There is no active setup to cancel.");
    await ending;
    return;
  }
  const startHome = command?.name === "start" && ctx.message?.text?.trim().split(/\s+/).length === 1;
  if (privateChat && (startHome || command?.name === "manage" || data === "home_main" || data === "admin_groups")) {
    await endWorkflow(userId, "left_for_menu");
    return next();
  }

  const session = getWorkflow(userId);
  let workflowControl = false;
  if (data?.startsWith("wf:") || (data && controlKind(data))) {
    const original = session?.controls.get(data);
    if (!privateChat || !session || !original || session.controlMessageId !== ctx.callbackQuery?.message?.message_id || session.controlStep !== step(session) || session.recovering) {
      logger.info({ user_id: userId, workflow: session?.kind }, "Rejected stale workflow control");
      await ctx.answerCallbackQuery({ text: "This setup control has expired. Use the latest setup message or start again.", show_alert: true });
      return;
    }
    ctx.callbackQuery!.data = original;
    workflowControl = true;
  }
  const input = privateChat && !!ctx.message && !command;
  if (session && (input || workflowControl)) {
    if (workflowControl) {
      bindings.set(ctx.api, session);
      session.state.createdAt = Date.now();
    }
    if (session.recovering) {
      await recoverPrompt(ctx, session);
      return;
    }
  }
  try {
    await next();
  } catch (err) {
    if (!session || !(input || workflowControl) || sessions.get(userId) !== session) throw err;
    session.deliveryFailed = true;
    logger.warn({ ...fields(session), error_type: err instanceof Error ? err.name : "unknown" }, "Workflow handler failed");
    if (workflowControl) {
      try { await ctx.answerCallbackQuery({ text: "Restoring your setup. Please use the latest message." }); } catch {}
    }
  }
  if (session && sessions.get(userId) === session && session.deliveryFailed && (input || workflowControl)) {
    logger.warn(fields(session), "Workflow prompt delivery failed; restoring current step");
    await recoverPrompt(ctx, session);
  }
}
