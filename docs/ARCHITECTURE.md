# Architecture

This file holds what the code cannot tell: the modules, the layers, the
patterns, and the numbered invariants with their checks. `CLAUDE.md` holds how
to work: the commands and the conventions. The code comments hold the detail of
each behaviour; this file points at them and does not restate them.

## Bird's-eye view

`telegram-agent-kit` turns one user message into one Telegram reply from an
LLM agent. The caller implements four small interfaces: `BotClient` (raw Bot
API calls), `AgentStream` (the agent as an async iterable of render events),
`Checkpointer` (snapshot and rollback of the agent's thread) and `ThreadStore`
(which thread a chat is on). The kit owns everything between them.
`runTelegramTurn` resolves the thread, snapshots it, streams the agent's events
into one live Telegram draft, renders the final markdown to Telegram HTML,
sends it in chunks with deterministic fallbacks, and rolls the thread back when
the turn fails. `createTurnQueue` keeps two turns of one chat from overlapping.

Three contracts carry a rule that their types cannot state. `BotClient`
throws `TelegramApiError` on a Bot API error, or no 400 fallback fires.
`AgentStream` passes `threadId` to the agent, so the checkpointer snapshots
and rolls back the same thread. `ThreadStore` keys a thread by
`{ chatId, agentId }`, so two bots in one chat do not share it.

The core has no runtime dependency and no `node:` import, so it runs on Node
20+, Bun, Deno and in the browser. The `/deepagents` entry point adapts a
deepagents/LangGraph agent to `AgentStream`. It is the only code that knows
those libraries, and it imports them as types only.

## Codemap

```
src/
  index.ts        package root: re-exports bridge, draft, format and errors
  errors.ts       TelegramApiError and the two predicates that classify it
  format/         markdown to Telegram HTML; splitting; rich-markdown repairs
  draft/          the live-draft streamer, its tunables, the progress feed
  bridge/         the turn loop, the final send, the turn queue, the interfaces
  deepagents/     adapter: a deepagents/LangGraph agent becomes an AgentStream
test/             the same folders as src/
tsup.config.ts    the two build entries; the optional peers are externalized
```

## Modules

Each module is a folder with an `index.ts`, except `errors`, which is one
file. The `index.ts` is the module's part of the package's public API. The
three core modules re-export every file with `export *`; `src/deepagents/index.ts` exports
by name, because the subpath surface is curated. `src/index.ts` is the package
root and re-exports the core modules and `errors.ts`.

- **format** (`src/format/`). Pure text functions: markdown to Telegram HTML
  (`md-to-html.ts`), surrogate-safe splitting (`chunk.ts`), GFM table repair,
  media neutralization, trailing-cover extraction and the `needsRich` gate
  (`rich.ts`). Imports nothing.
- **draft** (`src/draft/`). Animates one live Telegram draft from a growing
  text: throttle, keepalive, typing heartbeat, preview cap, drain
  (`draft-streamer.ts`); the plan and tool-progress feed composed above the
  reply (`feed.ts`); the tunables and their defaults (`constants.ts`,
  overridable per call).
- **bridge** (`src/bridge/`). One turn end to end (`turn-loop.ts`), the final
  send with its fallback chains (`send.ts`), serialization of turns per
  `ChatKey` (`turn-queue.ts`), and the four contracts the caller implements
  with the event types they exchange (`interfaces.ts`).
- **errors** (`src/errors.ts`). `TelegramApiError`, `isBadRequest` (400:
  rejected, not delivered) and `isRateLimited` (429: throttled). The one place
  that classifies a Bot API failure.
- **deepagents** (`src/deepagents/`). `toAgentStream` and `streamAgent`:
  LangGraph `streamEvents` become `RenderEvent`s. Owns the `thread_id` config
  shape, the reserved-key strip, and the tool semantics of deepagents (the plan
  from `write_todos`, a skill load from `read_file`). Shipped as the second
  package entry `telegram-agent-kit/deepagents`, so the core never pulls in
  LangChain.

## Layers

The import order inside the kit is `deepagents → bridge → draft → format`, with
`errors` below `bridge` and `draft`. A module imports only modules below it
(I-1 to I-3). The roles:

- **Edge.** `src/bridge/turn-loop.ts` takes the user's text and drives the
  caller's interfaces; `src/bridge/send.ts` is the outbound edge to the Bot
  API. `src/deepagents/` is the edge on the agent's side.
- **Logic.** `src/draft/` decides when and what to write to the live draft.
  `src/format/` decides what the text becomes.
- **Data and transport.** Not in the kit. `BotClient`, `Checkpointer` and
  `ThreadStore` are the caller's, and the turn loop holds no state between
  turns. That is why `createTurnQueue` exists: the turn loop cannot serialize
  itself.

## Patterns

Kept everywhere, and not obvious from one file.

- **Rich is a gate, not a mode.** Wherever text goes to Telegram
  (`src/bridge/send.ts`, `src/draft/draft-streamer.ts`), `needsRich` decides
  per chunk or per write whether the rich renderer is used. `rich: true` means
  "rich when it buys something".
- **Log lines are a contract.** Every log line is a fixed string prefixed
  `telegram ` plus a data object, through the injected `Logger`. Tests assert
  on the strings.

## Invariants

Each invariant is one MUST statement. A `Check:` line is a machine check
(`grep`, `lines`, `files`) that passes on the current tree; the paths on a
`debt` list break it today and are known debt. An invariant with no `Check:`
line is review only, and the test named with it pins it.

### Structure

- **I-1.** `src/format/` and `src/errors.ts` import nothing from another
  module of `src/`.
  Check: grep `from '\.\./|from '\./(bridge|draft|deepagents|format|index)` in `src/format` `src/errors.ts`.

- **I-2.** `src/draft/` never imports `src/bridge/` or `src/deepagents/`.
  Check: grep `from '\.\./(bridge|deepagents)/` in `src/draft` debt `src/draft/draft-streamer.ts` `src/draft/feed.ts`.
  The two debt files import `BotClient`, `Logger` and `PlanItem` as types from
  `src/bridge/interfaces.ts`: type-only, but upward.

- **I-3.** The core never imports `src/deepagents/`; `src/index.ts` does not
  re-export it.
  Check: grep `(from |import\()'\.\.?/deepagents/` in `src` except `src/deepagents`.

- **I-4.** The core imports nothing from outside `src/`: no package and no
  `node:` built-in.
  Check: grep `^((import|export|\})[^']*from|import) '[^.]|import\('[^.]` in `src` except `src/deepagents`.

- **I-5.** `src/deepagents/` imports `@langchain/*` and `deepagents` with
  `import type` only.
  Check: grep `^(import|export) ([^t]|t[^y]|ty[^p]|typ[^e]|type[^ ])[^']*from '(@langchain|deepagents)|import\('(@langchain|deepagents)|^import '(@langchain|deepagents)` in `src/deepagents`.
  The grep reads one line, so a multi-line runtime import escapes it.
  `test/deepagents/no-peers.test.ts` checks the built bundle for the same
  thing, and `tsup.config.ts` externalizes both peers.

- **I-6.** Only `src/deepagents/to-agent-stream.ts` spells the LangGraph
  `thread_id` key.
  Check: grep `thread_id` in `src` except `src/deepagents/to-agent-stream.ts`.

- **I-7.** The core names no agent tool. The core renders what the stream
  labels or what the caller's `formatTool` returns; tool semantics live in
  `src/deepagents/`.
  Check: grep `'(write_todos|read_file)'` in `src` except `src/deepagents`.
  The grep is a canary for the two names deepagents uses today. Pinned by
  `test/bridge/turn-loop.test.ts` ("the core knows no tool names").

- **I-8.** Only `src/errors.ts` reads `error_code` to classify a failure. The
  rest of the kit asks `isBadRequest` or `isRateLimited`.
  Check: grep `error_code *[!=]=` in `src` except `src/errors.ts`.

- **I-9.** The kit never writes to the console. Every log line goes through
  the injected `Logger`.
  Check: grep `console\.` in `src`.

- **I-10.** No default export in `src/` or `test/`.
  Check: grep `export default|as default` in `src` `test`.
  The root tool configs (`tsup.config.ts`, `vitest.config.ts`) need one and
  are outside the check.

- **I-11.** Every relative import in `src/` and `test/` carries its `.ts`
  extension.
  Check: grep `(from |import\()'\.([^']*[^s]|[^']*[^t]s|[^']*[^.]ts)'` in `src` `test`.

### Limits of decomposition

At v0.9.1 the 90th percentile of the project's own sizes was 400 lines for a
file and 5 code files for a folder, and `src/bridge/turn-loop.ts` and
`src/bridge/` were on those limits. The limits leave room for the v1.0
milestone. A new number needs an ADR.

- **I-12.** No code file in `src/` or `test/` has more than 500 lines.
  Check: lines 500 in `src` `test` debt `test/bridge/turn-loop.test.ts` `test/format/rich.test.ts`.

- **I-13.** No folder in `src/` or `test/` holds more than 8 code files of its
  own.
  Check: files 8 in `src` `test`.

### Behaviour

Review only. The code comments at the named places are the spec.

- **I-14.** `mdToTelegramHtml` never throws, whatever the input. Pinned by
  `test/format/md-to-html.test.ts`. `src/bridge/send.ts` wraps it anyway and
  falls back to plain text.

- **I-15.** A Bot API 400 falls back along a fixed chain, and any other error
  propagates out of `src/bridge/send.ts`: rich → classic HTML → plain text,
  and photo → text. On a 400 to a rich draft write, the draft streamer flips
  rich → plain for the rest of the turn and does not spend `maxFailures`.
  `test/bridge/send.test.ts` pins rich → classic and photo → text;
  `test/draft/draft-streamer.test.ts` pins the draft flip.

- **I-16.** A 429 is never a draft failure. The streamer waits `retry_after`
  (floor 1 s), silences the keepalive and the typing heartbeat for that time,
  and does not spend `maxFailures`. Only the draft path does this; in
  `src/bridge/send.ts` a 429 propagates like any non-400. The caller's
  transport must pass the Bot API `parameters` into `TelegramApiError`, or
  the streamer waits the floor. Pinned by `test/draft/draft-streamer.test.ts`.

- **I-17.** The last draft write is acknowledged before the final message is
  sent. `finalize()` waits for the in-flight write; `drainMs` is a
  wedged-socket backstop, and tripping it logs
  `telegram draft drain abandoned`. Rationale on `drainMs` in
  `src/draft/constants.ts`. Pinned by `test/draft/draft-streamer.test.ts`.

- **I-18.** `runTelegramTurn` never throws out. The snapshot is taken only
  after `preStream`; the rollback fires only when a snapshot exists and the
  turn did not complete, and `hooks.shouldRollback` may veto it except on a
  cancelled turn; draft teardown is idempotent; the hooks are isolated.
  `test/bridge/turn-loop.test.ts` pins all of it except a throwing
  `beforeTurn` or `preStream`.

- **I-19.** The caller's `configurable` reaches LangGraph with the reserved
  keys stripped (`thread_id`, `thread_ts`, `checkpoint_id`, `checkpoint_ns`,
  `checkpoint_map`, `run_id`, any `__pregel_*`) and the kit's `thread_id`
  spread last. Pinned by `test/deepagents/configurable-strip.test.ts` and
  `test/deepagents/to-agent-stream.test.ts`.

- **I-20.** `chunkText`, `safeSlice` and `chunkRich` never sever a UTF-16
  surrogate pair. Limits: `TELEGRAM_LIMIT` 4096 (target 4000), `RICH_LIMIT`
  32768, photo caption 1024 (`src/bridge/send.ts`). Pinned by
  `test/format/chunk.test.ts`.

## Cross-cutting concerns

- **Failure classification** lives in `src/errors.ts`. 400 means rejected, not
  delivered: safe to retry on a degraded path. 429 means throttled: the draft
  waits and does not count it as a failure (I-16). In the send path, a 429 and
  any other non-400 error propagate; in the draft, any other error counts
  toward `maxFailures`.
- **Logging** goes through the injected `Logger` (I-9).
- **Cancellation** is the caller's `AbortSignal`. `runTelegramTurn` forwards
  it to the agent and to the final send. The draft streamer does not take it:
  it aborts its own in-flight write on teardown and when `drainMs` trips. A
  cancelled turn skips the `shouldRollback` veto (I-18).
- **Unicode safety.** Text is cut on UTF-16 code units with a surrogate guard
  (`src/format/chunk.ts`), decorated per grapheme (`src/draft/feed.ts`,
  `Intl.Segmenter`), and judged blank by Unicode properties
  (`src/bridge/send.ts`).

## ADRs

ADRs go to `docs/adr/NNNN-title.md`. Accepted:

- [0001](adr/0001-helpers-above-the-export.md) Helpers above the export
- [0002](adr/0002-short-bodies.md) Short bodies: implicit arrow returns and brace-less `if`
- [0003](adr/0003-constant-case-for-module-values.md) CONSTANT_CASE for every module-level value
- [0004](adr/0004-types-beside-their-code.md) Types beside their code, no `models/` folder
