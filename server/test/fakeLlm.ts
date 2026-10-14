import type { Llm, LlmRequest, LlmResult, TurnBlock, TurnRequest, TurnResult, Usage } from '../gen/llm';

/** A scripted stand-in for the model: queues of answers per graph node, and a record of what was asked. */
type Answer = unknown | ((req: LlmRequest<unknown>) => unknown);
type Script = Partial<Record<'brief' | 'replan' | 'draft' | 'repair' | 'critique', Answer[]>>;

export class FakeLlm implements Llm {
  readonly requests: LlmRequest<unknown>[] = [];
  private readonly script: Script;
  private readonly usage: Usage;
  /** Characters per streamed chunk. */
  chunk = 300;
  /** Runs before each answer; tests use it to hold a call open or to fail it. */
  before?: (req: LlmRequest<unknown>) => Promise<void>;

  constructor(script: Script, usage: Partial<Usage> = {}) {
    this.script = script;
    this.usage = { input: 1_000, output: 500, cacheRead: 0, cacheWrite: 0, ...usage };
  }

  get labels(): string[] {
    return this.requests.map((r) => r.label);
  }

  async turn(_req: TurnRequest): Promise<TurnResult> {
    throw new Error('FakeLlm: a chat turn was asked of the plan-and-draft fake; use ChatFakeLlm');
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    this.requests.push(req as LlmRequest<unknown>);
    const queue = this.script[req.label as keyof Script];
    if (!queue?.length) throw new Error(`FakeLlm: no scripted answer left for "${req.label}"`);
    const next = queue.length > 1 ? queue.shift()! : queue[0]; // the last answer repeats
    await this.before?.(req as LlmRequest<unknown>);
    const value = typeof next === 'function' ? (next as (r: LlmRequest<unknown>) => unknown)(req as LlmRequest<unknown>) : next;
    const parsed = req.schema.parse(value);
    // Stream the answer like the real thing: the text grows a few hundred characters at a time.
    if (req.onText) {
      const text = JSON.stringify(parsed);
      for (let n = this.chunk; n < text.length + this.chunk; n += this.chunk) req.onText(text.slice(0, n));
    }
    return { value: parsed, usage: { ...this.usage } };
  }
}

/** What a scripted chat turn may be: blocks, or a function of the request (to look at what the model was sent). */
export type ChatStep = TurnBlock[] | ((req: TurnRequest) => TurnBlock[]);

let toolIds = 0;
/** A tool call block. */
export const call = (name: string, input: Record<string, unknown> = {}): TurnBlock => ({ type: 'tool_use', id: `toolu_${++toolIds}`, name, input });
/** A text block. */
export const say = (text: string): TurnBlock => ({ type: 'text', text });

/**
 * A scripted stand-in for the model in the map chat: one entry per model turn. A turn that
 * contains a tool call stops with `tool_use`, any other ends the conversation turn. Records
 * every request, so a test can look at what the model was told.
 */
export class ChatFakeLlm implements Llm {
  readonly requests: TurnRequest[] = [];
  private readonly steps: ChatStep[];
  private readonly usage: Usage;
  /** Runs before each turn is answered (to hold a call open or to fail it). */
  before?: (req: TurnRequest) => Promise<void>;

  constructor(steps: ChatStep[], usage: Partial<Usage> = {}) {
    this.steps = [...steps];
    this.usage = { input: 500, output: 300, cacheRead: 0, cacheWrite: 0, ...usage };
  }

  async generate<T>(_req: LlmRequest<T>): Promise<LlmResult<T>> {
    throw new Error('ChatFakeLlm: only chat turns are scripted');
  }

  async turn(req: TurnRequest): Promise<TurnResult> {
    // The caller mutates the message list as the conversation grows: keep what was seen at this turn.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    await this.before?.(req);
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0];
    if (!step) throw new Error('ChatFakeLlm: no scripted turn left');
    const content = typeof step === 'function' ? step(req) : step;
    return { content, stop: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { ...this.usage } };
  }
}
