/**
 * The ONLY place that talks to Releasebot. Wrapping the CLI here keeps credit
 * accounting and error handling in one spot (see CLAUDE.md "conserve credits").
 *
 * Credit rule: search is free; release-returning calls cost 1 credit per release
 * (min 1). So `fetchFeedSince` is the one guaranteed daily spend — we always pass
 * `--since` so it returns only *new* releases.
 *
 * The JSON shape of `releasebot feed --json` is confirmed on the first real run;
 * `normaliseRelease` is intentionally defensive and always preserves the full
 * original object in `raw`, so nothing is lost even if a key is named unexpectedly.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { FeedResult, Release } from "./types.js";

const execFileAsync = promisify(execFile);

const CLI_BIN = "releasebot";
const MAX_BUFFER = 16 * 1024 * 1024; // release notes can be large

export type ReleasebotErrorKind =
  | "out_of_credits" // HTTP 402
  | "cli_missing" // binary not installed
  | "bad_output" // couldn't parse JSON
  | "unknown";

export class ReleasebotError extends Error {
  constructor(
    readonly kind: ReleasebotErrorKind,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ReleasebotError";
  }
}

/** Run the CLI with the API key injected via env. Returns raw stdout. */
async function runReleasebot(args: string[], apiKey: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(CLI_BIN, args, {
      env: { ...process.env, RELEASEBOT_API_KEY: apiKey },
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (e.code === "ENOENT") {
      throw new ReleasebotError(
        "cli_missing",
        `Releasebot CLI not found. Install with: npm i -g @releasebot-io/cli`,
      );
    }
    const blob = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (/\b402\b/.test(blob) || /out of credits|insufficient credit/i.test(blob)) {
      throw new ReleasebotError(
        "out_of_credits",
        "Releasebot is out of API credits (402).",
        blob.trim(),
      );
    }
    throw new ReleasebotError(
      "unknown",
      `Releasebot CLI failed: ${e.message}`,
      blob.trim(),
    );
  }
}

// --- defensive JSON helpers ---

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
    if (typeof val === "number") return String(val);
  }
  return null;
}

function toIso(value: string | null): string | null {
  if (value === null) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? value : new Date(t).toISOString();
}

/** Extract the array of release items from whatever wrapper the CLI emits. */
function extractItems(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const obj = asRecord(parsed);
  if (obj) {
    for (const key of ["releases", "items", "data", "results", "feed"]) {
      const candidate = obj[key];
      if (Array.isArray(candidate)) return candidate;
    }
  }
  return [];
}

/** Best-effort remaining-credit reading if the CLI includes it in the payload. */
function extractCredits(parsed: unknown): number | null {
  const obj = asRecord(parsed);
  if (!obj) return null;
  for (const key of ["credits_remaining", "creditsRemaining", "x_credits_remaining"]) {
    const val = obj[key];
    if (typeof val === "number") return val;
    if (typeof val === "string" && val.trim() !== "" && !Number.isNaN(Number(val))) {
      return Number(val);
    }
  }
  return null;
}

/** Map one raw item to a normalised Release, keeping the original in `raw`. */
export function normaliseRelease(item: unknown): Release {
  const obj = asRecord(item) ?? {};
  const vendor = pickString(obj, ["vendor", "vendor_name", "vendorName", "source"]) ?? "unknown";
  const product = pickString(obj, ["product", "product_name", "productName", "slug"]);
  const title = pickString(obj, ["title", "name", "headline"]) ?? "(untitled release)";
  const url = pickString(obj, ["url", "link", "permalink", "html_url"]);
  const publishedAt = toIso(
    pickString(obj, ["published_at", "publishedAt", "date", "published", "released_at"]),
  );
  const discoveredAt = toIso(
    pickString(obj, ["discovered_at", "discoveredAt", "seen_at", "created_at", "indexed_at"]),
  );
  const summary = pickString(obj, ["summary", "description", "body", "content", "notes"]);

  const explicitId = pickString(obj, ["id", "guid", "uuid", "slug"]);
  const id =
    explicitId ??
    url ??
    createHash("sha1")
      .update([vendor, product ?? "", title, publishedAt ?? ""].join("|"))
      .digest("hex")
      .slice(0, 16);

  return { id, vendor, product, title, url, publishedAt, discoveredAt, summary, raw: item };
}

/**
 * Fetch new releases from the user's followed feed since `sinceIso` (null = no
 * lower bound, e.g. the very first run). `limit` caps results as a safety net so
 * a huge backlog can't drain credits in one call.
 */
export async function fetchFeedSince(
  apiKey: string,
  sinceIso: string | null,
  limit?: number,
): Promise<FeedResult> {
  const args = ["feed", "--json"];
  if (sinceIso) args.push("--since", sinceIso);
  if (limit && limit > 0) args.push("--limit", String(limit));

  const stdout = await runReleasebot(args, apiKey);

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new ReleasebotError(
      "bad_output",
      "Could not parse Releasebot feed JSON.",
      stdout.slice(0, 500),
    );
  }

  const releases = extractItems(parsed).map(normaliseRelease);
  return { releases, creditsRemaining: extractCredits(parsed) };
}

/**
 * Credits a feed fetch cost, inferred from release count when the CLI doesn't
 * surface a remaining balance (1 credit per release, minimum 1 per request).
 */
export function inferSpend(releaseCount: number): number {
  return Math.max(1, releaseCount);
}
