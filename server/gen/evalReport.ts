import { estimateCostUsd, noUsage, totalTokens, type Usage } from './llm';

/**
 * What one eval run records and how a set of runs is summarised. Pure functions over plain
 * data, so the arithmetic is tested offline without spending a token.
 */

export interface EvalRun {
  id: string;
  run: number;
  prompt: string;
  kind: string;
  size: string;
  /** ok: passed every check. not-ok: the generator gave up with a closest map. error: no map at all. */
  status: 'ok' | 'not-ok' | 'error';
  stoppedBy: string;
  /** For `error`: the generator's error code ("api", "budget", "truncated", ...). */
  errorCode?: string;
  error?: string;
  /** Model drafts used (the first draft counts as 1). */
  attempts: number;
  /** Model calls by label, in order. */
  calls: { label: string; ms: number; usage: Usage }[];
  usage: Usage;
  ms: number;
  pieces: number;
  /** Problems the first check found: what the model gets wrong before any repair. */
  firstProblems: string[];
  /** What the review step asked to change (empty: it passed the map or was skipped). */
  reviewIssues: string[];
  /** Problems left when it gave up. */
  finalProblems: string[];
  /** Automatic fixes applied by code. */
  fixes: number;
  fitChecked: number;
  fitPassed: number;
  fitMisses: string[];
  notes: string[];
}

export interface Stat {
  min: number;
  median: number;
  p90: number;
  max: number;
  mean: number;
}

