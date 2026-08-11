import { expect, test, vi } from 'vitest';

import type {
  AgentStream,
  BotClient,
  Checkpointer,
  ThreadStore,
} from '../../src/bridge/interfaces.ts';
import type { RollbackContext } from '../../src/bridge/turn-loop.ts';
import { runTelegramTurn } from '../../src/bridge/turn-loop.ts';

const noopLog = { warn: () => {}, error: () => {} };

function deps(over: Record<string, unknown> = {}) {
  const client: BotClient = {
    sendMessage: vi.fn(async () => {}),
    sendRichMessage: vi.fn(async () => {}),
    sendPhoto: vi.fn(async () => {}),
    sendChatAction: vi.fn(async () => {}),
    sendMessageDraft: vi.fn(async () => {}),
    sendRichMessageDraft: vi.fn(async () => {}),
  };
  const checkpointer: Checkpointer = {
    snapshot: vi.fn(async () => 'cp-1'),
    rollback: vi.fn(async () => {}),
  };
  const threadStore: ThreadStore = {
    resolve: vi.fn(async () => 'tg-1-main'),
    touch: vi.fn(async () => {}),
  };
  const okStream: AgentStream = async function* () {
    yield { type: 'token', text: 'hello' };
  };
  return {
    chatKey: { chatId: 1, agentId: 'main' },
    userText: 'hi',
    draftId: 7,
    rich: true,
    client,
    agentStream: okStream,
    checkpointer,
    threadStore,
    log: noopLog,
    ...over,
  } as Parameters<typeof runTelegramTurn>[0];
}

test('happy path: streams, finalizes, sends reply, touches, no rollback', async () => {
  const d = deps();
  await runTelegramTurn(d);
  // 'hello' is table-less prose, so even under rich: true it goes out classic.
  expect(d.client.sendMessage).toHaveBeenCalled();
  expect(d.threadStore.touch).toHaveBeenCalled();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('threadId from threadStore.resolve reaches the AgentStream context', async () => {
  const seen: string[] = [];
  const stream: AgentStream = async function* (_input, ctx) {
    seen.push(ctx.threadId);
    yield { type: 'token', text: 'x' };
  };
  await runTelegramTurn(deps({ agentStream: stream }));
  expect(seen).toEqual(['tg-1-main']);
});

test('error event → abort + rollback to snapshot, no reply', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'boom' };
  };
  const d = deps({ agentStream: stream });
  await runTelegramTurn(d);
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('error event → logs the message and sends errorNotice as plain text', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'boom' };
  };
  const error = vi.fn();
  const d = deps({
    agentStream: stream,
    errorNotice: 'нет связи с моделью, повтори',
    log: { warn: () => {}, error },
  });
  await runTelegramTurn(d);
  expect(error).toHaveBeenCalledWith(
    'telegram turn errored',
    expect.objectContaining({ err: 'boom' }),
  );
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      chatId: 1,
      text: 'нет связи с моделью, повтори',
    }),
    undefined,
  );
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('errorNotice is skipped when the turn was aborted via signal', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'error', message: 'canceled' };
  };
  const d = deps({
    agentStream: stream,
    errorNotice: 'oops',
    signal: AbortSignal.abort(),
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).not.toHaveBeenCalled();
});

/** A turn that dies after its tools already wrote somewhere. The predicate is
 *  what the app answers "those writes are real, don't erase the turn" with. */
const failingStream: AgentStream = async function* () {
  yield { type: 'tool_start', name: 'log_meal', args: {} };
  yield { type: 'error', message: 'Recursion limit of 120 reached' };
};

