/**
 * The map generator over HTTP (docs/llm-map-generation-plan.md, milestone 3): who may start a
 * generation, the live event stream, and the limits. A scripted model stands in for Claude, so
 * nothing here calls the API.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type RunningServer, type ServerOptions } from '../main';
import { BUILT_IN_MAPS } from '../../src/editor/templates';
import { checkGenerated } from '../gen/check';
import { loadConfig, type GenConfig } from '../gen/config';
import { GenError, type Llm } from '../gen/llm';
import type { Blueprint } from '../gen/blueprint';
import { combatExample } from '../gen/blueprintExamples';
import { toWire } from '../gen/wire';
import { SqliteStore } from '../store/SqliteStore';
import { FakeLlm } from './fakeLlm';

const highwire = () => BUILT_IN_MAPS[0].data();
const brief: Blueprint = { ...combatExample(), notes: ['Approximate.'] };

function config(limits: Partial<GenConfig['limits']> = {}): GenConfig {
  const c = loadConfig({ GEN_CRITIQUE: 'off' });
  c.limits = { ...c.limits, ...limits };
  return c;
}

/** A model that answers with Highwire. `before` can hold a call open. */
const goodModel = (before?: FakeLlm['before'], usage = {}) => () => {
  const llm = new FakeLlm({ brief: [brief], draft: [toWire(highwire())] }, usage);
  llm.before = before;
  return llm as Llm;
};

async function withServer(options: Partial<ServerOptions>, body: (s: RunningServer) => Promise<void>): Promise<void> {
  const server = await startServer({ port: 0, staticDir: 'no-such-dir', log: () => {}, ...options });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

const withGenerator = (llm: (() => Llm) | null, cfg = config(), body: (s: RunningServer) => Promise<void>, check = true) =>
  withServer({ generator: { llm, config: cfg, ...(check ? { check: checkGenerated } : {}) } }, body);

interface Reply {
  status: number;
  body: any;
}

async function call(s: RunningServer, method: string, path: string, cookie: string | null, body?: unknown): Promise<Reply> {
  const res = await fetch(`http://localhost:${s.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function signUp(s: RunningServer, name: string, rights = true): Promise<string> {
  const res = await fetch(`http://localhost:${s.port}/api/register`, { method: 'POST', body: JSON.stringify({ name, password: 'correct horse' }) });
  assert.equal(res.status, 200);
  if (rights) s.store.setRights(s.store.findUserForLogin(name)!.id, ['generate-maps']);
  return res.headers.getSetCookie()[0].split(';')[0];
}

interface Sse {
  id: number;
  event: string;
  data: any;
}

/** Reads the whole event stream of a finished (or soon finished) job. */
async function events(s: RunningServer, jobId: string, cookie: string, lastEventId?: number): Promise<{ status: number; list: Sse[]; type: string | null }> {
  const res = await fetch(`http://localhost:${s.port}/api/generate/${jobId}/events`, { headers: { cookie, ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}) } });
  if (res.status !== 200) return { status: res.status, list: [], type: res.headers.get('content-type') };
  const text = await res.text();
  const list = text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => ({
      id: Number(/^id: (\d+)$/m.exec(block)![1]),
      event: /^event: (.+)$/m.exec(block)![1],
      data: JSON.parse(/^data: (.+)$/m.exec(block)![1]),
    }));
  return { status: 200, list, type: res.headers.get('content-type') };
}

const start = (s: RunningServer, cookie: string, body: object = { prompt: 'a pvp map with tiers' }) => call(s, 'POST', '/api/generate', cookie, body);

test('without an API key the generator is off; logins and rights are still required first', async () => {
  await withGenerator(null, config(), async (s) => {
    assert.equal((await call(s, 'POST', '/api/generate', null, { prompt: 'a map' })).status, 401);
    const ada = await signUp(s, 'Ada');
    const r = await start(s, ada);
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'generator-disabled');
  });
});

