# 0004 Types beside their code, no `models/` folder

- Status: accepted
- Date: 2026-10-31

## Context

A type in `src/` lives in the file of the code that owns it, also when
several files use it. The four injected contracts and the events they
exchange are in `src/bridge/interfaces.ts`. A function's options and context
types sit beside the function: `RunTelegramTurnOpts`, `TurnContext` and
`RollbackContext` in `src/bridge/turn-loop.ts`, `TurnQueue` in
`src/bridge/turn-queue.ts`, `DraftConstants` in `src/draft/constants.ts`,
`FeedBlock` and `FeedOverrides` in `src/draft/feed.ts`. A source file
exports several functions and types that do one job together
(`src/bridge/send.ts`, `src/format/rich.ts`, `src/draft/feed.ts`). The
`craft:typescript-conventions` rules "Files are kebab-case, one entity
per file" and "A shared type is a model in `models/`" set one entity per file
and one shared type per file in a `models/` folder.

## Options considered

- Keep the code's layout: each type beside the code that owns it, the
  injected contracts in `src/bridge/interfaces.ts`, several related exports
  per file, no `models/` folder.
- Follow the convention: one file per shared type in a `models/` folder, and
  one entity per source file.

## Decision

We will keep the code's layout. A type lives in the file of the code that
owns it; the contracts that the caller implements live in
`src/bridge/interfaces.ts`. A source file may export several functions and
types that do one job together. This ADR replaces the
`typescript-conventions` rules "one entity per file" and "A shared type is a
model in `models/`" in this project.

## Consequences

Good: a function and its options read in one file; the caller's contracts
read in one file, which the README's "The four interfaces" section maps to;
no file split.
Bad: a type that several modules use sits in the module of its owner, as
`src/bridge/interfaces.ts`, which `src/draft/` also imports (the debt of
I-2).

## Invariants

None.

## Confirmation

Review only.
