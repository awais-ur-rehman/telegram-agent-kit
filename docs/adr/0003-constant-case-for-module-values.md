# 0003 CONSTANT_CASE for every module-level value

- Status: accepted
- Date: 2026-10-31

## Context

The code in `src/` names a module-level `const` in CONSTANT_CASE when it is
not a function, also when the module makes the value when it loads:
`RESERVED = new Set(…)` in `src/deepagents/to-agent-stream.ts`,
`GRAPHEMES = new Intl.Segmenter(…)` and `PLAN_BLOCK = Symbol(…)` in
`src/draft/feed.ts`, `RICH_MEDIA_RE = new RegExp(…)` in `src/format/rich.ts`,
and `NOOP_LOG` (an object of no-op functions) in `src/bridge/turn-loop.ts`.
A module-level function is camelCase: `escapeHtml`, `isWord`,
`defaultDelay`. The `craft:typescript-conventions` rule "A constant's
name is CONSTANT_CASE" gives CONSTANT_CASE only to data written out in the
code, and camelCase to a value made at run time and to an object of
functions.

## Options considered

- Keep the rule of the code: every module-level `const` that is not a
  function is CONSTANT_CASE.
- Follow the convention: rename the values made at load and `NOOP_LOG` to
  camelCase.

## Decision

We will keep the rule of the code. A module-level `const` that holds a
function is camelCase; every other module-level `const` is CONSTANT_CASE,
whether the code writes the value out or makes it when the module loads.
This ADR replaces the `typescript-conventions` rule "A constant's name is
CONSTANT_CASE" in this project.

## Consequences

Good: no rename; one simple test for a name, "is it a function?".
Bad: CONSTANT_CASE does not tell a reader whether the value is literal data
or an object with state, such as a `RegExp` with the `g` flag.

## Invariants

None.

## Confirmation

Review only.
