/**
 * The generation graph (docs/llm-map-generation-plan.md, milestone 2) against a scripted model:
 * the happy path, the repair loop, the budgets, the review and cancellation. No API calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_MAPS } from '../../src/editor/templates';
import { loadConfig } from '../gen/config';
import { generateMap, type BuildEvent, type GenEvent } from '../gen/graph';
import { AnthropicLlm, BudgetedLlm, GenError, type AnthropicLike } from '../gen/llm';
import type { Brief } from '../gen/prompts';
import { PartialMapReader } from '../gen/partial';
import { WireMapSchema, pieceFromWire, toWire, type WireMap } from '../gen/wire';
import { FakeLlm } from './fakeLlm';

const highwire = () => BUILT_IN_MAPS[0].data();
const good = (): WireMap => toWire(highwire());
/** Highwire with a second piece called "trap": the lint reports the duplicate id (nothing autofix can settle). */
const broken = (): WireMap => {
  const w = good();
  w.pieces.push({ type: 'spikes', at: [-8, 0, 0], size: [2, 0, 2], rot: 0, center: false, params: [{ key: 'id', value: 'trap' }] });
  return w;
};
const brief = (over: Partial<Brief> = {}): Brief => ({
  kind: 'combat',
  size: 'medium',
  symmetric: true,
  concept: 'Three tiers around a central pit',
  tiers: [
    { name: 'floor', floorY: 0, purpose: 'start' },
    { name: 'ledge', floorY: 8, purpose: 'ranged fights' },
  ],
  hazards: ['spikes on the ledge'],
  portalPlan: 'portal walls on every tier',
  notes: ['The map is a loose take on the idea.'],
  requirements: ['floating platforms carry hazards'],
  ...over,
});
const request = { prompt: 'a pvp map with tiers', kind: 'auto' as const, size: 'auto' as const };
const config = (over: Record<string, string> = {}) => loadConfig({ GEN_CRITIQUE: 'off', ...over });

async function run(script: ConstructorParameters<typeof FakeLlm>[0], cfg = config(), signal?: AbortSignal) {
  const llm = new FakeLlm(script);
  const events: GenEvent[] = [];
  const outcome = await generateMap(request, { llm: new BudgetedLlm(llm, cfg), config: cfg, emit: (e) => events.push(e), signal });
  return { llm, events, outcome };
}

test('a good first draft goes brief, draft, check, finalize', async () => {
  const { llm, events, outcome } = await run({ brief: [brief()], draft: [good()] });
  assert.deepEqual(llm.labels, ['brief', 'draft']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 1);
  assert.equal(outcome.stoppedBy, 'ok');
  assert.deepEqual(outcome.notes, ['The map is a loose take on the idea.']);
  assert.equal(outcome.map!.pieces.length, highwire().pieces.length);
  assert.deepEqual([...new Set(events.map((e) => e.node))], ['brief', 'draft', 'check', 'finalize']);
});

test('the planner cannot override an explicit kind', async () => {
  const w = good();
  const llm = new FakeLlm({ brief: [brief({ kind: 'puzzle' })], draft: [w] });
  const cfg = config();
  await generateMap({ ...request, kind: 'combat' }, { llm: new BudgetedLlm(llm, cfg), config: cfg });
  assert.match(String((llm.requests[1] as { user: string }).user), /Kind: combat/);
});