test('shouldRollback → false keeps the failed turn in history', async () => {
  const d = deps({
    agentStream: failingStream,
    hooks: { shouldRollback: () => false },
  });
  await runTelegramTurn(d);
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('shouldRollback → true rolls back, same as no predicate', async () => {
  const d = deps({
    agentStream: failingStream,
    hooks: { shouldRollback: async () => true },
  });
  await runTelegramTurn(d);
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
});

test('no shouldRollback → unconditional rollback (0.7.2 default)', async () => {
  const d = deps({ agentStream: failingStream, hooks: {} });
  await runTelegramTurn(d);
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
});

test('shouldRollback gets the threadId, the turn start and the error text', async () => {
  const seen: RollbackContext[] = [];
  const before = Date.now();
  const d = deps({
    // A domain clock, as a real caller injects (feeding the kit the Telegram
    // message's SEND time, so a message backlogged across a day boundary is
    // filed into the day it was actually sent). `startedAt` must not be that
    // clock.
    now: () => 1_700_000_000_000,
    agentStream: failingStream,
    hooks: {
      shouldRollback: (ctx: RollbackContext) => {
        seen.push(ctx);
        return true;
      },
    },
  });
  await runTelegramTurn(d);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    chatKey: { chatId: 1, agentId: 'main' },
    userText: 'hi',
    threadId: 'tg-1-main',
    error: 'Recursion limit of 120 reached',
  });
  // Wall clock, not opts.now(): the predicate compares this against timestamps
  // its own tools wrote, and those carry real time.
  expect(seen[0]?.startedAt).toBeGreaterThanOrEqual(before);
  expect(seen[0]?.startedAt).toBeLessThanOrEqual(Date.now());
});

test('a mid-stream throw reaches the predicate as a bare message, not "Error: …"', async () => {
  const seen: string[] = [];
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'log_meal', args: {} };
    throw new Error('Recursion limit of 120 reached');
  };
  const d = deps({
    agentStream: stream,
    hooks: {
      shouldRollback: ({ error }: RollbackContext) => {
        seen.push(error);
        return true;
      },
    },
  });
  await runTelegramTurn(d);
  // Same shape the `error`-event path delivers, so a predicate reading the text
  // cannot decide one way on one path and the other way on the other.
  expect(seen).toEqual(['Recursion limit of 120 reached']);
});

test('a kept turn on the mid-stream-throw path still gets keptNotice', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'log_meal', args: {} };
    throw new Error('mid');
  };
  const d = deps({
    agentStream: stream,
    errorNotice: 'сломалось, повтори',
    keptNotice: 'ход упал, записи остались',
    hooks: { shouldRollback: () => false },
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'ход упал, записи остались' }),
    undefined,
  );
});

test('a rolled-back turn on the mid-stream-throw path stays silent (0.7.2)', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'partial' };
    throw new Error('mid');
  };
  const d = deps({
    agentStream: stream,
    errorNotice: 'сломалось, повтори',
    keptNotice: 'ход упал, записи остались',
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).not.toHaveBeenCalled();
});

test('a checkpointer whose rollback throws SYNCHRONOUSLY never escapes the turn', async () => {
  // Not an async method: a plain one that validates first. `.catch()` on the
  // returned promise never sees this throw — only a try/catch around the call
  // does, and from the mid-stream-throw handler it would leave runTelegramTurn.
  const checkpointer: Checkpointer = {
    snapshot: vi.fn(async () => 'cp-1'),
    rollback: vi.fn((): Promise<void> => {
      throw new Error('saver offline');
    }),
  };
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'partial' };
    throw new Error('mid');
  };
  const d = deps({ agentStream: stream, checkpointer });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
});

test('a throwing shouldRollback keeps the turn and never breaks the turn loop', async () => {
  // Fail-open by design: a predicate that throws answered nothing, and a turn
  // wrongly kept is one stale thread entry, while a turn wrongly rolled back
  // desyncs memory from writes that really happened. See rollbackUnlessVetoed.
  const error = vi.fn();
  const d = deps({
    agentStream: failingStream,
    log: { warn: () => {}, error },
    hooks: {
      shouldRollback: () => {
        throw new Error('audit db down');
      },
    },
  });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    'telegram shouldRollback hook failed',
    expect.objectContaining({ err: expect.stringContaining('audit db down') }),
  );
});

test('an aborted turn rolls back whatever the predicate says', async () => {
  const shouldRollback = vi.fn(() => false);
  const d = deps({
    agentStream: failingStream,
    signal: AbortSignal.abort(),
    hooks: { shouldRollback },
  });
  await runTelegramTurn(d);
  expect(shouldRollback).not.toHaveBeenCalled();
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
});

