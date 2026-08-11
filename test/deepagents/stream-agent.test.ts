import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessageChunk } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { ChatGenerationChunk } from '@langchain/core/outputs';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { todoListMiddleware } from 'langchain';
import { expect, test } from 'vitest';

import type { PlanItem } from '../../src/bridge/interfaces.ts';
import { streamAgent } from '../../src/deepagents/stream-agent.ts';

/** One streamed chunk: prose, a tool call, or both. */
type Step = { text?: string; call?: { name: string; args?: unknown } };

/** Scripted model driving a real delegation — `script[n]` is what the model
 *  streams on its nth call. Call-ordered rather than tool-inspecting so the same
 *  instance can back both levels (createAgent binds tools onto it twice). */
class ScriptedModel extends BaseChatModel {
  calls = 0;
  script: Step[][];

  constructor(script: Step[][]) {
    super({});
    this.script = script;
  }

  _llmType() {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  async *_streamResponseChunks(
    _messages: BaseMessage[],
    _options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const turn = this.script[this.calls] ?? [];
    this.calls += 1;

    for (const [i, step] of turn.entries()) {
      const text = step.text ?? '';
      await runManager?.handleLLMNewToken(text);
      yield new ChatGenerationChunk({
        text,
        message: new AIMessageChunk({
          content: text,
          ...(step.call
            ? {
                tool_call_chunks: [
                  {
                    name: step.call.name,
                    args: JSON.stringify(step.call.args ?? {}),
                    id: `call_${this.calls}_${i}`,
                    index: i,
                    type: 'tool_call_chunk' as const,
                  },
                ],
              }
            : {}),
        }),
      });
    }
  }

  async _generate(): Promise<ChatResult> {
    throw new Error('scripted model: only the streaming path is exercised');
  }
}

const delegate = {
  name: 'task',
  args: { description: 'do the thing', subagent_type: 'gp' },
};

/** No tools: the root delegates, the subagent answers, the root answers. */
const PROSE_SCRIPT: Step[][] = [
  [{ text: 'ROOT-A ' }, { call: delegate }],
  [{ text: 'SUB-1 ' }, { text: 'SUB-2' }],
  [{ text: 'ROOT-B' }],
];

/** Tools at both levels: the root runs `root_tool`, then delegates; the
 *  subagent runs `sub_tool` before either level writes prose. Distinct names so
 *  a leaked subagent tool call cannot hide behind a root one. */
const TOOL_SCRIPT: Step[][] = [
  [{ call: { name: 'root_tool' } }],
  [{ call: delegate }],
  [{ call: { name: 'sub_tool' } }],
  [{ text: 'SUB' }],
  [{ text: 'ROOT' }],
];

const stubTool = (name: string) =>
  tool(async () => 'ok', {
    name,
    description: name,
    // JSON schema rather than zod — zod is only a transitive dep here.
    schema: { type: 'object', properties: {}, additionalProperties: false },
  });

function makeAgent(name?: string, script: Step[][] = PROSE_SCRIPT) {
  const model = new ScriptedModel(script);
  const agent = createDeepAgent({
    model,
    ...(name ? { name } : {}),
    // deepagents 1.12 dropped `write_todos` from the default middleware stack —
    // it now ships only in the Codex harness profile — so the tool has to be
    // wired explicitly for the plan-event path to exist at all. The tool itself
    // is unchanged (langchain's todoListMiddleware, same name, same args).
    middleware: [todoListMiddleware()],
    tools: [stubTool('root_tool')],
    subagents: [
      {
        name: 'gp',
        description: 'general purpose',
        systemPrompt: 'you are a subagent',
        tools: [stubTool('sub_tool')],
      },
    ],
  });
  return { agent, model };
}

async function collect(
  agent: ReturnType<typeof makeAgent>['agent'],
  signal?: AbortSignal,
) {
  const out: string[] = [];
  const errors: string[] = [];
  const tools: string[] = [];
  const toolCalls: { name: string; args: unknown; label?: string }[] = [];
  const plans: PlanItem[][] = [];
  for await (const ev of streamAgent(
    agent,
    { messages: [{ role: 'user', content: 'hi' }] },
    { configurable: { thread_id: 't1' } },
    signal,
  )) {
    if (ev.type === 'token') out.push(ev.text);
    if (ev.type === 'tool_start') {
      tools.push(ev.name);
      toolCalls.push({ name: ev.name, args: ev.args, label: ev.label });
    }
    if (ev.type === 'plan') plans.push(ev.items);
    if (ev.type === 'error') errors.push(ev.message);
  }
  return { text: out.join(''), errors, tools, toolCalls, plans };
}

test('root tokens reach the caller', async () => {
  const { agent } = makeAgent();
  const { text, errors } = await collect(agent);

  expect(errors).toEqual([]);
  expect(text).toBe('ROOT-A ROOT-B');
});

test('subagent tokens are dropped', async () => {
  const { agent, model } = makeAgent();
  const { text } = await collect(agent);

  // The subagent really did run — it just never reached the user.
  expect(model.calls).toBe(3);
  expect(text).not.toContain('SUB-1');
  expect(text).not.toContain('SUB-2');
});

// Regression guard for the trap that sank the `lc_agent_name` filter:
// createDeepAgent({ name }) stamps `lc_agent_name` on the ROOT as well as on
// subagents, so a name-based filter would silence the bot entirely — with no
// error anywhere. Nesting depth is independent of the caller's config, so
// naming the root must stay a no-op for streaming. See NESTED_NS in
// src/deepagents/stream-agent.ts.
test('naming the root agent does not silence it', async () => {
  const { agent } = makeAgent('root-bot');
  const { text, errors } = await collect(agent);

  expect(errors).toEqual([]);
  expect(text).toBe('ROOT-A ROOT-B');
  expect(text).not.toContain('SUB-');
});

test('root tool calls surface as tool_start, in order', async () => {
  const { agent } = makeAgent(undefined, TOOL_SCRIPT);
  const { tools, errors } = await collect(agent);

  // `task` is itself a root tool call — delegation is visible to the user as
  // the tool it actually is, rather than as a gap in the narration.
  expect(errors).toEqual([]);
  expect(tools).toEqual(['root_tool', 'task']);
});

test('a subagent tool call is dropped', async () => {
  const { agent, model } = makeAgent(undefined, TOOL_SCRIPT);
  const { tools, text } = await collect(agent);

  // The subagent really did run its tool — it just never reached the user.
  expect(model.calls).toBe(5);
  expect(tools).not.toContain('sub_tool');
  expect(text).toBe('ROOT');
});

test('tool_start forwards the tool input as args (ev.data.input)', async () => {
  const { agent } = makeAgent(undefined, TOOL_SCRIPT);
  const { toolCalls } = await collect(agent);

  // Proves the plumbing: `ev.data.input` reaches `ev.args` at all (before the
  // fix it was dropped) AND carries the actual call payload — the delegate's
  // args survive the trip. The exact object shape is langchain's, not ours;
  // the real `{ file_path }` shape skillName consumes is pinned in turn-loop.
  const task = toolCalls.find((c) => c.name === 'task');
  expect(task?.args).toBeDefined();
  expect(JSON.stringify(task?.args)).toContain('do the thing');
});

test('a real write_todos call arrives as a plan event, not a tool call', async () => {
  // End-to-end through the actual graph: the built-in tool really executes, and
  // what comes out the other side is a `plan`. The mapping itself is pinned in
  // plan-events.test.ts; this is the wiring — that `on_tool_start` for a
  // built-in reaches the branch at all, with its args intact.
  const { agent } = makeAgent(undefined, [
    [
      {
        call: {
          name: 'write_todos',
          args: {
            todos: [
              { content: 'find', status: 'in_progress' },
              { content: 'count', status: 'pending' },
            ],
          },
        },
      },
    ],
    [{ text: 'DONE' }],
  ]);
  const { plans, tools, text } = await collect(agent);

  expect(plans).toEqual([
    [
      { text: 'find', status: 'active' },
      { text: 'count', status: 'pending' },
    ],
  ]);
  expect(tools).not.toContain('write_todos');
  expect(text).toBe('DONE');
});

test('abort yields a single canceled error event', async () => {
  const { agent } = makeAgent();
  const ctrl = new AbortController();
  ctrl.abort();

  const { errors } = await collect(agent, ctrl.signal);

  expect(errors).toEqual(['canceled']);
});
