/**
 * The eval harness (docs/llm-map-generation-plan.md, milestone 7) without the real API:
 * the statistics, problem clustering, the golden prompt set, the fit measurements, and the
 * runner driven by a scripted model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_MAPS } from '../../src/editor/templates';
import type { Blueprint } from '../gen/blueprint';
import { combatExample } from '../gen/blueprintExamples';
import { loadConfig } from '../gen/config';
import { clusterProblems, problemKind, renderMarkdown, stat, summarize, type EvalRun } from '../gen/evalReport';
import { runEval } from '../gen/evalRun';
import { GOLDEN, fit, measure } from '../gen/golden';
import { GenError, noUsage, type Llm } from '../gen/llm';
import { PIECES } from '../../src/world/maps/MapFormat';
import { toWire } from '../gen/wire';
import { FakeLlm } from './fakeLlm';

const highwire = () => BUILT_IN_MAPS[0].data();
const config = loadConfig({ GEN_CRITIQUE: 'off' });
const plan = (): Blueprint => ({ ...combatExample(), requirements: [] });

const run = (over: Partial<EvalRun> = {}): EvalRun => ({
  id: 'p',
  run: 1,
  prompt: 'x',
  kind: 'auto',
  size: 'auto',
  status: 'ok',
  stoppedBy: 'ok',
  attempts: 1,
  calls: [],
  usage: { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0 },
  ms: 10_000,
  pieces: 30,
  firstProblems: [],
  reviewIssues: [],
  finalProblems: [],
  fixes: 0,
  fitChecked: 2,
  fitPassed: 2,
  fitMisses: [],
  notes: [],
  ...over,
});

test('stat picks nearest-rank percentiles', () => {
  const s = stat([10, 1, 5, 3, 2, 8, 6, 4, 9, 7]);
  assert.deepEqual([s.min, s.median, s.p90, s.max, s.mean], [1, 5, 9, 10, 5.5]);
  assert.deepEqual(stat([]), { min: 0, median: 0, p90: 0, max: 0, mean: 0 });
});

test('problems that differ only in numbers and names are one kind', () => {
  const a = problemKind('Spawn at [3.2, 4, -1] is inside block "B3" by 0.4 m');
  const b = problemKind('Spawn at [-9, 0, 22.5] is inside block "wall7" by 1.25 m');
  assert.equal(a, b);
  assert.notEqual(a, problemKind('Door "d" has no receiver'));
});

test('clusters count occurrences and distinct prompts', () => {
  const runs = [
    run({ id: 'a', firstProblems: ['spawn 1 is in acid', 'spawn 2 is in acid'] }),
    run({ id: 'b', firstProblems: ['spawn 7 is in acid', 'door "x" has no receiver'] }),
  ];
  const c = clusterProblems(runs, (r) => r.firstProblems);
  assert.equal(c[0].count, 3);
  assert.equal(c[0].prompts, 2);
  assert.equal(c.length, 2);
});

test('the summary separates pass rate, first-draft rate, fit, cache and cost', () => {
  const runs = [
    run({ id: 'a' }),
    run({ id: 'b', attempts: 3, usage: { input: 20_000, output: 4_000, cacheRead: 40_000, cacheWrite: 8_000 }, fitPassed: 1, fitMisses: ['2 spawns, wanted 4'] }),
    run({ id: 'c', status: 'not-ok', stoppedBy: 'attempts', attempts: 3, finalProblems: ['spawn 1 is in acid'], fitChecked: 0, fitPassed: 0 }),
    run({ id: 'd', status: 'error', errorCode: 'budget', stoppedBy: 'budget', attempts: 0, usage: noUsage() }),
  ];
  const s = summarize(runs);
  assert.equal(s.runs, 4);
  assert.equal(s.ok, 2);
  assert.equal(s.passRate, 0.5);
  assert.equal(s.firstDraftRate, 0.25);
  assert.equal(s.fitRate, 0.5); // of the two ok runs, one met every expectation
  assert.equal(s.fitChecks, 3 / 4);
  assert.equal(s.errors.budget, 1);
  assert.equal(s.overBudget.budgetStops, 1);
  // cache reads: 40K of (10+20+40+8+10 + ...) prompt tokens, counted over all runs
  assert.ok(s.cacheHitRate > 0.3 && s.cacheHitRate < 0.5);
  assert.ok(s.billedTokens.max < s.tokens.max, 'cache reads at 10% make a job look smaller');
  assert.ok(s.costUsd.total > 0);
  assert.equal(s.finalProblems[0].count, 1);
  assert.equal(s.fitMisses[0].count, 1);
});

test('the markdown report has the summary, one row per run, and the problem tables', () => {
  const runs = [run({ id: 'a', firstProblems: ['spawn 1 is in acid'] }), run({ id: 'b', status: 'not-ok', stoppedBy: 'attempts', finalProblems: ['no floor | none'] })];
  const md = renderMarkdown(runs, summarize(runs), { when: '2026-10-10', models: 'claude-haiku-5-5', critique: true, concurrency: 3 });
  assert.match(md, /Build pass rate \| \*\*50%\*\*/);
  assert.match(md, /\| a \| 1 \| ok \| 1 \|/);
  assert.match(md, /not ok \(attempts\)/);
  assert.match(md, /What the first draft gets wrong/);
  assert.ok(!/no floor \| none/.test(md), 'pipes in problem text must not break the table');
});

