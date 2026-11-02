# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`telegram-agent-kit` is a published npm library (ESM-only) that wires LLM agents to
Telegram. Its modules, layers, patterns and invariants are in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Its product decisions — the
direction, what it will not do, the PDRs — are in
[`docs/PRODUCT.md`](docs/PRODUCT.md).

Before a spec, a plan or the first edit of a new feature, read
`docs/ARCHITECTURE.md`. At the start of a new feature, and for a decision, load
`craft:architecture`.

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

## Conventions

- **`strict` TypeScript**, ESM only (`"type": "module"`).
- **Comment the *why*, heavily.** The format/rich modules carry long doc-comments
  explaining each invariant (flanking rules, code-region tracking, fence anchoring).
  When you change behavior there, update the rationale comment too — those comments are
  the spec.
- Formatting: Biome, 2-space indent, single quotes (`biome.json`). Run `npm run format`
  before committing.
- `dist/` and `node_modules/` are gitignored; only `dist/` is published (`files` in
  `package.json`).
