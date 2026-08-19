# Release-Agent

A small, self-contained app that reads the software releases you follow on
[Releasebot](https://releasebot.io) and turns them into a **plain-English morning
briefing on Telegram** — then lets you ask follow-up questions in natural language,
answered by Claude.

> Every morning at 08:30 it checks your Releasebot feed, summarises what's new, and
> messages you. Reply _"more about the Chrome one"_ or _"is that Node update urgent?"_ and
> it digs in — answering from what it already fetched, so it barely touches your API quota.

## What it does

1. **Daily digest (08:30).** Fetches only the releases that are *new* since it last ran,
   caches them locally, and sends a short, skimmable summary to your Telegram chat.
2. **Follow-ups, all day.** Reply to the digest in plain English. It works out which
   release you mean and answers from its local cache. If the answer genuinely isn't
   cached, it asks your permission before making a paid Releasebot call.
3. **Tuned to what you care about.** Editable *skills* (plain Markdown files) define the
   digest's tone and what to highlight per vendor (e.g. for Chrome, lead with CVEs and
   deprecations; for Node, breaking changes and LTS status).

Everything is delivered over Telegram — there is no other interface.

## Why it's careful with credits

Releasebot's free tier is **250 API credits/month**, shared across the API, MCP, and CLI.
**Search is free; other calls cost 1 credit per release returned.** So the app is built
cache-first:

- It pays **once per day** for `feed --since <last run>`, which returns only new releases.
- It caches the full payload, and answers your follow-ups from that cache for **0 credits**.
- A live paid call only happens when the answer isn't cached — **and only after it asks
  you first** in Telegram ("Not in my cache. Fetch live (~N credits)? yes/no").
- It logs the remaining balance and warns you when it runs low.

Set `RELEASEBOT_TIER=pro` if you upgrade to the paid plan; it stays conservative either way.

## Why it's careful with Anthropic tokens

The digest and follow-ups run on Claude, which costs actual money per call — so the app
minimises that too:

- **Quiet days skip Claude entirely.** A day with `DIGEST_AI_THRESHOLD` releases or fewer
  (default 8) gets a plain, code-rendered digest straight from the cache: **0 tokens**.
  Only busier days pay for an AI rollup.
- **Follow-ups see an index, not the whole cache.** Instead of inlining every cached
  release into every question, Claude gets a compact one-line-per-release index and reads
  full notes on demand via free local lookup tools — so cost doesn't grow with how much
  history you've accumulated.
- **`CLAUDE_MODEL` defaults to Haiku**, the cheapest model capable of this job.
- **`/cost` tells you what it's actually spent** — today, this calendar month, and last
  calendar month — read from a local log, not from Anthropic's dashboard, and not itself
  an AI call.

## How it works

One long-running Node/TypeScript container with two duties sharing a local SQLite cache:

```
  node-cron 08:30  ─▶  fetch new releases ─▶ cache ─▶ Claude summary ─▶ Telegram
  Telegram poll    ─▶  your question ─▶ Claude (cache-first, gated live fallback) ─▶ reply
```

- **Claude Agent SDK** does the summarising and question-answering, using the skills.
- The **paid-call confirmation gate** is enforced in code (the SDK's tool-permission
  callback), not just asked for in a prompt — so credits can't be spent without your yes.
- The **Releasebot CLI** does the daily fetch; the **Releasebot MCP** is the gated live
  fallback for follow-ups.

## Prerequisites

- **Docker** (with Compose) — the intended way to run it. (Node 22+ if running locally.)
- **A Releasebot API key** — from <https://releasebot.io/notifications> (format `rb_…`).
  Follow the vendors/products you care about on releasebot.io so they show up in your feed.
