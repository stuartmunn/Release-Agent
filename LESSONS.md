# Lessons from PR Agent

A running log of feedback from the PR Agent that reviews pushes to this repo.
**Read this before writing any code** and apply the rules so we don't repeat mistakes.

When PR Agent flags something, add an entry below in this format:

```
## <short title>  (PR #<n>, <date>)
- **Flagged:** what the PR Agent objected to.
- **Rule:** the thing to do (or avoid) next time.
```

---

## Cache/id uniqueness in the Releasebot normaliser  (PR #2, 2026-08-17)
- **Flagged:** `normaliseRelease` used `url` directly as the release id, and included
  `slug` among id candidates. A changelog URL shared across versions, or a repeated slug
  (e.g. `"chrome"`), would collide and silently overwrite rows via `ON CONFLICT DO UPDATE`.
- **Rule:** an id fallback must be **unique per release**. Never key on a value that can
  legitimately repeat (shared URL, vendor/product slug). When there's no explicit unique
  id, hash the distinguishing fields together (vendor + product + title + date + url).

## Provable counts over transaction-visibility assumptions  (PR #2, 2026-08-17)
- **Flagged:** `upsertReleases` counted "new" rows via a pre-insert existence check that
  could double-count if the same id appeared twice in one batch.
- **Rule:** when a batch may contain duplicate keys, **de-duplicate the input first**
  (Map by id, keep last) so counts are provably correct and rows aren't written twice —
  don't rely on in-transaction read visibility to get the count right.

## Order log tables by a monotonic key, not a timestamp string  (PR #2, 2026-08-17)
- **Flagged:** `credit_log` ordered by an ISO-text `ts`; same-millisecond writes tie and
  a non-ISO value would sort wrong lexicographically.
- **Rule:** give append-only/log tables an `INTEGER PRIMARY KEY AUTOINCREMENT` and order
  by it for "latest" queries — robust regardless of timestamp format or write frequency.

## Spawned-subprocess env must extend, not replace, process.env  (PR #3, 2026-08-17)
- **Flagged:** the Releasebot MCP stdio config passed `env: { RELEASEBOT_API_KEY }`, which
  replaces the child's whole environment — `npx` would lose `PATH` and fail to launch.
- **Rule:** when setting `env` for a spawned process, spread the current environment in
  first and set your extra vars last (so they win). Never hand a child a bare env.

## Validate any path component built from a name — even if only called with literals  (PR #3, 2026-08-17)
- **Flagged:** `readSkill(name)` joined `name` into a path with no check; an exported fn
  called with `../../…` would read arbitrary files.
- **Rule:** whitelist slug-like inputs (`/^[a-z0-9][a-z0-9-]*$/`) before using them in a
  filesystem path. Exported functions are reachable by future callers — harden at the fn.

## Enforce security invariants in code, and neutralise injected "transcript" text  (PR #3, 2026-08-17)
- **Flagged:** conversation history concatenated as `role: text` let a user inject a fake
  `assistant:` turn (e.g. "I already approved the paid fetch").
- **Rule:** (1) keep hard invariants (the paid-call gate) enforced in code via the SDK
  `canUseTool` callback, never in the prompt; (2) when embedding user text as history,
  collapse newlines, label it context-only, and delimit turns so injected role lines
  can't masquerade as real ones.

## Advance a progress marker only after the work it gates succeeds  (PR #4, 2026-08-17)
- **Flagged:** `dailyJob` called `setLastRun` right after fetching, before the digest was
  generated/sent. A Claude or Telegram failure would leave `last_run` advanced, so those
  releases would never be summarised on a later run.
- **Rule:** persist a "done up to here" marker (`last_run`, offsets, cursors) **after** the
  side effect it represents has succeeded — so a transient failure retries rather than
  silently skipping. Accept the small cost of re-doing idempotent work on retry.

## Don't hard-depend on a devDependency at runtime (pino-pretty)  (live run, 2026-08-17)
- **Found:** the runtime image prunes devDependencies, but the logger loaded the
  `pino-pretty` transport whenever stdout was a TTY. `docker compose up -d` (no TTY) was
  fine, but `docker compose exec` **allocates a TTY**, so the one-shot crashed with
  "unable to determine transport target for pino-pretty".
- **Rule:** anything only present in dev (pretty printers, test helpers) must be optional
  at runtime — guard with `require.resolve(...)` (via `createRequire` in ESM) and fall
  back, and/or wrap construction in try/catch. Never let a pruned module be on a hot path.
