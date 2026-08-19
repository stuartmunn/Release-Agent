/**
 * Local SQLite cache — the source of truth for follow-up questions.
 *
 * The daily feed is paid for once, cached in full here, and follow-ups read from
 * this store (0 credits). Four tables:
 *   - releases    : one row per release, keyed by id; `raw_json` holds the full payload.
 *   - meta        : key/value scratch (e.g. `last_run` timestamp).
 *   - credit_log  : running record of remaining Releasebot credits over time.
 *   - cost_log    : one row per Claude call, so Anthropic spend survives container
 *                   restarts (unlike `docker logs`, which resets with the process).
 *
 * better-sqlite3 is synchronous, which keeps this code simple and race-free for a
 * single-process app.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Release } from "./types.js";

export type Db = Database.Database;

/** Open (creating if needed) the database at `dbPath` and ensure the schema exists. */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  // Run all schema steps in one transaction so the database is never left half-migrated.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id            TEXT PRIMARY KEY,
        vendor        TEXT NOT NULL,
        product       TEXT,
        title         TEXT NOT NULL,
        url           TEXT,
        published_at  TEXT,
        discovered_at TEXT,
        summary       TEXT,
        content       TEXT,
        raw_json      TEXT NOT NULL,
        fetched_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_releases_vendor ON releases (vendor);
      CREATE INDEX IF NOT EXISTS idx_releases_discovered ON releases (discovered_at);

      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS credit_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        TEXT NOT NULL,
        remaining INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cost_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        kind     TEXT NOT NULL,
        cost_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cost_log_ts ON cost_log (ts);
    `);

    // Add columns introduced after the first release, for databases created earlier.
    const cols = new Set(
      (db.prepare(`PRAGMA table_info(releases)`).all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has("content")) {
      db.exec(`ALTER TABLE releases ADD COLUMN content TEXT`);
    }
  })();
}

/**
 * Insert or update releases by id (idempotent — re-running the daily job never
 * duplicates rows). Returns the number of rows that were newly inserted.
 */
export function upsertReleases(db: Db, releases: Release[]): number {
  const now = new Date().toISOString();
  const existing = db.prepare(`SELECT 1 FROM releases WHERE id = ?`);
  const stmt = db.prepare(`
    INSERT INTO releases
      (id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json, fetched_at)
    VALUES
      (@id, @vendor, @product, @title, @url, @publishedAt, @discoveredAt, @summary, @content, @rawJson, @fetchedAt)
    ON CONFLICT(id) DO UPDATE SET
      vendor        = excluded.vendor,
      product       = excluded.product,
      title         = excluded.title,
      url           = excluded.url,
      published_at  = excluded.published_at,
      discovered_at = excluded.discovered_at,
      summary       = excluded.summary,
      content       = excluded.content,
      raw_json      = excluded.raw_json
  `);

  const insertMany = db.transaction((rows: Release[]) => {
    // De-duplicate by id first (keep the last occurrence — freshest in a batch), so
    // the "newly inserted" count is provably the number of genuinely new ids and we
    // don't write the same row twice.
    const byId = new Map<string, Release>();
    for (const r of rows) byId.set(r.id, r);

    let inserted = 0;
    for (const r of byId.values()) {
      const isNew = existing.get(r.id) === undefined;
      if (isNew) inserted += 1;
      stmt.run({
        id: r.id,
        vendor: r.vendor,
        product: r.product,
        title: r.title,
        url: r.url,
        publishedAt: r.publishedAt,
        discoveredAt: r.discoveredAt,
        summary: r.summary,
        content: r.content,
        rawJson: JSON.stringify(r.raw),
        fetchedAt: now,
      });
    }
    return inserted;
  });

  return insertMany(releases);
}

interface ReleaseRow {
  id: string;
  vendor: string;
  product: string | null;
  title: string;
  url: string | null;
  published_at: string | null;
  discovered_at: string | null;
  summary: string | null;
  content: string | null;
  raw_json: string;
}

function rowToRelease(row: ReleaseRow): Release {
  return {
    id: row.id,
    vendor: row.vendor,
    product: row.product,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    discoveredAt: row.discovered_at,
    summary: row.summary,
    content: row.content,
    raw: JSON.parse(row.raw_json),
  };
}

/** All cached releases, newest discovered first. */
export function getAllReleases(db: Db): Release[] {
  const rows = db
    .prepare(
      `SELECT id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json
       FROM releases
       ORDER BY COALESCE(discovered_at, published_at, fetched_at) DESC`,
    )
    .all() as ReleaseRow[];
  return rows.map(rowToRelease);
}

/**
 * The `limit` newest releases — used to build the follow-up agent's compact index, so
 * the prompt stays bounded no matter how big the cache grows. Older rows remain
 * reachable via `searchReleases`.
 */
export function getRecentReleases(db: Db, limit: number): Release[] {
  const rows = db
    .prepare(
      `SELECT id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json
       FROM releases
       ORDER BY COALESCE(discovered_at, published_at, fetched_at) DESC
       LIMIT ?`,
    )
    .all(limit) as ReleaseRow[];
  return rows.map(rowToRelease);
}

/** One release by its exact id, or null if not cached. */
export function getReleaseById(db: Db, id: string): Release | null {
  const row = db
    .prepare(
      `SELECT id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json
       FROM releases
       WHERE id = ?`,
    )
    .get(id) as ReleaseRow | undefined;
  return row ? rowToRelease(row) : null;
}

/**
 * Case-insensitive substring search over vendor/product/title/summary/content — free,
 * local, and reaches the whole cache (including rows too old for the index). The query
 * is LIKE-escaped so user text can't inject wildcards.
 */
export function searchReleases(db: Db, query: string, limit: number): Release[] {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  const pattern = `%${escaped}%`;
  const rows = db
    .prepare(
      `SELECT id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json
       FROM releases
       WHERE vendor  LIKE ? ESCAPE '\\'
          OR product LIKE ? ESCAPE '\\'
          OR title   LIKE ? ESCAPE '\\'
          OR summary LIKE ? ESCAPE '\\'
          OR content LIKE ? ESCAPE '\\'
       ORDER BY COALESCE(discovered_at, published_at, fetched_at) DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, pattern, limit) as ReleaseRow[];
  return rows.map(rowToRelease);
}

