/**
 * Structured logging via pino. Pretty output when a TTY is attached (local dev),
 * plain JSON in the container.
 *
 * Never log secrets. API keys and tokens must not be passed to the logger.
 */
import pino from "pino";

const isTty = process.stdout.isTTY === true;

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(isTty
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      }
    : {}),
  // Defensive redaction in case an object with these keys is ever logged.
  redact: {
    paths: [
      "apiKey",
      "botToken",
      "*.apiKey",
      "*.botToken",
      "RELEASEBOT_API_KEY",
      "ANTHROPIC_API_KEY",
      "TELEGRAM_BOT_TOKEN",
    ],
    censor: "[redacted]",
  },
});
