import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { PRICES, type Effort } from './config';

/**
 * The only place that talks to a model. The graph depends on `Llm`, so tests use a fake and a
 * different provider (Claude on Foundry, say) is one more class. `BudgetedLlm` wraps any `Llm`
 * with the token limits from docs/llm-map-generation-plan.md.
 */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const noUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const totalTokens = (u: Usage): number => u.input + u.output + u.cacheRead + u.cacheWrite;
export const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

/** USD estimate at list price; real billing is in the Anthropic Console. */
export const estimateCostUsd = (u: Usage): number => (u.input * PRICES.input + u.output * PRICES.output + u.cacheRead * PRICES.cacheRead + u.cacheWrite * PRICES.cacheWrite) / 1_000_000;

export interface LlmRequest<T> {
  /** The graph node asking, for logs and events. */
  label: string;
  model: string;
  /** The static part of the prompt. It is sent with cache_control, so keep it byte-stable. */
  system: string;
  user: string;
  schema: z.ZodType<T>;
  thinking: 'off' | 'adaptive';
  effort: Effort;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface LlmResult<T> {
  value: T;
  usage: Usage;
}

export interface Llm {
  generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type GenErrorCode = 'aborted' | 'refusal' | 'truncated' | 'bad-output' | 'budget' | 'api';

/** A generation that cannot continue, with a reason the caller can show. */
export class GenError extends Error {
  readonly code: GenErrorCode;

  constructor(code: GenErrorCode, message: string) {
    super(message);
    this.name = 'GenError';
    this.code = code;
  }
}

/** The part of the Anthropic client used here, so tests can pass a stand-in. */
export interface AnthropicLike {
  messages: { stream: Anthropic['messages']['stream'] };
}

export class AnthropicLlm implements Llm {
  private readonly client: AnthropicLike;

  constructor(client: AnthropicLike = new Anthropic()) {
    this.client = client;
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages
        .stream(
          {
            model: req.model,
            max_tokens: req.maxTokens,
            ...(req.thinking === 'off' ? { thinking: { type: 'disabled' as const } } : {}),
            output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            messages: [{ role: 'user', content: req.user }],
          },
          { signal: req.signal },
        )
        .finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIUserAbortError || req.signal?.aborted) throw new GenError('aborted', 'The generation was cancelled.');
      if (e instanceof Anthropic.APIError) throw new GenError('api', `The model service answered ${e.status ?? 'with an error'}: ${e.message}`);
      throw e;
    }
    const usage: Usage = {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
    };
    if (message.stop_reason === 'refusal') throw new GenError('refusal', 'The model declined this request. Try describing the map differently.');
    if (message.stop_reason === 'max_tokens') throw new GenError('truncated', 'The model ran out of output space before finishing the map.');
    const text = message.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!text) throw new GenError('bad-output', 'The model returned no map.');
    try {
      return { value: req.schema.parse(JSON.parse(text.text)), usage };
    } catch (e) {
      throw new GenError('bad-output', `The model's answer did not match the expected structure: ${(e as Error).message.slice(0, 300)}`);
    }
  }
}

/** Characters per token for a conservative size guess (the catalogue prompt measures about 2). */
const CHARS_PER_TOKEN = 2;
/** Below this much room left for output, a call is pointless: stop instead. */
const MIN_OUTPUT_TOKENS = 1_500;

export interface CallRecord {
  label: string;
  usage: Usage;
  ms: number;
}

/**
 * Enforces the limits: a prompt over `maxCallInputTokens` is never sent, and the sum of input
 * and output tokens over all calls stays under `maxJobTokens` (the output cap of each call is
 * lowered to what is left). Records every call for the final report.
 */
export class BudgetedLlm implements Llm {
  used = noUsage();
  readonly calls: CallRecord[] = [];
  private readonly inner: Llm;
  private readonly limits: { maxCallInputTokens: number; maxJobTokens: number };

  constructor(inner: Llm, limits: { maxCallInputTokens: number; maxJobTokens: number }) {
    this.inner = inner;
    this.limits = limits;
  }

  get usedTokens(): number {
    return totalTokens(this.used);
  }

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    const estimate = Math.ceil((req.system.length + req.user.length) / CHARS_PER_TOKEN);
    if (estimate > this.limits.maxCallInputTokens)
      throw new GenError('budget', `The ${req.label} prompt would be about ${Math.round(estimate / 1000)}K tokens, over the ${this.limits.maxCallInputTokens / 1000}K limit for one call.`);
    const left = this.limits.maxJobTokens - this.usedTokens - estimate;
    if (left < MIN_OUTPUT_TOKENS) throw new GenError('budget', `This generation has used ${Math.round(this.usedTokens / 1000)}K of its ${this.limits.maxJobTokens / 1000}K token budget.`);
    const t0 = Date.now();
    const result = await this.inner.generate({ ...req, maxTokens: Math.min(req.maxTokens, left) });
    this.used = addUsage(this.used, result.usage);
    this.calls.push({ label: req.label, usage: result.usage, ms: Date.now() - t0 });
    return result;
  }
}
