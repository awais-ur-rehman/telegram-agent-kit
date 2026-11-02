# 0003 Rollback undoes memory, not consequences

- Status: accepted
- Level: feature
- Date: 2026-07-31

## Decision

A failed turn is rolled back by default. The caller can veto the rollback with
`hooks.shouldRollback`, because tools that finished before the failure have
already written to the outside world. A predicate that throws keeps the turn.
A cancelled turn is always rolled back, and the predicate is not asked. A kept
turn tells the user with `keptNotice`, not with "try again".

## Rests on

- A real failure: a turn made 25 write calls and died on a recursion limit;
  the rollback left six journal lines that the agent no longer remembered,
  and the next turn "repaired" them. CHANGELOG 0.8.0.
- Only the caller knows which tools write.
- A turn wrongly kept is one stale thread entry that a person can see; a turn
  wrongly rolled back hides real writes.

## Revisit when

A caller needs the veto on a cancelled turn, as when `signal` is used as a
turn budget.

## Options considered

- Always roll back: the behaviour before 0.8.0, and the failure above.
- Never roll back: a failed turn leaves a half-finished thread in every case.

## Links

ARCHITECTURE.md I-18; README "Conditional rollback"; #17