test('a kept turn is told so with keptNotice, a rolled-back one with errorNotice', async () => {
  const kept = deps({
    agentStream: failingStream,
    errorNotice: 'сломалось, повтори',
    keptNotice: 'ход упал, но записи остались — не повторяй',
    hooks: { shouldRollback: () => false },
  });
  await runTelegramTurn(kept);
  expect(kept.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      text: 'ход упал, но записи остались — не повторяй',
    }),
    undefined,
  );

  const rolled = deps({
    agentStream: failingStream,
    errorNotice: 'сломалось, повтори',
    keptNotice: 'ход упал, но записи остались — не повторяй',
    hooks: { shouldRollback: () => true },
  });
  await runTelegramTurn(rolled);
  expect(rolled.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'сломалось, повтори' }),
    undefined,
  );
});

test('keptNotice unset → a kept turn still gets errorNotice', async () => {
  const d = deps({
    agentStream: failingStream,
    errorNotice: 'сломалось',
    hooks: { shouldRollback: () => false },
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'сломалось' }),
    undefined,
  );
});

test('a rollback that itself throws is reported to the user as kept', async () => {
  const checkpointer: Checkpointer = {
    snapshot: vi.fn(async () => 'cp-1'),
    rollback: vi.fn(async () => {
      throw new Error('saver offline');
    }),
  };
  const d = deps({
    agentStream: failingStream,
    checkpointer,
    errorNotice: 'сломалось, повтори',
    keptNotice: 'ход упал, записи остались',
  });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'ход упал, записи остались' }),
    undefined,
  );
});

test('shouldRollback also guards the mid-stream-throw path', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'log_meal', args: {} };
    throw new Error('mid');
  };
  const d = deps({
    agentStream: stream,
    hooks: { shouldRollback: () => false },
  });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('throw mid-stream → rollback, never rethrows', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'partial' };
    throw new Error('mid');
  };
  const d = deps({ agentStream: stream });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).toHaveBeenCalledWith('tg-1-main', 'cp-1');
});

test('post-completion send failure is NOT rolled back', async () => {
  const client = deps().client;
  (client.sendRichMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error('send fail'),
  );
  const d = deps({ client });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('preStream { skip:true } ends the turn before snapshot', async () => {
  const d = deps({ hooks: { preStream: () => ({ skip: true }) } });
  await runTelegramTurn(d);
  expect(d.checkpointer.snapshot).not.toHaveBeenCalled();
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('a throwing afterTurn hook is swallowed (never throws out)', async () => {
  const d = deps({
    hooks: {
      afterTurn: () => {
        throw new Error('after');
      },
    },
  });
  await expect(runTelegramTurn(d)).resolves.toBeUndefined();
});

/** Every draft frame the turn actually pushed to Telegram, in order, across
 *  both the plain and rich draft transports. Tests that inspect frames run with
 *  `throttleMs: 0` so each push flushes instead of being coalesced by the gate. */
function draftFrames(client: BotClient): string[] {
  const calls = [
    ...(client.sendMessageDraft as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => [c[0].text, c] as const,
    ),
    ...(client.sendRichMessageDraft as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => [c[0].markdown, c] as const,
    ),
  ];
  return calls.map(([text]) => text as string);
}

/** Lets the draft streamer's in-flight promise settle between stream events, so
 *  a push is never dropped merely because the previous write is still pending. */
const settle = () => new Promise((r) => setTimeout(r, 1));

test('tool_start status never leaks into the sent reply', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'one ' };
    yield { type: 'tool_start', name: 'web_search', args: {} };
    yield { type: 'token', text: 'two' };
  };
  const d = deps({ agentStream: stream });
  await runTelegramTurn(d);

  // The whole point: the persisted message is exactly the tokens.
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'one two' }),
    undefined,
  );
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
});

test('a token after a tool_start keeps the tool line above it', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'one ' };
    await settle();
    yield { type: 'tool_start', name: 'web_search', args: {} };
    await settle();
    yield { type: 'token', text: 'two' };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  // The feed is append-only. Pre-0.9 the tool line was DELETED the moment tokens
  // resumed, which edits the middle of the draft — and the client repaints every
  // character of a draft whose middle changed. Keeping it costs nothing on
  // screen and makes each token a pure append to the tail.
  expect(draftFrames(d.client).at(-1)).toBe('🔧 `web_search`…\n─────\none two');
});

test('a turn ending on a tool_start leaves the feed standing', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: 'thinking ' };
    await settle();
    yield { type: 'tool_start', name: 'web_search', args: {} };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  // No final rewrite: the reply below goes out as a real message, and a real
  // message wipes every live draft in the chat on its own.
  expect(draftFrames(d.client).at(-1)).toBe(
    '🔧 `web_search`…\n─────\nthinking ',
  );
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'thinking ' }),
    undefined,
  );
});