export function stat(values: number[]): Stat {
  if (!values.length) return { min: 0, median: 0, p90: 0, max: 0, mean: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  return { min: v[0], median: at(0.5), p90: at(0.9), max: v[v.length - 1], mean: v.reduce((a, b) => a + b, 0) / v.length };
}

export interface Cluster {
  text: string;
  count: number;
  /** Distinct prompts it showed up in. */
  prompts: number;
}

/** "Spawn at [3.2, 4, -1] is inside block 'B3'" and its siblings count as one kind of problem. */
export function problemKind(problem: string): string {
  return problem
    .replace(/\[[^\]]*\]/g, '[..]')
    .replace(/"[^"]*"/g, '"."')
    .replace(/'[^']*'/g, "'.'")
    .replace(/-?\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

export function clusterProblems(runs: EvalRun[], pick: (r: EvalRun) => string[]): Cluster[] {
  const map = new Map<string, { count: number; prompts: Set<string> }>();
  for (const r of runs)
    for (const p of pick(r)) {
      const key = problemKind(p);
      const e = map.get(key) ?? { count: 0, prompts: new Set() };
      e.count++;
      e.prompts.add(r.id);
      map.set(key, e);
    }
  return [...map.entries()].map(([text, e]) => ({ text, count: e.count, prompts: e.prompts.size })).sort((a, b) => b.count - a.count);
}

export interface Summary {
  runs: number;
  ok: number;
  /** Fraction of runs that ended ok. */
  passRate: number;
  /** Fraction that were ok with the first draft (no repair). */
  firstDraftRate: number;
  /** Fraction whose first draft passed the automatic checks (the review may still have asked for changes). */
  firstCheckRate: number;
  /** Fraction in which the review step asked for changes. */
  reviewChangeRate: number;
  /** Fraction of ok runs that also met every measured expectation of their prompt. */
  fitRate: number;
  /** Fraction of all measured expectations met, over all ok runs. */
  fitChecks: number;
  attempts: Stat;
  tokens: Stat;
  /** Tokens if prompt-cache reads counted a tenth, which is how they are billed. */
  billedTokens: Stat;
  /** Share of prompt tokens served from the prompt cache. */
  cacheHitRate: number;
  latencySeconds: Stat;
  costUsd: Stat & { total: number };
  /** Runs whose token total passed these thresholds, for the "how far does Haiku get in 100K" question. */
  overBudget: { over80k: number; over100k: number; budgetStops: number };
  /** Problems the first check reported, most common first. */
  firstProblems: Cluster[];
  /** What the review asked for, most common first. */
  reviewIssues: Cluster[];
  /** Problems still there when the generator gave up. */
  finalProblems: Cluster[];
  /** Expectations missed, most common first. */
  fitMisses: Cluster[];
  errors: Record<string, number>;
}

const sumUsage = (runs: EvalRun[]): Usage => runs.reduce((u, r) => ({ input: u.input + r.usage.input, output: u.output + r.usage.output, cacheRead: u.cacheRead + r.usage.cacheRead, cacheWrite: u.cacheWrite + r.usage.cacheWrite }), noUsage());

export function summarize(runs: EvalRun[]): Summary {
  const done = runs.filter((r) => r.status !== 'error');
  const ok = runs.filter((r) => r.status === 'ok');
  const frac = (n: number, d: number) => (d ? n / d : 0);
  const usage = sumUsage(runs);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const checks = ok.reduce((a, r) => a + r.fitChecked, 0);
  const passes = ok.reduce((a, r) => a + r.fitPassed, 0);
  const errors: Record<string, number> = {};
  for (const r of runs) if (r.status === 'error') errors[r.errorCode ?? 'unknown'] = (errors[r.errorCode ?? 'unknown'] ?? 0) + 1;
  const costs = runs.map((r) => estimateCostUsd(r.usage));
  return {
    runs: runs.length,
    ok: ok.length,
    passRate: frac(ok.length, runs.length),
    firstDraftRate: frac(ok.filter((r) => r.attempts <= 1).length, runs.length),
    firstCheckRate: frac(done.filter((r) => r.firstProblems.length === 0).length, done.length),
    reviewChangeRate: frac(done.filter((r) => r.reviewIssues.length > 0).length, done.length),
    fitRate: frac(ok.filter((r) => r.fitPassed === r.fitChecked).length, ok.length),
    fitChecks: frac(passes, checks),
    attempts: stat(done.map((r) => r.attempts)),
    tokens: stat(runs.map((r) => totalTokens(r.usage))),
    billedTokens: stat(runs.map((r) => r.usage.input + r.usage.output + r.usage.cacheWrite + r.usage.cacheRead / 10)),
    cacheHitRate: frac(usage.cacheRead, promptTokens),
    latencySeconds: stat(runs.map((r) => r.ms / 1000)),
    costUsd: { ...stat(costs), total: costs.reduce((a, b) => a + b, 0) },
    overBudget: {
      over80k: runs.filter((r) => totalTokens(r.usage) > 80_000).length,
      over100k: runs.filter((r) => totalTokens(r.usage) > 100_000).length,
      budgetStops: runs.filter((r) => r.stoppedBy === 'budget' || r.errorCode === 'budget').length,
    },
    firstProblems: clusterProblems(done, (r) => r.firstProblems),
    reviewIssues: clusterProblems(done, (r) => r.reviewIssues),
    finalProblems: clusterProblems(runs.filter((r) => r.status === 'not-ok'), (r) => r.finalProblems),
    fitMisses: clusterProblems(ok, (r) => r.fitMisses),
    errors,
  };
}

const pct = (f: number) => `${Math.round(f * 100)}%`;
const k = (n: number) => `${(n / 1000).toFixed(1)}K`;
const usd = (n: number) => `$${n.toFixed(4)}`;

export function renderMarkdown(runs: EvalRun[], s: Summary, meta: { when: string; models: string; critique: boolean; concurrency: number }): string {
  const L: string[] = [];
  L.push(`# Map generator eval`, '');
  L.push(`${meta.when} | models: ${meta.models} | review step ${meta.critique ? 'on' : 'off'} | ${s.runs} runs, concurrency ${meta.concurrency}`, '');
  L.push('## Summary', '');
  L.push(`| | |`, `|---|---|`);
  L.push(`| Build pass rate | **${pct(s.passRate)}** (${s.ok}/${s.runs}) |`);
  L.push(`| Pass with the first draft | ${pct(s.firstDraftRate)} (first draft passes the checks: ${pct(s.firstCheckRate)}; review asked for changes: ${pct(s.reviewChangeRate)}) |`);
  L.push(`| Ok runs that also meet every measured expectation | ${pct(s.fitRate)} (${pct(s.fitChecks)} of individual expectations) |`);
  L.push(`| Drafts per run | median ${s.attempts.median}, p90 ${s.attempts.p90}, max ${s.attempts.max} |`);
  L.push(`| Tokens per run (all counted) | median ${k(s.tokens.median)}, p90 ${k(s.tokens.p90)}, max ${k(s.tokens.max)} |`);
  L.push(`| Tokens if cache reads counted 10% | median ${k(s.billedTokens.median)}, p90 ${k(s.billedTokens.p90)}, max ${k(s.billedTokens.max)} |`);
  L.push(`| Runs over 80K / over 100K / stopped by the budget | ${s.overBudget.over80k} / ${s.overBudget.over100k} / ${s.overBudget.budgetStops} |`);
  L.push(`| Prompt cache hit rate | ${pct(s.cacheHitRate)} of prompt tokens |`);
  L.push(`| Latency | median ${s.latencySeconds.median.toFixed(0)} s, p90 ${s.latencySeconds.p90.toFixed(0)} s, max ${s.latencySeconds.max.toFixed(0)} s |`);
  L.push(`| Cost at list price | total ${usd(s.costUsd.total)}, mean ${usd(s.costUsd.mean)}, max ${usd(s.costUsd.max)} per run |`);
  if (Object.keys(s.errors).length) L.push(`| Errors | ${Object.entries(s.errors).map(([c, n]) => `${c} x${n}`).join(', ')} |`);
  L.push('', '## Runs', '');
  L.push('| prompt | run | result | drafts | tokens | s | cost | pieces | fit | notes |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const r of runs) {
    const result = r.status === 'ok' ? 'ok' : r.status === 'not-ok' ? `not ok (${r.stoppedBy})` : `error ${r.errorCode ?? ''}`;
    const fitCell = r.status === 'error' ? '-' : r.fitChecked ? `${r.fitPassed}/${r.fitChecked}${r.fitMisses.length ? ': ' + r.fitMisses.join('; ') : ''}` : '-';
    L.push(`| ${r.id} | ${r.run} | ${result} | ${r.attempts} | ${k(totalTokens(r.usage))} | ${(r.ms / 1000).toFixed(0)} | ${usd(estimateCostUsd(r.usage))} | ${r.pieces} | ${fitCell} | ${r.status === 'ok' ? '' : (r.finalProblems[0] ?? r.error ?? '').replace(/\|/g, '/').slice(0, 80)} |`);
  }
  const table = (title: string, c: Cluster[], cap = 12) => {
    if (!c.length) return;
    L.push('', `## ${title}`, '', '| count | prompts | problem |', '|---|---|---|');
    for (const e of c.slice(0, cap)) L.push(`| ${e.count} | ${e.prompts} | ${e.text.replace(/\|/g, '/')} |`);
  };
  table('What the first draft gets wrong (before any repair)', s.firstProblems);
  table('What the review asked to change', s.reviewIssues);
  table('What was still wrong when the generator gave up', s.finalProblems);
  table('Expectations missed by maps that built', s.fitMisses);
  L.push('');
  return L.join('\n');
}
