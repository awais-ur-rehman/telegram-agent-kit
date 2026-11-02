# 0004 A new message waits for the running turn

- Status: accepted
- Level: feature
- Date: 2026-08-01

## Decision

Turns on one chat run one at a time, through `createTurnQueue`, keyed by the
whole `ChatKey`. A new message waits for the running turn. It never cancels it.

## Rests on

- Two overlapping turns corrupt each other: the snapshot, the one live draft
  and the rollback. CHANGELOG 0.9.0.
- To supersede a turn is to abort it, and an aborted turn is rolled back with
  no `shouldRollback` veto, so tool writes that already landed are erased
  (PDR 0003).

## Revisit when

A cancel path keeps the rollback veto (#17), or users ask that the latest
message wins.

## Options considered

- Supersede: the new message aborts the running turn; erases finished writes.
- A queue inside the turn loop: per-process, cannot be turned off, and hides
  where the state lives.

## Links

PDR 0003; README "One turn at a time per chat"; #17
