/** Shared domain types. */

/**
 * A normalised release, as stored in the cache. `raw` keeps the full original
 * Releasebot JSON so follow-up questions can be answered without another API call
 * even for fields we don't model explicitly.
 *
 * NOTE: the exact shape of `releasebot feed --json` is confirmed on the first real
 * run (see plan open items). The normaliser in `releasebot.ts` is deliberately
 * defensive so an unexpected key never loses data — everything lands in `raw`.
 */
export interface Release {
  /** Stable unique id used as the cache primary key. */
  id: string;
  vendor: string;
  product: string | null;
  title: string;
  url: string | null;
  /** ISO date the release was published by the vendor, if known. */
  publishedAt: string | null;
  /** ISO date Releasebot discovered it (what `--since` filters on), if known. */
  discoveredAt: string | null;
  /** Short summary/body text if the feed provides one. */
  summary: string | null;
  /** The full original object from Releasebot. */
  raw: unknown;
}

/** Result of a feed fetch, including whatever we could learn about credit spend. */
export interface FeedResult {
  releases: Release[];
  /** Remaining credits if the CLI surfaced them, else null (inferred elsewhere). */
  creditsRemaining: number | null;
}

export type ReleasebotTier = "free" | "pro";
