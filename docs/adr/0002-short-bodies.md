# 0002 Short bodies: implicit arrow returns and brace-less `if`

- Status: accepted
- Date: 2026-10-31

## Context

The code in `src/` writes a one-expression callback with an implicit return,
as in `src/deepagents/to-agent-stream.ts:32`,
`src/deepagents/stream-agent.ts:114` and `src/draft/feed.ts:56`, and a
one-statement `if` on one line with no braces, as in
`src/draft/draft-streamer.ts:140` and `src/bridge/turn-queue.ts:53`. The
`craft:typescript-conventions` rule "Bodies are braced and expanded"
forbids both. Biome's `recommended` set, which the project runs, does not
enforce either form.

## Options considered

- Keep the short forms of the code.
- Follow the convention: braces and an explicit `return` everywhere, with a
  Biome rule to enforce it.

## Decision

We will keep the short forms. An arrow function whose body is one expression
may return it implicitly, and an `if` whose body is one statement may put it
on the same line without braces. This ADR replaces the
`typescript-conventions` rule "Bodies are braced and expanded" in this
project.

## Consequences

Good: no rewrite of `src/`; the dense format and rich modules stay short
enough to read their long rationale comments beside the code.
Bad: a second statement added to a brace-less `if` needs the braces added
too; no tool enforces either form, so review is the only check.

## Invariants

None.

## Confirmation

Review only.
