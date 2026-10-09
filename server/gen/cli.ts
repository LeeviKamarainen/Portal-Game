/**
 * Generate a map from the command line, for trying prompts and tuning the generator:
 *
 *   npm run gen -- "pvp map with big height differences" --out map.json
 *   npm run gen -- "recreate a portal test chamber" --kind puzzle --size small
 *
 * Flags: --out <file>   --kind combat|puzzle   --size small|medium|large
 *        --no-critique  --thinking   (adaptive thinking for the draft)   --effort low|medium|high
 * Needs ANTHROPIC_API_KEY (the npm script loads .env). Spends real tokens: roughly a cent.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, type Effort } from './config';
import { generateMap, type GenEvent } from './graph';
import { AnthropicLlm, BudgetedLlm, GenError, estimateCostUsd } from './llm';
import type { GenRequest } from './prompts';

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const key = a.slice(2);
    const takesValue = ['out', 'kind', 'size', 'effort'].includes(key);
    flags.set(key, takesValue ? argv[++i] : true);
  }
  return { flags, prompt: words.join(' ').trim() };
}

const { flags, prompt } = parseArgs(process.argv.slice(2));
if (!prompt) {
  console.error('Usage: npm run gen -- "<describe the map>" [--out file.json] [--kind combat|puzzle] [--size small|medium|large] [--no-critique]');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Put it in .env at the project root and run through "npm run gen".');
  process.exit(2);
}

const config = loadConfig();
if (flags.has('no-critique')) config.critique = false;
if (flags.has('thinking')) config.draft.thinking = 'adaptive';
if (typeof flags.get('effort') === 'string') config.draft.effort = flags.get('effort') as Effort;

const request: GenRequest = {
  prompt,
  kind: (flags.get('kind') as GenRequest['kind']) ?? 'auto',
  size: (flags.get('size') as GenRequest['size']) ?? 'auto',
};

const llm = new BudgetedLlm(new AnthropicLlm(), config);
const t0 = Date.now();
const emit = (e: GenEvent) => {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${e.node.padEnd(8)} ${e.message}`);
  for (const p of e.problems ?? []) console.log(`           - ${p}`);
};

try {
  const outcome = await generateMap(request, { llm, config, emit });
  console.log('');
  console.log(outcome.ok ? 'RESULT: ok' : `RESULT: not ok (${outcome.stoppedBy})`, `| drafts ${outcome.attempts} | fixes ${outcome.fixes.length}`);
  if (outcome.map) {
    const kinds = new Map<string, number>();
    for (const p of outcome.map.pieces) kinds.set(p.type, (kinds.get(p.type) ?? 0) + 1);
    console.log(`MAP: "${outcome.map.name}" ${outcome.map.kind} | ${outcome.map.pieces.length} pieces | ${[...kinds].map(([t, n]) => `${n} ${t}`).join(', ')}`);
  }
  for (const n of outcome.notes) console.log(`NOTE: ${n}`);
  if (!outcome.ok) for (const p of outcome.problems) console.log(`PROBLEM: ${p}`);
  console.log('');
  for (const c of llm.calls)
    console.log(`call ${c.label.padEnd(9)} ${String(c.ms).padStart(6)} ms | in ${c.usage.input} out ${c.usage.output} cacheR ${c.usage.cacheRead} cacheW ${c.usage.cacheWrite}`);
  console.log(`TOTAL ${llm.usedTokens} tokens of ${config.maxJobTokens} | ~$${estimateCostUsd(llm.used).toFixed(4)} at list price | ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const out = flags.get('out');
  if (typeof out === 'string' && outcome.map) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(outcome.map, null, 2));
    console.log(`Saved ${out}`);
  }
  process.exit(outcome.ok ? 0 : 1);
} catch (e) {
  if (e instanceof GenError) console.error(`Generation failed (${e.code}): ${e.message}`);
  else console.error(e);
  process.exit(1);
}
