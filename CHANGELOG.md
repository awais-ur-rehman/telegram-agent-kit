# Changelog

## 0.9.1 — 2026-08-11

- **A draft write is now acknowledged before the final send, so a stale frame no
  longer sits above the finished answer.** `finalize()` cut an unfinished draft
  write loose after a second and sent the reply anyway — but aborting cancels only
  our own fetch, never a request Telegram already holds, so an abandoned write
  could still be applied, and one applied *after* the reply can never be cleared
  (the Bot API has no clear-draft call; an empty `text` renders a "Thinking…"
  placeholder rather than erasing). The stale frame then lingered for its ~30s TTL.
  This fired routinely, not exceptionally: the streamer throttles writes to 300ms
  and keeps one in flight, and the last token almost always starts one, so any Bot
  API call slower than a second played the race. `drainMs` goes 1000 → 5000, which
  puts the budget above the API's realistic worst case — tripping it now means a
  wedged socket rather than a merely slow call — and abandoning is logged
  (`telegram draft drain abandoned`), since it is the only remaining path that can
  strand a draft over the reply. `abort()` deliberately still does not wait: the
  turn is already dead there and sends nothing afterwards.
- **`BotClient` implementations are asked to bound their own calls.** The kit's
  timer can only stop waiting; the transport is the one layer that can actually
  cancel a request. The README's example transport gained a ceiling of its own
  (`AbortSignal.timeout` + `AbortSignal.any`) instead of passing the caller's
  signal straight through. A consumer with a bounded transport can close the drain
  race completely by raising `drainMs` above its own ceiling.
- **`/deepagents` on deepagents 1.12+ needs `todoListMiddleware()` passed
  explicitly for plan events.** 1.12 dropped `write_todos` from its default
  middleware stack (it now ships only in the Codex harness profile), so the tool
  call vanishes into the tools node with no plan event. The tool itself is
  unchanged — name and args — so `planItems` needed no change; pass
  `middleware: [todoListMiddleware()]` (from `langchain`) to `createDeepAgent` to
  get plans back. README updated.

## 0.9.0 — 2026-08-01

- **A `429` no longer kills the draft — it backs off by `retry_after`.** Throttling
  is not rejection: the transport is alive and the API said how long to wait.
  Before, a `429` fell into the draft streamer's generic error branch and spent the
  `maxFailures` budget — three in a row and the draft was off for the rest of the
  turn. `TelegramApiError` now carries the Bot API's `parameters`, and
  `isRateLimited` sits next to `isBadRequest`. During the backoff window the draft
  goes quiet **including the keepalive and the typing heartbeat** — both spend the
  same per-chat budget, so hammering a chat that just asked for a pause only
  extends the window being waited out — and the failure budget is untouched. The
  wait has a **1s floor**: `retry_after` arrives from the caller's untyped JSON, and
  `0` / negative / non-numeric produced a deadline already in the past, which — now
  that a `429` no longer spends `maxFailures` — degraded into a retry every 300ms
  for the whole turn, worse than before the fix. Requires the caller's transport to
  pass the Bot API `parameters` into `TelegramApiError` (README updated). Draft path
  only: in `send.ts` a `429` is still a non-400 and propagates. Closes #16.
- **`createTurnQueue()` serializes turns per chat, and is now the supported way to
  drive them.** Two messages landing back to back used to start two turns against
  one thread with nothing between them: the second turn's `snapshot` ran on top of
  the first one's half-finished state (so its rollback target rewound into someone
  else's turn), both animated the chat's single live draft, and a rollback in
  either erased the other's work. The kit holds no state between turns by design,
  so the fix is a queue the caller owns rather than a map hidden inside the turn
  loop — which would also have been per-process, unopt-out-able, and a lie about
  where the state lives. Keyed by the whole `ChatKey`, like the `ThreadStore`, so
  two bots over one chat id never wait on each other. A rejecting task does not
  wedge the turns behind it (the stored chain tail swallows the outcome; the caller
  still gets its own rejection), and drained chains are dropped from the map so a
  bot serving many chats does not retain one promise per chat it ever saw. No
  cancellation policy: a new message waits for the running turn, never supersedes
  it — superseding means aborting mid-flight, and an aborted turn is rolled back
  unconditionally, erasing tool writes that already landed.
