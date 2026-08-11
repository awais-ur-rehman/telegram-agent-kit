import type { RunnableConfig } from '@langchain/core/runnables';
import type { createDeepAgent } from 'deepagents';

import type {
  PlanItem,
  RenderEvent,
  StreamInput,
} from '../bridge/interfaces.ts';

/** LangGraph's `on_tool_start` reports the call's arguments in `data.input`, and
 *  that shape is NOT stable: usually the parsed argument object, but
 *  `{ input: "<json string>" }` when the call reaches the tool node as an
 *  unparsed argument string (reproduced against deepagents 1.10). Everything
 *  downstream — `planItems`, `skillName`, and the caller's own `formatTool` —
 *  reads named fields off those arguments, so on the string shape they all
 *  silently see nothing and fall back to a bare `🔧 name…`.
 *
 *  Normalize once, here, where every consumer routes through. Unwrapping is
 *  deliberately conservative: it only applies when the inner string parses to a
 *  plain OBJECT, so a tool that genuinely takes a string parameter named `input`
 *  keeps its own arguments untouched. */
export function toolArgs(input: unknown): unknown {
  const inner = (input as { input?: unknown } | undefined)?.input;
  if (typeof inner !== 'string') return input;
  try {
    const parsed: unknown = JSON.parse(inner);

    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? parsed
      : input;
  } catch {
    return input;
  }
}

/** Skills load via progressive disclosure — the model reads
 *  `/skills/<name>/SKILL.md` with `read_file`, there is no dedicated tool. Lives
 *  here, not in the core turn loop: `read_file` and this path layout are
 *  deepagents conventions, and the core is meant to know no tool names at all. */
export function skillName(name: string, args: unknown): string | null {
  if (name !== 'read_file') return null;

  return (
    (args as { file_path?: string } | undefined)?.file_path?.match(
      /\/skills\/([^/]+)\/SKILL\.md$/,
    )?.[1] ?? null
  );
}

const TODO_STATUS: Record<string, PlanItem['status']> = {
  completed: 'done',
  in_progress: 'active',
  pending: 'pending',
};

/** `write_todos` IS the plan: it takes the whole list every call
 *  (`{ todos: [{ content, status }] }`, verified against deepagents 1.10 and
 *  langchain 1.5), which is exactly the shape of a `plan` event. The tool comes
 *  from langchain's `todoListMiddleware` — default in deepagents up to 1.11,
 *  Codex-harness-only from 1.12, so callers on 1.12+ wire it themselves; the
 *  name and args never changed. Anything unrecognized returns
 *  null and stays an ordinary tool call, so a hand-rolled todo tool with another
 *  shape degrades to a `🔧 write_todos…` line rather than an empty plan. */
export function planItems(name: string, args: unknown): PlanItem[] | null {
  if (name !== 'write_todos') return null;
  const todos = (args as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  const items = todos.flatMap((t): PlanItem[] => {
    const { content, status } = (t ?? {}) as {
      content?: unknown;
      status?: unknown;
    };
    if (typeof content !== 'string') return [];

    return [
      {
        text: content,
        status: TODO_STATUS[String(status)] ?? 'pending',
      },
    ];
  });

  return items.length > 0 ? items : null;
}

type Agent = ReturnType<typeof createDeepAgent>;

type LangGraphEvent = {
  event: string;
  name?: string;
  metadata?: { langgraph_node?: string; checkpoint_ns?: string };
  data?: { chunk?: { content?: unknown }; input?: unknown };
};

/** True for an event replayed from a delegated agent (a `subagents` entry or the
 *  built-in `task` tool) rather than produced by the root run. See NESTED_NS. */
function isNested(ev: LangGraphEvent): boolean {
  return ev.metadata?.checkpoint_ns?.includes('|') ?? false;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: 'text'; text: string } =>
          typeof p === 'object' &&
          p !== null &&
          (p as { type?: unknown }).type === 'text' &&
          typeof (p as { text?: unknown }).text === 'string',
      )
      .map((p) => p.text)
      .join('');
  }
  return '';
}

export async function* streamAgent(
  agent: Agent,
  input: StreamInput,
  config: RunnableConfig,
  signal?: AbortSignal,
): AsyncIterable<RenderEvent> {
  const iter = agent.streamEvents(input, {
    ...config,
    signal,
    version: 'v2',
  }) as AsyncIterable<LangGraphEvent>;

  try {
    for await (const ev of iter) {
      if (ev.event === 'on_chat_model_stream') {
        if (ev.metadata?.langgraph_node !== 'model_request') continue;
        // NESTED_NS: a delegated agent (a `subagents` entry, or the built-in
        // `task` tool) runs its OWN `model_request` node and LangChain replays
        // its events into the parent's streamEvents — so `langgraph_node`
        // alone lets a subagent's monologue interleave with the root's reply.
        //
        // `checkpoint_ns` separates the levels structurally: the root's is a
        // single segment (`model_request:<uuid>`), while a delegated run is
        // `|`-joined per nesting level
        // (`tools:<uuid>|model_request:<uuid>`). One `|` means "not the root".
        //
        // Deliberately NOT keyed off `metadata.lc_agent_name` even though
        // subagents do carry it: `createDeepAgent({ name })` stamps
        // `lc_agent_name` on the ROOT too (langchain ReactAgent sets it for
        // any `options.name`), so naming the root — a harmless-looking thing
        // to do for logs — would silently drop every token with no error.
        // Nesting depth has no such coupling to the caller's config.
        if (isNested(ev)) continue;
        const text = extractText(ev.data?.chunk?.content);
        if (text) yield { type: 'token', text };
      } else if (ev.event === 'on_tool_start') {
        // Same nesting test as the tokens above, and verified to discriminate
        // on THIS event too rather than assumed: a root tool start carries
        // `checkpoint_ns: 'tools:<uuid>'`, while a tool called inside a
        // delegated subagent carries `'tools:<uuid>|tools:<uuid>'` — the `|`
        // separator is per nesting level regardless of event type.
        //
        // No `langgraph_node` gate here, unlike the token branch: tool starts
        // run on the `tools` node, not `model_request`, so reusing that check
        // would drop every tool call. Nesting alone is the filter.
        if (isNested(ev)) continue;
        const name = ev.name ?? 'unknown';
        const args = toolArgs(ev.data?.input);

        // The plan is a tool call only by accident of transport — surface it as
        // what it is, so the draft can render progress instead of one more
        // `🔧 write_todos…` line that says nothing about what changed.
        const items = planItems(name, args);
        if (items !== null) {
          yield { type: 'plan', items };
          continue;
        }

        const skill = skillName(name, args);
        yield {
          type: 'tool_start',
          name,
          args,
          ...(skill !== null ? { label: `🧠 load_skill(\`${skill}\`)…` } : {}),
        };
      }
    }
  } catch (err) {
    yield {
      type: 'error',
      message: signal?.aborted
        ? 'canceled'
        : err instanceof Error
          ? err.message
          : String(err),
    };
  }
}
