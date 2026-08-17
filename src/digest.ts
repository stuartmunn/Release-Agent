/**
 * The daily job: fetch new releases since the last run, cache them, summarise with
 * Claude, and send to Telegram. This is the one guaranteed Releasebot credit spend, so
 * it's deliberately economical:
 *   - always `--since last_run` so only *new* releases are fetched;
 *   - if nothing is new, we send a one-liner and skip Claude entirely (saves tokens);
 *   - we log the remaining-credit reading and warn when it's low.
 *
 * Runnable directly for manual testing: `npm run digest:now`.
 */
import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import {
  getLastRun,
  logCredits,
  openDb,
  setLastRun,
  upsertReleases,
  type Db,
} from "./cache.js";
import { fetchFeedSince, inferSpend, ReleasebotError } from "./releasebot.js";
import { generateDigest } from "./agent.js";
import { createBot, sendChunked } from "./telegram.js";
import { logger } from "./logger.js";

/** Warn when known remaining credits fall to/below this (free tier is 250/month). */
const LOW_CREDIT_THRESHOLD = 40;
/** Safety cap so a large backlog can't drain credits in a single fetch. */
const FEED_LIMIT = 50;

export interface DailyJobDeps {
  config: Config;
  db: Db;
  /** Sends a message to the owner (chunked). */
  send: (text: string) => Promise<void>;
}

export async function dailyJob({ config, db, send }: DailyJobDeps): Promise<void> {
  const since = getLastRun(db);
  logger.info({ since }, "daily job: fetching feed");

  let result;
  try {
    result = await fetchFeedSince(config.releasebot.apiKey, since, FEED_LIMIT);
  } catch (err) {
    if (err instanceof ReleasebotError) {
      const msg =
        err.kind === "out_of_credits"
          ? "⚠️ Releasebot is out of API credits — no digest today."
          : err.kind === "cli_missing"
            ? "⚠️ Releasebot CLI isn't installed in the container."
            : `⚠️ Couldn't fetch releases: ${err.message}`;
      logger.error({ err: err.kind, detail: err.detail }, "feed fetch failed");
      await send(msg);
      return;
    }
    throw err;
  }

  const { releases, creditsRemaining } = result;
  const inserted = upsertReleases(db, releases);
  const now = new Date().toISOString();

  // The credits were spent on the fetch regardless of whether the digest is delivered,
  // so record the reading now.
  if (creditsRemaining !== null) {
    logCredits(db, creditsRemaining);
  }
  logger.info(
    {
      fetched: releases.length,
      newlyCached: inserted,
      creditsRemaining,
      inferredSpend: creditsRemaining === null ? inferSpend(releases.length) : undefined,
    },
    "daily job: fetched",
  );

  if (releases.length === 0) {
    // Nothing new — don't spend Claude tokens on an empty digest.
    await send(`📦 No new releases as of ${now.slice(0, 10)}. Quiet day.`);
    setLastRun(db, now);
    return;
  }

  const digest = await generateDigest(config.anthropic.model, releases);
  await send(digest);
  // Advance last_run only after a successful send. If generateDigest or send throws,
  // last_run is untouched so the next run retries these releases rather than skipping
  // them permanently. (Re-fetch may re-spend credits, but the daily digest is the point.)
  setLastRun(db, now);

  if (creditsRemaining !== null && creditsRemaining <= LOW_CREDIT_THRESHOLD) {
    await send(
      `⚠️ Heads up: only ${creditsRemaining} Releasebot credits left this month` +
        `${config.releasebot.tier === "free" ? " (free tier: 250/mo)" : ""}.`,
    );
  }
}

/** Manual one-shot entrypoint: `npm run digest:now`. Sends via the bot API, no polling. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const bot = createBot(config.telegram.botToken);
  try {
    await dailyJob({
      config,
      db,
      send: (text) => sendChunked(bot.api, config.telegram.chatId, text),
    });
  } finally {
    db.close();
  }
}

// Run only when invoked directly with --now (not when imported).
if (process.argv.includes("--now")) {
  main().then(
    () => process.exit(0),
    (err) => {
      logger.error({ err }, "digest:now failed");
      process.exit(1);
    },
  );
}