- **The live draft carries a feed: the agent's plan with per-step progress, plus a
  line per tool call, above the growing answer.** New `RenderEvent` variant
  `plan` (`{ items: PlanItem[] }`, the whole list every time — no delta
  reconciliation, because `write_todos` and its kin already emit the whole list),
  and `tool_start` gains an optional `label`. Done steps are struck through with
  U+0336 rather than `<s>` + `parse_mode`: the draft primitive is plain text, and
  taking it to HTML would mean escaping the model's reply inside the same frame
  and adding a 400 fallback for a malformed one — a whole failure path bought for
  one visual effect. The strike is applied per **grapheme** (`Intl.Segmenter`), so
  it neither severs a surrogate pair nor lands between an emoji base and its ZWJ.
- **Only one live draft exists per chat, and that shaped the whole design.**
  Measured against a live chat 2026-08-01: writing with a second `draft_id`
  *replaces* the bubble instead of appending one, contradicting the MTProto docs'
  "variable number of live drafts". So plan and answer share a single draft, and
  the layout is what makes it bearable. **The reply is always last** — the client
  repaints every character of a draft whose middle changed, so a streaming token
  has to be a pure append to the tail. **The feed is append-only, and the plan is
  a block *in* it**, anchored where the agent first wrote it rather than pinned as
  a header: a header reorders the feed the instant the plan arrives, and a tool
  line that was on top visibly jumps under it. Repaints now cost one plan status
  flip or one tool call, never one token.
- **The core no longer knows a single tool name.** `skillName` moved out of
  `turn-loop.ts` into `/deepagents`, which also turns the built-in `write_todos`
  into `plan` events. App-specific wording lives in the new `formatTool` option —
  return a string to show it, `null` to hide a noisy call, `undefined` to defer to
  the stream's `label` and then to the bare `🔧 \`name\`…`. `null` is checked
  explicitly rather than through `??`, which would have read an explicit "hide
  this" as a miss and printed the very line the formatter suppressed.
- **`/deepagents` normalizes tool arguments, fixing a bug that predates the
  feed.** LangGraph reports `on_tool_start` args in `data.input`, and that shape
  is not stable: usually the parsed object, but `{ input: "<json string>" }` when
  the call reaches the tool node unparsed. On that shape `skillName` silently saw
  nothing and every skill load fell back to `🔧 read_file…`. `toolArgs` unwraps it
  once at the yield site, so `planItems`, `skillName` and the caller's
  `formatTool` all get real arguments. Unwrapping applies only when the inner
  string parses to a plain object, so a tool whose own parameter is a string named
  `input` keeps its arguments.
- **The final draft rewrite is gone, and both halves of its rationale are now
  measured rather than guessed.** A real message wipes every live draft in the
  chat the moment it lands, so the reply send clears the feed by itself. And empty
  draft text does **not** clear the draft and does **not** render a "Thinking…"
  placeholder (as the aiogram docs claim) — it renders an empty bubble, so
  blanking the draft on an empty turn traded a feed that at least says what the
  turn did for a blank box. The feed now stands until `emptyNotice` lands or the
  draft expires.
- **The tool line is no longer deleted when tokens resume.** That deletion edited
  the middle of the draft on every return to prose, which is precisely what
  triggers a full repaint — so the append-only feed repaints *less* than 0.8.0 did.
- Tuning via `feedConstants` (`planTitle`, `icons` merged key by key rather than
  replaced wholesale, `maxLines`, `separator`). The ring never evicts the plan
  block: dropping it would make the plan vanish on exactly the tool-heavy turn
  where progress matters most. `renderFeed`, `strikeThrough`, `PLAN_BLOCK` and
  `DEFAULT_FEED_CONSTANTS` are exported, but no turn needs them.

