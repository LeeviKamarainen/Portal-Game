/**
 * The chat loop (server/gen/agent.ts) with a scripted model: what it sends, how it runs the
 * model's tool calls, and what it will not let the model finish with. No model calls.
 *
 *   npx tsx --test server/test/agent.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankMap, blankPuzzle } from '../../src/editor/templates';
import type { MapData } from '../../src/world/maps/MapFormat';
import { runAgent, turnUser, type AgentEvent, type AgentRequest } from '../gen/agent';
import { checkGenerated } from '../gen/check';
import { loadConfig, PRICES } from '../gen/config';
import { GenError } from '../gen/llm';
import { playtest } from '../gen/playtest';
import { analyzeRoutes } from '../gen/routes';
import { ChatFakeLlm, call, say } from './fakeLlm';

const settings = () => ({ ...loadConfig({}).agent });
const env = { check: checkGenerated, routes: analyzeRoutes, playtest };
const request = (prompt: string, over: Partial<AgentRequest> = {}): AgentRequest => ({ prompt, kind: 'auto', size: 'auto', baseMap: blankPuzzle(), history: [], ...over });

async function run(llm: ChatFakeLlm, req: AgentRequest, over: Partial<ReturnType<typeof settings>> = {}, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  const outcome = await runAgent(req, { llm, settings: { ...settings(), ...over }, prices: PRICES, env, emit: (e) => events.push(e), signal });
  return { outcome, events };
}

/** The user message of the first request, as the model saw it. */
const firstUser = (llm: ChatFakeLlm): string => {
  const msgs = llm.requests[0].messages;
  const last = msgs[msgs.length - 1];
  return typeof last.content === 'string' ? last.content : '';
};

/** The text of the "Before you finish" message the loop sent back, if it did. */
const gateMessage = (llm: ChatFakeLlm): string | undefined =>
  llm.requests
    .flatMap((r) => r.messages)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .find((c) => c.startsWith('Before you finish'));

