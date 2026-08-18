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

interface CliResult {
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI with the API key injected via env. Returns both streams: stdout carries
 * the JSON payload, and stderr is where the CLI echoes diagnostics — including the
 * `X-Credits-Remaining` response header, which is how we learn the remaining balance
 * (the feed JSON body doesn't carry it). See `parseCreditsRemaining`.
 */
async function runReleasebot(args: string[], apiKey: string): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(CLI_BIN, args, {
      env: { ...process.env, RELEASEBOT_API_KEY: apiKey },
      maxBuffer: MAX_BUFFER,
    });
    return { stdout, stderr: stderr ?? "" };
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

/**
 * Releasebot reports the remaining balance in the `X-Credits-Remaining` HTTP *header*,
 * not the JSON body, so it surfaces on the CLI's stderr diagnostics rather than in the
 * parsed feed. Scan text for it, most-specific pattern first. Scanned against stderr
 * only (never release-note prose in stdout) so changelog text like "5 credits remaining"
 * can't be mistaken for a balance. Returns null when nothing credit-shaped is present —
 * behaviour then matches the pre-fix code exactly (no reading logged, no regression).
 */
export function parseCreditsRemaining(text: string): number | null {
  if (!text) return null;
  // Header form first (the reliable source); the textual variants are bounded hedges in
  // case the CLI prints the balance as prose rather than echoing the raw header. `\d+`
  // never captures a sign, so no non-negativity check is needed (credits floor at 0
  // anyway — an exhausted account 402s rather than going negative).
  const patterns = [
    /x-credits-remaining["']?\s*[:=]\s*(\d+)/i,
    /\bcredits[-\s]?remaining["']?\s*[:=]\s*(\d+)/i,
    /\bremaining\s+credits?["']?\s*[:=]?\s*(\d+)/i,
    /\b(\d+)\s+credits?\s+remaining\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/**
 * Bumped whenever `normaliseRelease` changes how it maps fields. The cache re-normalises
 * its stored raw payloads (for free) when this differs from what it last recorded.
 */
export const NORMALISER_VERSION = 2;

/** A vendor/product may be a nested object ({name,slug}) or a plain string. */
function pickName(v: unknown): string | null {
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  const o = asRecord(v);
  return o ? pickString(o, ["name", "slug", "title"]) : null;
}

/**
 * Map one raw feed item to a normalised Release, keeping the original in `raw`.
 *
 * Grounded in the real `releasebot feed --json` shape (confirmed from live data):
 *   { id, slug, releaseDate, createdAt,
 *     releaseDetails: { release_name, release_number, release_summary, release_deep_source },
 *     formattedContent, vendor: {name}, product: {name}, source: {url} }
 * Flat fallbacks are kept so the parser degrades gracefully if the shape shifts.
 */
export function normaliseRelease(item: unknown): Release {
  const obj = asRecord(item) ?? {};
  const details = asRecord(obj["releaseDetails"]) ?? {};
  const source = asRecord(obj["source"]);

  const vendor = pickName(obj["vendor"]) ?? "unknown";
  const product = pickName(obj["product"]);
  const title =
    pickString(details, ["release_name", "release_number"]) ??
    pickString(obj, ["title", "name", "headline", "slug"]) ??
    "(untitled release)";
  const url =
    (source && pickString(source, ["url"])) ??
    pickString(details, ["release_deep_source"]) ??
    pickString(obj, ["url", "link", "permalink", "html_url"]);
  const publishedAt = toIso(
    pickString(obj, ["releaseDate", "published_at", "publishedAt", "date", "released_at"]),
  );
  const discoveredAt = toIso(
    pickString(obj, ["createdAt", "discovered_at", "discoveredAt", "seen_at", "created_at"]),
  );
  const summary = pickString(details, ["release_summary"]) ?? pickString(obj, ["summary", "description", "notes"]);
  const content = pickString(obj, ["formattedContent", "body", "content"]);

  // Prefer a genuinely unique explicit id (the feed's numeric id). When absent, hash the
  // distinguishing fields — never key on a value that can legitimately repeat.
  const explicitId = pickString(obj, ["id", "guid", "uuid"]);
  const id =
    explicitId ??
    createHash("sha1")
      .update([vendor, product ?? "", title, publishedAt ?? "", url ?? ""].join("|"))
      .digest("hex")
      .slice(0, 16);

  return { id, vendor, product, title, url, publishedAt, discoveredAt, summary, content, raw: item };
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

  const { stdout, stderr } = await runReleasebot(args, apiKey);

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
  // Prefer a balance in the JSON body if a future CLI version adds one; otherwise read
  // the `X-Credits-Remaining` header the CLI echoes on stderr.
  const creditsRemaining = extractCredits(parsed) ?? parseCreditsRemaining(stderr);
  return { releases, creditsRemaining };
}

/**
 * Credits a feed fetch cost, inferred from release count when the CLI doesn't
 * surface a remaining balance (1 credit per release, minimum 1 per request).
 */
export function inferSpend(releaseCount: number): number {
  return Math.max(1, releaseCount);
}
