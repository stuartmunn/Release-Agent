/**
 * Telegram bot (grammy) — the only channel. It:
 *   - sends the daily digest and any messages the app initiates;
 *   - answers follow-up questions by calling the Claude agent (cache-first);
 *   - bridges the agent's paid-call gate to a Telegram yes/no prompt.
 *
 * Access is restricted to a single chat id (the owner). All other chats are ignored.
 *
 * Paid-call flow (the tricky bit): while answering a question the agent may want a paid
 * Releasebot call. `answerQuestion` awaits our `confirmPaidCall`, which posts a yes/no
 * prompt and parks a promise. The *next* message from that chat is interpreted as the
 * answer (not as a new question) and resolves the parked promise. A timeout declines.
 */
import { Bot } from "grammy";
import type { Api } from "grammy";
import { answerQuestion, ClaudeQueryError, type PaidCallRequest } from "./agent.js";
import {
  getCostSummary,
  getLatestCredits,
  getRecentReleases,
  getReleaseById,
  logCost,
  searchReleases,
  type Db,
} from "./cache.js";
import { logger } from "./logger.js";
import type { ReleasebotTier } from "./types.js";

/** Telegram hard limit per message. */
const TG_MAX = 4096;
/** How long to wait for a yes/no before declining a paid call. */
const CONFIRM_TIMEOUT_MS = 120_000;
/** Conversation messages kept for context — 12 messages = 6 user/assistant turns. */
const HISTORY_MESSAGES = 12;
/**
 * Newest releases listed in the follow-up agent's index. Bounds the system prompt no
 * matter how big the cache grows; older releases stay reachable via search_cache.
 */
const INDEX_LIMIT = 200;

export function createBot(token: string): Bot {
  return new Bot(token);
}