/** Releases discovered on/after `sinceIso` (used to build "today's" digest). */
export function getReleasesSince(db: Db, sinceIso: string): Release[] {
  const rows = db
    .prepare(
      `SELECT id, vendor, product, title, url, published_at, discovered_at, summary, content, raw_json
       FROM releases
       WHERE COALESCE(discovered_at, published_at, fetched_at) >= ?
       ORDER BY COALESCE(discovered_at, published_at, fetched_at) DESC`,
    )
    .all(sinceIso) as ReleaseRow[];
  return rows.map(rowToRelease);
}

// --- meta (key/value) ---

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** ISO timestamp of the last successful feed fetch, or null if never run. */
export function getLastRun(db: Db): string | null {
  return getMeta(db, "last_run");
}

export function setLastRun(db: Db, iso: string): void {
  setMeta(db, "last_run", iso);
}

// --- credit log ---

export function logCredits(db: Db, remaining: number): void {
  db.prepare(`INSERT INTO credit_log (ts, remaining) VALUES (?, ?)`).run(
    new Date().toISOString(),
    remaining,
  );
}

/**
 * Re-normalise every cached release from its stored `raw_json` when the normaliser has
 * changed since we last recorded it. Free (no API calls) — the raw payloads are already
 * cached — so improving `normaliseRelease` retroactively fixes existing rows on next boot.
 * Returns the number of rows re-normalised (0 if already up to date).
 */
