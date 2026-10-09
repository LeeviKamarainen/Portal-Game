/**
 * Saved maps over HTTP: who may save, read, change and delete what; limits; and a logged-in
 * player keeping their account name in rooms.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as WsClient } from 'ws';
import { startServer, type RunningServer } from '../main';
import { MAPS_PER_USER } from '../../src/net/accounts';
import { MAP_JSON_MAX, PROTOCOL_VERSION, type ServerMessage } from '../../src/net/protocol';
import { blankMap } from '../../src/editor/templates';

async function withServer(body: (s: RunningServer) => Promise<void>): Promise<void> {
  const server = await startServer({ port: 0, staticDir: 'no-such-dir', log: () => {} });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

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

/** Registers `name` and returns the cookie that logs in as them. */
async function signUp(s: RunningServer, name: string): Promise<string> {
  const res = await fetch(`http://localhost:${s.port}/api/register`, {
    method: 'POST',
    body: JSON.stringify({ name, password: 'correct horse' }),
  });
  assert.equal(res.status, 200);
  return res.headers.getSetCookie()[0].split(';')[0];
}

const mapNamed = (name: string) => ({ ...blankMap(), id: 'm', name });

test('saving needs a login; the owner lists, reads, updates and deletes', async () => {
  await withServer(async (s) => {
    assert.equal((await call(s, 'GET', '/api/maps', null)).status, 401);
    assert.equal((await call(s, 'POST', '/api/maps', null, { data: mapNamed('Nope') })).status, 401);

    const ada = await signUp(s, 'Ada');
    const saved = await call(s, 'POST', '/api/maps', ada, { data: mapNamed('First') });
    assert.equal(saved.status, 201);
    assert.equal(saved.body.map.name, 'First');
    assert.equal(saved.body.map.visibility, 'private');
    assert.equal(saved.body.map.ownerName, 'Ada');
    assert.equal('data' in saved.body.map, false);
    const id = saved.body.map.id as string;

    assert.deepEqual((await call(s, 'GET', '/api/maps', ada)).body.maps.map((m: { id: string }) => m.id), [id]);
    const read = await call(s, 'GET', `/api/maps/${id}`, ada);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body.map.data, mapNamed('First'));

    const renamed = await call(s, 'PUT', `/api/maps/${id}`, ada, { data: mapNamed('Second'), visibility: 'unlisted' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.map.name, 'Second', "the name is the file's name");
    assert.equal(renamed.body.map.visibility, 'unlisted');
    assert.equal((await call(s, 'PUT', `/api/maps/${id}`, ada, { visibility: 'public' })).body.map.visibility, 'public', 'just the visibility');
    assert.equal((await call(s, 'GET', `/api/maps/${id}`, ada)).body.map.data.name, 'Second', 'the file stays');

    assert.equal((await call(s, 'DELETE', `/api/maps/${id}`, ada)).status, 200);
    assert.equal((await call(s, 'GET', `/api/maps/${id}`, ada)).status, 404);
    assert.equal((await call(s, 'DELETE', `/api/maps/${id}`, ada)).status, 404);
  });
});

test('visibility: private maps are invisible to others; unlisted need the id; public are listed', async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    const secret = (await call(s, 'POST', '/api/maps', ada, { data: mapNamed('Secret') })).body.map.id;
    const link = (await call(s, 'POST', '/api/maps', ada, { data: mapNamed('Link'), visibility: 'unlisted' })).body.map.id;
    const open = (await call(s, 'POST', '/api/maps', ada, { data: mapNamed('Open'), visibility: 'public' })).body.map.id;

    assert.equal((await call(s, 'GET', `/api/maps/${secret}`, bob)).status, 404);
    assert.equal((await call(s, 'GET', `/api/maps/${secret}`, null)).status, 404, 'or to guests');
    assert.equal((await call(s, 'GET', `/api/maps/${link}`, bob)).status, 200);
    assert.equal((await call(s, 'GET', `/api/maps/${link}`, null)).status, 200);
    assert.equal((await call(s, 'GET', `/api/maps/${open}`, null)).status, 200);

    const listed = await call(s, 'GET', '/api/maps/public', null);
    assert.deepEqual(listed.body.maps.map((m: { id: string }) => m.id), [open]);
    assert.equal(listed.body.maps[0].ownerName, 'Ada');
    assert.equal('data' in listed.body.maps[0], false);
    assert.deepEqual((await call(s, 'GET', '/api/maps', bob)).body.maps, [], "Bob's own list is his alone");
  });
});

