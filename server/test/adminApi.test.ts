/**
 * The admin page's API (server/auth/AdminApi.ts): who may see the player list, granting and
 * revoking the map generator right, and what a refused request looks like.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer, type ServerOptions } from '../main';
import { SESSION_COOKIE, type PublicUser } from '../auth/AuthApi';
import type { AdminUser } from '../../src/net/accounts';

async function withServer(options: Partial<ServerOptions>, body: (s: RunningServer) => Promise<void>): Promise<void> {
  const server = await startServer({ port: 0, staticDir: 'no-such-dir', log: () => {}, ...options });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}

/** A request; `cookie` is the login cookie (or none for a guest). */
async function call(s: RunningServer, method: string, path: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://localhost:${s.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Registers a player and returns their login cookie and id. */
async function player(s: RunningServer, name: string): Promise<{ cookie: string; id: number }> {
  const res = await fetch(`http://localhost:${s.port}/api/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, password: 'correct horse' }),
  });
  const set = res.headers.getSetCookie()[0];
  const value = set.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))![1];
  const body = (await res.json()) as { user: PublicUser };
  return { cookie: `${SESSION_COOKIE}=${value}`, id: body.user.id };
}

/** Registers an admin (the first one is made the way the admin tool makes one: by role). */
async function admin(s: RunningServer, name: string): Promise<string> {
  const { cookie, id } = await player(s, name);
  s.store.setRole(id, 'admin');
  return cookie;
}

test('the player list is for admins only: guests get a 401, players a 403', async () => {
  await withServer({}, async (s) => {
    const ada = await player(s, 'Ada');
    assert.equal((await call(s, 'GET', '/api/admin/users', null)).status, 401);
    const refused = await call(s, 'GET', '/api/admin/users', ada.cookie);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, 'forbidden');
    assert.equal((await call(s, 'PUT', `/api/admin/users/${ada.id}/rights`, ada.cookie, { rights: ['generate-maps'] })).status, 403);
    assert.deepEqual(s.store.getUser(ada.id)?.rights, [], 'a refused request changes nothing');
  });
});

test('admins list every player with their rights, role and today\'s generations', async () => {
  await withServer({}, async (s) => {
    const root = await admin(s, 'Root');
    const bob = await player(s, 'Bob');
    s.store.setRights(bob.id, ['generate-maps']);
    const { users } = (await call(s, 'GET', '/api/admin/users', root)).body as { users: AdminUser[] };
    assert.deepEqual(
      users.map((u) => [u.name, u.role, u.rights, u.disabled, u.generationsToday]),
      [
        ['Root', 'admin', ['generate-maps'], false, 0],
        ['Bob', 'user', ['generate-maps'], false, 0],
      ],
      'an admin has every right, so the list shows all of them',
    );
    assert.doesNotMatch(JSON.stringify(users), /scrypt|passwordHash/, 'no password hashes');
    assert.equal((await call(s, 'POST', '/api/admin/users', root, {})).status, 405);
  });
});

test('granting and revoking the generate-maps right takes effect at once for the player', async () => {
  await withServer({}, async (s) => {
    const root = await admin(s, 'Root');
    const bob = await player(s, 'Bob');
    const quotaOf = async () => (await call(s, 'GET', '/api/generate/quota', bob.cookie)).body.allowed;
    assert.equal(await quotaOf(), false);

    const granted = await call(s, 'PUT', `/api/admin/users/${bob.id}/rights`, root, { rights: ['generate-maps'] });
    assert.equal(granted.status, 200);
    assert.deepEqual(granted.body.user.rights, ['generate-maps']);
    assert.equal(granted.body.user.name, 'Bob');
    assert.equal(await quotaOf(), true, 'Bob may generate now, with no new login');
    assert.deepEqual((await call(s, 'GET', '/api/me', bob.cookie)).body.user.rights, ['generate-maps']);

    const revoked = await call(s, 'PUT', `/api/admin/users/${bob.id}/rights`, root, { rights: [] });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body.user.rights, []);
    assert.equal(await quotaOf(), false);
  });
});

test('the rights list is checked: known names only, each once; a player must exist', async () => {
  await withServer({}, async (s) => {
    const root = await admin(s, 'Root');
    const bob = await player(s, 'Bob');
    const put = (body: unknown, id = bob.id) => call(s, 'PUT', `/api/admin/users/${id}/rights`, root, body);
    assert.equal((await put({ rights: ['fly'] })).status, 400);
    assert.equal((await put({ rights: 'generate-maps' })).status, 400);
    assert.equal((await put({})).status, 400);
    assert.equal((await put({ rights: ['generate-maps'] }, 999)).status, 404);
    assert.equal((await put({ rights: ['generate-maps'] }, Number.NaN)).status, 404);
    assert.equal((await call(s, 'PUT', `/api/admin/users/${bob.id}/nope`, root, { rights: [] })).status, 404);
    const twice = await put({ rights: ['generate-maps', 'generate-maps'] });
    assert.equal(twice.status, 200);
    assert.deepEqual(twice.body.user.rights, ['generate-maps']);
  });
});

test('cross-site changes are refused, and the change is logged for the admin', async () => {
  const lines: string[] = [];
  await withServer({ log: (line) => lines.push(line) }, async (s) => {
    const root = await admin(s, 'Root');
    const bob = await player(s, 'Bob');
    const evil = await call(s, 'PUT', `/api/admin/users/${bob.id}/rights`, root, { rights: ['generate-maps'] }, { origin: 'http://evil.example' });
    assert.equal(evil.status, 403);
    assert.deepEqual(s.store.getUser(bob.id)?.rights, []);
    await call(s, 'PUT', `/api/admin/users/${bob.id}/rights`, root, { rights: ['generate-maps'] });
    assert.ok(lines.some((l) => l.includes('Root set the rights of Bob to: generate-maps')), lines.join('\n'));
  });
});
