export interface WebhookConfig {
  url: string;
  secret: string;
  port: number;
}

/** Parse and fail closed on webhook configuration. */
export function getWebhookConfig(
  env: NodeJS.ProcessEnv = process.env
): WebhookConfig | null {
  const rawUrl = env.WEBHOOK_URL?.trim();
  if (!rawUrl) return null;

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("WEBHOOK_URL must be a valid absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || !url.hostname) {
    throw new Error("WEBHOOK_URL must use HTTPS and include a hostname");
  }
  if (url.pathname !== "/webhook" || url.search || url.hash) {
    throw new Error("WEBHOOK_URL must point exactly to the /webhook path");
  }

  const secret = env.WEBHOOK_SECRET?.trim() || "";
  if (secret.length < 16 || secret.length > 256 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error(
      "WEBHOOK_SECRET is required in webhook mode and must be 16-256 characters using A-Z, a-z, 0-9, _ or -"
    );
  }

  const rawPort = env.WEBHOOK_PORT?.trim() || "3001";
  if (!/^\d+$/.test(rawPort)) {
    throw new Error("WEBHOOK_PORT must be an integer between 1 and 65535");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("WEBHOOK_PORT must be an integer between 1 and 65535");
  }

  return { url: url.toString(), secret, port };
}

/** Use Telegram's hosted API by default, or a Bot API server on the bot's network. */
export function getTelegramApiRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const rawUrl = env.TELEGRAM_API_ROOT?.trim();
  if (!rawUrl) return undefined;

  const url = URL.parse(rawUrl);
  if (
    !url ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash
  ) {
    throw new Error("TELEGRAM_API_ROOT must be an HTTP or HTTPS origin");
  }
  return url.origin;
}
