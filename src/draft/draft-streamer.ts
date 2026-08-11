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
        // Wait for the write to SETTLE — that response is the only thing that
        // orders it ahead of the final message the caller sends next.
        // `controller.abort()` cancels OUR fetch; it does not withdraw a
        // request Telegram already holds, so an abandoned write can still be
        // applied, and one applied after the reply lands outlives it: the Bot
        // API has no clear-draft call (an empty `text` renders a "Thinking…"
        // placeholder, not an erasure), so the stale frame sits above the
        // answer until its ~30s TTL lapses. Abandoning at the old 1s deadline
        // made that the routine outcome of an ordinarily slow write.
        const drain = delay(k.drainMs);
        try {
          const landed = await Promise.race([
            inFlight.then(() => true),
            drain.promise.then(() => false),
          ]);
          if (!landed) {
            // Budget blown means wedged, not slow — `drainMs` sits well above
            // the Bot API's realistic worst case. Abandoning is still the
            // lesser evil: holding the turn open here parks the caller's
            // per-chat turn queue for as long as the socket hangs, and a
            // transport with no ceiling of its own would park it forever.
            // Logged because this is now the ONLY path that can strand a draft
            // over the reply, and a silent one is unobservable after the fact.
            inFlightController?.abort();
            await inFlight?.catch(() => {});
            log.warn('telegram draft drain abandoned', {
              chat_id: chatId,
              drain_ms: k.drainMs,
            });
          }
        } finally {
          drain.cancel(); // clear the drain timer on both paths — no leak
        }
      } catch (err) {
        log.warn('telegram draft finalize error', { err: String(err) });
      }
    },

    /** Cancellation, not shutdown-with-ordering: this one abandons the write
     *  immediately and on purpose. It runs when the turn is already dead, and
     *  the two callers want opposite things from a delay — a turn cancelled via
     *  `signal` sends nothing afterwards (so there is no ordering to protect),
     *  while a turn that errored sends only a fallback NOTICE, which is not
     *  worth parking the chat's turn queue behind a wedged socket. The cost is
     *  the `finalize` race in miniature: a late write can strand a draft above
     *  that notice. Accepted — the notice path is rare and already degraded. */
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
