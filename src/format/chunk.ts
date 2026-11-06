const TELEGRAM_LIMIT = 4096;
/** Headroom under TELEGRAM_LIMIT for the classic chunker. */
const CHUNK_TARGET = 4000;
/** Telegram's rich-message text limit (vs the classic 4096). */
const RICH_LIMIT = 32768;

/** Split into ≤TELEGRAM_LIMIT UTF-16-code-unit chunks without severing a
 *  surrogate pair. Prefers paragraph/line boundaries, hard-cuts otherwise. */
export function chunkText(text: string): string[] {
  if (text.length <= TELEGRAM_LIMIT) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > TELEGRAM_LIMIT) {
    let cut = rest.lastIndexOf('\n\n', CHUNK_TARGET);
    if (cut < 1) cut = rest.lastIndexOf('\n', CHUNK_TARGET);
    if (cut < 1) cut = CHUNK_TARGET;
    // Never split a surrogate pair. A cut at 1 means index 1 is a newline,
    // so any high surrogate before it is unpaired and can be kept.
    const code = rest.charCodeAt(cut - 1);
    if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) chunks.push(rest);

  return chunks;
}

/** Surrogate-safe hard truncation to `max` UTF-16 code units. Mirrors the
 *  high-surrogate guard in chunkText so a draft cap never severs a pair. */
export function safeSlice(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // don't split a surrogate pair

  return text.slice(0, cut);
}

/** Block-aware splitter for rich markdown. Most replies fit RICH_LIMIT in one
 *  message; when they don't, split only on blank-line (paragraph) boundaries
 *  so a table/list/quote is never cut. A single block over the limit is
 *  hard-cut surrogate-safely (rare — see spec §9). */
export function chunkRich(md: string): string[] {
  if (md.length <= RICH_LIMIT) return [md];
  const out: string[] = [];
  let cur = '';
  for (const block of md.split('\n\n')) {
    const candidate = cur === '' ? block : `${cur}\n\n${block}`;
    if (candidate.length <= RICH_LIMIT) {
      cur = candidate;
      continue;
    }
    if (cur !== '') {
      out.push(cur);
      cur = '';
    }
    if (block.length <= RICH_LIMIT) {
      cur = block;
      continue;
    }
    let rest = block;
    while (rest.length > RICH_LIMIT) {
      const cut = safeSlice(rest, RICH_LIMIT);
      out.push(cut);
      rest = rest.slice(cut.length);
    }
    cur = rest;
  }
  if (cur !== '') out.push(cur);

  return out;
}
