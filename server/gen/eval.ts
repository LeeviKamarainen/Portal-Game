/**
 * Measure the generator on the golden prompts, against the real API:
 *
 *   npm run gen:eval                          every golden prompt once
 *   npm run gen:eval -- --only pvp-heights,acid-gap --runs 3
 *   npm run gen:eval -- --no-critique         without the review step, to see what it earns
 *
 * Flags: --only <id,id>  --runs <n>  --concurrency <n> (default 3)  --out <dir>
 *        --no-critique   --thinking  --effort low|medium|high   --list
 * Needs ANTHROPIC_API_KEY (the npm script loads .env). Costs real money: about a cent for
 * three prompts at Haiku prices. Writes report.md, report.json and every map to the out dir
 * (default generated/eval/<time>), which is gitignored.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, type Effort } from './config';
import { renderMarkdown, summarize, type EvalRun } from './evalReport';
import { runEval } from './evalRun';
import { GOLDEN } from './golden';
import { AnthropicLlm, estimateCostUsd, totalTokens } from './llm';

const flags = new Map<string, string | true>();
const VALUE_FLAGS = ['only', 'runs', 'concurrency', 'out', 'effort'];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  flags.set(key, VALUE_FLAGS.includes(key) ? argv[++i] : true);
}

if (flags.has('list')) {
  for (const g of GOLDEN) console.log(`${g.id.padEnd(16)} ${g.kind.padEnd(7)} ${g.size.padEnd(6)} ${g.prompt}`);
  process.exit(0);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Put it in .env at the project root and run through "npm run gen:eval".');
  process.exit(2);
}

const only = typeof flags.get('only') === 'string' ? String(flags.get('only')).split(',').map((s) => s.trim()) : null;
const prompts = only ? GOLDEN.filter((g) => only.includes(g.id)) : GOLDEN;
const unknown = (only ?? []).filter((id) => !GOLDEN.some((g) => g.id === id));
if (unknown.length || !prompts.length) {
  console.error(`Unknown prompt id(s): ${unknown.join(', ') || '(none selected)'}. Use --list.`);
  process.exit(2);
}
const num = (v: string | true | undefined, fallback: number) => (typeof v === 'string' && Number(v) > 0 ? Math.floor(Number(v)) : fallback);
const runs = num(flags.get('runs'), 1);
const concurrency = num(flags.get('concurrency'), 3);

const config = loadConfig();
if (flags.has('no-critique')) config.critique = false;
if (flags.has('thinking')) config.draft.thinking = 'adaptive';
if (typeof flags.get('effort') === 'string') config.draft.effort = flags.get('effort') as Effort;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = typeof flags.get('out') === 'string' ? String(flags.get('out')) : join('generated', 'eval', stamp);
mkdirSync(join(outDir, 'maps'), { recursive: true });

console.log(`Evaluating ${prompts.length} prompt(s) x ${runs} run(s), concurrency ${concurrency}, models ${config.fast.model} / ${config.draft.model}, review ${config.critique ? 'on' : 'off'}`);
const t0 = Date.now();
const results = await runEval({
  prompts,
  runs,
  concurrency,
  config,
  makeLlm: () => new AnthropicLlm(),
  onMap: (r, map) => writeFileSync(join(outDir, 'maps', `${r.id}-${r.run}.json`), JSON.stringify(map, null, 2)),
  onRun: (r: EvalRun, done, total) => {
    const flag = r.status === 'ok' ? 'ok     ' : r.status === 'not-ok' ? 'NOT OK ' : 'ERROR  ';
    const fitText = r.fitChecked ? ` fit ${r.fitPassed}/${r.fitChecked}` : '';
    console.log(
      `[${String(done).padStart(2)}/${total}] ${flag} ${r.id.padEnd(16)} drafts ${r.attempts} | ${(totalTokens(r.usage) / 1000).toFixed(1).padStart(5)}K tokens | ${(r.ms / 1000).toFixed(0).padStart(3)} s | $${estimateCostUsd(r.usage).toFixed(4)}${fitText}${r.status === 'error' ? ` | ${r.errorCode}: ${r.error}` : ''}`,
    );
  },
});

const summary = summarize(results);
const models = config.fast.model === config.draft.model ? config.fast.model : `${config.fast.model} (plan, review) / ${config.draft.model} (draft)`;
const md = renderMarkdown(results, summary, { when: new Date().toISOString(), models, critique: config.critique, concurrency });
writeFileSync(join(outDir, 'report.md'), md);
writeFileSync(join(outDir, 'report.json'), JSON.stringify({ config, summary, runs: results }, null, 2));

console.log('');
console.log(
  `PASS ${summary.ok}/${summary.runs} (${Math.round(summary.passRate * 100)}%) | first draft ${Math.round(summary.firstDraftRate * 100)}% | fit ${Math.round(summary.fitRate * 100)}% | drafts median ${summary.attempts.median} max ${summary.attempts.max}`,
);
console.log(
  `TOKENS median ${(summary.tokens.median / 1000).toFixed(1)}K p90 ${(summary.tokens.p90 / 1000).toFixed(1)}K max ${(summary.tokens.max / 1000).toFixed(1)}K | cache hit ${Math.round(summary.cacheHitRate * 100)}% | cost total $${summary.costUsd.total.toFixed(4)} | ${((Date.now() - t0) / 1000).toFixed(0)} s wall`,
);
console.log(`Report: ${join(outDir, 'report.md')}`);
process.exit(summary.ok === summary.runs ? 0 : 1);