test('a broken draft is repaired with the problems in the prompt', async () => {
  const { llm, events, outcome } = await run({ brief: [brief()], draft: [broken()], repair: [good()] });
  assert.deepEqual(llm.labels, ['brief', 'draft', 'repair']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 2);
  const prompt = (llm.requests[2] as { user: string }).user;
  assert.match(prompt, /\n1\. piece #\d+ \(spikes\): the id "trap" is used twice/);
  assert.match(prompt, /after automatic tidying/);
  assert.ok(events.some((e) => e.node === 'repair'));
  assert.ok(events.some((e) => e.node === 'check' && e.problems?.length));
});

test('the repair prompt carries the previous map, so the model edits rather than starts again', async () => {
  const { llm } = await run({ brief: [brief()], draft: [broken()], repair: [good()] });
  const prompt = (llm.requests[2] as { user: string }).user;
  assert.ok(prompt.includes('"type":"spikes"') && prompt.includes('"at":[-8,0,0]'));
});

test('three bad drafts stop with the closest map and its problems', async () => {
  const { llm, outcome } = await run({ brief: [brief()], draft: [broken()], repair: [broken()] });
  assert.deepEqual(llm.labels, ['brief', 'draft', 'repair', 'repair']);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'attempts');
  assert.equal(outcome.attempts, 3);
  assert.ok(outcome.map);
  assert.match(outcome.problems.join('\n'), /the id "trap" is used twice/);
});

test('a parameter the catalogue does not know is a problem, even if the rest builds', async () => {
  const w = good();
  w.pieces.find((p) => p.type === 'spikes')!.params.push({ key: 'sparkle', value: '1' });
  const { llm, outcome } = await run({ brief: [brief()], draft: [w], repair: [good()] });
  assert.deepEqual(llm.labels, ['brief', 'draft', 'repair']);
  assert.match((llm.requests[2] as { user: string }).user, /unknown parameter "sparkle"/);
  assert.equal(outcome.ok, true);
});

test('running out of the 100K token budget stops with what there is', async () => {
  const cfg = config();
  const llm = new FakeLlm({ brief: [brief()], draft: [broken()], repair: [good()] }, { input: 45_000, output: 5_000 });
  const outcome = await generateMap(request, { llm: new BudgetedLlm(llm, cfg), config: cfg });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stoppedBy, 'budget');
  assert.deepEqual(llm.labels, ['brief', 'draft']);
  assert.ok(outcome.map, 'the broken draft is still returned as the closest map');
});

test('a prompt over the per-call limit is never sent', async () => {
  const cfg = config({ GEN_MAX_CALL_INPUT_TOKENS: '1000' });
  const llm = new FakeLlm({ brief: [brief()], draft: [good()] });
  await assert.rejects(generateMap(request, { llm: new BudgetedLlm(llm, cfg), config: cfg }), (e: unknown) => e instanceof GenError && e.code === 'budget');
  assert.equal(llm.requests.length, 0);
});

test('BudgetedLlm lowers max_tokens to what is left of the job budget, then refuses', async () => {
  const cfg = config();
  const fake = new FakeLlm({ draft: [good()] }, { input: 30_000, output: 8_000 });
  const budgeted = new BudgetedLlm(fake, cfg);
  const req = { label: 'draft', model: 'm', system: 'x', user: 'y', schema: WireMapSchema, thinking: 'off' as const, effort: 'low' as const, maxTokens: 24_000 };
  await budgeted.generate(req);
  await budgeted.generate(req);
  await budgeted.generate(req);
  assert.deepEqual(
    fake.requests.map((r) => r.maxTokens),
    [24_000, 24_000, 100_000 - 76_000 - 1],
    'the third call gets what is left of the 100K, minus a one-token prompt estimate',
  );
  assert.equal(budgeted.usedTokens, 114_000);
  await assert.rejects(budgeted.generate(req), (e: unknown) => e instanceof GenError && e.code === 'budget');
});

test('the review passes a map that fits', async () => {
  const { llm, outcome } = await run({ brief: [brief()], draft: [good()], critique: [{ satisfies: true, issues: [] }] }, config({ GEN_CRITIQUE: 'on' }));
  assert.deepEqual(llm.labels, ['brief', 'draft', 'critique']);
  assert.equal(outcome.ok, true);
  const asked = (llm.requests[2] as { user: string }).user;
  assert.match(asked, /Requirements to check:\n1\. floating platforms carry hazards/);
  assert.match(asked, /Map summary:\nName: Highwire/);
});

