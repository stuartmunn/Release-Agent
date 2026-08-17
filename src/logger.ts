/**
 * Structured logging via pino. Pretty output when a TTY is attached AND pino-pretty is
 * installed (local dev); plain JSON otherwise (the container).
 *
 * pino-pretty is a devDependency and is pruned from the production image, so we must not
 * hard-depend on it: in the runtime image `docker compose exec` attaches a TTY but the
 * module isn't there. We check it's resolvable before asking pino to load it, and fall
 * back to JSON if anything goes wrong.
 *
 * Never log secrets. API keys and tokens must not be passed to the logger.
 */
import { createRequire } from "node:module";
import pino from "pino";

const require = createRequire(import.meta.url);

function prettyAvailable(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

const baseOptions = {
  level: process.env.LOG_LEVEL ?? "info",
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
};

function createLogger(): pino.Logger {
  if (process.stdout.isTTY === true && prettyAvailable()) {
    try {
      return pino({
        ...baseOptions,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss" },
        },
      });
    } catch {
      // Fall through to plain JSON if the transport can't be initialised.
    }
  }
  return pino(baseOptions);
}

export const logger = createLogger();
