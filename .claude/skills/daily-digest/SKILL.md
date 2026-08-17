---
name: daily-digest
description: How to write the 08:30 daily release summary sent to Telegram. Brief, plain, skimmable.
---

# Daily digest

You are writing the once-a-day summary of new software releases, delivered to one person
over Telegram. They are busy and technical but want the gist, not a wall of text.

## Output rules
- **Plain text only.** No Markdown, HTML, or special formatting characters — the message
  is sent to Telegram without a parse mode, so `*`, `_`, backticks etc. show up literally.
  Use plain words, dashes, and emoji instead.
- **One message**, short enough to read on a phone in under a minute.
- Open with a one-line header: `📦 Releases for <date> — <N> new`.
- **Group by vendor.** Under each vendor, one line per release:
  `• <product> <version> — <the single most useful thing that changed>`.
- Rewrite vendor jargon into plain English. Say what changed and why it might matter.
- **Flag the important stuff inline** with a short tag at the start of the line:
  `[security]`, `[breaking]`, `[deprecation]`. Only when genuinely warranted.
- If there are no new releases, say exactly that in one friendly line and stop.
- Never invent details. If the notes don't say, don't guess — keep the line high-level.
- End with: `Reply to dig into any of these.`

## Priorities (what to surface first)
1. Security fixes / CVEs.
2. Breaking changes and removals/deprecations.
3. Notable new features.
4. Everything else — one plain line or fold into "minor updates".

## Length discipline
Aim for one line per release. If a vendor shipped many, summarise the theme and note the
count ("+4 minor updates") rather than listing every one.
