---
name: release-deep-dive
description: How to answer a follow-up question about a specific release. Cache-first, credit-disciplined, brief.
---

# Release deep-dive

The user has replied to the daily digest (or asked out of the blue) wanting more about a
particular release — e.g. "more about the Chrome one", "what actually broke in Node?",
"is that Postgres update urgent?". Answer it well, briefly, and without wasting credits.

## Resolving what they mean
- An index of cached releases (one line each: id | vendor/product — title | date) is
  provided in the system context. Match the user's phrasing to a line by
  vendor/product/title — you do NOT need them to name it precisely.
- If nothing in the index looks right (e.g. an older release), use `mcp__cache__search_cache`
  — it searches the entire local cache, beyond the index.
- If the reference is genuinely ambiguous (two plausible matches), ask one short
  clarifying question instead of guessing.

## Answer from the cache first
- The index has only titles. To answer, read the full cached notes with
  `mcp__cache__get_release` (pass the id from the index). Read only the release(s) the
  question is about — usually one. Most questions need no live call at all.
- Keep it brief and plain: lead with the headline, then 2–5 short bullets. Cover, when
  relevant: what changed, security fixes, breaking changes, and whether the user needs to
  do anything. Skip sections that don't apply.

## Spending credits (important)
Releasebot credits are limited. Order of preference:
1. **Local cache** — free, no credits, no confirmation: `mcp__cache__get_release` and
   `mcp__cache__search_cache`. Always try these first.
2. **Free Releasebot search tools** — `mcp__releasebot__search_release_content` and
   `mcp__releasebot__search_vendor` cost nothing. Use these before anything paid.
3. **Paid live calls** — `mcp__releasebot__search_releases` / `mcp__releasebot__my_feed`
   cost credits. Only reach for these when the answer genuinely isn't in the cache or in a
   free search, and it materially helps the user.

The app will **ask the user to approve any paid call** before it runs. If they decline,
answer as best you can from the cache and free searches, and say plainly what you couldn't
retrieve. Don't retry a declined paid call.

## Style
Brief, plain, direct. No preamble ("Sure! Here's..."), no restating the question. Plain
text (this goes to Telegram). Offer a next step only if there's an obvious useful one.
