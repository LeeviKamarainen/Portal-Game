/**
 * Chat with the map generator from the command line, for trying prompts and tuning it:
 *
 *   npm run gen -- "a difficult multi-part puzzle that needs at least two portal hops" --out map.json
 *   npm run gen -- "make the first ledge higher" --base map.json --out map2.json
 *   npm run gen -- "pvp arena with a central pit" --then "add a bridge over the pit" --then "put acid under it"
 *
 * Flags: --out <file>      write the final map
 *        --base <file>     start from this map instead of a blank one
 *        --then "<text>"   a follow-up message in the same conversation (repeatable)
 *        --kind combat|puzzle   --size small|medium|large   (hints for the first message)
 *        --sonnet          use Sonnet 5.5 instead of the configured model   --model <id>
 *        --effort low|medium|high   --no-thinking
 *        --legacy          the older plan-and-draft pipeline (one message, no chat)
 * Needs ANTHROPIC_API_KEY (the npm script loads .env). Spends real tokens: cents.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { blankMap } from '../../src/editor/templates';
import type { MapData } from '../../src/world/maps/MapFormat';
import { runAgent, type AgentEvent, type ChatTurn } from './agent';
import { CheckWorker } from './checkPool';
import { SONNET, SONNET_PRICES, PRICES, loadConfig, type Effort } from './config';
import { generateMap, type GenEvent } from './graph';
import { AnthropicLlm, BudgetedLlm, GenError, estimateCostUsd } from './llm';
import type { GenRequest } from './prompts';

function parseArgs(argv: string[]) {
  const flags = new Map<string, string | true>();
  const then: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      words.push(a);
      continue;
    }
    const key = a.slice(2);
    const takesValue = ['out', 'kind', 'size', 'effort', 'base', 'then', 'model'].includes(key);
    const value = takesValue ? argv[++i] : true;
    if (key === 'then') then.push(String(value));
    else flags.set(key, value);
  }
  return { flags, then, prompt: words.join(' ').trim() };
}

const { flags, then, prompt } = parseArgs(process.argv.slice(2));
if (!prompt) {
  console.error('Usage: npm run gen -- "<describe the map or the change>" [--base file.json] [--then "<follow-up>"] [--out file.json] [--kind combat|puzzle] [--size small|medium|large] [--sonnet]');
  process.exit(2);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Put it in .env at the project root and run through "npm run gen".');
  process.exit(2);
}

const config = loadConfig();
if (flags.has('sonnet')) config.agent.model = SONNET;
if (typeof flags.get('model') === 'string') config.agent.model = String(flags.get('model'));
if (typeof flags.get('effort') === 'string') config.agent.effort = flags.get('effort') as Effort;
if (flags.has('no-thinking')) config.agent.thinking = 'off';
const kind = (flags.get('kind') as GenRequest['kind']) ?? 'auto';
const size = (flags.get('size') as GenRequest['size']) ?? 'auto';
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`;

function summary(map: MapData): string {
  const kinds = new Map<string, number>();
  for (const p of map.pieces) kinds.set(p.type, (kinds.get(p.type) ?? 0) + 1);
  return `"${map.name}" ${map.kind} | ${map.pieces.length} pieces | ${[...kinds].map(([t, n]) => `${n} ${t}`).join(', ')}`;
}

function save(map: MapData | null): void {
  const out = flags.get('out');
  if (typeof out === 'string' && map) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(map, null, 2));
    console.log(`Saved ${out}`);
  }
}

async function legacy(): Promise<void> {
  const llm = new BudgetedLlm(new AnthropicLlm(), config);
  const emit = (e: GenEvent) => {
    console.log(`${stamp()} ${e.node.padEnd(8)} ${e.message}`);
    for (const d of e.detail ?? []) console.log(`           . ${d}`);
    for (const p of e.problems ?? []) console.log(`           - ${p}`);
  };
  const outcome = await generateMap({ prompt, kind, size }, { llm, config, emit });
  console.log('');
  console.log(outcome.ok ? 'RESULT: ok' : `RESULT: not ok (${outcome.stoppedBy})`, `| drafts ${outcome.attempts} | fixes ${outcome.fixes.length}`);
  if (outcome.map) console.log(`MAP: ${summary(outcome.map)}`);
  for (const n of outcome.notes) console.log(`NOTE: ${n}`);
  if (!outcome.ok) for (const p of outcome.problems) console.log(`PROBLEM: ${p}`);
  console.log(`TOTAL ${llm.usedTokens} tokens | ~$${estimateCostUsd(llm.used).toFixed(4)} at list price | ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  save(outcome.map);
  process.exit(outcome.ok ? 0 : 1);
}

async function chat(): Promise<void> {
  const worker = new CheckWorker((l) => console.error(l));
  const llm = new BudgetedLlm(new AnthropicLlm(), config);
  const prices = config.agent.model.includes('sonnet') ? SONNET_PRICES : PRICES;
  const settings = config.agent;
  if (flags.has('sonnet')) settings.maxUsd = Math.max(settings.maxUsd, 0.75);
  let map: MapData = typeof flags.get('base') === 'string' ? (JSON.parse(readFileSync(String(flags.get('base')), 'utf8')) as MapData) : blankMap();
  const history: ChatTurn[] = [];
  const messages = [prompt, ...then];
  let allOk = true;
  for (const [i, message] of messages.entries()) {
    console.log(`\n${stamp()} YOU: ${message}`);
    const emit = (e: AgentEvent) => {
      if (e.type === 'say') console.log(`${stamp()} AI: ${e.text.replace(/\n/g, '\n           ')}`);
      else if (e.type === 'tool') {
        console.log(`${stamp()}   ${e.ok ? '·' : '!'} ${e.tool}: ${e.summary}`);
        for (const p of e.problems ?? []) console.log(`           - ${p}`);
        for (const d of e.detail ?? []) console.log(`           | ${d}`);
      }
    };
    const outcome = await runAgent(
      { prompt: message, kind: i === 0 ? kind : 'auto', size: i === 0 ? size : 'auto', baseMap: map, history },
      { llm, settings, prices, env: { check: (m) => worker.check(m, { keepHidden: true }), routes: worker.routes, playtest: worker.playtest }, emit },
    );
    history.push({ role: 'user', text: message }, { role: 'assistant', text: outcome.reply });
    if (outcome.map) map = outcome.map;
    allOk &&= outcome.ok;
    console.log(`${stamp()} ${outcome.ok ? 'ok' : 'NOT OK'} | turns ${outcome.turns} | ${outcome.map ? summary(outcome.map) : 'map unchanged'} | ~$${outcome.costUsd.toFixed(4)}`);
    for (const p of outcome.problems) console.log(`PROBLEM: ${p}`);
    for (const n of outcome.notes) console.log(`NOTE: ${n}`);
  }
  console.log('');
  for (const c of llm.calls) console.log(`call ${c.label.padEnd(5)} ${String(c.ms).padStart(6)} ms | in ${c.usage.input} out ${c.usage.output} cacheR ${c.usage.cacheRead} cacheW ${c.usage.cacheWrite}`);
  console.log(`TOTAL ${llm.calls.length} calls | ~$${estimateCostUsd(llm.used, prices).toFixed(4)} at ${config.agent.model} list price | ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  save(map);
  await worker.dispose();
  process.exit(allOk ? 0 : 1);
}

try {
  await (flags.has('legacy') ? legacy() : chat());
} catch (e) {
  if (e instanceof GenError) console.error(`Generation failed (${e.code}): ${e.message}`);
  else console.error(e);
  process.exit(1);
}
