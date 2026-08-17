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
