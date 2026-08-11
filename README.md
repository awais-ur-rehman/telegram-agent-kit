# telegram-agent-kit

> Wire LLM agents to Telegram: render Markdown, stream replies into a live native draft, and drive a snapshot/rollback turn-loop — over thin injected interfaces, with **zero runtime dependencies** in the core.

[![npm](https://img.shields.io/npm/v/telegram-agent-kit.svg)](https://www.npmjs.com/package/telegram-agent-kit)
[![license](https://img.shields.io/npm/l/telegram-agent-kit.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/telegram-agent-kit.svg)](https://www.typescriptlang.org/)

ESM-only. Runs on **Node 20+, Bun, Deno, and the browser** (the formatting core).

---

## Why this exists

Connecting an LLM agent to a Telegram bot looks simple until you hit the edges:

- LLMs emit arbitrary Markdown — Telegram speaks a small, strict HTML subset. A
  single unclosed tag makes the Bot API reject the whole message.
- Token streaming into a *live draft* means you render **partial** Markdown many
  times a second, where marks and fences are routinely mid-token.
- A failed turn must roll back cleanly so the conversation thread isn't corrupted.

`telegram-agent-kit` solves these once. Notably, it's the only JS package that
renders Markdown to **Telegram-HTML** with **totality** (never throws on arbitrary
LLM output) *and* a **streaming/partial** mode (auto-closes unclosed marks and
fences, so a live draft never flashes broken markup).

It is **runtime-agnostic**: you supply all I/O through small injected interfaces,
and the kit owns the orchestration. No HTTP client, no framework, no globals.

## Features

- **Markdown → Telegram-HTML** that never throws, with a `partial` mode for live drafts.
- **Live draft streaming** — a throttle / keepalive / typing-heartbeat / drain state
  machine that animates one native Telegram draft from a growing string.
- **Turn-loop orchestration** — `snapshot → stream → animate → finalize → reply`,
  with a vetoable rollback on error and a guarantee it never throws out.
- **Resilient send path** — automatic chunking, surrogate-safe splitting, and
  deterministic `400` fallbacks (rich → HTML → plain text; photo → text).
- **Optional deepagents adapter** on a separate subpath, so the core never pulls in
  langchain.

## Installation

```sh
npm install telegram-agent-kit
```

The optional `telegram-agent-kit/deepagents` subpath needs its peers — install them
only if you use it:

```sh
npm install @langchain/core deepagents
```

## Quick start

Implement a thin `BotClient` over the Bot API, then drive one turn per incoming
message. The example uses the deepagents adapter, but any `AgentStream` works.

```ts
import { createTurnQueue, runTelegramTurn, TelegramApiError, type BotClient } from 'telegram-agent-kit';
import { toAgentStream } from 'telegram-agent-kit/deepagents';

// 1. Raw Bot API primitives — one HTTP call each. Throw TelegramApiError on a
//    Bot API error so the kit's deterministic-400 fallbacks can fire.
const client: BotClient = {
  sendMessage:        (p, signal) => call('sendMessage',        { chat_id: p.chatId, text: p.text, parse_mode: p.parseMode }, signal),
  sendRichMessage:    (p, signal) => call('sendMessage',        { chat_id: p.chatId, text: p.markdown },                       signal),
  sendPhoto:          (p, signal) => call('sendPhoto',          { chat_id: p.chatId, photo: p.url, caption: p.caption, parse_mode: p.parseMode }, signal),
  sendChatAction:     (p, signal) => call('sendChatAction',     { chat_id: p.chatId, action: p.action ?? 'typing' },          signal),
  sendMessageDraft:   (p, signal) => call('sendMessageDraft',   { chat_id: p.chatId, draft_id: p.draftId, text: p.text },     signal),
  sendRichMessageDraft:(p, signal) => call('sendRichMessageDraft',{ chat_id: p.chatId, draft_id: p.draftId, text: p.markdown },signal),
};

// 2. Drive one turn — inside the queue, so turns on one chat never overlap.
//    Create the queue ONCE at startup, not per message.
const queue = createTurnQueue();

const chatKey = { chatId, agentId: 'main' };

await queue(chatKey, () => runTelegramTurn({
  chatKey,
  userText,
  draftId: updateId,        // non-zero, unique per turn — reused for every draft write
  rich: true,
  client,
  agentStream: toAgentStream(agent),   // your deepagents agent
  checkpointer: {
    snapshot: (threadId)     => saver.snapshotId(threadId),
    rollback: (threadId, id) => saver.rollbackThread(threadId, id),
  },
  threadStore: {
    resolve: (key)      => threads.resolve(key.chatId, key.agentId),
    touch:   (key, now) => threads.touch(key.chatId, key.agentId, now),
  },
  log: console,
}));

// Thin transport helper. Bound every call with a ceiling of your own: the kit
// awaits a draft write's response because that response is the only thing
// ordering it ahead of the message that replaces it, and only the transport can
// actually cancel a request — the kit's `drainMs` can stop waiting, not sending.
async function call(method: string, body: unknown, signal?: AbortSignal) {
  const ceiling = AbortSignal.timeout(30_000);
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, ceiling]) : ceiling,
  });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    // Pass `parameters` through: on a 429 the draft streamer backs off by its
    // `retry_after` instead of counting the throttle as a transport failure.
    throw new TelegramApiError(res.status, j.description, j.parameters);
  }
}
```

> **Note:** `sendRichMessage` / `sendRichMessageDraft` map to your bot's rich-text
> transport. If your bot has no rich endpoint, point them at plain `sendMessage`
> and set `rich: false` — the kit then renders via HTML only.

> **Note:** `rich: true` means *rich when it buys something*, not *rich always*.
> Drafts and final messages go out rich only for text that needs the rich
> renderer — today, a GFM table (`needsRich`); everything else is classic HTML, so
> ordinary replies keep the client's normal message font. `rich: false` is still
> the kill-switch: HTML only, always.

## How it works

The kit is three layers plus one optional adapter. The dependency direction is
strictly **Bridge → Draft → Formatting**; lower layers never import higher ones,
and the core never imports the adapter.

```
┌─────────────────────────────────────────────────────────────┐
│  /deepagents  (optional subpath)                            │
│  toAgentStream · streamAgent  →  AgentStream                │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Bridge       runTelegramTurn · sendReply · sendText        │
│               + the four interfaces you implement           │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Draft        createDraftStreamer (throttle/keepalive/drain)│
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  Format       mdToTelegramHtml · chunk* · rich helpers      │
│               pure, zero deps, browser-safe                 │
└─────────────────────────────────────────────────────────────┘
```

**Transport vs. orchestration.** You provide *raw* Bot API primitives — one HTTP
call each, no chunking, rendering, or fallback. The kit owns all orchestration over
them: HTML rendering, chunking, the rich → classic and photo → text `400` fallbacks,
and the trailing-cover photo flow.

## One turn at a time per chat

**Turns on the same chat must not overlap.** The kit holds no state between turns, so
nothing inside `runTelegramTurn` serializes them — that is `createTurnQueue`'s job, and
it is the supported way to drive turns:

```ts
import { createTurnQueue, runTelegramTurn } from 'telegram-agent-kit';

const queue = createTurnQueue();   // once, at startup

// per incoming message
await queue(chatKey, () => runTelegramTurn({ chatKey, userText, /* … */ }));
```

Two messages landing back to back start two turns against the same thread, and all
three of a turn's stateful steps then corrupt each other: the second turn's
`checkpointer.snapshot` runs on top of the first one's half-finished state, so its
rollback target rewinds into someone else's turn; both turns animate the chat's single
live draft and overwrite each other's frames; and a rollback in either erases work the
other did. Wrap the whole turn, not just the stream — all three steps have to be inside.

Keyed by the whole `ChatKey`, so two bots sharing one chat id never wait on each other.
A rejecting task doesn't wedge the turns queued behind it, and each caller still gets
its own task's result. Drained chains are dropped, so a bot serving many chats doesn't
retain one promise per chat it ever saw.

Two things to avoid. **Await the returned promise** — a rejection from your own callback
reaches nobody else, and an unhandled one takes the process down on Node. And **don't
call the queue for the same key from inside a queued task** (a hook starting a follow-up
turn for its own chat): it waits on a tail that can't settle until the task waiting on it
returns. Both are inherent to a mutex, not specific to this one.

A queue instance is per-process; a bot on several instances needs a shared lock, which is
the same decision its `ThreadStore` already forces. And a new message always *waits* for
the running turn — it never supersedes it. Superseding means aborting mid-flight, and an
aborted turn is rolled back unconditionally, erasing tool writes that already landed.

## The four interfaces

You implement these; the kit drives them.

| Interface      | Shape                                                                 | Role |
| -------------- | --------------------------------------------------------------------- | ---- |
| `BotClient`    | `sendMessage`, `sendRichMessage`, `sendPhoto`, `sendChatAction`, `sendMessageDraft`, `sendRichMessageDraft` | Raw transport. Each throws `TelegramApiError` on a Bot API error, and bounds itself with a ceiling of its own — only the transport can cancel a request. |
| `AgentStream`  | `(input, { threadId, signal, configurable }) => AsyncIterable<RenderEvent>` | Your agent. `threadId` **must** reach it so the checkpointer writes to the snapshotted thread. `configurable` is an optional pass-through bag forwarded verbatim from `runTelegramTurn`'s `configurable` option. |
| `Checkpointer` | `{ snapshot(threadId), rollback(threadId, id) }`                       | Per-thread snapshot/rollback for clean recovery on a failed turn. |
| `ThreadStore`  | `{ resolve(chatKey, now), touch(chatKey, now) }`                      | Maps `{ chatId, agentId }` to a thread id (so two bots over one chat id don't collide). |

A `RenderEvent` is one of `token`, `tool_start`, `plan` or `error`. `token` text is
appended to the live draft *and* to the reply that gets sent. `tool_start` and `plan`
feed the draft only, and **never** become part of the sent message. An `error` rolls the
turn back (unless you veto it — see below), logs the message, and — if you pass
`errorNotice` — tells the user in the chat instead of going silent.

A turn can also *complete* with nothing to say: it ended on a tool call, or the model
answered with invisible characters only (a bare U+200B counts as text for `trim()` but is
empty to the Bot API). Both are treated as an empty reply — logged, and — if you pass
`emptyNotice` — said out loud. The draft is **not** blanked in either case: empty draft
text renders an empty bubble rather than clearing the draft, so the feed is left standing
as the only record of what the turn did, and it expires with the draft in ~30s (or the
moment `emptyNotice` lands, since any real message wipes every live draft in the chat).
The same check guards `sendText` itself, so a *direct* caller (a background job handing
model output to `sendReply`) skips the send — with a `telegram blank send skipped`
warning — instead of throwing a Bot API 400. That notice is a **separate** line from
`errorNotice` on purpose: an empty turn is not rolled back, so whatever its tools wrote
stands, and "it broke" would invite a re-send that repeats the write.

## The draft feed: plan and tool progress

While a turn runs, the draft shows a **feed** above the growing answer — the agent's plan
with per-step progress, plus a line per tool call:

```
🧠 load_skill(`nutrition`)…
📋 Plan
✔️ f̶i̶n̶d̶ ̶t̶h̶e̶ ̶w̶e̶e̶k̶'̶s̶ ̶e̶n̶t̶r̶i̶e̶s̶
🔘 total the calories
⬜ compare against the target
🔧 `query_journal`…
📝 logged: lunch, 620 kcal
─────
Over the week you ate 14,200 kcal —
```

Nothing here reaches the sent message: the final `sendMessage` carries only the reply, and
a real message wipes every live draft in the chat, so the feed disappears on its own.

Three properties are load-bearing, and all three were settled by watching a live chat
rather than reasoned about:

- **The reply is always last.** The client repaints every character of a draft whose
  middle changed, so a streaming token must be a pure append to the tail. Put the feed
  below the answer and every token repaints the whole draft.
- **The feed is append-only, and the plan is a block *in* it** — anchored where the agent
  first wrote it, not pinned as a header. A header reorders the feed the instant the plan
  arrives (a tool line that was on top jumps under it); anchoring it means nothing ever
  moves. Repaints then cost one plan status flip or one tool call, not one token.
- **Only one live draft exists per chat.** Writing with a second `draft_id` *replaces* the
  bubble rather than adding one, so plan and answer share a single draft. (The MTProto
  docs suggest otherwise; the Bot API does not behave that way.)

With `telegram-agent-kit/deepagents` this needs **no wiring at all** — the adapter turns
`write_todos` into `plan` events and labels skill loads (a `read_file` on
`/skills/<name>/SKILL.md`). Note that deepagents 1.12 dropped `write_todos` from its
default middleware stack (it now ships only in the Codex harness profile), so on 1.12+
pass `middleware: [todoListMiddleware()]` (from `langchain`) to `createDeepAgent` if you
want plans. Two optional knobs shape the rest:

```ts
await runTelegramTurn({
  // …
  feedConstants: {
    planTitle: '📋 План',              // the heading defaults to English
    icons: { active: '⏳' },           // merged key by key, not replaced wholesale
    maxLines: 5,                       // status lines kept; the plan is never evicted
  },
  // Your tools in your words. `null` hides a call, `undefined` defers to the
  // stream's own label and then to the bare `🔧 \`name\`…`.
  formatTool: ({ name, args }) =>
    name === 'write_journal'
      ? `📝 logged: ${(args as { meal: string }).meal}`
      : name === 'read_state'
        ? null
        : undefined,
});
```

Everything else — `renderFeed`, `strikeThrough`, `PLAN_BLOCK`, `DEFAULT_FEED_CONSTANTS` —
is exported if you want to render a feed somewhere else, but no turn needs it.

If your `AgentStream` is not deepagents, emit `plan` events yourself
(`{ type: 'plan', items: [{ text, status: 'pending' | 'active' | 'done' }] }`, the whole
list every time — the kit does not reconcile deltas) and optionally set `label` on a
`tool_start` to suggest a line for it.

## Conditional rollback

Rolling a failed turn back undoes **memory, never consequences**. Tools that finished
before the turn died have already written to the outside world — notes, journal rows,
tables — and no checkpoint rewind touches those. Erase the turn and the agent no longer
remembers writes it really made, so the next turn reads its own output as foreign and
starts "repairing" it.

Which of your tools write is knowledge the kit cannot have, so it asks:

```ts
hooks: {
  // false → keep the failed turn in the thread; true → rewind, as always.
  shouldRollback: async ({ threadId, startedAt, error, chatKey, userText }) =>
    !(await audit.hadWritesSince(threadId, startedAt)),
},
keptNotice: 'Ход упал на середине. Часть записей уже сделана — не повторяй, проверь.',
```

`threadId` is the same id your `AgentStream` got. `startedAt` is `Date.now()` pinned
before the stream, so no tool of this turn can predate it — deliberately the **wall
clock, not the injectable `opts.now`**, which is your domain clock for the thread store
and may legitimately run hours off real time (feeding it a message's send time so a
backlogged message is filed into the day it was sent is a real pattern). Compare
`startedAt` against timestamps written by that same wall clock. Rules:

- **No predicate → unconditional rollback**, byte for byte the pre-0.8.0 behaviour.
- **Cancellation (`signal`) is exempt** — a cancelled turn is always rolled back, the
  predicate isn't consulted. Mind this if you use `signal` as a turn *budget* rather than
  for shutdown: a timed-out turn that already wrote gets erased anyway, which is the very
  case the predicate exists for. Cancel that way and you want the veto on every path —
  open an issue rather than working around it.
- **A predicate that throws keeps the turn** and never breaks the loop. The two wrong
  answers aren't symmetric: a turn wrongly kept is one stale thread entry you can see and
  fix, a turn wrongly rolled back silently desyncs memory from real writes.
- **It is awaited unbounded**, like every other hook here, and runs after the draft is
  torn down but before the notice — a predicate that hangs parks the turn with a dead
  draft and no `afterTurn`. Bound your own I/O.
- Guards both failure paths — the `error` event *and* a mid-stream throw. `error` reaches
  the predicate as a bare message on both (an `Error` is unwrapped, not stringified).
- `keptNotice` replaces `errorNotice` for a kept turn (and falls back to it when unset),
  because "sorry, try again" is the one thing the user must not do when the writes stand.
  On the mid-stream-throw path only a *kept* turn speaks: a rolled-back one stays silent
  there, exactly as it did before 0.8.0.

**What a kept turn leaves in the thread.** Measured against `@langchain/langgraph` 1.4.8
with a `MemorySaver`, killing a model → tool → model loop with `GraphRecursionError` (the
failure from the incident this feature comes from): the thread keeps the human message,
every `AIMessage` with its `tool_calls`, and a `ToolMessage` for every tool that actually
completed — one checkpoint per super-step, the first written *before* the model ran. So
the kept turn is an honest record of what happened, not a fragment: the agent's memory
now matches the rows its tools wrote. Two caveats. The graph is left mid-run
(`getState().next` points at the node that was about to run, with a pending task), and
the turn has no final assistant message — the next user message appends to that state and
runs from there. Judge for yourself whether your graph resumes cleanly from it; if it
doesn't, that's an argument for rolling back and reconciling the writes by hand.

## API reference

### Core entry — `telegram-agent-kit`

**Formatting** (pure, zero deps)

- `mdToTelegramHtml(md, opts?)` — Markdown → Telegram-HTML. Never throws. `opts.partial`
  auto-closes unclosed marks/fences for live drafts.
- `chunkText(text)` / `safeSlice(text, max)` / `chunkRich(md)` — surrogate-safe splitting
  (classic limit 4096, rich limit 32768).
- `repairRichTables(md)` · `neutralizeRichMedia(md)` · `extractTrailingCover(reply)` — rich helpers.
- `needsRich(md)` — does this text need the rich renderer (today: does it contain a GFM
  table, outside code)? The gate behind `rich: true`; everything else goes classic.

**Draft engine**

- `createDraftStreamer(deps)` → `{ start(), push(fullText), finalize(), abort() }`.
- `DEFAULT_DRAFT_CONSTANTS` / `DraftConstants` — overridable tunables (throttle, keepalive,
  typing heartbeat, preview cap, drain, …).
- `renderFeed(blocks, plan, reply, overrides?)` — compose one draft frame (see
  [The draft feed](#the-draft-feed-plan-and-tool-progress)). `PLAN_BLOCK` marks the plan's
  slot in `blocks`; `strikeThrough(text)` is the U+0336 overlay used on done steps, applied
  per grapheme so emoji sequences survive. `DEFAULT_FEED_CONSTANTS` / `FeedConstants` /
  `FeedOverrides` are the knobs.

**Bridge**

- `runTelegramTurn(opts)` — orchestrate one turn. Never throws out; every failure is caught and logged.
  Accepts an optional `configurable` bag forwarded to your `AgentStream` as `context.configurable`,
  for passing per-turn data (e.g. `pendingImages`) to the agent without widening the core input type.
  Pass `errorNotice` (plain text, your language) to have a failed turn say so in the chat —
  omit it and the user just sees the draft stop, which reads as being ignored. Pass
  `emptyNotice` for the same reason on a turn that completed with no reply text, and
  `keptNotice` for a failed turn your `hooks.shouldRollback` kept (see
  [Conditional rollback](#conditional-rollback)). `feedConstants` and `formatTool` shape the
  draft feed (see [The draft feed](#the-draft-feed-plan-and-tool-progress)).
- `createTurnQueue()` → `(chatKey, task) => Promise` — serializes turns per `ChatKey`. Turns on
  one chat must not overlap; wrap every `runTelegramTurn` call in it (see
  [One turn at a time per chat](#one-turn-at-a-time-per-chat)).
- `sendReply(client, chatId, reply, opts, signal?)` / `sendText(...)` — the send path on its own.
  `opts` is `{ rich: boolean, log: Logger }`, with the same `rich` semantics as above.
- Types: `BotClient`, `AgentStream`, `Checkpointer`, `ThreadStore`, `RenderEvent`, `PlanItem`,
  `ChatKey`, `Logger`, `TurnContext`, `RollbackContext`, `TurnQueue`.

**Errors**

- `TelegramApiError` — throw this from `BotClient` primitives (carries `error_code`, `description`
  and the Bot API's `parameters`, whose `retry_after` the draft streamer honours on a `429`).
- `isBadRequest(err)` — true only for a deterministic `400` (rejected, safe to retry on a degraded path).
- `isRateLimited(err)` — true for a `429` (throttled, not rejected — wait `parameters.retry_after`).

### Optional entry — `telegram-agent-kit/deepagents`

- `toAgentStream(agent)` → `AgentStream` — adapts a deepagents/langgraph agent to the kit's contract.
  The `context.configurable` bag is merged into the LangGraph `RunnableConfig`, but the reserved keys
  `thread_id`, `thread_ts`, `checkpoint_id`, `checkpoint_ns`, `checkpoint_map`, and `run_id` — plus any
  `__pregel_*` LangGraph internal-execution key — are stripped so the kit retains full control over
  checkpoint routing and execution.
- Turns `write_todos` (langchain's todo-list middleware) into `plan` events and labels a skill load (a `read_file`
  on `/skills/<name>/SKILL.md`, how deepagents load skills via progressive disclosure) as
  `🧠 load_skill(\`name\`)…`. This is the **only** place in the kit that knows any tool name; the core
  turn loop knows none. `planItems`, `skillName` and `toolArgs` are exported for reuse.
- `streamAgent(agent, input, config, signal?)` — lower-level event stream if you need direct control.
  Yields tokens from the **root** agent only: a delegated agent (a `subagents` entry, or the built-in
  `task` tool) runs its own model node and LangChain replays its events into the parent stream, so
  without this its monologue would interleave with the reply. Naming the root agent does not change
  what streams.

> `@langchain/core` and `deepagents` are **type-only, optional** peers. The built
> `/deepagents` bundle contains no runtime import of either, so the core stays
> dependency-free.

## Design guarantees

These are intentional and enforced by tests:

- **`mdToTelegramHtml` is total** — it never throws on any LLM output. The send path
  also wraps it and falls back to plain text as defence-in-depth.
- **Deterministic `400` fallbacks** keyed off `isBadRequest`: rich → classic HTML →
  plain text, and photo → text. Any non-`400` error always propagates.
- **`runTelegramTurn` never throws out** — snapshot happens only after a turn isn't
  skipped, rollback fires only on a real failure (and only if `hooks.shouldRollback`
  allows it), and draft teardown is idempotent.
- **Surrogate-safe splitting** — chunking never severs a UTF-16 surrogate pair.
- **One turn at a time per chat** — `createTurnQueue` serializes by `ChatKey`, and one
  task failing never wedges the turns queued behind it.

## Development

```sh
npm run build       # tsup → dist/ (ESM + .d.ts) for both entry points
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run format      # biome format --write .
```

Run a single test:

```sh
npx vitest run test/format/md-to-html.test.ts     # one file
npx vitest run -t "renders nested bold"           # by name
```

> Build before testing if you touch `/deepagents`: one test greps the built bundle
> to prove it carries no runtime import of the optional peers (it skips when `dist/`
> is absent). CI runs `build` before `test` for this reason.

## Contributing

Issues and pull requests are welcome. Before opening a PR, please run
`npm run lint`, `npm run typecheck`, and `npm test` — and `npm run build` if your
change touches the `/deepagents` entry. See [CHANGELOG.md](./CHANGELOG.md) for the
project history.

## License

[MIT](./LICENSE) © Ivan Kalinichenko