## 0.8.0 — 2026-07-31

- **The rollback of a failed turn can be vetoed: `hooks.shouldRollback`.** Rolling
  a turn back undoes MEMORY, never CONSEQUENCES — tools that completed before the
  turn died have already written to the outside world, and no checkpoint rewind
  touches those rows. 2026-07-31, a health bot: a turn ran 5m21s, made 25 write
  calls and died on `Recursion limit of 120 reached`. The kit did exactly what it
  promised — draft killed, thread rewound, `errorNotice` sent — and left six real
  journal lines behind that the agent no longer remembered writing, so the next
  turn started "repairing" its own output. The predicate gets a `RollbackContext`
  (`chatKey`, `userText`, `threadId`, `startedAt`, `error`); returning `false`
  leaves the turn standing. `startedAt` is `now()` pinned before the stream — no
  tool of the turn can predate it — so "were there writes since the turn began?"
  is answerable by a lookup on the app's own audit table. What counts as a
  *writing* tool stays entirely with the app; the kit only asks. It lives in
  `hooks` because that bag is the caller's callbacks and already steers the flow
  (`preStream`'s `{ skip: true }`), not at the top level with the notices.
- **Default unchanged, so this is a drop-in minor.** No predicate → unconditional
  rollback, exactly as in 0.7.2. Cancellation via `signal` is exempt and never
  consults the predicate: the caller asked for the turn to go away, which is a
  different question from whether it is safe to forget. A predicate that **throws**
  keeps the turn and logs — the two wrong answers are not symmetric, since a turn
  wrongly kept is one stale thread entry that is visible and fixable by hand, while
  a turn wrongly rolled back silently desyncs memory from writes that really
  happened. The veto guards both failure paths — the `error` event and a mid-stream
  throw — because both leave the same finished tool calls behind.
- **`startedAt` is the wall clock, not `opts.now()`.** The injectable clock is the
  caller's DOMAIN clock for the thread store — a consuming app feeds it the
  Telegram message's send time so a backlogged message is filed into the day it
  was sent, hours off real time — while the audit rows a predicate compares it
  against carry `Date.now()`. Riding on `opts.now` would have handed the
  predicate a boundary from the wrong clock. Same split the draft engine already
  makes with its own timing clock.
- **`keptNotice`, a third notice line.** Split off `errorNotice` for the reason
  `emptyNotice` was: a kept turn's writes stand, so "sorry, try again" is the one
  thing the user must not do — the repeat logs the same thing twice. Optional,
  falls back to `errorNotice`. Also sent when `checkpointer.rollback` itself throws:
  the thread most likely still carries the turn, so the cautious wording is the
  honest one. On the mid-stream-throw path only a **kept** turn speaks: silence
  there used to mean "erased", and letting it also mean "your writes stand" is
  what invites the duplicate re-send. A rolled-back turn stays as silent as it
  was in 0.7.2. README documents what a kept turn actually leaves in the thread,
  measured against `@langchain/langgraph` 1.4.8 rather than reasoned about.
- **`checkpointer.rollback` is called inside try/catch, not `.catch()`.** A
  caller's `rollback` may be a plain method that validates before returning a
  promise, and a SYNCHRONOUS throw walks straight past `.catch` — from the
  mid-stream-throw handler that landed outside every try in `runTelegramTurn`,
  breaking the one thing it promises cannot happen. Pinned by a test that fails
  against the old chain. The `error` string also reaches the predicate in one
  shape now: an `Error` from the throw path is unwrapped to `.message` instead of
  arriving as `Error: …` where the event path delivers a bare message.

## 0.7.2 — 2026-07-31

- **`isBlankText` tests the UNION `[\p{Cf}\p{Default_Ignorable_Code_Point}]`.**
  The two classes overlap without containing each other: `Default_Ignorable`
  misses part of `Cf` (U+0600 and the other Arabic number signs, U+FFF9–FFFB),
  and `Cf` misses the variation selectors (`Mn`) and the Hangul fillers (`Lo`).
  Testing either alone leaves a hole shaped like the other, and left this
  package disagreeing with forge-backends ≥0.10.1, which tests the union for the
  same question: a bare U+0600 reply was mute to the model chain yet not blank
  here, so it went out as an invisible message — no `400`, no
  `blank send skipped` warn, an empty bubble, and callers gating on this
  predicate treating the turn as delivered.

## 0.7.1 — 2026-07-30

- **The blank-text guard moved into `sendText`, the primitive that actually
  throws.** 0.7.0 guarded only `runTelegramTurn`, leaving every other caller
  unprotected — and callers reach the send path directly: a consuming app's
  digest and nudge jobs hand model output straight to `sendReply`. A chain that
  goes mute end to end (the residue 0.9.0-style empty-retry logic leaves behind)
  therefore still threw `400 text must be non-empty` out of the job's send
  instead of skipping quietly. `sendText` now returns early on text with no
  visible characters; `isBlankText` is the one shared predicate. A reply that is
  only a trailing cover image is unaffected — the guard sits below
  `extractTrailingCover`, so the photo still goes out. The skip is **logged**
  (`telegram blank send skipped`): a silent return leaves an operator chasing
  "the digest never arrived" with no trace at all, which is the same
  unobservable silence this guard exists to end. The turn loop's own path warns
  before it ever reaches `sendText`, so there is no double warning.
- **`isBlankText` now tests `\p{Default_Ignorable_Code_Point}`, not `\p{Cf}`.**
  Not every invisible is a format character: variation selectors (U+FE00–FE0F)
  are `Mn` and the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) are `Lo`, so
  a reply of nothing but a bare U+FE0F cleared the old guard and reached the Bot
  API — the same `400 text must be non-empty` the guard was written for. The
  Unicode property is the whole test on purpose: a hand-kept code point list
  rots at every Unicode revision. Still predicate-only, so an emoji held
  together by ZWJ and variation selectors is unaffected. Braille blank (U+2800)
  is deliberately **not** covered: Telegram accepts it, so it is a visibly empty
  bubble rather than a rejected send — a different problem from this one.
