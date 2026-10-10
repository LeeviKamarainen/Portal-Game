import { randomBytes } from 'node:crypto';
import { hasRight, type Store, type User } from '../store/Store';
import { ApiError } from '../auth/http';
import { RateLimiter } from '../auth/RateLimiter';
import type { MapData } from '../../src/world/maps/MapFormat';
import { isTerminalEvent, type JobEvent, type PublicOutcome } from '../../src/net/generate';
import { cleanBaseMap } from './base';
import type { CheckResult } from './check';
import type { GenConfig } from './config';
import { generateMap, type GenOutcome } from './graph';
import { BudgetedLlm, GenError, estimateCostUsd, type Llm } from './llm';
import type { GenRequest } from './prompts';

/**
 * Runs map generations for logged-in users (docs/llm-map-generation-plan.md, milestone 3):
 * decides who may start one, keeps each job's events so a viewer can watch live or catch up
 * afterwards, and records every run in the store for the daily quota and for audit.
 *
 * Jobs live in memory, like rooms: a restart ends the running ones (they are marked
 * "interrupted" and not charged to anyone's quota the next time the server starts).
 */

export type JobStatus = 'running' | 'ok' | 'partial' | 'failed' | 'cancelled';

// What a viewer is sent is shared with the page (src/net/generate.ts).
export type { JobEvent, PublicOutcome };

export interface StoredEvent {
  seq: number;
  event: JobEvent;
}

export const isTerminal = isTerminalEvent;

export class Job {
  readonly id: string;
  readonly userId: number;
  readonly request: GenRequest;
  readonly createdAt: number;
  status: JobStatus = 'running';
  finishedAt: number | null = null;
  readonly events: StoredEvent[] = [];
  readonly abort = new AbortController();
  /** Set when the server is shutting down, so the run is recorded as interrupted rather than cancelled. */
  interrupted = false;
  /** Resolves when the run has finished and been recorded. */
  done: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(e: StoredEvent) => void>();

  constructor(id: string, userId: number, request: GenRequest, createdAt: number) {
    this.id = id;
    this.userId = userId;
    this.request = request;
    this.createdAt = createdAt;
  }

  push(event: JobEvent): void {
    const stored = { seq: this.events.length + 1, event };
    this.events.push(stored);
    for (const l of [...this.listeners]) l(stored);
  }

