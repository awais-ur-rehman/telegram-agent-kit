import type { BotClient, Logger } from '../bridge/interfaces.ts';
import { isBadRequest, isRateLimited } from '../errors.ts';
import { safeSlice } from '../format/chunk.ts';
import { needsRich } from '../format/rich.ts';
import { DEFAULT_DRAFT_CONSTANTS, type DraftConstants } from './constants.ts';

type IntervalHandle = ReturnType<typeof setInterval>;

export type DraftStreamerDeps = {
  client: Pick<
    BotClient,
    'sendMessageDraft' | 'sendRichMessageDraft' | 'sendChatAction'
  >;
  chatId: number;
  draftId: number; // non-zero; reused for every write of one turn (animation)
  rich: boolean; // true = rich mode; false (kill-switch active) → plain from the start
  log: Logger;
  /** Override any subset of the draft tunables; defaults fill the rest. */
  constants?: Partial<DraftConstants>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => IntervalHandle;
  cancel?: (h: IntervalHandle) => void;
  delay?: (ms: number) => { promise: Promise<void>; cancel: () => void };
};

export type DraftStreamer = {
  start(): void;
  push(fullText: string): void;
  finalize(): Promise<void>;
  abort(): Promise<void>;
};

const defaultDelay = (ms: number) => {
  let handle: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
};

export function createDraftStreamer(deps: DraftStreamerDeps): DraftStreamer {
  const k = { ...DEFAULT_DRAFT_CONSTANTS, ...deps.constants };
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const cancel = deps.cancel ?? ((h: IntervalHandle) => clearInterval(h));
  const delay = deps.delay ?? defaultDelay;
  const { client, chatId, draftId, log } = deps;

  let latest = '';
  let lastSent: string | null = null;
  let lastSentAt = 0;
  let lastAttemptAt = Number.NEGATIVE_INFINITY; // first push flushes even at now()===0
  let lastTypingAt = 0;
  let inFlight: Promise<void> | null = null;
  let inFlightController: AbortController | null = null;
  let consecutiveFailures = 0;
  let backoffUntil = 0; // 429: no write, keepalive or typing before this
  let disabled = false;
  let richMode = deps.rich; // turn-scoped: flips to plain on a 400
  let stopped = false;
  let timer: IntervalHandle | null = null;

  function send(text: string, t: number): void {
    const controller = new AbortController();
    inFlightController = controller;
    lastAttemptAt = t;
    // Same gate as the final send: rich only for text that needs it. Without it
    // the draft animates a whole turn in the rich renderer's body font and then
    // the final message lands in the normal one — the mismatch is the visible
    // half of the problem. Re-evaluated per write, so a draft flips to rich the
    // moment a table's delimiter row streams in.
    const usingRich = richMode && needsRich(text);
    const op = usingRich
      ? client.sendRichMessageDraft(
          { chatId, draftId, markdown: text },
          controller.signal,
        )
      : client.sendMessageDraft({ chatId, draftId, text }, controller.signal);
    inFlight = op
      .then(() => {
        lastSent = text; // raw; the keepalive re-sends it via the current mode
        lastSentAt = now();
        consecutiveFailures = 0;
      })
      .catch((err) => {
        if (controller.signal.aborted) return; // our own abort — not a failure
        if (isRateLimited(err)) {
          // Throttled, transport healthy: wait exactly what the API asked for
          // and keep the maxFailures budget for real failures. Drafts write
          // ~once per throttleMs, so they are the first thing to hit a rate
          // limit — counting a 429 as a failure kills the draft for the whole
          // turn over a delay the API already told us how to ride out.
          // retry_after (seconds) is untyped caller JSON; floor it at 1s, or a
          // bad value means no pause at all — and nothing left to stop the
          // retries, since a 429 no longer spends the budget that used to.
          const retryAfter = Math.max(
            1,
            Number(err.parameters?.retry_after) || 1,
          );
          backoffUntil = now() + retryAfter * 1000;
          log.warn('telegram draft rate limited', {
            chat_id: chatId,
            retry_after: retryAfter,
          });

          return;
        }
        if (usingRich && isBadRequest(err)) {
          // Rich rejected, transport healthy: plain for the rest of the turn,
          // without burning the maxFailures budget.
          richMode = false;
          log.warn('telegram draft rich disabled', {
            chat_id: chatId,
            method: 'sendRichMessageDraft',
            error_code: err.error_code,
            description: err.description,
          });

          return;
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= k.maxFailures) {
          disabled = true;
          log.warn('telegram draft disabled after failures', {
            chat_id: chatId,
            failures: consecutiveFailures,
          });
        } else {
          log.warn('telegram draft send failed', { chat_id: chatId });
        }
      })
      .finally(() => {
        inFlight = null;
        inFlightController = null;
      });
  }

  function maybeFlush(): void {
    if (stopped || disabled || inFlight) return;
    const t = now();
    if (t < backoffUntil) return; // 429 backoff — silences the keepalive too
    if (
      latest !== lastSent &&
      latest.trim().length > 0 &&
      t - lastAttemptAt >= k.throttleMs
    ) {
      send(latest, t);
    } else if (lastSent !== null && t - lastSentAt >= k.keepaliveMs) {
      send(lastSent, t); // keepalive — beat the ~30s draft expiry
    }
  }

  function tick(): void {
    maybeFlush();
    // The typing action spends the same per-chat budget as a draft write, so
    // it observes the 429 backoff too — heartbeating a chat that just told us
    // to wait only extends the throttle we are riding out.
    const t = now();
    if (
      !stopped &&
      t >= backoffUntil &&
      t - lastTypingAt >= k.typingHeartbeatMs
    ) {
      client.sendChatAction({ chatId }).catch(() => {});
      lastTypingAt = t;
    }
  }

  return {
    start(): void {
      lastTypingAt = now();
      client.sendChatAction({ chatId }).catch(() => {});
      timer = schedule(tick, k.tickMs);
    },

    push(fullText: string): void {
      latest = safeSlice(fullText, k.previewCap);
      maybeFlush();
    },

    async finalize(): Promise<void> {
      try {
        stopped = true;
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        if (!inFlight) return;
        // Wait for the write to settle — its response is what orders it before
        // the final send. Why, and why the budget is large: `drainMs` docs.
        const drain = delay(k.drainMs);
        try {
          const landed = await Promise.race([
            inFlight.then(() => true),
            drain.promise.then(() => false),
          ]);
          if (!landed) {
            // Wedged, not slow. Logged — the only path left that can strand a
            // draft over the reply, and holding the turn open is worse.
            inFlightController?.abort();
            await inFlight?.catch(() => {});
            log.warn('telegram draft drain abandoned', { chat_id: chatId });
          }
        } finally {
          drain.cancel(); // clear the drain timer on both paths — no leak
        }
      } catch (err) {
        log.warn('telegram draft finalize error', { err: String(err) });
      }
    },

    /** Cancellation: abandons the write on purpose — the turn is already dead,
     *  and only a fallback notice ships after it, if anything. */
    async abort(): Promise<void> {
      try {
        stopped = true;
        if (timer !== null) {
          cancel(timer);
          timer = null;
        }
        inFlightController?.abort();
        await inFlight?.catch(() => {});
      } catch (err) {
        log.warn('telegram draft abort error', { err: String(err) });
      }
    },
  };
}