test('golden prompts: ids are unique, sizes and kinds valid, and both map kinds are covered', () => {
  assert.ok(GOLDEN.length >= 20);
  assert.equal(new Set(GOLDEN.map((g) => g.id)).size, GOLDEN.length);
  for (const g of GOLDEN) {
    assert.ok(g.prompt.length >= 3 && g.prompt.length <= 500, g.id);
    assert.ok(['auto', 'combat', 'puzzle'].includes(g.kind), g.id);
    assert.ok(['auto', 'small', 'medium', 'large'].includes(g.size), g.id);
    for (const type of Object.keys(g.expect.has ?? {})) assert.ok(PIECES[type] || type === 'goal', `${g.id}: unknown piece type ${type}`);
  }
  assert.ok(GOLDEN.filter((g) => g.expect.kind === 'combat').length >= 8);
  assert.ok(GOLDEN.filter((g) => g.expect.kind === 'puzzle').length >= 6);
  // The two prompts from the original request are in the set.
  assert.ok(GOLDEN.some((g) => /big height differences/.test(g.prompt)));
  assert.ok(GOLDEN.some((g) => /Portal 1 stage 1/.test(g.prompt)));
});

test('measure and fit read a known map', () => {
  const m = measure(highwire());
  assert.equal(m.kind, 'combat');
  assert.ok(m.spawns >= 2);
  assert.ok(m.heightSpread >= 8, `Highwire climbs to a 16 m bridge, got ${m.heightSpread}`);
  assert.ok(m.portalPieces >= 1);
  const ok = fit(highwire(), { kind: 'combat', minSpawns: 2, heightSpread: 8 });
  assert.deepEqual([ok.checked, ok.passed, ok.misses], [3, 3, []]);
  const bad = fit(highwire(), { kind: 'puzzle', has: { goal: 1, acid: 5 }, minSpawns: 99 });
  assert.equal(bad.passed, 0);
  assert.equal(bad.misses.length, 4);
  assert.match(bad.misses.join('|'), /wanted puzzle/);
});

test('hazardOnEachPlatform notices a bare floating platform', () => {
  const map = highwire();
  const bare = { type: 'block', at: [0, 12, 0], size: [6, 1, 6] };
  const m = { ...map, pieces: [...map.pieces, bare] };
  const f = fit(m, { hazardOnEachPlatform: true });
  assert.equal(f.passed, 0);
  assert.match(f.misses[0], /floating platforms have no hazard/);
  const withSpikes = { ...m, pieces: [...m.pieces, { type: 'spikes', at: [0, 13, 0], size: [2, 0, 2] }] };
  // The map is symmetric, so the block and its mirror image stand on the same spot.
  assert.ok(measure(withSpikes).floatingBare < measure(m).floatingBare);
});

test('the runner drives the real pipeline with a scripted model and records every run', async () => {
  const wire = toWire(highwire());
  const seen: string[] = [];
  const prompts = GOLDEN.filter((g) => ['pvp-heights', 'flat-cover', 'moving-acid'].includes(g.id));
  const results = await runEval({
    prompts,
    runs: 2,
    concurrency: 2,
    config,
    makeLlm: () => new FakeLlm({ brief: [plan()], draft: [wire] }, { input: 2_000, output: 800, cacheRead: 5_000 }),
    onRun: (r) => seen.push(`${r.id}#${r.run}`),
  });
  assert.equal(results.length, 6);
  assert.equal(seen.length, 6);
  // Reported in prompt order, then by run, whatever order they finished in.
  assert.deepEqual(results.map((r) => `${r.id}#${r.run}`), ['pvp-heights#1', 'pvp-heights#2', 'flat-cover#1', 'flat-cover#2', 'moving-acid#1', 'moving-acid#2']);
  for (const r of results) {
    assert.equal(r.status, 'ok');
    assert.equal(r.attempts, 1);
    assert.deepEqual(r.calls.map((c) => c.label), ['brief', 'draft']);
    assert.equal(r.usage.input, 4_000);
    assert.equal(r.usage.cacheRead, 10_000);
    assert.ok(r.pieces > 0);
  }
  // A map that builds but has no moving platform for a moving-platform prompt shows up in the fit, not as a failed build.
  const trap = results.find((r) => r.id === 'moving-acid')!;
  assert.ok(trap.fitMisses.some((m) => /platform/.test(m)));
});

test('a model that fails is recorded as an error with its code, and the others still finish', async () => {
  let n = 0;
  const failing: Llm = {
    async generate() {
      throw new GenError('api', 'The model service answered 529: overloaded');
    },
  };
  const wire = toWire(highwire());
  const results = await runEval({
    prompts: GOLDEN.slice(0, 2),
    runs: 1,
    concurrency: 1,
    config,
    makeLlm: () => (n++ === 0 ? failing : new FakeLlm({ brief: [plan()], draft: [wire] })),
  });
  assert.equal(results[0].status, 'error');
  assert.equal(results[0].errorCode, 'api');
  assert.match(results[0].error!, /529/);
  assert.equal(results[1].status, 'ok');
  const s = summarize(results);
  assert.equal(s.errors.api, 1);
  assert.equal(s.passRate, 0.5);
});
