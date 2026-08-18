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
import type { Release } from "./types.js";
import { loadConfig } from "./config.js";
import {
  getAllReleases,
  getLastRun,
  logCredits,
  openDb,
  renormaliseIfNeeded,
  setLastRun,
  upsertReleases,
  type Db,
} from "./cache.js";
import {
  fetchFeedSince,
  inferSpend,
  NORMALISER_VERSION,
  normaliseRelease,
  ReleasebotError,
} from "./releasebot.js";
import { generateDigest } from "./agent.js";
import { createBot, sendChunked } from "./telegram.js";
import { logger } from "./logger.js";

/** Warn when known remaining credits fall to/below this (free tier is 250/month). */
const LOW_CREDIT_THRESHOLD = 40;
/** Safety cap so a large backlog can't drain credits in a single fetch. */
const FEED_LIMIT = 50;

/**
 * Plain-text digest used when Claude can't produce the summary (model error, etc.), so the
 * daily job always delivers something. Mirrors the daily-digest skill's plain-text rules.
 */
function fallbackDigest(releases: Release[], nowIso: string): string {
  const lines = releases.map(
    (r) => `• ${r.vendor}${r.product ? ` / ${r.product}` : ""} — ${r.title}`,
  );
  return (
    `📦 ${releases.length} new release(s) for ${nowIso.slice(0, 10)} ` +
    `(couldn't generate the summary — raw list):\n\n${lines.join("\n")}\n\n` +
    `Reply to dig into any of these.`
  );
}

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

  // Generate the summary, but never let a generation hiccup swallow the whole digest:
  // the releases are already fetched (and paid for), so on failure we still deliver a
  // plain list rather than leaving the user in silence.
  let digest: string;
  try {
    digest = await generateDigest(config.anthropic.model, releases);
  } catch (err) {
    logger.error({ err }, "digest generation failed; sending plain fallback list");
    digest = fallbackDigest(releases, now);
  }
  await send(digest);
  // Advance last_run only after a successful send. If send throws, last_run is untouched
  // so the next run retries these releases rather than skipping them permanently.
  // (Re-fetch may re-spend credits, but the daily digest is the point.)
  setLastRun(db, now);

  if (creditsRemaining !== null && creditsRemaining <= LOW_CREDIT_THRESHOLD) {
    await send(
      `⚠️ Heads up: only ${creditsRemaining} Releasebot credits left this month` +
        `${config.releasebot.tier === "free" ? " (free tier: 250/mo)" : ""}.`,
    );
  }
}

/** Max releases to include when re-summarising the cache (bounds tokens). */
const REDIGEST_LIMIT = 50;

/**
 * Re-summarise what's already cached and send it, WITHOUT fetching (0 credits). Useful
 * after a normaliser fix or to re-read today's digest. Run with `--redigest`.
 */
export async function redigest({ config, db, send }: DailyJobDeps): Promise<void> {
  const releases = getAllReleases(db).slice(0, REDIGEST_LIMIT);
  if (releases.length === 0) {
    await send("Nothing cached yet — run a digest first.");
    return;
  }
  logger.info({ count: releases.length }, "redigest: summarising cached releases");
  await send(await generateDigest(config.anthropic.model, releases));
}

/** Manual one-shot entrypoint. `--now` fetches + digests; `--redigest` re-summarises cache. */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  // Heal any stale-normalised rows for free before doing anything else.
  const healed = renormaliseIfNeeded(db, NORMALISER_VERSION, normaliseRelease);
  if (healed > 0) logger.info({ healed }, "re-normalised cached releases");

  const bot = createBot(config.telegram.botToken);
  const send = (text: string): Promise<void> =>
    sendChunked(bot.api, config.telegram.chatId, text);
  try {
    if (process.argv.includes("--redigest")) {
      await redigest({ config, db, send });
    } else {
      await dailyJob({ config, db, send });
    }
  } finally {
    db.close();
  }
}

// Run only when invoked directly with a flag (not when imported).
if (process.argv.includes("--now") || process.argv.includes("--redigest")) {
  main().then(
    () => process.exit(0),
    (err) => {
      logger.error({ err }, "digest run failed");
      process.exit(1);
    },
  );
}