- **An Anthropic API key** — from <https://console.anthropic.com> (for the Claude Agent SDK).
- **A Telegram bot + your chat id:**
  1. Message [@BotFather](https://t.me/BotFather) → `/newbot` → copy the **bot token**.
  2. Send your new bot any message, then get your **chat id** (e.g. message
     [@userinfobot](https://t.me/userinfobot), which replies with your numeric id).

## Setup

```bash
git clone https://github.com/stuartmunn/Release-Agent.git
cd Release-Agent
cp .env.example .env      # then edit .env with your keys (see the table below)
docker compose up -d --build
```

That's it — the container schedules the daily digest and starts listening for your
messages. The SQLite cache is persisted in `./data` (a Docker volume), so it survives
restarts.

**Try it immediately** without waiting for 08:30:

```bash
docker compose exec release-agent node dist/digest.js --now
```

…or temporarily set `DIGEST_CRON` a minute or two ahead in `.env` and `docker compose up -d`.

## Configuration

All configuration is via environment variables in `.env` (never committed). See
[`.env.example`](.env.example).

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RELEASEBOT_API_KEY` | ✅ | — | Releasebot API key (`rb_…`). |
| `RELEASEBOT_TIER` | | `free` | `free` (250 credits/mo) or `pro` (unlimited). |
| `ANTHROPIC_API_KEY` | ✅ | — | For the Claude Agent SDK. |
| `CLAUDE_MODEL` | | `claude-haiku-4-5-20251001` | Model used for summaries/answers. |
| `TELEGRAM_BOT_TOKEN` | ✅ | — | From @BotFather. |
| `TELEGRAM_CHAT_ID` | ✅ | — | The only chat allowed to talk to the bot. |
| `TZ` | | `Europe/London` | Timezone the schedule runs in; also the timezone `/cost`'s today/this-month/last-month boundaries use. |
| `DIGEST_CRON` | | `30 8 * * *` | When to send the daily digest (cron). |
| `DIGEST_AI_THRESHOLD` | | `8` | Days with at most this many releases get a plain, code-rendered digest (0 Anthropic tokens). Busier days get an AI rollup. |
| `DATA_DIR` | | `/data` | Where the SQLite cache lives (mounted volume). |

## Using it

- **Morning:** you get the digest automatically.
- **Ask anything, plainly:** _"more about the Chrome release"_, _"what changed in Node?"_,
  _"anything security-related today?"_. No special syntax — it figures out what you mean.
- **Commands:**
  - `/digest` — re-send the latest summary.
  - `/credits` — remaining Releasebot credits (last known).
  - `/cost` — Anthropic API spend: today, this calendar month, and last calendar month.
  - `/help` — quick reference.

If a question needs data it hasn't cached, it will ask before spending a credit — reply
`yes` to allow or `no` to skip (it'll answer from what it has).

## Tuning what you're told (skills)

The `.claude/skills/` folder is the editable "what I care about" layer — plain Markdown:

- [`daily-digest`](.claude/skills/daily-digest/SKILL.md) — the digest's format and priorities.
- [`release-deep-dive`](.claude/skills/release-deep-dive/SKILL.md) — how follow-ups are
  answered, and the credit discipline.
- [`vendors`](.claude/skills/vendors/SKILL.md) — per-vendor focus. **Add your own vendors
  here** (copy the Chrome/Node pattern) and the digests and answers follow suit.

Edit a file, rebuild/restart the container, and the behaviour changes — no code needed.

## Local development

```bash
npm install
npm run typecheck      # tsc --noEmit
npm run build          # compile to dist/
npm run dev            # run with tsx (watch mode); needs a .env
npm run digest:now     # trigger one digest run and exit
```

## Project layout

```
src/
  index.ts        boot: cron schedule + Telegram listener + graceful shutdown
  config.ts       env parsing/validation
  cache.ts        SQLite cache (releases, last_run, credit log)
  releasebot.ts   the only place that talks to Releasebot (CLI wrapper)
  agent.ts        Claude Agent SDK: digest + Q&A, skills, paid-call gate
  telegram.ts     grammy bot: send, question handler, confirmation flow
  digest.ts       the daily job
.claude/skills/   editable per-topic guidance (see above)
Dockerfile, docker-compose.yml
```

See [`CLAUDE.md`](CLAUDE.md) for contributor notes and conventions.

## License

[MIT](LICENSE) © Stuart Munn