- **The draft-clear condition is back to `if (status)`, as before 0.7.0.** The
  widening rested on this file's claim that empty draft text clears the draft
  outright, and a consuming app's channel notes record the opposite (an empty
  draft renders a "Thinking…" placeholder — which is why that app never sends
  empty text on abort). Neither claim is verified against the live Bot API, and
  the failure mode of being wrong is worse than the cosmetic issue it fixed: a
  fresh "Thinking…" rendered directly above the `emptyNotice` that says the turn
  is over, with the ~30s draft expiry refreshed. An invisible-only reply
  therefore keeps its stale 🔧 frame, exactly as in 0.6.0. The call site now
  states the uncertainty instead of asserting either behaviour.

## 0.7.0 — 2026-07-30

- **Turn-loop bridge** — a reply made of nothing but invisible characters no longer
  escapes the turn as an unhandled send failure. `String.trim` does not strip
  `\p{Cf}` (U+200B zero-width space, U+FEFF, U+2060, soft hyphen …), so the
  empty-reply guard passed a bare U+200B straight into `sendReply`, where the Bot
  API answered `400 text must be non-empty` — on the HTML send and again on the
  plain-text retry, whose throw left `runTelegramTurn`'s send step entirely.
  Observed in prod 2026-07-30: a local fallback model closed a food-logging turn
  with one U+200B; the diary row was written, the user got silence, and the only
  trace was a `telegram turn failed` line. The blank check now ignores format
  characters (predicate only — `\p{Cf}` also covers the ZWJ inside emoji
  sequences, and the sent text is never rewritten), and such a turn also clears
  its draft: a U+200B token resets the tool status, so the old `if (status)`
  branch left the `🔧` frame standing.
