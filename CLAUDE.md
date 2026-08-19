# Releasebot → Telegram Digest

A self-contained Dockerised Node/TypeScript app that summarises the user's Releasebot
followed-vendor feed **to Telegram** once a day (08:30), then answers follow-up questions
using the Claude Agent SDK with project skills. **Telegram is the only channel** — the
daily digest is sent there and all questions come back through the same chat. No email.

## What it does
1. **08:30 daily** (node-cron): pull *new* releases from Releasebot, cache them, generate
   a high-level summary with Claude, send it to Telegram.
2. **All day** (Telegram long-poll): you ask in plain English — "more about the Chrome
   release", "what changed in Node?", anything — and it answers. It figures out which
   release you mean and pulls from its local cache automatically; you never have to
   mention the cache or phrase things a special way. It only queries Releasebot live when
   the answer genuinely isn't already cached.

## Working on this repo (read first)
- **Before writing any code, read [`LESSONS.md`](./LESSONS.md)** — a running log of PR Agent
  feedback. Apply those rules up-front. After PR Agent flags something new, append the lesson.
- **Always branch.** Never commit to `main`. Name branches `feat/…`, `fix/…`, `chore/…`,
  push, open a PR, let PR Agent review, then merge.
- **Update [`CHANGELOG.md`](./CHANGELOG.md) in every PR** — a short section (newest first)
  saying what changed and *why* (the problem it solves), not just a list of edits.
- Remote: `https://github.com/stuartmunn/Release-Agent.git`.

## Voice (how the app talks to the user)
Brief, plain, to the point. Rewrite release notes into something readable at a glance —
plain words over vendor jargon, no filler. Lead with what changed and why it matters;
offer depth only when asked.

## Golden rule: conserve Releasebot credits
Free tier = **250 credits/month**, shared by API/MCP/CLI. **Search is free; other calls
cost 1 credit per release returned (min 1).** Therefore:
- Pay **once** per day: `releasebot feed --json --since <last_run>` (only new releases).
- **Cache the full JSON** and answer follow-ups from cache (0 credits).
- Follow-ups may use the Releasebot MCP **only** when the fact isn't cached; prefer the
  **free** `search_release_content` over paid release fetches.
- Watch `X-Credits-Remaining` (logged each run); warn in Telegram when low.
- **Never** call `all` or unbounded `feed` without `--since`/`--limit`.

## Architecture
One long-running container: `node-cron` for the daily job + `grammy` Telegram long-poll,
sharing a `better-sqlite3` cache in the `/data` volume. See `src/` modules:
`releasebot.ts` (CLI wrapper), `cache.ts`, `digest.ts` (daily job), `agent.ts`
(Claude Agent SDK), `telegram.ts`.

## Commands
- `npm run dev` — run locally (needs env vars).
- `npm run build` / `npm start` — compile & run.
- `docker compose up -d` — run the container.
- `npm run digest:now` — trigger the daily job once (manual test).

## Secrets — hard rule
**No secret ever enters git.** `.env`, `~/.releasebot/credentials.json`, and `/data` are
git-ignored; only `.env.example` (placeholders) is committed. Never paste a key into code,
a commit, a PR description, or a log line. If a secret is ever committed, treat the key as
compromised and rotate it.

## Environment (.env)
- `RELEASEBOT_API_KEY` — `rb_...` (Releasebot).
- `RELEASEBOT_TIER` — `free` (250 credits/mo) or `pro` (~$5/mo, unlimited). Stay
  conservative on both; controls how loud the low-credit warnings are.
- `ANTHROPIC_API_KEY` — Claude Agent SDK.
- `TELEGRAM_BOT_TOKEN` — from @BotFather.
- `TELEGRAM_CHAT_ID` — the only chat allowed to talk to the bot.
- `TZ=Europe/London`, `DIGEST_CRON=30 8 * * *`, `CLAUDE_MODEL=claude-haiku-4-5-20251001`.

## Spending Releasebot credits
Cache-first, always. Free searches are fine. **Any paid live call must be confirmed by the
user in Telegram first** ("Not in my cache. Fetch live (~N credits)? y/n") — never spend
credits silently.

## Releasebot cheat-sheet
CLI: `feed`, `releases <vendor[/product]>`, `search-releases <q>` (free), `all`,
flags `--json --since --before -l`. MCP tools: `my_feed`, `search_releases`,
`search_release_content` (free), `search_vendor` (free).

## Skills (edit these to tune what you get told)
- `.claude/skills/daily-digest/` — format/priorities of the 08:30 summary.
- `.claude/skills/release-deep-dive/` — how follow-ups are answered + credit discipline.
- `.claude/skills/vendors/` — per-vendor focus (Chrome, Node, ...). Add files freely.

## Conventions
- TypeScript ESM, strict mode. Secrets only via env — never commit `.env`.
- All Releasebot access goes through `releasebot.ts` so credit logging is centralised.
- Cache is the source of truth for follow-ups; live calls are the exception, not default.
