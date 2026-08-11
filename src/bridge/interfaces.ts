export type ChatKey = { chatId: number; agentId: string };

export type Logger = {
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
};

/** Raw Bot API transport primitives — one HTTP call each, NO chunking /
 *  rendering / fallback (the kit owns those). Each throws TelegramApiError
 *  (see ../errors.ts) on a Bot API error. Bound every call with a ceiling of
 *  your own (`AbortSignal.timeout`, combined with any signal passed in) — only
 *  the transport can cancel a request; the kit can only stop waiting. */
export type BotClient = {
  sendMessage(
    p: { chatId: number; text: string; parseMode?: 'HTML' },
    signal?: AbortSignal,
  ): Promise<void>;
  sendRichMessage(
    p: { chatId: number; markdown: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendPhoto(
    p: { chatId: number; url: string; caption?: string; parseMode?: 'HTML' },
    signal?: AbortSignal,
  ): Promise<void>;
  sendChatAction(
    p: { chatId: number; action?: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendMessageDraft(
    p: { chatId: number; draftId: number; text: string },
    signal?: AbortSignal,
  ): Promise<void>;
  sendRichMessageDraft(
    p: { chatId: number; draftId: number; markdown: string },
    signal?: AbortSignal,
  ): Promise<void>;
};

/** One step of the agent's plan. `active` is the step being worked on now; the
 *  kit renders it distinctly and strikes through `done` ones. */
export type PlanItem = {
  text: string;
  status: 'pending' | 'active' | 'done';
};

export type RenderEvent =
  | { type: 'token'; text: string }
  /** The agent started a tool call. Appended to the live draft's feed and NEVER
   *  folded into the reply — see runTelegramTurn. `args` carries the tool input
   *  so a `formatTool` can render specific calls in the app's own words. `label`
   *  is the stream's own suggestion (the `/deepagents` adapter sets it for skill
   *  loads); `formatTool` outranks it, and both outrank the bare tool name. */
  | { type: 'tool_start'; name: string; args: unknown; label?: string }
  /** The agent rewrote its plan. Carries the WHOLE list every time, never a
   *  delta — that is the shape `write_todos` and its kin already emit, so
   *  reconciling deltas would be work in service of nothing. The plan occupies
   *  one block in the draft feed, anchored where it first appeared. */
  | { type: 'plan'; items: PlanItem[] }
  | { type: 'error'; message: string };

export type StreamInput = { messages: { role: 'user'; content: string }[] };
export type AgentStreamContext = {
  threadId: string;
  signal?: AbortSignal;
  configurable?: Record<string, unknown>;
};
export type AgentStream = (
  input: StreamInput,
  context: AgentStreamContext,
) => AsyncIterable<RenderEvent>;

export type Checkpointer = {
  snapshot(threadId: string): Promise<string | null>;
  rollback(threadId: string, checkpointId: string | null): Promise<void>;
};

export type ThreadStore = {
  resolve(key: ChatKey, now: number): Promise<string>;
  touch(key: ChatKey, now: number): Promise<void>;
};
