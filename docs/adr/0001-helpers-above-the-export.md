# 0001 Helpers above the export

- Status: accepted
- Date: 2026-10-31

## Context

A source file in `src/` declares each module-level constant and private
helper above the first code that uses it. So a file reads bottom-up: its
main export comes after what it calls. In a file with several exports, the
helpers of a later export sit between the exports, as in
`src/bridge/send.ts` (exports at `:41`, `:119`, `:181`) and
`src/format/rich.ts` (exports at `:163`, `:221`, `:255`, `:361`). The
`craft:typescript-conventions` rule "Files are kebab-case, one entity
per file" sets the opposite order: imports, then the primary export, then the
helpers it uses.

## Options considered

- Keep the order of the code: each helper and constant above its first user.
- Follow the convention: move the primary export to the top of each file.

## Decision

We will keep the order of the code. In a file in `src/`, a module-level
constant or private helper is declared above the first code that uses it.
This ADR replaces the intra-file order of the `typescript-conventions` rule
"Files are kebab-case, one entity per file" in this project.

## Consequences

Good: no file moves; a reader meets each helper and its rationale comment
before the code that uses it; new code has one order to follow.
Bad: a file does not open with what it is for; in a long file such as
`src/format/md-to-html.ts` the export is far down.

## Invariants

None.

## Confirmation

Review only.