- **Also:** behaviour that keys off `process.stdout.isTTY` differs between a detached
  container and `exec` — test both. `docker compose exec -T` (no TTY) is a quick workaround.

## Clean up timers and parked async state in `finally`, not just the happy path  (PR #4, 2026-08-17)
- **Flagged:** the paid-call confirmation parked a `setTimeout`; if `answerQuestion` threw
  before the user replied, the timer was never cleared and would later fire on a stale
  context.
- **Rule:** any `setTimeout`/pending promise/lock created in a handler must be released in
  a `finally` (or equivalent), covering the throw path — not only when things go right.
- **TS note:** an early-return truthy guard narrows a nullable field to `null` for the rest
  of the scope, so a later `if (x)` sees `never`. Move the cleanup into a helper that takes
  the owning object as a parameter to get the full declared type back.

## Confirm real payload shapes on first live data; make normalisers self-healing  (live run, 2026-08-17)
- **Found:** the `feed --json` shape was nested (`vendor.name`, `product.name`,
  `releaseDetails.release_name/release_summary`, `formattedContent`), not the flat keys the
  normaliser guessed — so every release came through as `unknown` with no notes. The digest
  ran end-to-end but was useless.
- **Rule:** (1) don't ship a parser built on guessed field names — verify against real data
  as soon as it's available (the cached `raw_json` let us do this for **zero** API credits).
  (2) Always keep the full raw payload so you can re-derive fields later. (3) Version the
  normaliser and re-normalise cached rows from `raw_json` on boot when it changes — fixes
  existing data for free instead of re-fetching (which would re-spend credits).
- **Also:** cache the *full* notes (`formattedContent`), not just the short summary, so
  follow-ups are genuinely answerable from cache without a paid live call.

## A tool-free SDK query needs three things, not one — the digest kept hitting error_max_turns  (live run, 2026-08-18/19)
- **Found (in layers):** `generateDigest` was meant to be a tool-free text gen but repeatedly
  failed with `error_max_turns`. Three distinct causes, each uncovered only after fixing the
  previous:
  1. `allowedTools: []` does **not** mean "no tools" — the SDK treats an empty allowlist as
     "no filter", so every built-in stayed on offer and the model called `WebFetch` on the
     URLs in the notes.
  2. `disallowedTools` blocks a tool from **executing**, but **not from being attempted** —
     each denied attempt still costs a turn. So a *low* `maxTurns` doesn't "fail fast", it
     fails *needlessly*: the model needs a couple of turns to recover from its own attempt.
  3. The prompt was **advertising a tool**: `DIGEST_SYSTEM` said "Follow the daily-digest
     **skill**" and the content was injected under `# Skill: …` headers, so the model reached
     for the built-in `Skill` tool (~40% of runs, nondeterministic).
- **Rule — to run genuinely tool-free, do all three:** (1) block execution with
  **`disallowedTools`** listing the built-ins (never rely on empty `allowedTools`); (2) keep
  the prompt free of anything that *names/invites* a tool — inject skill files under neutral
  headers and don't say "skill" (see `instructionBlock`); (3) leave **turn headroom**
  (`maxTurns` 6, not 2) so a rare stray attempt recovers instead of failing. Verified 14/14
  after the prompt reword (was ~40% failing).
- **Also:** a user-facing job that can still fail (model/network) must degrade, not vanish —
  `dailyJob` sends a plain fallback list if generation throws, so silence never happens.
- **Debugging note:** reproduce for **zero Releasebot credits** from the cached rows (a
  throwaway probe importing `dist/` + the SDK). Log each streamed message's `type` and
  tool-use block names, and **run it several times** — this bug was nondeterministic, so a
  single passing probe (my first mistake) proves nothing; loop 5–8×.

## Make schema migrations and bulk re-derivations atomic  (PR #7, 2026-08-17)
- **Flagged:** `migrate()` split its DDL across two `db.exec` calls (a crash between them
  could leave a half-built schema), and `renormaliseIfNeeded` re-wrote all rows then
  stamped the version without a transaction (a mid-way throw could leave a mix of
  old/new rows).
- **Rule:** wrap any multi-statement migration and any bulk re-derivation of stored data
  in a single `db.transaction(...)` so it fully succeeds or fully rolls back. Stamp the
  "done" marker inside the same transaction. (`CREATE ... IF NOT EXISTS` is idempotent, but
  atomicity is clearer and safer than relying on next-boot self-repair.)