- **Turn-loop bridge** — new opt-in `emptyNotice`, the completed-turn sibling of
  `errorNotice`: a plain-text line sent when a turn finishes with no reply text
  (ended on a tool call, or answered invisibly). Kept separate from `errorNotice`
  because an empty turn is **not** rolled back — its tool writes stand, and
  error-shaped wording invites a re-send that repeats them. Omitted → the previous
  warn-only behaviour, unchanged.

## 0.6.0 — 2026-07-24

- **Turn-loop bridge** — a skill load now reads as `🧠 load_skill(\`name\`)…` in the
  live draft instead of the generic `🔧 \`read_file\`…`. Skills load via progressive
  disclosure: there is no dedicated tool — the model just reads
  `/skills/<name>/SKILL.md` with `read_file`, which made a skill load
  indistinguishable from reading any other file. The new `skillName` helper spots
  that specific read (a `read_file` whose `file_path` ends `/skills/<name>/SKILL.md`)
  and relabels only the transient status line; a plain `read_file` still shows 🔧, and
  the status is still never folded into the sent message.
- **Turn-loop bridge / /deepagents** — `RenderEvent`'s `tool_start` now carries an
  `args` field so the tool input reaches the draft (the file path is what the relabel
  keys off). The `/deepagents` adapter forwards it from the LangGraph event's
  `data.input`.

## 0.5.0 — 2026-07-22

- **Turn-loop bridge** — the live draft now shows which tool the agent is running.
  A turn that stopped streaming to call a tool used to leave the draft frozen, which
  from the chat is indistinguishable from the bot having hung. `RenderEvent` gains a
  `tool_start` case, rendered as a transient `🔧 \`name\`…` line under the draft.
  The status is held separately from the reply and **never** folded into it, so the
  message that actually gets sent is still exactly the concatenated tokens; the next
  token clears the line rather than stacking under it. A turn that *ends* on a tool
  call rewrites the status-free text directly, because `finalize()` stops the draft
  animation but leaves its last frame standing — without that, a tool-only turn
  (tools ran, no tokens) would strand a 🔧 on screen with no message to explain it.
  No new option or callback: the format is fixed until a second consumer disagrees.