export function renormaliseIfNeeded(
  db: Db,
  version: number,
  normalise: (raw: unknown) => Release,
): number {
  const key = "normaliser_version";
  if (getMeta(db, key) === String(version)) return 0;

  const rows = db.prepare(`SELECT raw_json FROM releases`).all() as { raw_json: string }[];
  const releases = rows.map((r) => normalise(JSON.parse(r.raw_json)));
  // Atomic: either every row is re-normalised and the version is stamped, or nothing
  // changes (so a failure mid-way retries cleanly on next boot rather than leaving a
  // partial mix of old/new rows). Nested inside upsertReleases' own transaction via a
  // savepoint, which better-sqlite3 handles.
  db.transaction(() => {
    if (releases.length > 0) upsertReleases(db, releases);
    setMeta(db, key, String(version));
  })();
  return releases.length;
}

/** Most recently recorded remaining-credit reading, or null if none logged. */
export function getLatestCredits(db: Db): number | null {
  const row = db
    .prepare(`SELECT remaining FROM credit_log ORDER BY id DESC LIMIT 1`)
    .get() as { remaining: number } | undefined;
  return row?.remaining ?? null;
}

// --- cost log ---

/** Record one Claude call's cost so spend survives container restarts. */
export function logCost(db: Db, kind: "digest" | "answer", costUsd: number): void {
  db.prepare(`INSERT INTO cost_log (ts, kind, cost_usd) VALUES (?, ?, ?)`).run(
    new Date().toISOString(),
    kind,
    costUsd,
  );
}

/**
 * Local calendar Y-M-D for `instant` in `tz` (e.g. "2026-08-19"), using the same IANA
 * timezone the digest cron runs in — so "today"/"this month" mean the user's actual day,
 * not a UTC one that can be off by up to an hour either side of midnight.
 */
function localDateParts(instant: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

/** How far `tz`'s local wall clock is ahead of UTC at `instantMs`, in milliseconds. */
function tzOffsetMs(instantMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instantMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instantMs;
}

/**
 * The UTC instant (as an ISO string) at which local midnight starts, for a given local
 * Y-M-D in `tz`. Computes the timezone's actual offset at that moment rather than
 * assuming a fixed one — correct across DST transitions (BST/GMT included).
 *
 * The offset is read at the *candidate* instant and re-checked once: a single pass would
 * use the offset at the naive UTC guess, which is only right for zones whose DST
 * transition doesn't land within a day of local midnight (true for Europe/London, whose
 * clocks change at 1am — but not guaranteed for every IANA zone `config.tz` could name).
 * Iterating to a fixed point makes this correct generally, not just for our default zone.
 */
function localMidnightIso(year: number, month: number, day: number, tz: string): string {
  const targetAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  let candidate = targetAsUtc - tzOffsetMs(targetAsUtc, tz);
  // One re-check against the candidate's own offset converges except in the (real-world
  // nonexistent) case of a DST shift larger than a day, so two passes suffice.
  candidate = targetAsUtc - tzOffsetMs(candidate, tz);
  return new Date(candidate).toISOString();
}

/** Sum of `cost_usd` for rows with `ts` in `[startIso, endIso)` (end optional = open). */
function sumCost(db: Db, startIso: string, endIso?: string): number {
  const row = endIso
    ? (db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE ts >= ? AND ts < ?`)
        .get(startIso, endIso) as { total: number })
    : (db
        .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_log WHERE ts >= ?`)
        .get(startIso) as { total: number });
  return row.total;
}

/** Anthropic spend so far today, this calendar month, and last calendar month, in `tz`. */
export function getCostSummary(
  db: Db,
  tz: string,
): { today: number; thisMonth: number; lastMonth: number } {
  const now = localDateParts(new Date(), tz);
  const todayStart = localMidnightIso(now.year, now.month, now.day, tz);
  const monthStart = localMidnightIso(now.year, now.month, 1, tz);

  const lastMonthDate = new Date(Date.UTC(now.year, now.month - 1, 1));
  lastMonthDate.setUTCMonth(lastMonthDate.getUTCMonth() - 1);
  const lastMonthStart = localMidnightIso(
    lastMonthDate.getUTCFullYear(),
    lastMonthDate.getUTCMonth() + 1,
    1,
    tz,
  );

  return {
    today: sumCost(db, todayStart),
    thisMonth: sumCost(db, monthStart),
    lastMonth: sumCost(db, lastMonthStart, monthStart),
  };
}
