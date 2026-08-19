# Changelog

What changed and, more importantly, **why**. Newest first. One section per PR (or
notable live fix), added in the same PR as the change itself — see CLAUDE.md.

## PR #11 — Token diet: hybrid plain digest + index/lookup follow-ups (2026-08-19)
**Why:** Anthropic API spend (~$1.73) was on track to make the app not worth running.
The dominant structural cost: every Telegram follow-up rebuilt a system prompt containing
*every cached release* at up to 4,000 chars each, re-sent on every internal agent turn and
growing daily as the cache grew.
**What:**
- Quiet days (≤ `DIGEST_AI_THRESHOLD` releases, default 8) get a code-rendered digest
  straight from the cache — zero Anthropic tokens. Busier days keep the AI rollup, still
  degrading to the plain list if generation fails.
- Follow-ups now see a one-line-per-release index (newest 200) and read full notes on
  demand via free in-process cache tools (`get_release`, `search_cache`) instead of having
  the whole cache inlined. Cost per question no longer scales with cache size.
- Replayed conversation turns capped at 600 chars; startup log states the model in use.

## PR #10 — Stop the digest advertising the Skill tool (2026-08-19)
**Why:** the digest still hit `error_max_turns` ~40% of runs. Root cause: the prompt said
"follow the skill", which made the model reach for the built-in `Skill` tool.
**What:** skill file content is injected under neutral headers; prompts never name a tool.

## PR #9 — Disable built-in tools for the digest (2026-08-18)
**Why:** `allowedTools: []` means "no filter", not "no tools" — the digest model was
calling `WebFetch` on release-note URLs and burning its turn budget (`error_max_turns`).
**What:** explicitly `disallowedTools` every built-in; keep turn headroom (`maxTurns: 6`).

## PR #8 — Read the Releasebot credit balance from response headers (2026-08-18)
**Why:** credit warnings need a real reading; the CLI/API expose no balance endpoint.
**What:** parse `X-Credits-Remaining` from feed responses and log it per run.

## PR #7 — Atomic migrations and cache re-normalisation (2026-08-17)
**Why:** a crash mid-migration or mid-renormalise could leave a half-updated database.
**What:** wrap multi-statement DDL and bulk re-derivations in single transactions.

## PR #6 — Make pino-pretty optional at runtime (2026-08-17)
**Why:** the runtime image prunes devDependencies; `docker compose exec` allocates a TTY,
which made the logger load the missing pretty transport and crash.
**What:** resolve the transport defensively and fall back to plain JSON logs.

## PR #5 — README (2026-08-17)
**What:** documented what the app is and how to set it up.

## PR #4 — Telegram bot, daily job wiring, Docker (2026-08-17)
**Why/What:** the long-running container: node-cron 08:30 digest + grammy long-poll
follow-ups sharing one SQLite cache. Progress markers advance only after delivery
succeeds, so failures retry instead of silently skipping releases.

## PR #3 — Claude Agent SDK integration + skills (2026-08-17)
**Why/What:** digest generation and follow-up answering via the Agent SDK, with editable
`.claude/skills/` files as the tuning layer and a code-enforced paid-call confirmation
gate so Releasebot credits are never spent silently.

## PR #2 — Core scaffold: config, logger, SQLite cache, Releasebot CLI wrapper (2026-08-17)
**Why/What:** cache-first foundation — pay for the feed once a day, cache full payloads,
answer everything else locally. Live fix that followed: the real feed JSON shape was
nested, so the normaliser is versioned and re-derives cached rows from `raw_json` on boot
(free, no re-fetch).

## PR #1 — Repo scaffold (2026-08-17)
**What:** project guide (CLAUDE.md), ignore rules, TypeScript/ESM setup.