test('a stream-supplied label outranks the generic 🔧 line', async () => {
  // The skill relabel used to be hardcoded here; it now belongs to /deepagents,
  // which is where knowledge of `read_file` and skill paths actually applies.
  // The core only honours whatever label the stream hands it.
  const stream: AgentStream = async function* () {
    yield {
      type: 'tool_start',
      name: 'read_file',
      args: {},
      label: '🧠 load_skill(`food-logging`)…',
    };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  const frames = draftFrames(d.client);
  expect(frames.some((f) => f.includes('🧠 load_skill(`food-logging`)…'))).toBe(
    true,
  );
  expect(frames.some((f) => f.includes('🔧'))).toBe(false);
});

test('the core knows no tool names — an unlabelled read_file stays generic', async () => {
  const stream: AgentStream = async function* () {
    yield {
      type: 'tool_start',
      name: 'read_file',
      args: { file_path: '/skills/food-logging/SKILL.md' },
    };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  const frames = draftFrames(d.client);
  expect(frames.some((f) => f.includes('🔧 `read_file`…'))).toBe(true);
  expect(frames.some((f) => f.includes('🧠'))).toBe(false);
});

test('formatTool outranks the label, and null hides the call outright', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'write_journal', args: { kcal: 620 } };
    await settle();
    yield { type: 'tool_start', name: 'noisy', args: {}, label: '🧠 noisy…' };
    await settle();
    yield { type: 'tool_start', name: 'deferred', args: {}, label: '🧠 kept…' };
    await settle();
    yield { type: 'token', text: 'done' };
    await settle();
  };
  const d = deps({
    agentStream: stream,
    draftConstants: { throttleMs: 0 },
    // `null` must not read as "no opinion": a `??` chain would fall through to
    // the label and print the very line the formatter asked to suppress.
    formatTool: ({ name, args }: { name: string; args: unknown }) =>
      name === 'write_journal'
        ? `📝 logged: ${(args as { kcal: number }).kcal} kcal`
        : name === 'noisy'
          ? null
          : undefined,
  });
  await runTelegramTurn(d);

  expect(draftFrames(d.client).at(-1)).toBe(
    '📝 logged: 620 kcal\n🧠 kept…\n─────\ndone',
  );
});

test('the plan is a feed block anchored where it first appeared', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'load', args: {} };
    await settle();
    yield {
      type: 'plan',
      items: [
        { text: 'find', status: 'active' },
        { text: 'count', status: 'pending' },
      ],
    };
    await settle();
    yield { type: 'tool_start', name: 'query', args: {} };
    await settle();
    yield {
      type: 'plan',
      items: [
        { text: 'find', status: 'done' },
        { text: 'count', status: 'active' },
      ],
    };
    await settle();
    yield { type: 'token', text: 'answer' };
    await settle();
  };
  const d = deps({ agentStream: stream, draftConstants: { throttleMs: 0 } });
  await runTelegramTurn(d);

  // The second plan updates the block in place: it neither appends a second plan
  // nor moves — `query` stays BELOW the plan, where it landed.
  expect(draftFrames(d.client).at(-1)).toBe(
    [
      '🔧 `load`…',
      '📋 Plan',
      '✔️ f̶i̶n̶d̶',
      '🔘 count',
      '🔧 `query`…',
      '─────',
      'answer',
    ].join('\n'),
  );
  // And none of the feed reaches the persisted message.
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: 'answer' }),
    undefined,
  );
});

test('feedConstants override icons and heading without losing the rest', async () => {
  const stream: AgentStream = async function* () {
    yield {
      type: 'plan',
      items: [
        { text: 'go', status: 'active' },
        { text: 'wait', status: 'pending' },
      ],
    };
    await settle();
  };
  const d = deps({
    agentStream: stream,
    draftConstants: { throttleMs: 0 },
    // Only `active` is overridden — a wholesale replace of `icons` would leave
    // the other two rendering as `undefined`.
    feedConstants: { planTitle: '📋 План', icons: { active: '⏳' } },
  });
  await runTelegramTurn(d);

  expect(draftFrames(d.client).at(-1)).toBe('📋 План\n⏳ go\n⬜ wait');
});

