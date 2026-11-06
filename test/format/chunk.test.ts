import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';

import { chunkRich, chunkText, safeSlice } from '../../src/format/chunk.ts';

// RICH_LIMIT is module-private in chunk.ts; mirror the value here for the tests.
const RICH_LIMIT = 32768;

describe('chunkText', () => {
  test('returns one chunk for short text', () => {
    expect(chunkText('hello')).toEqual(['hello']);
  });
  test('splits >4096 into ordered chunks each <=4096', () => {
    const chunks = chunkText('a'.repeat(9000));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 4096)).toBe(true);
    expect(chunks.join('')).toBe('a'.repeat(9000));
  });
  test('does not split a non-BMP char mid-codepoint', () => {
    const emoji = '😀'; // 2 UTF-16 code units
    const chunks = chunkText(emoji.repeat(2100)); // 4200 code units
    for (const c of chunks) {
      expect([...c].every((ch) => ch === '😀')).toBe(true);
    }
    expect(chunks.join('')).toBe(emoji.repeat(2100));
  });
  test('makes progress after a lone high surrogate before a newline', () => {
    const text = `\uD800\n${'a'.repeat(5000)}`;
    // Bound the subprocess because the original bug is a synchronous loop.
    const source = readFileSync(
      new URL('../../src/format/chunk.ts', import.meta.url),
      'utf8',
    );
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext },
    });
    const program = `${outputText}\nconsole.log(JSON.stringify(chunkText(${JSON.stringify(text)})));`;
    const output = execFileSync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {
        encoding: 'utf8',
        timeout: 1000,
      },
    );
    expect(JSON.parse(output)).toEqual([
      '\uD800',
      `\n${'a'.repeat(3999)}`,
      'a'.repeat(1001),
    ]);
  });
  test('returns a single chunk for exactly the 4096 limit', () => {
    const text = 'a'.repeat(4096);
    expect(chunkText(text)).toEqual([text]);
  });
  test('prefers a blank-line boundary over a hard cut', () => {
    const head = 'a'.repeat(3500);
    const tail = 'b'.repeat(2000);
    const chunks = chunkText(`${head}\n\n${tail}`);
    expect(chunks).toEqual([head, `\n\n${tail}`]);
    expect(chunks.join('')).toBe(`${head}\n\n${tail}`);
  });
  test('falls back to a single-newline boundary when no blank line', () => {
    const head = 'a'.repeat(3500);
    const tail = 'b'.repeat(2000);
    const chunks = chunkText(`${head}\n${tail}`);
    expect(chunks).toEqual([head, `\n${tail}`]);
    expect(chunks.join('')).toBe(`${head}\n${tail}`);
  });
});

describe('safeSlice', () => {
  test('returns text unchanged when within max', () => {
    expect(safeSlice('hello', 4000)).toBe('hello');
  });
  test('trims a trailing high surrogate at the boundary', () => {
    const text = `${'a'.repeat(3999)}\uD83D${'b'.repeat(10)}`; // index 3999 is a lone high surrogate
    expect(safeSlice(text, 4000).length).toBe(3999);
  });
  test('keeps exactly max when the boundary char is not a high surrogate', () => {
    expect(safeSlice('a'.repeat(5000), 4000).length).toBe(4000);
  });
});

describe('chunkRich', () => {
  test('returns one piece when within RICH_LIMIT', () => {
    expect(chunkRich('hello')).toEqual(['hello']);
    expect(chunkRich('a'.repeat(RICH_LIMIT))).toEqual(['a'.repeat(RICH_LIMIT)]);
  });
  test('splits on blank-line boundaries, each piece <= RICH_LIMIT', () => {
    const a = 'a'.repeat(RICH_LIMIT - 100);
    const b = 'b'.repeat(500);
    const pieces = chunkRich(`${a}\n\n${b}`);
    expect(pieces).toEqual([a, b]);
    expect(pieces.every((p) => p.length <= RICH_LIMIT)).toBe(true);
  });
  test('hard-cuts a single oversized block surrogate-safely', () => {
    const big = `${'a'.repeat(RICH_LIMIT - 1)}😀${'b'.repeat(10)}`;
    const pieces = chunkRich(big);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.length <= RICH_LIMIT)).toBe(true);
    expect(pieces.join('')).toBe(big); // no codepoint severed
  });
});
