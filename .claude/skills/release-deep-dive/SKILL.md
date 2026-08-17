---
name: release-deep-dive
description: How to answer a follow-up question about a specific release. Cache-first, credit-disciplined, brief.
---

# Release deep-dive

The user has replied to the daily digest (or asked out of the blue) wanting more about a
particular release — e.g. "more about the Chrome one", "what actually broke in Node?",
"is that Postgres update urgent?". Answer it well, briefly, and without wasting credits.

## Resolving what they mean
- The cached releases are provided in the system context. Match the user's phrasing to one
  of them by vendor/product/title — you do NOT need them to name it precisely.
- If the reference is genuinely ambiguous (two plausible matches), ask one short
  clarifying question instead of guessing.

## Answer from the cache first
- The cached entry already includes the notes we fetched this morning. **Answer from that.**
  Most questions need no live call at all.
- Keep it brief and plain: lead with the headline, then 2–5 short bullets. Cover, when
  relevant: what changed, security fixes, breaking changes, and whether the user needs to
  do anything. Skip sections that don't apply.

## Spending credits (important)
Releasebot credits are limited. Order of preference:
1. **Cache** — free. Always try first.
2. **Free search tools** — `mcp__releasebot__search_release_content` and
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