test("nobody changes or deletes another player's map", async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const bob = await signUp(s, 'Bob');
    const id = (await call(s, 'POST', '/api/maps', ada, { data: mapNamed('Mine'), visibility: 'public' })).body.map.id;
    assert.equal((await call(s, 'PUT', `/api/maps/${id}`, bob, { data: mapNamed('Stolen') })).status, 404);
    assert.equal((await call(s, 'PUT', `/api/maps/${id}`, bob, { visibility: 'private' })).status, 404);
    assert.equal((await call(s, 'DELETE', `/api/maps/${id}`, bob)).status, 404);
    assert.equal((await call(s, 'PUT', `/api/maps/${id}`, null, { visibility: 'private' })).status, 401);
    const after = await call(s, 'GET', `/api/maps/${id}`, null);
    assert.equal(after.body.map.name, 'Mine');
    assert.equal(after.body.map.visibility, 'public');
  });
});

test('bad maps and requests are refused with a reason', async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const post = (body: unknown) => call(s, 'POST', '/api/maps', ada, body);
    assert.equal((await post({})).status, 400);
    assert.equal((await post({ data: 'text' })).status, 400);
    assert.equal((await post({ data: { id: 'x', name: 'No pieces' } })).status, 400);
    assert.equal((await post({ data: { pieces: [] } })).status, 400, 'no id or name');
    assert.equal((await post({ data: { id: 'x', name: 'Many', pieces: Array.from({ length: 2001 }, () => ({})) } })).status, 400);
    assert.equal((await post({ data: mapNamed('Odd'), visibility: 'secret' })).status, 400);

    const huge = await post({ data: { ...mapNamed('Huge'), blurb: 'x'.repeat(MAP_JSON_MAX) } });
    assert.ok(huge.status === 400 || huge.status === 413, `refused (${huge.status})`);
    assert.equal((await call(s, 'GET', '/api/maps/no/such/path', ada)).status, 404);
    assert.equal((await call(s, 'GET', '/api/maps/!!!', ada)).status, 404);
    assert.equal((await call(s, 'PATCH', '/api/maps/abcdef123456', ada)).status, 405);

    // Not a playable arena yet is fine to save: it is still being worked on.
    assert.equal((await post({ data: mapNamed('   Padded name   ') })).body.map.name, 'Padded name');
    assert.equal((await post({ data: mapNamed('') })).body.map.name, 'Untitled map');
  });
});

test(`a user keeps at most ${MAPS_PER_USER} maps`, async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    for (let i = 0; i < MAPS_PER_USER; i++) {
      // Rate limits are per minute: save straight into the store past the first batch.
      if (i < 20) assert.equal((await call(s, 'POST', '/api/maps', ada, { data: mapNamed(`Map ${i}`) })).status, 201);
      else s.store.saveMap(1, `Map ${i}`, '{}');
    }
    const over = await call(s, 'POST', '/api/maps', ada, { data: mapNamed('One too many') });
    assert.equal(over.status, 409);
    assert.equal(over.body.error.code, 'map-limit');
  });
});

test('saves are throttled per user', async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const id = (await call(s, 'POST', '/api/maps', ada, { data: mapNamed('One') })).body.map.id;
    let last = 0;
    for (let i = 0; i < 70; i++) last = (await call(s, 'PUT', `/api/maps/${id}`, ada, { visibility: i % 2 ? 'public' : 'private' })).status;
    assert.equal(last, 429);
  });
});

test('cross-site writes are refused', async () => {
  await withServer(async (s) => {
    const ada = await signUp(s, 'Ada');
    const res = await fetch(`http://localhost:${s.port}/api/maps`, {
      method: 'POST',
      headers: { cookie: ada, origin: 'http://evil.example' },
      body: JSON.stringify({ data: mapNamed('Planted') }),
    });
    assert.equal(res.status, 403);
    assert.equal(s.store.listMapsOf(1).length, 0);
  });
});

test('a logged-in player keeps their account name in rooms, whatever the page sends', async () => {
  await withServer(async (s) => {
    const cookie = await signUp(s, 'Ada');
    const joined = await new Promise<Extract<ServerMessage, { type: 'joined' }>>((done, fail) => {
      const ws = new WsClient(`ws://localhost:${s.port}/ws`, { headers: { cookie } });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION })));
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(data.toString()) as ServerMessage;
        if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'create', name: 'IMPOSTOR', skin: 'a' }));
        if (msg.type === 'joined') {
          ws.close();
          done(msg);
        }
      });
      ws.on('error', fail);
    });
    assert.deepEqual(joined.lobby.members.map((m) => m.name), ['Ada']);
  });
});
