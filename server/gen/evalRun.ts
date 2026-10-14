import type { GenConfig } from './config';
import type { EvalRun } from './evalReport';
import { fit, type GoldenPrompt } from './golden';
import { generateMap, type GenEvent } from './graph';
import { BudgetedLlm, GenError, type Llm } from './llm';

/**
 * Runs golden prompts through the real pipeline and records what each cost and how it ended.
 * The model is injected, so the harness itself is tested with a scripted one; `eval.ts` is the
 * command line that supplies the real one.
 */

export interface RunOptions {
  prompts: GoldenPrompt[];
  runs: number;
  concurrency: number;
  config: GenConfig;
  /** A fresh model client per generation (each gets its own token budget). */
  makeLlm: () => Llm;
  /** Called as each run finishes, in completion order. */
  onRun?: (run: EvalRun, done: number, total: number) => void;
  /** Called with the finished map, so it can be written to disk. */
  onMap?: (run: EvalRun, map: unknown) => void;
}

export async function runEval(opts: RunOptions): Promise<EvalRun[]> {
  const jobs: { golden: GoldenPrompt; run: number }[] = [];
  for (let run = 1; run <= opts.runs; run++) for (const golden of opts.prompts) jobs.push({ golden, run });
  const results: EvalRun[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const r = await one(job.golden, job.run, opts);
      results.push(r);
      opts.onRun?.(r, results.length, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, jobs.length)) }, worker));
  // Stable order for the report: by prompt, then run.
  const order = new Map(opts.prompts.map((p, i) => [p.id, i]));
  return results.sort((a, b) => (order.get(a.id)! - order.get(b.id)!) || a.run - b.run);
}

async function one(golden: GoldenPrompt, run: number, opts: RunOptions): Promise<EvalRun> {
  const llm = new BudgetedLlm(opts.makeLlm(), opts.config);
  const t0 = Date.now();
  let firstProblems: string[] | null = null;
  const reviewIssues: string[] = [];
  const emit = (e: GenEvent) => {
    // "Checking the map" carries no result; the event after it does (an empty list when the map passed).
    if (e.node === 'check' && e.problems !== undefined && firstProblems === null) firstProblems = e.problems;
    if (e.node === 'critique' && e.problems?.length) reviewIssues.push(...e.problems);
  };
  const base: EvalRun = {
    id: golden.id,
    run,
    prompt: golden.prompt,
    kind: golden.kind,
    size: golden.size,
    status: 'error',
    stoppedBy: 'error',
    attempts: 0,
    calls: [],
    usage: llm.used,
    ms: 0,
    pieces: 0,
    firstProblems: [],
    reviewIssues: [],
    finalProblems: [],
    fixes: 0,
    fitChecked: 0,
    fitPassed: 0,
    fitMisses: [],
    notes: [],
  };
  try {
    const outcome = await generateMap({ prompt: golden.prompt, kind: golden.kind, size: golden.size }, { llm, config: opts.config, emit });
    const f = outcome.map ? fit(outcome.map, golden.expect) : { checked: 0, passed: 0, misses: [] as string[] };
    const result: EvalRun = {
      ...base,
      status: outcome.ok ? 'ok' : 'not-ok',
      stoppedBy: outcome.stoppedBy,
      attempts: outcome.attempts,
      calls: llm.calls.map((c) => ({ label: c.label, ms: c.ms, usage: c.usage })),
      usage: llm.used,
      ms: Date.now() - t0,
      pieces: outcome.map?.pieces.length ?? 0,
      firstProblems: firstProblems ?? [],
      reviewIssues,
      finalProblems: outcome.ok ? [] : outcome.problems,
      fixes: outcome.fixes.length,
      fitChecked: f.checked,
      fitPassed: f.passed,
      fitMisses: f.misses,
      notes: outcome.notes,
    };
    if (outcome.map) opts.onMap?.(result, outcome.map);
    return result;
  } catch (e) {
    const code = e instanceof GenError ? e.code : 'crash';
    return {
      ...base,
      errorCode: code,
      error: (e as Error).message,
      stoppedBy: code,
      calls: llm.calls.map((c) => ({ label: c.label, ms: c.ms, usage: c.usage })),
      usage: llm.used,
      ms: Date.now() - t0,
      firstProblems: firstProblems ?? [],
      reviewIssues,
    };
  }
}
