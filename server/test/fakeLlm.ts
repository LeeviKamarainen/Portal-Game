import type { Llm, LlmRequest, LlmResult, Usage } from '../gen/llm';

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
