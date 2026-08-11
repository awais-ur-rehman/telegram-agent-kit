import { describe, expect, test } from 'vitest';

import { DEFAULT_DRAFT_CONSTANTS } from '../../src/draft/constants.ts';
import { createDraftStreamer } from '../../src/draft/index.ts';
import { TelegramApiError } from '../../src/errors.ts';

const DRAFT_MAX_FAILURES = DEFAULT_DRAFT_CONSTANTS.maxFailures;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e?: unknown) => void;
};
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = (e) => rej(e);
  });
  return { promise, resolve, reject };
}

function setup(opts: { cancelThrows?: boolean; rich?: boolean } = {}) {
  let clock = 0;
  let tickFn: (() => void) | null = null;
  const cancelInterval = { called: false };
  const drainCancel = { called: false };
  const drafts: Array<{ method: 'rich' | 'plain'; text: string }> = [];
  const typing: number[] = [];
  const warns: string[] = [];
  let aborted = 0;
  let lastDraft: Deferred | null = null;
  let drain: Deferred | null = null;

  const log = {
    debug() {},
    info() {},
    warn(msg: string) {
      warns.push(msg);
    },
    error() {},
    child() {
      return log;
    },
  } as never;

  const record =
    (method: 'rich' | 'plain') =>
    (p: { text?: string; markdown?: string }, signal?: AbortSignal) => {
      drafts.push({ method, text: p.markdown ?? p.text ?? '' });
      const d = deferred();
      lastDraft = d;
      if (signal)
        signal.addEventListener(
          'abort',
          () => {
            aborted += 1;
            d.reject(new Error('aborted'));
          },
          { once: true },
        );

      return d.promise;
    };

  const streamer = createDraftStreamer({
    chatId: 111,
    draftId: 7,
    rich: opts.rich ?? true,
    log,
    client: {
      sendRichMessageDraft: record('rich'),
      sendMessageDraft: record('plain'),
      sendChatAction: async (p: { chatId: number }) => {
        typing.push(p.chatId);
      },
    } as never,
    now: () => clock,
    schedule: (fn: () => void) => {
      tickFn = fn;
      return 1 as never;
    },
    cancel: () => {
      if (opts.cancelThrows) throw new Error('cancel blew up');
      cancelInterval.called = true;
    },
    delay: () => {
      drain = deferred();
      return {
        promise: drain.promise,
        cancel: () => {
          drainCancel.called = true;
        },
      };
    },
  });

  streamer.start();
  return {
    streamer,
    drafts,
    typing,
    cancelInterval,
    drainCancel,
    warns,
    abortCount: () => aborted,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => tickFn?.(),
    resolveDraft: () => lastDraft?.resolve(),
    rejectDraft: (e?: unknown) => lastDraft?.reject(e ?? new Error('fail')),
    resolveDrain: () => drain?.resolve(),
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

// A draft goes rich only for text that needs the rich renderer (needsRich) —
// same gate as the final send, so the animation and the message that replaces
// it use the same renderer. Prose under rich: true streams plain.
const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |';

describe('DraftStreamer', () => {
  test('first push flushes immediately at now()===0', () => {
    const s = setup();
    s.streamer.push('a');
    expect(s.drafts).toEqual([{ method: 'plain', text: 'a' }]);
  });

  test('rich:true streams plain until the text needs rich, then flips', async () => {
    const s = setup({ rich: true });
    s.streamer.push('Итого:\n| a | b |'); // header only — no table yet
    expect(s.drafts[0]?.method).toBe('plain');
    s.resolveDraft();
    await s.settle();
    s.advance(300);
    s.streamer.push(`Итого:\n${TABLE}`); // delimiter row landed → rich
    expect(s.drafts[1]?.method).toBe('rich');
  });

  test('rich:false (kill-switch) streams a plain draft from the first push', () => {
    const s = setup({ rich: false });
    s.streamer.push('| a |');
    expect(s.drafts).toEqual([{ method: 'plain', text: '| a |' }]);
  });

  test('every write carries the same non-zero draft_id', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.advance(300);
    s.streamer.push('ab');
    expect(s.drafts.length).toBe(2);
    expect(s.drafts.every((d) => d.method === 'plain')).toBe(true);
  });

  test('throttles content writes by attempt time', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.streamer.push('ab'); // clock still 0 → throttled
    expect(s.drafts.length).toBe(1);
    s.advance(300);
    s.tick();
    expect(s.drafts.length).toBe(2);
    expect(s.drafts[1]?.text).toBe('ab');
  });

  test('throttles retries after a failure (no storm)', async () => {
    const s = setup();
    s.streamer.push('a'); // send #1 at clock 0
    s.rejectDraft(); // fails — lastSent stays null, but lastAttemptAt was set
    await s.settle();
    s.streamer.push('ab'); // clock still 0 → throttled despite the failure
    expect(s.drafts.length).toBe(1);
    s.advance(300);
    s.tick();
    expect(s.drafts.length).toBe(2); // throttle window elapsed → retry allowed
  });

  test('caps the preview surrogate-safely', () => {
    const hi = setup();
    hi.streamer.push(`${'a'.repeat(3999)}\uD83D${'b'.repeat(1000)}`);
    expect(hi.drafts[0]?.text.length).toBe(3999);
    const plain = setup();
    plain.streamer.push('a'.repeat(5000));
    expect(plain.drafts[0]?.text.length).toBe(4000);
  });

  test('never drafts a whitespace-only preview', () => {
    const s = setup();
    s.streamer.push('   \n ');
    expect(s.drafts.length).toBe(0);
  });

  test('keepalive re-sends the last text past the expiry window', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.advance(20000);
    s.tick();
    expect(s.drafts.length).toBe(2);
    expect(s.drafts[1]?.text).toBe('a');
  });

  test('typing heartbeat fires on start and after the heartbeat window', () => {
    const s = setup(); // setup() auto-starts → initial typing already recorded
    expect(s.typing).toEqual([111]);
    s.advance(4500);
    s.tick();
    expect(s.typing).toEqual([111, 111]);
  });

  test('finalize drains a fast write and cancels the drain timer', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    s.resolveDraft(); // write resolves
    await s.streamer.finalize();
    expect(s.drainCancel.called).toBe(true);
    expect(s.cancelInterval.called).toBe(true);
    expect(s.drafts.length).toBe(1); // no clear send
  });

  // The ordering invariant. A draft write's HTTP response is the only thing
  // that puts it BEFORE the final message; abandoning the wait does not
  // withdraw the request, and a draft applied after the reply can never be
  // cleared (the Bot API has no clear-draft call), so it hangs over the answer
  // for its ~30s TTL. finalize() therefore waits for the write to settle
  // instead of cutting it loose at a deadline an ordinarily slow call trips.
  test('finalize waits out a write that settles inside the drain budget', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    let settled = false;
    const p = s.streamer.finalize().then(() => {
      settled = true;
    });
    await s.settle();
    // The caller sends the final message the moment finalize() resolves, so
    // resolving here would be the bug: the write is still unacknowledged.
    expect(settled).toBe(false);
    s.resolveDraft(); // lands while finalize is still waiting
    await p;
    expect(settled).toBe(true);
    expect(s.abortCount()).toBe(0); // never cut loose → ordering preserved
    expect(s.drainCancel.called).toBe(true);
    expect(s.warns).not.toContain('telegram draft drain abandoned');
  });

  test('finalize abandons a wedged write at the drain budget, loudly', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending, never resolved
    const p = s.streamer.finalize();
    s.resolveDrain(); // budget elapses first → abort + proceed
    await p;
    expect(s.drainCancel.called).toBe(true);
    expect(s.abortCount()).toBe(1);
    // The one remaining path that can strand a draft over the reply must be
    // observable — a silent abandon is unobservable after the fact.
    expect(s.warns).toContain('telegram draft drain abandoned');
  });

  test('abort cancels locally, sends no clear, and goes silent', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    await s.streamer.abort();
    expect(s.cancelInterval.called).toBe(true);
    expect(s.drafts.length).toBe(1); // no empty-text clear
    s.advance(1000);
    s.streamer.push('b');
    s.tick();
    expect(s.drafts.length).toBe(1); // stopped → nothing more
  });

  test('emits no typing heartbeat after stop', async () => {
    const s = setup();
    s.streamer.push('a');
    await s.streamer.abort();
    const typingBefore = s.typing.length;
    s.advance(4500); // past the typing-heartbeat window
    s.tick();
    expect(s.typing.length).toBe(typingBefore); // !stopped guard → bubble silent
  });

  test('finalize and abort never reject even if teardown throws', async () => {
    const s = setup({ cancelThrows: true });
    await expect(s.streamer.finalize()).resolves.toBeUndefined();
    await expect(s.streamer.abort()).resolves.toBeUndefined();
  });

  test('disables drafts after N failures; typing heartbeat survives', async () => {
    const s = setup(); // auto-started
    for (let i = 0; i < DRAFT_MAX_FAILURES; i++) {
      s.advance(300);
      s.streamer.push('x'.repeat(i + 1));
      s.rejectDraft();
      await s.settle();
    }
    expect(s.drafts.length).toBe(DRAFT_MAX_FAILURES); // bounded — no storm
    const draftsBefore = s.drafts.length;
    const typingBefore = s.typing.length;
    s.advance(4500);
    s.tick();
    expect(s.drafts.length).toBe(draftsBefore); // disabled → no new draft
    expect(s.typing.length).toBeGreaterThan(typingBefore); // bubble still alive
  });

  test('keeps at most one write in flight', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    s.advance(300);
    s.tick(); // would send, but inFlight set → blocked
    expect(s.drafts.length).toBe(1);
    s.resolveDraft();
    await s.settle();
    s.advance(300);
    s.streamer.push('ab');
    expect(s.drafts.length).toBe(2);
  });

  test('a 400 flips rich->plain without burning the failure budget', async () => {
    const s = setup({ rich: true });
    s.streamer.push(TABLE);
    expect(s.drafts[0]).toEqual({ method: 'rich', text: TABLE });
    s.rejectDraft(new TelegramApiError(400, "can't parse rich message"));
    await s.settle();
    s.advance(300);
    s.streamer.push('| a | b |');
    expect(s.drafts[1]?.method).toBe('plain'); // degraded for the turn
    // The 400 must NOT have counted toward DRAFT_MAX_FAILURES.
    for (let i = 0; i < DRAFT_MAX_FAILURES; i += 1) {
      s.rejectDraft();
      await s.settle();
      s.advance(300);
      s.streamer.push(`x${i}`);
    }
    expect(s.drafts.length).toBe(2 + DRAFT_MAX_FAILURES - 1);
  });

  test('a 429 backs off for retry_after without burning the failure budget', async () => {
    const s = setup();
    s.streamer.push('a'); // draft #1 at t=0
    s.rejectDraft(
      new TelegramApiError(429, 'Too Many Requests', {
        retry_after: 2,
      }),
    );
    await s.settle();
    s.advance(1000); // inside the retry_after window
    s.streamer.push('ab');
    s.tick();
    expect(s.drafts.length).toBe(1); // silent while backing off
    s.advance(1500); // past retry_after
    s.streamer.push('abc');
    expect(s.drafts.length).toBe(2); // resumes on its own
    // The 429 must NOT have counted toward DRAFT_MAX_FAILURES.
    for (let i = 0; i < DRAFT_MAX_FAILURES; i += 1) {
      s.rejectDraft();
      await s.settle();
      s.advance(300);
      s.streamer.push(`x${i}`);
    }
    expect(s.drafts.length).toBe(2 + DRAFT_MAX_FAILURES - 1);
  });

  test('keepalive stays silent during a 429 backoff', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft(); // lastSent set → keepalive armed
    await s.settle();
    s.advance(300);
    s.streamer.push('ab'); // draft #2
    s.rejectDraft(
      new TelegramApiError(429, 'Too Many Requests', {
        retry_after: 30,
      }),
    );
    await s.settle();
    const typingBefore = s.typing.length;
    s.advance(20000); // past the keepalive window, inside the backoff
    s.tick();
    expect(s.drafts.length).toBe(2); // no keepalive write while throttled
    // The typing action spends the same per-chat budget — heartbeating a
    // throttled chat would extend the very window we are waiting out.
    expect(s.typing.length).toBe(typingBefore);
  });

  test('a 429 without a usable retry_after still buys a real pause', async () => {
    for (const parameters of [
      undefined,
      { retry_after: -5 },
      { retry_after: 'soon' as unknown as number },
    ]) {
      const s = setup();
      s.streamer.push('a');
      s.rejectDraft(new TelegramApiError(429, 'Too Many Requests', parameters));
      await s.settle();
      s.advance(999); // inside the 1s floor
      s.streamer.push('ab');
      s.tick();
      expect(s.drafts.length).toBe(1); // never a 300ms retry storm
      s.advance(1); // floor elapsed
      s.streamer.push('abc');
      expect(s.drafts.length).toBe(2);
    }
  });

  test('keepalive re-sends as plain after a 400 rich->plain flip', async () => {
    const s = setup({ rich: true });
    s.streamer.push(TABLE); // rich draft #1
    s.rejectDraft(new TelegramApiError(400, "can't parse rich message"));
    await s.settle();
    s.advance(300);
    s.streamer.push(`${TABLE}\n| 3 | 4 |`); // content draft #2, now plain
    expect(s.drafts[1]?.method).toBe('plain');
    s.resolveDraft();
    await s.settle();
    s.advance(20000); // past the keepalive window
    s.tick();
    // The keepalive must use the flipped (plain) mode — never re-send rich
    // markdown Telegram already rejected (which would 400 every ~20s).
    expect(s.drafts.length).toBe(3);
    expect(s.drafts[2]).toEqual({
      method: 'plain',
      text: `${TABLE}\n| 3 | 4 |`,
    });
  });
});
