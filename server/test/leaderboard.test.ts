/**
 * The speedrun leaderboards: who may submit, that only a faster run replaces a player's time,
 * ranks and ties, what a bad run gets, and disabled players dropping off the board.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../main';
import { SqliteStore } from '../store/SqliteStore';
import { COURSES } from '../auth/LeaderboardApi';
import { runProblem } from '../../src/net/leaderboard';

const course = COURSES[0];
const splitsFor = (time: number) => Array.from({ length: course.checkpoints }, (_, i) => (time * (i + 1)) / (course.checkpoints + 1));

async function withServer(body: (s: RunningServer) => Promise<void>): Promise<void> {
  const server = await startServer({ port: 0, staticDir: 'no-such-dir', log: () => {} });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

async function call(s: RunningServer, method: string, path: string, cookie: string | null, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://localhost:${s.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function signUp(s: RunningServer, name: string): Promise<string> {
  const res = await fetch(`http://localhost:${s.port}/api/register`, { method: 'POST', body: JSON.stringify({ name, password: 'correct horse' }) });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

const run = (s: RunningServer, cookie: string | null, time: number, id = course.id) =>
  call(s, 'POST', `/api/leaderboard/${id}`, cookie, { time, splits: splitsFor(time) });

test('the courses are the built-in speedruns, each with its checkpoint count', () => {
  assert.deepEqual(COURSES.map((c) => c.id).slice(0, 2), ['slipstream', 'updraft']);
  for (const c of COURSES) assert.ok(c.checkpoints >= 1, `${c.id} has checkpoints`);
});

test('runProblem: shape of a run', () => {
  assert.equal(runProblem(2, 40, [10, 25]), null);
  assert.ok(runProblem(2, 1, [0.2, 0.5]), 'too fast');
  assert.ok(runProblem(2, 40, [10]), 'a split missing');
  assert.ok(runProblem(2, 40, [25, 10]), 'splits out of order');
  assert.ok(runProblem(2, 40, [10, 41]), 'a split after the finish');
  assert.ok(runProblem(2, NaN, [10, 20]), 'no time');
  assert.ok(runProblem(2, 40, [10, 'x']), 'not numbers');
});

test('submitting needs a login; the board is open to read', async () => {
  await withServer(async (s) => {
    assert.equal((await run(s, null, 60)).status, 401);
    const empty = await call(s, 'GET', `/api/leaderboard/${course.id}`, null);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.entries, []);
    assert.equal(empty.body.total, 0);
    assert.equal(empty.body.you, null);
    assert.equal((await call(s, 'GET', '/api/leaderboard', null)).body.courses.length, COURSES.length);
    assert.equal((await call(s, 'GET', '/api/leaderboard/nowhere', null)).status, 404);
    assert.equal((await run(s, await signUp(s, 'Ada'), 60, 'nowhere')).status, 404);
  });
});

test("only a faster run replaces a player's time; ranks follow", async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');

    const first = await run(s, ada, 70);
    assert.equal(first.status, 200);
    assert.equal(first.body.improved, true);
    assert.equal(first.body.you.rank, 1);

    const slower = await run(s, ada, 80);
    assert.equal(slower.body.improved, false);
    assert.equal(slower.body.you.time, 70, 'the old time stays');

    const bobRun = await run(s, bob, 65.123456);
    assert.equal(bobRun.body.you.rank, 1);
    assert.equal(bobRun.body.you.time, 65.123, 'kept to the millisecond');
    assert.equal((await call(s, 'GET', `/api/leaderboard/${course.id}`, ada)).body.you.rank, 2);

    assert.equal((await run(s, ada, 60)).body.you.rank, 1, 'a faster run moves up');
    const board = (await call(s, 'GET', `/api/leaderboard/${course.id}`, bob)).body;
    assert.deepEqual(board.entries.map((e: { name: string; rank: number }) => `${e.rank}:${e.name}`), ['1:Ada', '2:Bob']);
    assert.equal(board.total, 2);
    assert.equal(board.you.name, 'Bob');
    assert.equal(board.entries[0].splits.length, course.checkpoints);

    // Other courses have their own boards.
    assert.equal((await call(s, 'GET', `/api/leaderboard/${COURSES[1].id}`, null)).body.total, 0);
  });
});

test('bad runs are refused with a reason', async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    for (const body of [{ time: 1, splits: splitsFor(1) }, { time: 50, splits: [] }, { time: 'fast', splits: splitsFor(50) }, { splits: splitsFor(50) }]) {
      const r = await call(s, 'POST', `/api/leaderboard/${course.id}`, ada, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, 'bad-run');
    }
    assert.equal((await call(s, 'GET', `/api/leaderboard/${course.id}`, ada)).body.total, 0);
  });
});

test('store: ties go to the earlier run; disabled and deleted players leave the board', () => {
  let t = 1000;
  const store = new SqliteStore(':memory:', { now: () => t });
  const ada = store.createUser('Ada', 'h');
  const bob = store.createUser('Bob', 'h');
  const cy = store.createUser('Cyd', 'h');
  store.submitRun(bob.id, 'm', 50, [20]);
  t += 10;
  store.submitRun(ada.id, 'm', 50, [25]);
  t += 10;
  store.submitRun(cy.id, 'm', 49, [10]);
  assert.deepEqual(store.boardTop('m', 10).map((e) => `${e.rank}:${e.name}`), ['1:Cyd', '2:Bob', '3:Ada']);
  assert.equal(store.boardEntryOf('m', ada.id)!.rank, 3);
  assert.equal(store.submitRun(bob.id, 'm', 50, [1]).improved, false, 'an equal time is not an improvement');
  assert.deepEqual(store.boardEntryOf('m', bob.id)!.splits, [20]);

  store.setDisabled(cy.id, true);
  assert.equal(store.boardTotal('m'), 2);
  assert.equal(store.boardEntryOf('m', ada.id)!.rank, 2);
  assert.equal(store.boardEntryOf('m', cy.id), null);
  store.setDisabled(cy.id, false);
  assert.equal(store.boardTotal('m'), 3);

  assert.equal(store.removeRun(bob.id, 'm'), true);
  assert.equal(store.removeRun(bob.id, 'm'), false);
  store.deleteUser(cy.id);
  assert.deepEqual(store.boardTop('m', 10).map((e) => e.name), ['Ada']);
  assert.deepEqual(store.boardTop('m', 1, 1), [], 'offset past the end');
  store.close();
});