test('with no checkable requirements the review is skipped, not guessed', async () => {
  const { llm, events, outcome } = await run({ brief: [brief({ requirements: [] })], draft: [good()] }, config({ GEN_CRITIQUE: 'on' }));
  assert.deepEqual(llm.labels, ['brief', 'draft']);
  assert.equal(outcome.ok, true);
  assert.ok(events.some((e) => e.node === 'critique' && /skipping the review/.test(e.message)));
});

test('a review that finds something missing sends it back for one repair, and no second review', async () => {
  const better = good();
  better.name = 'Highwire two';
  const { llm, outcome } = await run(
    { brief: [brief()], draft: [good()], critique: [{ satisfies: false, issues: ['Add spikes on the top ledge'] }], repair: [better] },
    config({ GEN_CRITIQUE: 'on' }),
  );
  assert.deepEqual(llm.labels, ['brief', 'draft', 'critique', 'repair']);
  assert.match((llm.requests[3] as { user: string }).user, /1\. Review: Add spikes on the top ledge/);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.map!.name, 'Highwire two');
});

test('if the repair after a review breaks the map, the earlier good map is kept', async () => {
  const { outcome } = await run(
    { brief: [brief()], draft: [good()], critique: [{ satisfies: false, issues: ['Add more'] }], repair: [broken()] },
    config({ GEN_CRITIQUE: 'on' }),
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.map!.name, 'Highwire');
});

test('a cancelled generation rejects with code aborted and asks the model for nothing', async () => {
  const ac = new AbortController();
  ac.abort();
  const llm = new FakeLlm({ brief: [brief()], draft: [good()] });
  const cfg = config();
  await assert.rejects(generateMap(request, { llm: new BudgetedLlm(llm, cfg), config: cfg, signal: ac.signal }), (e: unknown) => e instanceof GenError && e.code === 'aborted');
  assert.equal(llm.requests.length, 0);
});

// --- the Anthropic adapter, against a stand-in client -------------------------------------------

function fakeClient(message: Record<string, unknown>, seen: unknown[] = []): AnthropicLike {
  return {
    messages: {
      stream: ((params: unknown, options: unknown) => {
        seen.push({ params, options });
        return { finalMessage: async () => message };
      }) as unknown as AnthropicLike['messages']['stream'],
    },
  };
}
const reply = (over: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: JSON.stringify(good()) }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 35, output_tokens: 900, cache_read_input_tokens: 7900, cache_creation_input_tokens: 0 },
  ...over,
});
const draftReq = { label: 'draft', model: 'claude-haiku-5-5', system: 'S', user: 'U', schema: WireMapSchema, thinking: 'off' as const, effort: 'low' as const, maxTokens: 5000 };

test('AnthropicLlm sends thinking off, effort, a JSON schema and a cached system prompt', async () => {
  const seen: { params: Record<string, any>; options: { signal?: AbortSignal } }[] = [];
  const ac = new AbortController();
  const r = await new AnthropicLlm(fakeClient(reply(), seen)).generate({ ...draftReq, signal: ac.signal });
  const p = seen[0].params;
  assert.equal(p.model, 'claude-haiku-5-5');
  assert.deepEqual(p.thinking, { type: 'disabled' });
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(p.max_tokens, 5000);
  assert.equal(seen[0].options.signal, ac.signal);
  assert.deepEqual(r.usage, { input: 35, output: 900, cacheRead: 7900, cacheWrite: 0 });
  assert.equal(r.value.pieces.length, good().pieces.length);
});

test('AnthropicLlm leaves thinking at the default when asked for adaptive', async () => {
  const seen: { params: Record<string, unknown> }[] = [];
  await new AnthropicLlm(fakeClient(reply(), seen)).generate({ ...draftReq, thinking: 'adaptive' });
  assert.equal('thinking' in seen[0].params, false);
});

