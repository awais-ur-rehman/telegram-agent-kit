# 0002 Zero-dependency core, optional deepagents subpath

- Status: accepted
- Level: project
- Date: 2026-06-21

## Decision

The package root has no runtime dependency and no `node:` import, so it runs
on Node 20+, Bun, Deno and in the browser. The deepagents/LangGraph adapter
ships as the separate entry `telegram-agent-kit/deepagents`, with
`@langchain/core` and `deepagents` as optional, type-only peers. A user who
does not use deepagents installs nothing else.

## Rests on

- The README promises "zero runtime dependencies in the core" and four
  runtimes, `README.md`.
- The adapter is "on a separate subpath, so the core never pulls in
  langchain", `README.md`; peers shipped optional and type-only since 0.1.0,
  `CHANGELOG.md`.

## Revisit when

A feature needs a package that the platform cannot replace, or a second agent
framework needs its own adapter.

## Options considered

- One entry with LangChain as a hard dependency: every user installs it.
- A second npm package for the adapter: two versions to release and keep in
  step.

## Links

`ARCHITECTURE.md` I-3, I-4, I-5;
`test/deepagents/no-peers.test.ts`; #23