- **/deepagents** — `streamAgent` now maps `on_tool_start` onto the new event,
  behind the same nested-agent filter the tokens use, so a delegated subagent's tool
  calls stay out of the root draft. That the `checkpoint_ns` `|` separator
  discriminates on tool starts too was verified against a real delegation rather
  than assumed: a root tool start carries `tools:<uuid>`, one inside a subagent
  carries `tools:<uuid>|tools:<uuid>`. The token branch's `langgraph_node ===
  'model_request'` gate is deliberately *not* reused — tool starts run on the
  `tools` node, so it would have dropped every tool call. The built-in `task` tool
  surfaces as a normal root tool call, so delegation reads as the tool it is instead
  of as a gap in the narration.

## 0.4.1 — 2026-07-20

- **/deepagents** — `streamAgent` no longer leaks a nested agent's tokens into the
  parent stream. A delegated agent — a `subagents` entry, or the built-in `task`
  tool — runs its *own* `model_request` node and LangChain replays its events into
  the parent's `streamEvents`, so the previous `langgraph_node` check could not tell
  the levels apart and a subagent's monologue interleaved with the reply the user
  was reading. Nesting is now read off `checkpoint_ns`, which is `|`-joined per
  level: the root is a single segment, anything delegated carries a separator.
  Deliberately not keyed off `lc_agent_name` even though subagents do carry it —
  `createDeepAgent({ name })` stamps that key on the *root* too, so a name-based
  filter would have silenced streaming outright, with no error, the first time
  anyone named their agent. Naming the root is now a no-op for streaming, pinned by
  a test.
- **Docs** — `sendReply` / `sendText` now document the shape of their `opts`
  argument, which the README previously referenced without ever describing.

## 0.4.0 — 2026-07-19

- **Turn-loop bridge / Formatting** — `rich: true` now means *rich when it buys
  something*, not *rich always*. Bot API rich messages have no body-typography
  field, so every reply sent through the rich renderer looked unlike a normal
  message; routing prose to classic is the only lever a bot has. A new
  `needsRich(md)` predicate asks whether the text carries structure only the rich
  renderer can draw — today, a GFM table — and drafts and final messages go rich
  only when it does. Tables inside a fence or an HTML `<pre>`/`<code>` region are
  literal examples and do not count. `rich: false` is unchanged and still the
  kill-switch: HTML only, always.
- **Turn-loop bridge / Draft engine** — the rich gate is applied per chunk and per
  draft write, not once per reply. Previously a table in the first chunk sent every
  later prose chunk rich, and drafts were never gated at all, so a turn could
  animate rich and then land classic. `needsRich` also now scans line pairs rather
  than block starts, so a table under a lead-in line, heading, list, or closing
  fence — and tables in CRLF output — are detected instead of falling through to
  classic, which has no table renderer and shipped literal pipes.
  `neutralizeRichMedia` moved into the classic path too, which was rendering raw
  `![alt](url)`.
- **Requires Node 20+** (was 18+). Node 18 reached end-of-life in April 2025 and is
  no longer covered by CI; the tested matrix is now Node 20, 22, and 24, plus Bun.
  Runtime behaviour is unchanged — the core still has zero dependencies.

## 0.3.1 — 2026-07-19

- **Turn-loop bridge** — a failed turn is no longer silent. An `error` event
  from the agent stream used to end the turn with nothing logged and nothing
  sent, leaving the user with a draft that just stopped moving; rollback then
  erased the turn from history, so the failure was unobservable afterwards.
  The message is now logged at error level, and a new opt-in `errorNotice`
  option on `runTelegramTurn` sends caller-owned copy to the chat as plain
  text. It is skipped when the turn was aborted via `signal`, since that
  cancellation is the caller's own.

## 0.3.0 — 2026-07-16

- **`/deepagents` (breaking)** — `RenderEvent` is now `token` | `error` only;
  the unconsumed `tool_start` / `tool_end` variants are removed, and
  `streamAgent` no longer emits them (the turn-loop only ever drove the draft
  and rollback off `token` / `error`). The `StreamAgentInput` export is dropped
  in favour of the shared `StreamInput` type, re-exported from the subpath.
- **Turn-loop bridge / Draft engine** — internal simplification: removed the
  unused `makeDraftStreamer` override (the draft streamer is still fully tunable
  via `draftConstants`) and the unused optional `Logger.info`.

## 0.2.0 — 2026-06-26

- **Turn-loop bridge** — `runTelegramTurn` now accepts a `configurable`
  bag that is forwarded verbatim to the `AgentStream` (and on through to
  the agent's run config), so callers can thread per-turn context to their
  agent.
- **`/deepagents`** — `toAgentStream` merges the caller's `configurable`
  under the kit-owned `thread_id`, stripping reserved LangGraph keys
  (`thread_id`, `thread_ts`, `checkpoint_*`, `run_id`, `__pregel_*`) so a
  caller bag can never clobber checkpointer routing.

## 0.1.0 — 2026-06-21

- Initial release:
  - **Formatting** — `mdToTelegramHtml` (totality + `partial` mode),
    `chunkText` / `safeSlice` / `chunkRich`, `repairRichTables`,
    `neutralizeRichMedia`, `extractTrailingCover`.
  - **Draft engine** — `createDraftStreamer` with overridable
    `DraftConstants`.
  - **Turn-loop bridge** — `runTelegramTurn` over injected `BotClient` /
    `AgentStream` / `Checkpointer` / `ThreadStore`, plus the kit-owned
    `sendReply` / `sendText` send orchestration (cover flow + chunking +
    rich→classic / photo→text fallbacks).
  - **Error contract** — `TelegramApiError` + `isBadRequest`.
  - **`/deepagents`** optional subpath — `streamAgent` + `toAgentStream`
    (langchain/deepagents as optional, type-only peers).
