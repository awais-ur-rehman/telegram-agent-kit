# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`telegram-agent-kit` is a published npm library (ESM-only) that wires LLM agents to
Telegram. It is **runtime-agnostic** with **zero runtime dependencies in the core** —
all I/O is supplied by the caller through thin injected interfaces. It runs on Node 20+,
Bun, Deno, and the browser (core layers).

## Commands

```sh
npm run build       # tsup → dist/ (ESM + .d.ts) for both entry points
npm run typecheck   # tsc --noEmit
npm test            # vitest run (whole suite)
npm run lint        # biome check .
npm run format      # biome format --write .
```

Run a single test file or test by name:

```sh
npx vitest run test/format/md-to-html.test.ts          # one file
npx vitest run -t "renders nested bold"                # by test name
npx vitest                                             # watch mode
```

**Build before test if touching `/deepagents`.** `test/deepagents/no-peers.test.ts`
greps `dist/deepagents/index.js` to prove the built bundle carries no runtime import of
the optional peers; it silently skips when `dist/` is absent. CI runs `build` before
`test` for exactly this reason — replicate that ordering locally when verifying the
peer-isolation guarantee.

## Architecture: three layers + an optional adapter

The dependency direction is strictly **Bridge → Draft → Formatting**; lower layers
never import higher ones. Each layer has a barrel `index.ts`; `src/index.ts` re-exports
all three layers (but not `/deepagents`, which is a separate package entry point).

- **Formatting (`src/format/`, pure, zero deps):** `mdToTelegramHtml`,
  `chunkText` / `safeSlice` / `chunkRich`, and the rich helpers `repairRichTables` /
  `neutralizeRichMedia` / `extractTrailingCover`. Browser-safe.
- **Draft engine (`src/draft/`):** `createDraftStreamer` — a throttle / keepalive /
  typing-heartbeat / preview-cap / drain state machine that animates a single live
  Telegram draft from a growing text. Tunables live in `src/draft/constants.ts`
  (`DEFAULT_DRAFT_CONSTANTS`), overridable per call.
- **Turn-loop bridge (`src/bridge/`):** `runTelegramTurn` orchestrates one turn
  (`turn-loop.ts`) and `sendReply` orchestrates the final send (`send.ts`). The four
  injectable interfaces are defined in `interfaces.ts`. `createTurnQueue`
  (`turn-queue.ts`) serializes turns per `ChatKey` — the turn loop itself holds no
  state, so overlapping turns on one thread corrupt each other.
- **`/deepagents` (`src/deepagents/`, optional subpath):** `toAgentStream` / `streamAgent`
  adapt a deepagents/langgraph agent to the kit's `AgentStream` contract. Shipped as a
  separate entry (`telegram-agent-kit/deepagents`) so the core never pulls in langchain.

### The four injected interfaces (`src/bridge/interfaces.ts`)

The caller implements these; the kit owns all orchestration over them.

- **`BotClient`** — *raw* Bot API transport primitives, one HTTP call each, **no**
  chunking/rendering/fallback. Each must throw `TelegramApiError` (from `src/errors.ts`)
  on a Bot API error so the deterministic-400 fallbacks fire.
- **`AgentStream`** — `(input, { threadId, signal, configurable }) => AsyncIterable<RenderEvent>`.
  The `threadId` MUST reach the agent so the checkpointer snapshots/rolls back the same
  thread. `configurable` is an optional pass-through bag forwarded verbatim from
  `runTelegramTurn`'s `configurable` option.
- **`Checkpointer`** — `{ snapshot(threadId), rollback(threadId, id) }`.
- **`ThreadStore`** — `{ resolve(key, now), touch(key, now) }`, keyed by
  `{ chatId, agentId }` so two bots sharing one chat id don't collide.

## Load-bearing invariants

These are intentional and enforced by tests — preserve them when editing.