test('needs a login and the generate-maps right; bad requests are refused', async () => {
  await withGenerator(goodModel(), config(), async (s) => {
    assert.equal((await start(s, null as unknown as string)).status, 401);
    const bob = await signUp(s, 'Bob', false);
    const refused = await start(s, bob);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'no-right');
    assert.deepEqual((await call(s, 'GET', '/api/generate/quota', bob)).body, { used: 0, limit: 10, allowed: false, enabled: true });

    const ada = await signUp(s, 'Ada');
    for (const body of [{}, { prompt: 'ab' }, { prompt: 'x'.repeat(501) }, { prompt: 'a map', kind: 'chess' }, { prompt: 'a map', size: 'huge' }]) {
      const r = await start(s, ada, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 40));
      assert.equal(r.body.error.code, 'invalid');
    }
    assert.equal((await call(s, 'GET', '/api/generate/quota', ada)).body.used, 0, 'refused requests cost nothing');
  });
});

test('a generation streams its steps and pieces, ends with done, and is recorded', async () => {
  // No `check` given: this one goes through the real worker thread.
  await withGenerator(goodModel(undefined, { input: 8_000, output: 2_000 }), config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const started = await start(s, ada, { prompt: '  A   pvp map\nwith tiers ', kind: 'combat', size: 'small' });
    assert.equal(started.status, 202);
    assert.deepEqual(started.body.quota.used, 1);
    const jobId = started.body.jobId as string;

    const { status, list, type } = await events(s, jobId, ada);
    assert.equal(status, 200);
    assert.match(type!, /^text\/event-stream/);
    assert.deepEqual(list.map((e) => e.id), list.map((_, i) => i + 1), 'numbered 1..n');
    const kinds = list.map((e) => e.event);
    assert.equal(kinds[kinds.length - 1], 'done');
    const order = kinds.filter((k, i) => k !== kinds[i - 1]);
    assert.deepEqual(order, ['step', 'map', 'step', 'start', 'piece', 'step', 'map', 'step', 'done'], 'planning, the structure built from the plan, the streamed pieces, the check, then the checked map and the result');
    assert.equal(list.filter((e) => e.event === 'piece').length, highwire().pieces.length, 'every piece was streamed');
    assert.equal(list.find((e) => e.event === 'start')!.data.head.name, 'Highwire');
    const maps = list.filter((e) => e.event === 'map');
    assert.equal(maps[0].data.ok, false, 'the structure built from the plan comes first, unchecked');
    assert.equal(maps[maps.length - 1].data.ok, true);

    const done = list[list.length - 1].data;
    assert.equal(done.status, 'ok');
    assert.equal(done.outcome.ok, true);
    assert.equal(done.outcome.map.name, 'Highwire');
    assert.deepEqual(done.outcome.notes, ['Approximate.']);
    assert.deepEqual(done.outcome.tokens, { input: 16_000, output: 4_000 }, 'brief + draft');
    assert.ok(done.outcome.costUsd > 0);

    const summary = await call(s, 'GET', `/api/generate/${jobId}`, ada);
    assert.equal(summary.body.status, 'ok');
    assert.equal(summary.body.prompt, 'A pvp map with tiers', 'whitespace tidied');
    assert.equal(summary.body.outcome.map.name, 'Highwire');

    const [record] = s.store.recentGenerations(s.store.findUserForLogin('Ada')!.id, 5);
    assert.equal(record.status, 'ok');
    assert.equal(record.kind, 'combat/small');
    assert.equal(record.tokensIn, 16_000);
    assert.equal(record.tokensOut, 4_000);
    assert.equal(record.attempts, 1);
    assert.equal((await call(s, 'GET', '/api/generate/quota', ada)).body.used, 1);
  });
});

test('a viewer that reconnects with Last-Event-ID gets only what it missed', async () => {
  await withGenerator(goodModel(), config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const { jobId } = (await start(s, ada)).body;
    const all = (await events(s, jobId, ada)).list;
    const rest = (await events(s, jobId, ada, 5)).list;
    assert.deepEqual(rest.map((e) => e.id), all.slice(5).map((e) => e.id));
    assert.equal(rest[rest.length - 1].event, 'done');
    assert.deepEqual((await events(s, jobId, ada, all.length)).list, [], 'caught up: nothing, and the stream still closes');
  });
});

