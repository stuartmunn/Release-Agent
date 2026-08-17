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