test('a tool-only turn warns, sends nothing, and keeps its feed on screen', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'web_search', args: {} };
    await settle();
  };
  const warn = vi.fn();
  const d = deps({
    agentStream: stream,
    draftConstants: { throttleMs: 0 },
    log: { warn, error: () => {} },
  });
  await runTelegramTurn(d);

  expect(warn).toHaveBeenCalledWith('telegram empty reply', { chatId: 1 });
  expect(d.client.sendMessage).not.toHaveBeenCalled();
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
  // Blanking the draft was the pre-0.9 move here. Watching a live chat showed
  // what it actually buys: empty draft text renders an EMPTY bubble, it does not
  // clear the draft — so it traded a feed that at least says what the turn did
  // for a blank box. `emptyNotice`, being a real message, wipes the feed; unset,
  // it expires with the draft in ~30s.
  expect(draftFrames(d.client).at(-1)).toBe('🔧 `web_search`…');
});

test('an invisible-only reply is treated as empty and never sent', async () => {
  // 2026-07-30 prod: the fallback model answered a food-logging turn with a bare
  // U+200B. `trim()` keeps it, so it reached the send path, where Telegram 400s
  // both the HTML and the plain retry — and that second throw escaped the turn.
  const stream: AgentStream = async function* () {
    yield { type: 'tool_start', name: 'log_meal', args: {} };
    await settle();
    yield { type: 'token', text: '\u200B' };
    await settle();
  };
  const warn = vi.fn();
  const d = deps({
    agentStream: stream,
    draftConstants: { throttleMs: 0 },
    log: { warn, error: () => {} },
  });
  await runTelegramTurn(d);

  expect(warn).toHaveBeenCalledWith('telegram empty reply', { chatId: 1 });
  expect(d.client.sendRichMessage).not.toHaveBeenCalled();
  // The feed stands, same as the tool-only turn above — see that test for why
  // blanking it is worse than leaving it.
  // The exact frame, not `not.toBe('')`: `.at(-1)` is `undefined` on zero frames.
  expect(draftFrames(d.client).at(-1)).toBe(
    '\uD83D\uDD27 `log_meal`\u2026\n\u2500\u2500\u2500\u2500\u2500\n\u200B',
  );
});

test('emptyNotice tells the user a completed turn had nothing to say', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: '​' };
  };
  const d = deps({
    agentStream: stream,
    emptyNotice: 'ответ не сформировался',
  });
  await runTelegramTurn(d);

  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ chatId: 1, text: 'ответ не сформировался' }),
    undefined,
  );
  // Completed, not errored: the tool writes stand, so nothing is rolled back.
  expect(d.checkpointer.rollback).not.toHaveBeenCalled();
});

test('emptyNotice is skipped when the turn was aborted via signal', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: '   ' };
  };
  const d = deps({
    agentStream: stream,
    emptyNotice: 'nothing',
    signal: AbortSignal.abort(),
  });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).not.toHaveBeenCalled();
});

test('emoji held together by ZWJ is a real reply, not a blank one', async () => {
  const stream: AgentStream = async function* () {
    yield { type: 'token', text: '👨‍👩‍👧' };
  };
  const d = deps({ agentStream: stream });
  await runTelegramTurn(d);
  expect(d.client.sendMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: '👨‍👩‍👧' }),
    undefined,
  );
});

test('opts.configurable is forwarded to agentStream context', async () => {
  let capturedConfigurable: Record<string, unknown> | undefined;
  const stream: AgentStream = async function* (_input, ctx) {
    capturedConfigurable = ctx.configurable;
    yield { type: 'token', text: 'ok' };
  };
  await runTelegramTurn(
    deps({ agentStream: stream, configurable: { pendingImages: ['img1'] } }),
  );
  expect(capturedConfigurable).toEqual({ pendingImages: ['img1'] });
});

test('context.configurable is undefined when opts.configurable is not set', async () => {
  let capturedConfigurable: Record<string, unknown> | undefined;
  const stream: AgentStream = async function* (_input, ctx) {
    capturedConfigurable = ctx.configurable;
    yield { type: 'token', text: 'ok' };
  };
  await runTelegramTurn(deps({ agentStream: stream }));
  expect(capturedConfigurable).toBeUndefined();
});
