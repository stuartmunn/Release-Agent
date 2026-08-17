/**
 * Environment parsing and validation. Fails fast with a clear message if a
 * required variable is missing so the container doesn't boot half-configured.
 *
 * Secrets come only from the environment — never hard-coded (see CLAUDE.md).
 */
import path from "node:path";
import type { ReleasebotTier } from "./types.js";

export interface Config {
  releasebot: {
    apiKey: string;
    tier: ReleasebotTier;
  };
  anthropic: {
    apiKey: string;
    model: string;
  };
  telegram: {
    botToken: string;
    /** Only this chat may talk to the bot. */
    chatId: string;
  };
  /** IANA timezone the cron schedule is interpreted in. */
  tz: string;
  /** Cron expression for the daily digest (default 08:30). */
  digestCron: string;
  /** Directory for the SQLite cache and other persisted state. */
  dataDir: string;
  /** Full path to the SQLite database file. */
  dbPath: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

function parseTier(raw: string): ReleasebotTier {
  const value = raw.toLowerCase();
  if (value === "free" || value === "pro") return value;
  throw new Error(`RELEASEBOT_TIER must be "free" or "pro", got: ${raw}`);
}

/** Build the config once at startup. Throws on invalid/missing values. */
export function loadConfig(): Config {
  const dataDir = optional("DATA_DIR", "/data");
  return {
    releasebot: {
      apiKey: required("RELEASEBOT_API_KEY"),
      tier: parseTier(optional("RELEASEBOT_TIER", "free")),
    },
    anthropic: {
      apiKey: required("ANTHROPIC_API_KEY"),
      model: optional("CLAUDE_MODEL", "claude-haiku-4-5-20251001"),
    },
    telegram: {
      botToken: required("TELEGRAM_BOT_TOKEN"),
      chatId: required("TELEGRAM_CHAT_ID"),
    },
    tz: optional("TZ", "Europe/London"),
    digestCron: optional("DIGEST_CRON", "30 8 * * *"),
    dataDir,
    dbPath: path.join(dataDir, "releasebot.sqlite"),
  };
}