for (const [stop, code] of [
  ['refusal', 'refusal'],
  ['max_tokens', 'truncated'],
] as const) {
  test(`AnthropicLlm turns stop_reason ${stop} into a ${code} error`, async () => {
    await assert.rejects(new AnthropicLlm(fakeClient(reply({ stop_reason: stop }))).generate(draftReq), (e: unknown) => e instanceof GenError && e.code === code);
  });
}

test('AnthropicLlm rejects an answer that does not match the structure', async () => {
  const bad = reply({ content: [{ type: 'text', text: '{"name":"x"}' }] });
  await assert.rejects(new AnthropicLlm(fakeClient(bad)).generate(draftReq), (e: unknown) => e instanceof GenError && e.code === 'bad-output');
});

// --- live building: the map as it is being written -------------------------------------------

test('PartialMapReader yields the header once and each piece as it completes, however the text is cut', () => {
  const w = good();
  w.hint = 'Mind the {braces}, "quotes", a \ backslash and a ] bracket.';
  w.pieces.find((p) => p.type === 'spikes')!.params.push({ key: 'id', value: 'a}b"c' });
  const text = JSON.stringify(w);
  for (const step of [1, 7, 64, text.length]) {
    const reader = new PartialMapReader();
    const events = [];
    for (let n = step; n < text.length + step; n += step) events.push(...reader.feed(text.slice(0, n)));
    const starts = events.filter((e) => e.type === 'start');
    const pieces = events.filter((e): e is Extract<typeof e, { type: 'piece' }> => e.type === 'piece');
    assert.equal(starts.length, 1, `chunk ${step}: one start`);
    assert.equal((starts[0] as { head: { name: string } }).head.name, 'Highwire');
    assert.deepEqual(
      pieces.map((e) => e.index),
      w.pieces.map((_, i) => i),
      `chunk ${step}: every piece, in order`,
    );
    assert.deepEqual(
      pieces.map((e) => e.piece),
      w.pieces.map((p, i) => pieceFromWire(p, i).piece),
      `chunk ${step}: same pieces as the final conversion`,
    );
  }
});

test('PartialMapReader says nothing about text it cannot read', () => {
  assert.deepEqual(new PartialMapReader().feed('{"name":"x","hint'), []);
  assert.deepEqual(new PartialMapReader().feed('not json at all "pieces":[{'), []);
  assert.deepEqual(new PartialMapReader().feed('{"name":1,"pieces":[{"type":"block"}]}'), [], 'a header that does not match the schema');
});

test('build events: pieces stream in, then the checked map; a repair starts a new streamed attempt', async () => {
  const cfg = config();
  const llm = new FakeLlm({ brief: [brief()], draft: [broken()], repair: [good()] });
  const seen: BuildEvent[] = [];
  const outcome = await generateMap(request, { llm: new BudgetedLlm(llm, cfg), config: cfg, onPartial: (e) => seen.push(e) });
  assert.equal(outcome.ok, true);
  const shape = seen.map((e) => (e.type === 'start' ? `start:${e.stage}` : e.type === 'map' ? `map:${e.ok}` : 'piece'));
  const compact = shape.filter((s, i) => s !== 'piece' || shape[i - 1] !== 'piece');
  assert.deepEqual(compact, ['start:draft', 'piece', 'map:false', 'start:repair', 'piece', 'map:true']);
  assert.equal(seen.filter((e) => e.type === 'piece').length, broken().pieces.length + good().pieces.length);
  const finalMap = [...seen].reverse().find((e) => e.type === 'map')!;
  assert.equal(finalMap.type === 'map' && finalMap.map.pieces.length, highwire().pieces.length);
});

test('nothing is streamed (no onText) when nobody is watching', async () => {
  const { llm } = await run({ brief: [brief()], draft: [good()] });
  assert.ok(llm.requests.every((r) => r.onText === undefined));
});