/** Split long text on line boundaries so every chunk fits Telegram's limit. */
export function chunkMessage(text: string, max = TG_MAX): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single overlong line: hard-split it.
    if (line.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (current.length + line.length + 1 > max) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Send text to a chat, split into Telegram-sized chunks. Plain text, no parse mode. */
export async function sendChunked(api: Api, chatId: string, text: string): Promise<void> {
  for (const chunk of chunkMessage(text)) {
    await api.sendMessage(chatId, chunk);
  }
}

/** Compact token count for `/cost`, e.g. 14234 -> "14.2K", 1234567 -> "1.2M". */
function formatTokens(n: number): string {
  // 999_950 is the exact point where rounding n/1000 to 1 decimal first reaches "1000.0"
  // (999.95 rounds up) — below it, the "K" branch never displays a 4-digit number.
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function parseYesNo(text: string): boolean {
  return /^\s*(y|yes|yeah|yep|ok|okay|sure|go|do it|approve|allow|fetch)\b/i.test(text);
}

function describePaidCall(req: PaidCallRequest): string {
  const tool = req.tool.replace("mcp__releasebot__", "");
  const cost = req.estimatedCredits ? `up to ~${req.estimatedCredits} credit(s)` : "some credits";
  return (
    `🔒 That isn't in my cache. I can fetch it live from Releasebot ` +
    `(${tool}, may use ${cost}).\n\nReply "yes" to allow, or "no" to skip.`
  );
}

interface ChatState {
  busy: boolean;
  history: { role: "user" | "assistant"; text: string }[];
  pendingConfirm: { resolve: (approved: boolean) => void; timer: NodeJS.Timeout } | null;
}

/** Cancel and clear a parked paid-call confirmation, if any. */
function clearPendingConfirm(state: ChatState): void {
  if (state.pendingConfirm) {
    clearTimeout(state.pendingConfirm.timer);
    state.pendingConfirm = null;
  }
}

export interface StartBotOptions {
  bot: Bot;
  chatId: string;
  db: Db;
  model: string;
  releasebotApiKey: string;
  tier: ReleasebotTier;
  /** IANA timezone for "today"/"this month" boundaries in /cost. */
  tz: string;
}

const HELP_TEXT = [
  "🤖 Release Agent",
  "",
  "I send a release summary every morning. Reply any time to dig in — e.g.",
  '  "more about the Chrome one"  ·  "is that Node update urgent?"',
  "",
  "Commands:",
  "  /digest  — re-send the latest summary I have",
  "  /credits — remaining Releasebot credits (last known)",
  "  /cost    — Anthropic spend: today / this month / last month",
  "  /help    — this message",
].join("\n");

/**
 * Register handlers and start long-polling. `onDigestRequest` lets /digest re-run the
 * daily job from the caller (index.ts owns the job wiring).
 */
export function startBot(
  opts: StartBotOptions,
  onDigestRequest: () => Promise<void>,
): void {
  const { bot, chatId, db, model, releasebotApiKey, tier, tz } = opts;
  const states = new Map<string, ChatState>();

  const stateFor = (id: string): ChatState => {
    let s = states.get(id);
    if (!s) {
      s = { busy: false, history: [], pendingConfirm: null };
      states.set(id, s);
    }
    return s;
  };

  // Ignore every chat except the owner's.
  bot.use(async (ctx, next) => {
    if (ctx.chat && String(ctx.chat.id) !== chatId) {
      logger.warn({ chatId: ctx.chat.id }, "ignoring message from non-owner chat");
      return;
    }
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(HELP_TEXT));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

  bot.command("credits", (ctx) => {
    const remaining = getLatestCredits(db);
    return ctx.reply(
      remaining === null
        ? "No credit reading yet — I'll know after the next fetch."
        : `Releasebot credits remaining (last known): ${remaining}.`,
    );
  });

  bot.command("cost", (ctx) => {
    const { today, thisMonth, lastMonth, todayCacheReadTokens, todayCacheCreationTokens, todayInputTokens } =
      getCostSummary(db, tz);
    const todayPromptTokens = todayCacheReadTokens + todayCacheCreationTokens + todayInputTokens;
    // Omit the line on a day with no calls yet, rather than show a meaningless 0%.
    const cacheLine =
      todayPromptTokens > 0
        ? `\nCache hit today: ${Math.round((todayCacheReadTokens / todayPromptTokens) * 100)}% ` +
          `(${formatTokens(todayCacheReadTokens)} / ${formatTokens(todayPromptTokens)} prompt tokens)`
        : "";
    return ctx.reply(
      `💰 Anthropic spend\n` +
        `Today: $${today.toFixed(2)}\n` +
        `This month: $${thisMonth.toFixed(2)}\n` +
        `Last month: $${lastMonth.toFixed(2)}` +
        cacheLine,
    );
  });

  bot.command("digest", async (ctx) => {
    await ctx.reply("Re-running today's digest…");
    try {
      await onDigestRequest();
    } catch (err) {
      logger.error({ err }, "manual /digest failed");
      await ctx.reply("Sorry — the digest run failed. Check the logs.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const id = String(ctx.chat.id);
    const state = stateFor(id);
    const text = ctx.message.text;

    // 1) A parked paid-call confirmation takes precedence over everything.
    if (state.pendingConfirm) {
      const { resolve, timer } = state.pendingConfirm;
      clearTimeout(timer);
      state.pendingConfirm = null;
      const approved = parseYesNo(text);
      await ctx.reply(approved ? "👍 Fetching…" : "👌 Skipping the live fetch.");
      resolve(approved);
      return;
    }

    // 2) Don't start a second question while one is in flight.
    if (state.busy) {
      await ctx.reply("⏳ Still working on the previous question — one sec.");
      return;
    }

    state.busy = true;
    try {
      await ctx.replyWithChatAction("typing").catch(() => {});
      const confirmPaidCall = (req: PaidCallRequest): Promise<boolean> =>
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => {
            state.pendingConfirm = null;
            void ctx.reply("⌛ No reply — skipping the live fetch.");
            resolve(false);
          }, CONFIRM_TIMEOUT_MS);
          state.pendingConfirm = { resolve, timer };
          void sendChunked(ctx.api, id, describePaidCall(req));
        });

      const { text: answer, costUsd, ...cacheUsage } = await answerQuestion({
        model,
        question: text,
        releases: getRecentReleases(db, INDEX_LIMIT),
        cache: {
          getRelease: (releaseId) => getReleaseById(db, releaseId),
          search: (query, limit) => searchReleases(db, query, limit),
        },
        releasebotApiKey,
        tier,
        confirmPaidCall,
        history: state.history,
      });
      logCost(db, "answer", { costUsd, ...cacheUsage });

      // Push the pair, then trim to the most recent messages (always an even count).
      state.history.push({ role: "user", text }, { role: "assistant", text: answer });
      if (state.history.length > HISTORY_MESSAGES) {
        state.history.splice(0, state.history.length - HISTORY_MESSAGES);
      }
      await sendChunked(ctx.api, id, answer);
    } catch (err) {
      // Anthropic still bills for the turns spent before a failed query — log that spend
      // even though the user gets an error instead of an answer.
      if (err instanceof ClaudeQueryError) {
        logCost(db, "answer", { costUsd: err.costUsd, ...err.cacheUsage });
      }
      logger.error({ err }, "failed to answer question");
      await ctx.reply("Sorry — I hit an error answering that. Check the logs.");
    } finally {
      state.busy = false;
      // If a paid-call confirmation was still parked (e.g. answerQuestion threw before
      // the user replied), clear its timer so it can't fire later on a stale context.
      clearPendingConfirm(state);
    }
  });

  bot.catch((err) => logger.error({ err: err.error }, "grammy error"));

  // Fire-and-forget: long polling runs until bot.stop().
  void bot.start({
    onStart: (info) => logger.info({ username: info.username }, "telegram bot started"),
  });
}