test('the model is told the map in the editor, the hints and the request, with the tools and a cached system prompt', async () => {
  const llm = new ChatFakeLlm([[say('Hello.')]]);
  await run(llm, request('make it harder', { kind: 'puzzle', size: 'small' }));
  const req = llm.requests[0];
  assert.equal(req.tools.length, 6);
  assert.match(req.system, /You are the level designer built into this game's map editor/);
  assert.match(req.system, /Catapult: a puzzle with jump pads/);
  const user = firstUser(llm);
  assert.match(user, /^The map in the editor right now:/);
  assert.match(user, /Map "New puzzle"/);
  assert.match(user, /untouched starting template/);
  assert.match(user, /kind: puzzle/);
  assert.match(user, /small room: about 16 x 6 x 20 m/);
  assert.match(user, /User: make it harder$/);
});

test('a question is answered without touching the map: no map comes back', async () => {
  const llm = new ChatFakeLlm([[say('The divider is 3.2 m high, so you need a portal.')]]);
  const { outcome, events } = await run(llm, request('why can I not reach the exit?'));
  assert.equal(outcome.map, null);
  assert.equal(outcome.ok, true);
  assert.match(outcome.reply, /divider/);
  assert.deepEqual(events.map((e) => e.type), ['turn', 'say']);
});

test('a conversation: earlier turns go in as messages, in alternating order, and the new one carries the map', async () => {
  const llm = new ChatFakeLlm([[say('ok')]]);
  await run(
    llm,
    request('and a second pit', {
      history: [
        { role: 'user', text: 'a puzzle with a pit' },
        { role: 'assistant', text: 'Built it.' },
      ],
    }),
  );
  assert.deepEqual(llm.requests[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(firstUser(llm), /User: and a second pit/);
  // Two user messages in a row (a history that ends oddly) are merged, not sent as an invalid conversation.
  const odd = new ChatFakeLlm([[say('ok')]]);
  await run(odd, request('next', { history: [{ role: 'user', text: 'one' }] }));
  assert.deepEqual(odd.requests[0].messages.map((m) => m.role), ['user']);
  assert.match(odd.requests[0].messages[0].content as string, /one\n\nThe map in the editor/);
});

test('edit, validate, check the route, answer: the map comes back tidied, with the events the page draws', async () => {
  const llm = new ChatFakeLlm([
    [say('Adding a ledge.'), call('edit_map', { ops: [{ op: 'add', piece: { type: 'block', at: [6, 0, 6], size: [3, 1, 3], portal: ['top'] } }] })],
    [call('validate_map')],
    [call('check_routes')],
    [say('Added a ledge by the spawn; the exit still needs one portal hop.')],
  ]);
  const { outcome, events } = await run(llm, request('add a small ledge'));
  assert.equal(outcome.ok, true, outcome.problems.join(' | '));
  assert.equal(outcome.turns, 4);
  assert.equal(outcome.stoppedBy, 'ok');
  assert.ok(outcome.map);
  assert.equal(outcome.map!.pieces.length, blankPuzzle().pieces.length + 1);
  assert.match(outcome.reply, /one portal hop/);
  const types = events.map((e) => e.type + (e.type === 'tool' ? `:${e.tool}` : ''));
  // (The validation tidied the template a little - an empty blurb - so it sends the map again.)
  assert.deepEqual(types, ['turn', 'say', 'tool:edit_map', 'map', 'turn', 'tool:validate_map', 'map', 'turn', 'tool:check_routes', 'turn', 'say']);
  const map = events.find((e) => e.type === 'map') as Extract<AgentEvent, { type: 'map' }>;
  assert.equal(map.map.pieces.length, 6);
  // The tool results went back to the model as results of its calls.
  const second = llm.requests[1].messages;
  const results = second[second.length - 1].content as { type: string; tool_use_id: string; content: string }[];
  assert.equal(results[0].type, 'tool_result');
  assert.match(results[0].content, /Applied: added 1 piece/);
});

test('it will not finish with a map that does not pass: the problems go back, and the fix is what comes out', async () => {
  const llm = new ChatFakeLlm([
    [call('edit_map', { ops: [{ op: 'add', piece: { type: 'door', at: [0, 0, 6], receiver: 'ghost' } }] })],
    [say('Done.')],
    [call('edit_map', { ops: [{ op: 'remove', index: 5 }] })],
    [say('Removed the door; it had nothing to open it.')],
  ]);
  const { outcome } = await run(llm, request('add a door'));
  const told = gateMessage(llm);
  assert.ok(told, 'the model was sent back with the problems');
  assert.match(told!, /no receiver piece has the id "ghost"/);
  assert.equal(outcome.ok, true, outcome.problems.join(' | '));
  assert.equal(outcome.map!.pieces.some((p) => p.type === 'door'), false);
});

test('a puzzle whose exit cannot be reached is sent back, and the route report is what it is told', async () => {
  const unreachable = blankPuzzle();
  unreachable.pieces[0] = { type: 'room', at: [0, 0, 0], size: [20, 8, 28], portal: [] };
  unreachable.pieces[2] = { type: 'block', at: [0, 0, 0], size: [20, 3.2, 1] };
  const llm = new ChatFakeLlm([
    [call('edit_map', { ops: [{ op: 'meta', meta: { hint: 'Find a way over.' } }] })],
    [say('Done.')],
    // After being told, it gives the divider a portal face and the room a portal floor.
    [call('edit_map', { ops: [{ op: 'update', index: 2, set: { portal: ['front', 'back'] } }, { op: 'update', index: 0, set: { portal: ['walls', 'floor'] } }] })],
    [say('Gave the room portal walls and the divider portal faces.')],
  ]);
  const { outcome } = await run(llm, request('add a hint', { baseMap: unreachable }));
  const told = gateMessage(llm);
  assert.ok(told, 'sent back');
  assert.match(told!, /CANNOT be reached/);
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.notes, [], 'solved by the end: no warning left');
});

test('a puzzle left unreachable after the rounds it was given ends with a warning, not a silent pass', async () => {
  const unreachable = blankPuzzle();
  unreachable.pieces[0] = { type: 'room', at: [0, 0, 0], size: [20, 8, 28], portal: [] };
  unreachable.pieces[2] = { type: 'block', at: [0, 0, 0], size: [20, 3.2, 1] };
  const llm = new ChatFakeLlm([[call('edit_map', { ops: [{ op: 'meta', meta: { hint: 'x' } }] })], [say('I cannot show the route.')]]);
  const { outcome } = await run(llm, request('tweak the hint', { baseMap: unreachable }));
  assert.equal(outcome.ok, true, 'it builds');
  assert.ok(outcome.notes.some((n) => /may not be solvable/.test(n)), outcome.notes.join(' | '));
});

test('stops: the step limit, the dollar limit and a cancel', async () => {
  const loops = () => new ChatFakeLlm([[call('view_map')]]);
  const turns = await run(loops(), request('look'), { maxTurns: 3 });
  assert.equal(turns.outcome.turns, 3);
  assert.equal(turns.outcome.stoppedBy, 'turns');
  assert.ok(turns.outcome.notes.some((n) => /step limit/.test(n)));

  const llm = new ChatFakeLlm([[call('view_map')]], { input: 40_000, output: 4_000 });
  const spent = await run(llm, request('look'), { maxUsd: 0.003 });
  assert.equal(spent.outcome.stoppedBy, 'budget');
  assert.ok(spent.outcome.turns < 24);

  const ctl = new AbortController();
  const slow = new ChatFakeLlm([[call('view_map')]]);
  slow.before = async () => ctl.abort();
  await assert.rejects(run(slow, request('look'), {}, ctl.signal), (e: unknown) => e instanceof GenError && e.code === 'aborted');
});

test('a refusal is an error the page can show', async () => {
  const llm = new ChatFakeLlm([[say('no')]]);
  const real = llm.turn.bind(llm);
  llm.turn = async (req) => ({ ...(await real(req)), stop: 'refusal' });
  await assert.rejects(run(llm, request('x')), (e: unknown) => e instanceof GenError && e.code === 'refusal');
});

test('turnUser says when the map is a template and leaves a real map alone', () => {
  const real: MapData = { ...blankMap(), pieces: [...blankMap().pieces, { type: 'block', at: [1, 0, 1], size: [2, 2, 2] }] };
  assert.doesNotMatch(turnUser(request('x', { baseMap: real })), /untouched starting template/);
  assert.match(turnUser(request('x', { baseMap: blankMap() })), /untouched starting template/);
});