- **Totality of `mdToTelegramHtml`:** it must **never throw** on arbitrary LLM output
  (pinned by `test/format/md-to-html.test.ts`). The send path also wraps it in
  try/catch as defence-in-depth and falls back to plain text on `null`. It auto-closes
  unclosed marks/fences only in `partial: true` (draft) mode.
- **Deterministic-400 fallback chains** keyed off `isBadRequest(err)` (a
  `TelegramApiError` with `error_code === 400` — "rejected, not delivered", safe to
  retry without double-send). A non-400 error always propagates. The chains:
  rich → classic (`sendRichMessage` → HTML `sendMessage`), HTML → plain text, and
  photo → text. Draft sends additionally flip rich → plain **for the rest of the turn**
  on a 400 without spending the `maxFailures` budget.
- **A 429 is not a draft failure.** `isRateLimited(err)` (429) means throttled, not
  rejected: the draft streamer backs off until `parameters.retry_after` elapses —
  silencing the keepalive *and* the typing heartbeat, which spend the same per-chat
  budget — and does **not** spend the `maxFailures` budget. The floor is 1s, so a
  missing / zero / non-numeric `retry_after` can never degrade into a retry storm.
  Requires the caller's transport to pass the Bot API `parameters` into
  `TelegramApiError`. **Only the draft path does this** — in `send.ts` a 429 is still a
  non-400 and propagates.
- **A draft write must be acknowledged before the final send** — `finalize()`
  waits for it to settle; `drainMs` is a wedged-socket backstop, not a routine
  budget, and tripping it logs `telegram draft drain abandoned`. Rationale lives
  on the `drainMs` field in `src/draft/constants.ts`.
- **`runTelegramTurn` never throws out** — every failure path is caught and logged.
  Ordering matters: snapshot happens only *after* `preStream` (so a skipped turn leaves
  no rollback target); rollback fires only if a snapshot was taken and the turn did not
  complete; draft teardown is idempotent (tracked via `draftTornDown`); `beforeTurn` /
  `afterTurn` hooks are isolated and never abort the turn.
- **`/deepagents` peers are type-only.** `@langchain/core` and `deepagents` are
  *optional* peer deps imported with `import type` only, and externalized in
  `tsup.config.ts`. The built `/deepagents` bundle must contain no runtime import of
  either (the no-peers dist-grep test). The langgraph config shape (`thread_id`) is
  centralized in `src/deepagents/to-agent-stream.ts` — keep it there. That file also
  owns the reserved-key strip (`thread_id`, `thread_ts`, `checkpoint_id`,
  `checkpoint_ns`, `checkpoint_map`, `run_id`, plus any `__pregel_*` LangGraph
  internal-execution key) applied to the caller's `configurable` before merging it
  under the kit-owned `thread_id` (spread last, so it always wins) — pinned by
  `test/deepagents/configurable-strip.test.ts` and `test/deepagents/to-agent-stream.test.ts`.
- **Surrogate-safe splitting:** `chunkText` / `safeSlice` / `chunkRich` must never sever
  a UTF-16 surrogate pair. Limits: classic text `TELEGRAM_LIMIT` 4096 (target 4000),
  rich `RICH_LIMIT` 32768, photo caption 1024.

## Conventions

- **Imports use explicit `.ts` extensions** (e.g. `from './send.ts'`). This is required
  by the tsconfig (`allowImportingTsExtensions`, `moduleResolution: Bundler`,
  `verbatimModuleSyntax`) and is how tsup resolves the source. Match it.
- **`strict` TypeScript**, ESM only (`"type": "module"`). No default exports; everything
  flows through barrel `index.ts` re-exports.
- **Comment the *why*, heavily.** The format/rich modules carry long doc-comments
  explaining each invariant (flanking rules, code-region tracking, fence anchoring).
  When you change behavior there, update the rationale comment too — those comments are
  the spec.
- Formatting: Biome, 2-space indent, single quotes (`biome.json`). Run `npm run format`
  before committing.
- `dist/` and `node_modules/` are gitignored; only `dist/` is published (`files` in
  `package.json`).
