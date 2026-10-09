/**
 * Generator settings. Everything has a default that follows docs/llm-map-generation-plan.md
 * (Haiku 5.5 only, every call and every job under 100K tokens); the environment can override
 * the model ids and the thinking mode without a code change. No secret lives here: the API
 * key is read from ANTHROPIC_API_KEY by the Anthropic client itself.
 */

export type Effort = 'low' | 'medium' | 'high';

export interface NodeSettings {
  model: string;
  /** "off" sends thinking: disabled (cheapest and fastest; lint-driven repair makes up for it). */
  thinking: 'off' | 'adaptive';
  effort: Effort;
  maxTokens: number;
}

export interface GenConfig {
  /** The planning step and the review step: small outputs. */
  fast: NodeSettings;
  /** Drafting and repairing a whole map. */
  draft: NodeSettings;
  /** Draft + repairs allowed per generation (the review's repair is extra). */
  maxAttempts: number;
  /** A single prompt may not exceed this many tokens (Haiku 5.5 is cheaper up to 100K). */
  maxCallInputTokens: number;
  /** Input + output tokens over all calls of one generation. */
  maxJobTokens: number;
  /** Ask a second opinion on whether the finished map fits the request. */
  critique: boolean;
  /** Who may spend how much; enforced by the job manager. */
  limits: {
    /** Generations one user may start in any 24 hours. */
    dailyPerUser: number;
    /** Generations running at once, all users together. */
    maxConcurrent: number;
    /** Tokens all users together may spend in any 24 hours; past it the generator pauses (503). */
    dailyTokenCeiling: number;
    /** Longest request text, in characters. */
    promptMax: number;
    /** Generations one user may start per minute. */
    startsPerMinute: number;
  };
}

export const HAIKU = 'claude-haiku-5-5';

/** Haiku 5.5 list prices in USD per million tokens, for prompts up to 100K tokens. For estimates only. */
export const PRICES = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 };

const pick = <T extends string>(v: string | undefined, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);
const int = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): GenConfig {
  return {
    fast: {
      model: env.GEN_MODEL_FAST || HAIKU,
      thinking: 'off',
      effort: 'low',
      maxTokens: 2_000,
    },
    draft: {
      model: env.GEN_MODEL_DRAFT || HAIKU,
      thinking: pick(env.GEN_DRAFT_THINKING, ['off', 'adaptive'], 'off'),
      effort: pick(env.GEN_DRAFT_EFFORT, ['low', 'medium', 'high'], 'low'),
      maxTokens: int(env.GEN_DRAFT_MAX_TOKENS, 24_000),
    },
    maxAttempts: int(env.GEN_MAX_ATTEMPTS, 3),
    maxCallInputTokens: int(env.GEN_MAX_CALL_INPUT_TOKENS, 100_000),
    maxJobTokens: int(env.GEN_MAX_JOB_TOKENS, 100_000),
    critique: env.GEN_CRITIQUE !== 'off',
    limits: {
      dailyPerUser: int(env.GEN_DAILY_LIMIT, 10),
      maxConcurrent: int(env.GEN_MAX_CONCURRENT, 2),
      // Roughly 100 full generations a day at the typical 30-60K tokens each: well under a dollar at list price.
      dailyTokenCeiling: int(env.GEN_DAILY_TOKEN_CEILING, 5_000_000),
      promptMax: int(env.GEN_PROMPT_MAX, 500),
      startsPerMinute: int(env.GEN_STARTS_PER_MINUTE, 6),
    },
  };
}