  /** Calls `listener` with every event after `afterSeq` (those already happened first), then with new ones. Returns the way to stop. */
  subscribe(afterSeq: number, listener: (e: StoredEvent) => void): () => void {
    for (const e of this.events) if (e.seq > afterSeq) listener(e);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface JobManagerOptions {
  store: Store;
  /** Makes the model client for one generation; null when no API key is configured (the generator is off). */
  llm: (() => Llm) | null;
  config: GenConfig;
  /** Checks a map; the server passes the worker-thread one. Default: in-process. */
  check?: (map: MapData) => Promise<CheckResult>;
  log?: (line: string) => void;
  now?: () => number;
  /** How long a finished job stays available to viewers (default 10 minutes). */
  retainMs?: number;
}

const DAY_MS = 24 * 3600 * 1000;
const PROMPT_MIN = 3;
const KINDS = ['auto', 'combat', 'puzzle'] as const;
const SIZES = ['auto', 'small', 'medium', 'large'] as const;

export class JobManager {
  private readonly opts: JobManagerOptions;
  private readonly store: Store;
  private readonly config: GenConfig;
  private readonly jobs = new Map<string, Job>();
  private readonly starts: RateLimiter;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(options: JobManagerOptions) {
    this.opts = options;
    this.store = options.store;
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.starts = new RateLimiter(options.config.limits.startsPerMinute, 60_000);
    const lost = this.store.interruptRunningGenerations();
    if (lost) this.log(`${lost} generation${lost === 1 ? '' : 's'} were running when the server stopped; marked interrupted`);
  }

  get enabled(): boolean {
    return this.opts.llm !== null;
  }

  /** Drops finished jobs nobody needs any more. */
  sweep(): void {
    this.starts.sweep();
    const cutoff = this.now() - (this.opts.retainMs ?? 600_000);
    for (const [id, job] of this.jobs) if (job.finishedAt !== null && job.finishedAt < cutoff) this.jobs.delete(id);
  }

  quota(user: User): { used: number; limit: number; allowed: boolean; enabled: boolean } {
    return {
      used: this.store.countGenerationsSince(user.id, this.now() - DAY_MS),
      limit: this.config.limits.dailyPerUser,
      allowed: hasRight(user, 'generate-maps'),
      enabled: this.enabled,
    };
  }

  /** Validates, applies every gate, then starts the run in the background. */
  start(user: User, input: Record<string, unknown>): Job {
    const limits = this.config.limits;
    if (!this.opts.llm) throw new ApiError(503, 'generator-disabled', 'The map generator is not set up on this server.');
    if (!hasRight(user, 'generate-maps')) throw new ApiError(403, 'no-right', 'Your account is not allowed to generate maps. Ask the admin for the map generator right.');
    const request = this.requestOf(input);
    if (!this.starts.allow(String(user.id))) throw new ApiError(429, 'rate-limited', 'Too many generations started - wait a minute.', { 'retry-after': '60' });
    const mine = [...this.jobs.values()].filter((j) => j.userId === user.id && j.status === 'running');
    if (mine.length > 0) throw new ApiError(409, 'already-running', 'You already have a map being generated; wait for it or cancel it.');
    if ([...this.jobs.values()].filter((j) => j.status === 'running').length >= limits.maxConcurrent)
      throw new ApiError(429, 'busy', 'The generator is busy right now - try again in a moment.', { 'retry-after': '15' });
    const since = this.now() - DAY_MS;
    if (this.store.countGenerationsSince(user.id, since) >= limits.dailyPerUser)
      throw new ApiError(429, 'quota', `You have used your ${limits.dailyPerUser} map generations for today. Try again tomorrow.`);
    if (this.store.tokensUsedSince(since) >= limits.dailyTokenCeiling)
      throw new ApiError(503, 'generator-paused', 'The map generator has reached its limit for today. Try again tomorrow.');

    const id = randomBytes(9).toString('base64url');
    const job = new Job(id, user.id, request, this.now());
    this.store.startGeneration(user.id, id, request.prompt, `${request.kind}/${request.size}`);
    this.jobs.set(id, job);
    job.done = this.run(job, user);
    return job;
  }

  /** The user's own job, or a 404 that doesn't admit other people's exist. */
  find(user: User, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.userId !== user.id) throw new ApiError(404, 'no-such-job', 'There is no such generation (it may be too old).');
    return job;
  }

  cancel(user: User, id: string): void {
    const job = this.find(user, id);
    if (job.status === 'running') job.abort.abort();
  }

  /** Stops every running job (recorded as interrupted) and waits for them to wind down. */
  async shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.status === 'running');
    for (const job of running) {
      job.interrupted = true;
      job.abort.abort();
    }
    await Promise.all(running.map((j) => j.done));
  }

  private requestOf(input: Record<string, unknown>): GenRequest {
    const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\s+/g, ' ').trim() : '';
    const max = this.config.limits.promptMax;
    if (prompt.length < PROMPT_MIN || prompt.length > max) throw new ApiError(400, 'invalid', `Describe the map in ${PROMPT_MIN}-${max} characters.`);
    const kind = input.kind === undefined ? 'auto' : input.kind;
    const size = input.size === undefined ? 'auto' : input.size;
    if (!KINDS.includes(kind as never)) throw new ApiError(400, 'invalid', `kind is one of: ${KINDS.join(', ')}.`);
    if (!SIZES.includes(size as never)) throw new ApiError(400, 'invalid', `size is one of: ${SIZES.join(', ')}.`);
    const request: GenRequest = { prompt, kind: kind as GenRequest['kind'], size: size as GenRequest['size'] };
    if (input.baseMap !== undefined) {
      const base = cleanBaseMap(input.baseMap);
      if ('error' in base) throw new ApiError(400, 'invalid', base.error);
      request.baseMap = base.map;
    }
    return request;
  }

  private async run(job: Job, user: User): Promise<void> {
    const llm = new BudgetedLlm(this.opts.llm!(), this.config);
    let status: JobStatus = 'failed';
    let error: { code: string; message: string } | null = null;
    let outcome: GenOutcome | null = null;
    try {
      outcome = await generateMap(job.request, {
        llm,
        config: this.config,
        check: this.opts.check,
        signal: job.abort.signal,
        emit: (e) => job.push({ type: 'step', node: e.node, message: e.message, ...(e.problems ? { problems: e.problems } : {}) }),
        onPartial: (e) => job.push(e),
      });
      status = outcome.ok ? 'ok' : 'partial';
    } catch (e) {
      if (e instanceof GenError) {
        status = e.code === 'aborted' ? 'cancelled' : 'failed';
        error = { code: e.code, message: e.message };
      } else {
        this.log(`generation ${job.id} for ${user.name} crashed: ${(e as Error).stack ?? e}`);
        error = { code: 'server', message: 'Something went wrong while generating the map.' };
      }
    }

    const used = llm.used;
    this.store.finishGeneration(job.id, {
      status: job.interrupted ? 'interrupted' : status,
      attempts: outcome?.attempts ?? 0,
      tokensIn: used.input + used.cacheRead + used.cacheWrite,
      tokensOut: used.output,
      error: error ? `${error.code}: ${error.message}` : null,
    });
    this.log(`generation ${job.id} for ${user.name}: ${job.interrupted ? 'interrupted' : status}, ${llm.usedTokens} tokens, ~$${estimateCostUsd(used).toFixed(4)}`);
    job.status = status;
    job.finishedAt = this.now();
    if (outcome) {
      const { ok, map, problems, notes, fixes, attempts, stoppedBy } = outcome;
      job.push({ type: 'done', status: ok ? 'ok' : 'partial', outcome: { ok, map, problems, notes, fixes, attempts, stoppedBy, tokens: { input: used.input + used.cacheRead + used.cacheWrite, output: used.output }, costUsd: estimateCostUsd(used) } });
    } else {
      job.push({ type: 'error', status: status === 'cancelled' ? 'cancelled' : 'failed', code: error!.code, message: error!.message });
    }
  }
}
