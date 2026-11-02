# Product

This file holds the product decisions: what a user of the kit installs, gets
and can rely on. How the code does it is in [`ARCHITECTURE.md`](ARCHITECTURE.md)
and its ADRs.

## What it is, and for whom

`telegram-agent-kit` is an ESM library for JavaScript and TypeScript developers
who connect an LLM agent to a Telegram bot. It renders the agent's markdown to
Telegram HTML, streams the reply into one live draft, and runs a turn with
snapshot and rollback. The developer gives the I/O through four small
interfaces. A deepagents/LangGraph agent plugs in through the optional
`/deepagents` entry.

Usage, 2026-11-02: 528 npm downloads in the last month and 203 in the last
week. Those numbers include CI and mirror traffic. The repository has 0 stars
and 0 forks. The one known consumer is the author's own bot.

## Direction

The current goal is milestone **v1.0.0**: a frozen public API surface and the
functions still missing for 1.0 (#17 to #23). After 1.0, each public export is
a semver commitment.

## What it will not do

- Hold a runtime dependency in the core ([PDR 0002](pdr/0002-zero-dependency-core.md)).
- Make HTTP calls, own a framework, or keep globals. The caller's `BotClient`
  is the transport.
- Keep state between turns, or lock across processes. One process serializes
  its own turns; a bot on several processes brings its own lock.
- Cancel a running turn for a new message
  ([PDR 0004](pdr/0004-new-message-waits.md)).
- Name an agent's tool in the core. Tool semantics live in the adapter or in
  the caller's `formatTool`.

## Constraints

- **The law.** The code is under the MIT licence
  ([PDR 0001](pdr/0001-mit-licence.md)). A bot built on the kit is bound by
  the [Telegram Bot API terms](https://telegram.org/tos/bot-developers); the
  kit stores no user data, because every write goes through the caller's
  interfaces.
- **The client.** None. No contract binds the project.
- **The money.** None. The project has no income and no paid service.

## Open questions

### Q-1 Which exports are public at 1.0, and what does semver cover?
- Answers: person
- Blocks: #18, v1.0.0
- Since: 2026-08-01

## Decisions

- [0001 MIT licence](pdr/0001-mit-licence.md) — accepted; revisit when: a contributor or a user asks for another licence
- [0002 Zero-dependency core, optional deepagents subpath](pdr/0002-zero-dependency-core.md) — accepted; revisit when: a feature needs a package that the platform cannot replace
- [0003 Rollback undoes memory, not consequences](pdr/0003-rollback-undoes-memory.md) — accepted; revisit when: a caller needs the veto on a cancelled turn
- [0004 A new message waits for the running turn](pdr/0004-new-message-waits.md) — accepted; revisit when: a cancel path keeps the rollback veto (#17)
