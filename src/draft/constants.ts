/** DraftStreamer tunables — overridable via DraftStreamerDeps.constants.
 *  The defaults are the ones this engine was extracted with, and each is pinned
 *  to an observed Telegram behaviour rather than picked: native drafts tolerate
 *  frequent writes; the keepalive must beat the ~30s draft-expiry window; the
 *  typing action must re-fire before its ~5s lifetime lapses. */
export type DraftConstants = {
  throttleMs: number;
  keepaliveMs: number;
  typingHeartbeatMs: number;
  previewCap: number;
  maxFailures: number;
  /** How long `finalize()` waits for an in-flight draft write to SETTLE before
   *  abandoning it. Not cosmetic drainage: that write's HTTP response is the
   *  only thing that orders it ahead of the final message, and abandoning one
   *  does not withdraw it — a draft applied after the reply then has no way to
   *  be cleared (the Bot API has no clear-draft call) and hangs over the answer
   *  for its ~30s TTL. Set it ABOVE the Bot API's realistic worst case, so that
   *  tripping it means the socket is wedged rather than merely slow; the whole
   *  budget is added to the turn's tail latency when it does trip. */
  drainMs: number;
  tickMs: number;
};

export const DEFAULT_DRAFT_CONSTANTS: DraftConstants = {
  throttleMs: 300, // min interval between draft content writes
  keepaliveMs: 20000, // re-send last draft text within the ~30s expiry window
  typingHeartbeatMs: 4500, // re-send `typing` before its ~5s lifetime lapses
  previewCap: 4000, // one-message cap for the live preview (= CHUNK_TARGET)
  maxFailures: 3, // consecutive send failures → disable draft for the turn
  drainMs: 5000, // finalize() wait for an in-flight write to settle (ordering)
  tickMs: 250, // ticker granularity
};
