import { Worker } from 'node:worker_threads';
import type { MapData } from '../../src/world/maps/MapFormat';
import { checkGenerated, type CheckOptions, type CheckResult } from './check';
import { playtest, type PlayReport, type PlayStep } from './playtest';
import { analyzeRoutes, type RouteReport } from './routes';

/** A map check that takes longer than this is given up on. */
const CHECK_TIMEOUT_MS = 30_000;

/**
 * The worker's JS heap is capped. Left alone V8 lets it grow to hundreds of megabytes of garbage
 * from the headless builds (measured: 360 MB resident after 60 checks, flat at 127 MB with these
 * limits), which on the 512 MB Fly machine with the server's own ~140 MB would be an out-of-memory
 * kill. A map check peaks around 40 MB live. A worker that does hit the cap dies, `lost` re-checks
 * on the main thread, and the next check starts a fresh one.
 */
export const WORKER_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 } as const;

interface Pending {
  resolve(r: any): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  /** Does the work again on this thread, when the worker cannot. */
  fallback(): Promise<unknown>;
  /** What to answer when the worker takes too long. */
  timeout: unknown;
}

/** Where the worker file is: next to this module when run from source, next to the bundle when built. */
function workerUrl(): URL {
  return new URL(`./checkWorker${import.meta.url.endsWith('.ts') ? '.ts' : '.js'}`, import.meta.url);
}

/**
 * Checks maps on one worker thread, started on first use. If the worker cannot start (the file
 * is missing from a build, say) it logs once and falls back to checking on the calling thread,
 * which works, but can stall the game loop for a moment.
 */
export class CheckWorker {
  private worker: Worker | null = null;
  private broken = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  /** Same signature as `checkGenerated`, so it can be passed to the graph. */
  readonly check = (map: MapData, options: CheckOptions = {}): Promise<CheckResult> =>
    this.call<CheckResult>({ kind: 'check', map, options }, () => checkGenerated(map, options), {
      ok: false,
      map,
      fixes: [],
      problems: ['The map took too long to check; make it simpler.'],
    });

  /** Whether the exit can be reached and how (server/gen/routes.ts). */
  readonly routes = (map: MapData): Promise<RouteReport> =>
    this.call<RouteReport>({ kind: 'routes', map }, () => analyzeRoutes(map), null);

  /** A scripted playtest in the real simulation (server/gen/playtest.ts). */
  readonly playtest = (map: MapData, steps: PlayStep[]): Promise<PlayReport> =>
    this.call<PlayReport>({ kind: 'playtest', map, steps }, () => playtest(map, steps), null);

  private call<T>(message: object, fallback: () => Promise<T>, onTimeout: T | null): Promise<T> {
    const worker = this.broken ? null : this.start();
    if (!worker) return fallback();
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A stuck check poisons the worker: replace it, and report the map as unbuildable.
        void this.worker?.terminate();
        this.worker = null;
        if (onTimeout === null) reject(new Error('The analysis took too long.'));
        else resolve(onTimeout);
      }, CHECK_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, fallback, timeout: onTimeout });
      worker.postMessage({ id, ...message });
    });
  }

  private start(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(workerUrl(), { resourceLimits: { ...WORKER_LIMITS } });
      worker.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result!);
        else p.reject(new Error(msg.error ?? 'The map check failed.'));
      });
      worker.on('error', (e: unknown) => this.lost(worker, e instanceof Error ? e : new Error(String(e))));
      worker.on('exit', (code) => {
        if (this.worker === worker) this.lost(worker, new Error(`the check worker exited with code ${code}`));
      });
      this.worker = worker;
      return worker;
    } catch (e) {
      this.broken = true;
      this.log(`map check worker unavailable (${(e as Error).message}); checking on the main thread`);
      return null;
    }
  }

  /** The worker died: fail what it was doing by re-checking here, and use a fresh worker next time. */
  private lost(worker: Worker, e: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.log(`map check worker stopped (${e.message})`);
    const orphans = [...this.pending.values()];
    this.pending.clear();
    for (const p of orphans) {
      clearTimeout(p.timer);
      p.fallback().then(p.resolve, (err: unknown) => p.reject(err instanceof Error ? err : new Error(String(err))));
    }
  }

  async dispose(): Promise<void> {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    const worker = this.worker;
    this.worker = null;
    await worker?.terminate();
  }
}