test("one user cannot see, watch or cancel another's generation", async () => {
  await withGenerator(goodModel(), config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    const { jobId } = (await start(s, ada)).body;
    assert.equal((await call(s, 'GET', `/api/generate/${jobId}`, bob)).status, 404);
    assert.equal((await events(s, jobId, bob)).status, 404);
    assert.equal((await call(s, 'DELETE', `/api/generate/${jobId}`, bob)).status, 404);
    assert.equal((await call(s, 'GET', '/api/generate/nosuchjob1', ada)).status, 404);
    assert.equal((await events(s, jobId, ada)).status, 200);
  });
});

test('one generation at a time per user; cancelling stops it, costs nothing, and frees the user', async () => {
  const hold: FakeLlm['before'] = (req) =>
    new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(new GenError('aborted', 'The generation was cancelled.'))));
  let n = 0;
  const model = () => (n++ === 0 ? goodModel(hold)() : goodModel()());
  await withGenerator(model, config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const { jobId } = (await start(s, ada)).body;
    const second = await start(s, ada);
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'already-running');

    assert.equal((await call(s, 'DELETE', `/api/generate/${jobId}`, ada)).status, 200);
    const { list } = await events(s, jobId, ada);
    const last = list[list.length - 1];
    assert.equal(last.event, 'error');
    assert.equal(last.data.status, 'cancelled');
    assert.equal(last.data.code, 'aborted');
    assert.equal((await call(s, 'GET', `/api/generate/${jobId}`, ada)).body.status, 'cancelled');
    assert.equal((await call(s, 'GET', '/api/generate/quota', ada)).body.used, 0, 'it spent nothing, so it is not charged');
    assert.equal((await start(s, ada)).status, 202, 'free to start another');
  });
});

test('a refused request fails the job with the reason and is not charged', async () => {
  const refused = () => {
    const llm = new FakeLlm({ brief: [brief], draft: [toWire(highwire())] });
    llm.before = async () => {
      throw new GenError('refusal', 'The model declined this request. Try describing the map differently.');
    };
    return llm as Llm;
  };
  await withGenerator(refused, config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const { jobId } = (await start(s, ada)).body;
    const { list } = await events(s, jobId, ada);
    const last = list[list.length - 1];
    assert.equal(last.event, 'error');
    assert.equal(last.data.status, 'failed');
    assert.equal(last.data.code, 'refusal');
    assert.match(last.data.message, /declined/);
    assert.equal((await call(s, 'GET', `/api/generate/${jobId}`, ada)).body.error.code, 'refusal');
    assert.equal((await call(s, 'GET', '/api/generate/quota', ada)).body.used, 0);
  });
});

test('the daily quota: the limit-th run is the last until tomorrow', async () => {
  await withGenerator(goodModel(), config({ dailyPerUser: 2 }), async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    for (let i = 0; i < 2; i++) {
      const { jobId } = (await start(s, ada)).body;
      await events(s, jobId, ada); // wait for it to finish
    }
    const third = await start(s, ada);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'quota');
    assert.deepEqual((await call(s, 'GET', '/api/generate/quota', ada)).body, { used: 2, limit: 2, allowed: true, enabled: true });
    assert.equal((await start(s, bob)).status, 202, "someone else's quota is their own");
  });
});

test('too many starts a minute are refused', async () => {
  await withGenerator(goodModel(), config({ startsPerMinute: 2, dailyPerUser: 50 }), async (s) => {
    const ada = await signUp(s, 'Ada');
    for (let i = 0; i < 2; i++) await events(s, (await start(s, ada)).body.jobId, ada);
    const r = await start(s, ada);
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, 'rate-limited');
  });
});

