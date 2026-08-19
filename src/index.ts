/**
 * Entrypoint. One long-running process with two duties:
 *   - node-cron fires the daily digest at the configured time (default 08:30);
 *   - the Telegram bot long-polls for questions all day.
 * Both share one SQLite cache.
 */
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { openDb, renormaliseIfNeeded } from "./cache.js";
import { NORMALISER_VERSION, normaliseRelease } from "./releasebot.js";
import { createBot, sendChunked, startBot } from "./telegram.js";
import { dailyJob } from "./digest.js";
import { logger } from "./logger.js";

function main(): void {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  // Re-normalise any cached rows written by an older normaliser (free, no fetch).
  const healed = renormaliseIfNeeded(db, NORMALISER_VERSION, normaliseRelease);
  if (healed > 0) logger.info({ healed }, "re-normalised cached releases on startup");
  const bot = createBot(config.telegram.botToken);

  const send = (text: string): Promise<void> =>
    sendChunked(bot.api, config.telegram.chatId, text);
  const runDailyJob = (): Promise<void> => dailyJob({ config, db, send });

  // Telegram listener (long polling). /digest re-runs the job on demand.
  startBot(
    {
      bot,
      chatId: config.telegram.chatId,
      db,
      model: config.anthropic.model,
      releasebotApiKey: config.releasebot.apiKey,
      tier: config.releasebot.tier,
      tz: config.tz,
    },
    runDailyJob,
  );

  // Daily schedule.
  if (!cron.validate(config.digestCron)) {
    throw new Error(`Invalid DIGEST_CRON: ${config.digestCron}`);
  }
  const task = cron.schedule(
    config.digestCron,
    () => {
      logger.info("cron: running daily digest");
      runDailyJob().catch((err) => logger.error({ err }, "scheduled digest failed"));
    },
    { timezone: config.tz },
  );
  logger.info({ cron: config.digestCron, tz: config.tz }, "scheduled daily digest");

  // Graceful shutdown.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    task.stop();
    void bot.stop();
    db.close();
    process.exit(0);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  logger.info(
    { model: config.anthropic.model, digestAiThreshold: config.digestAiThreshold },
    "release-agent is up",
  );
}

main();