test('everyone together: only so many run at once, and a day has a token ceiling', async () => {
  const hold: FakeLlm['before'] = (req) => new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(new GenError('aborted', 'The generation was cancelled.'))));
  await withGenerator(goodModel(hold), config({ maxConcurrent: 1 }), async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    const { jobId } = (await start(s, ada)).body;
    const busy = await start(s, bob);
    assert.equal(busy.status, 429);
    assert.equal(busy.body.error.code, 'busy');
    await call(s, 'DELETE', `/api/generate/${jobId}`, ada);
    await events(s, jobId, ada);
  });
  await withGenerator(goodModel(undefined, { input: 3_000, output: 1_000 }), config({ dailyTokenCeiling: 5_000 }), async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    await events(s, (await start(s, ada)).body.jobId, ada); // brief + draft: 8,000 tokens
    const paused = await start(s, bob);
    assert.equal(paused.status, 503);
    assert.equal(paused.body.error.code, 'generator-paused');
  });
});

test('writes need the game page as their origin', async () => {
  await withGenerator(goodModel(), config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const res = await fetch(`http://localhost:${s.port}/api/generate`, { method: 'POST', headers: { cookie: ada, origin: 'https://evil.example' }, body: JSON.stringify({ prompt: 'a map' }) });
    assert.equal(res.status, 403);
    assert.equal((await call(s, 'GET', '/api/generate/quota', ada)).body.used, 0);
  });
});

test('stopping the server marks a running generation interrupted, and it is not charged', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-gen-'));
  const dbPath = join(dir, 'game.db');
  try {
    const hold: FakeLlm['before'] = (req) => new Promise<void>((_, reject) => req.signal?.addEventListener('abort', () => reject(new GenError('aborted', 'The generation was cancelled.'))));
    let userId = 0;
    await withServer({ dbPath, generator: { llm: goodModel(hold), config: config(), check: checkGenerated } }, async (s) => {
      const ada = await signUp(s, 'Ada');
      userId = s.store.findUserForLogin('Ada')!.id;
      assert.equal((await start(s, ada)).status, 202);
      assert.equal(s.store.countGenerationsSince(userId, 0), 1, 'while it runs it counts');
    });
    const after = new SqliteStore(dbPath);
    assert.deepEqual(after.recentGenerations(userId, 5).map((r) => r.status), ['interrupted']);
    assert.equal(after.countGenerationsSince(userId, 0), 0);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refinement sends the map along: no planning, the change is made, bad base maps are refused', async () => {
  await withGenerator(goodModel(), config(), async (s) => {
    const ada = await signUp(s, 'Ada');
    const started = await start(s, ada, { prompt: 'make it taller', baseMap: highwire() });
    assert.equal(started.status, 202);
    const { list } = await events(s, started.body.jobId, ada);
    const steps = list.filter((e) => e.event === 'step').map((e) => e.data.message as string);
    assert.match(steps[0], /^Reading "Highwire"/);
    assert.ok(!steps.some((m) => /Planning/.test(m)), 'no planner call');
    const done = list[list.length - 1];
    assert.equal(done.event, 'done');
    assert.equal(done.data.outcome.ok, true);
    assert.equal(done.data.outcome.map.id, highwire().id, 'the map keeps its id');

    const bad: object[] = [
      { prompt: 'x change', baseMap: 'a map' },
      { prompt: 'x change', baseMap: { pieces: [] } },
      { prompt: 'x change', baseMap: { pieces: [{ type: 'toString', at: [0, 0, 0] }] } },
      { prompt: 'x change', baseMap: { pieces: [{ type: 'block', at: [0, 'up', 0] }] } },
      { prompt: 'x change', baseMap: { pieces: Array.from({ length: 151 }, () => ({ type: 'block', at: [0, 0, 0], size: [1, 1, 1] })) } },
    ];
    for (const body of bad) {
      const r = await start(s, ada, body);
      assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(r.body.error.code, 'invalid');
    }
    const huge = await start(s, ada, { prompt: 'x change', baseMap: { pieces: [], pad: 'x'.repeat(140_000) } });
    assert.equal(huge.status, 413);
  });
});
