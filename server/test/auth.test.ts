/**
 * Accounts over HTTP and WebSocket: register, log in/out, change password, throttling, the
 * origin check, disabled accounts, and the admin tool.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket as WsClient } from 'ws';
import { startServer, type RunningServer, type ServerOptions } from '../main';
import { runAdmin } from '../admin';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password';
import { hashToken, SESSION_COOKIE, type PublicUser } from '../auth/AuthApi';
import { PROTOCOL_VERSION } from '../../src/net/protocol';

interface Reply {
  status: number;
  body: any;
  cookie: string | null;
  setCookie: string | null;
}

/** Runs `body` against a fresh server (its own in-memory database, its own rate limits). */
async function withServer(options: ServerOptions, body: (s: RunningServer, lines: string[]) => Promise<void>): Promise<void> {
  const lines: string[] = [];
  const server = await startServer({ port: 0, staticDir: 'no-such-dir', log: (l) => lines.push(l), ...options });
  try {
    await body(server, lines);
  } finally {
    await server.close();
  }
}

async function call(server: RunningServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await fetch(`http://localhost:${server.port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie()[0] ?? null;
  const value = set?.match(new RegExp(`^${SESSION_COOKIE}=([^;]*)`))?.[1];
  return { status: res.status, body: await res.json(), setCookie: set, cookie: value ? `${SESSION_COOKIE}=${value}` : null };
}

const register = (s: RunningServer, name: string, password = 'correct horse') => call(s, 'POST', '/api/register', { name, password });
const me = async (s: RunningServer, cookie: string | null): Promise<PublicUser | null> =>
  (await call(s, 'GET', '/api/me', undefined, cookie ? { cookie } : {})).body.user;

test('passwords: hashed with a salt, verified, and bounded', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b, 'a fresh salt each time');
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('Correct horse', a), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$1$1$1$AA==$AA=='), false, 'absurd parameters are refused');
  assert.notEqual(passwordProblem('short'), null);
  assert.notEqual(passwordProblem('x'.repeat(129)), null);
  assert.notEqual(passwordProblem(42), null);
  assert.equal(passwordProblem('long enough'), null);
});

test('register logs you in; /api/me knows you by the cookie alone', async () => {
  await withServer({}, async (s) => {
    assert.equal(await me(s, null), null, 'a guest');
    const r = await register(s, 'Ada');
    assert.equal(r.status, 200);
    assert.equal(r.body.user.name, 'Ada');
    assert.deepEqual(r.body.user.rights, []);
    assert.match(r.setCookie!, /HttpOnly/);
    assert.match(r.setCookie!, /SameSite=Lax/);
    assert.doesNotMatch(r.setCookie!, /Secure/);
    assert.equal((await me(s, r.cookie))?.name, 'Ada');
    assert.equal(await me(s, `${SESSION_COOKIE}=forged`), null);
    // Only a hash of the token is stored.
    const token = r.cookie!.split('=')[1];
    assert.equal(s.store.userForSession(hashToken(token))?.name, 'Ada');
    assert.equal(s.store.userForSession(token), null);
    assert.doesNotMatch(JSON.stringify(r.body), /scrypt/);
  });
});

test('register: bad names and passwords, duplicates ignoring case, junk bodies', async () => {
  await withServer({}, async (s) => {
    assert.equal((await register(s, 'ab')).status, 400);
    assert.equal((await register(s, 'has space')).status, 400);
    assert.equal((await register(s, 'Okay', 'short')).status, 400);
    assert.equal((await register(s, 'Ada')).status, 200);
    const dup = await register(s, 'ADA');
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'name-taken');
    assert.equal((await call(s, 'POST', '/api/register', { name: 'Zed' })).status, 400, 'no password');
    const junk = await fetch(`http://localhost:${s.port}/api/register`, { method: 'POST', body: 'not json' });
    assert.equal(junk.status, 400);
    const huge = await fetch(`http://localhost:${s.port}/api/register`, { method: 'POST', body: JSON.stringify({ name: 'Big', password: 'x'.repeat(10000) }) });
    assert.equal(huge.status, 413);
    assert.equal((await call(s, 'GET', '/api/register')).status, 405);
    assert.equal((await call(s, 'GET', '/api/nope')).status, 404);
  });
});

test('login: the same answer for a wrong password and an unknown name; logout ends the session', async () => {
  await withServer({}, async (s) => {
    await register(s, 'Ada', 'correct horse');
    const wrong = await call(s, 'POST', '/api/login', { name: 'Ada', password: 'wrong horse' });
    const unknown = await call(s, 'POST', '/api/login', { name: 'Nobody', password: 'wrong horse' });
    assert.equal(wrong.status, 401);
    assert.deepEqual(wrong.body, unknown.body);
    assert.equal(wrong.cookie, null);

    const ok = await call(s, 'POST', '/api/login', { name: 'ada', password: 'correct horse' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.name, 'Ada');
    assert.notEqual(s.store.findUserForLogin('Ada')!.lastLoginAt, null);
    assert.equal((await me(s, ok.cookie))?.name, 'Ada');

    const out = await call(s, 'POST', '/api/logout', undefined, { cookie: ok.cookie! });
    assert.equal(out.status, 200);
    assert.match(out.setCookie!, /Max-Age=0/);
    assert.equal(await me(s, ok.cookie), null);
  });
});

test('disabled accounts: no login, and live sessions end', async () => {
  await withServer({}, async (s) => {
    const r = await register(s, 'Ada', 'correct horse');
    s.store.setDisabled(r.body.user.id, true);
    assert.equal(await me(s, r.cookie), null);
    const login = await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'disabled');
    // ...but only someone with the right password learns the account is disabled.
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Ada', password: 'wrong horse' })).status, 401);
    s.store.setDisabled(r.body.user.id, false);
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' })).status, 200);
  });
});

test('rights show up in /api/me: granted ones for a user, all for an admin', async () => {
  await withServer({}, async (s) => {
    const r = await register(s, 'Ada');
    s.store.setRights(r.body.user.id, ['generate-maps']);
    assert.deepEqual((await me(s, r.cookie))?.rights, ['generate-maps']);
    s.store.setRights(r.body.user.id, []);
    s.store.setRole(r.body.user.id, 'admin');
    const admin = await me(s, r.cookie);
    assert.equal(admin?.role, 'admin');
    assert.deepEqual(admin?.rights, ['generate-maps']);
  });
});

test('change password: needs the current one, ends the other sessions, keeps this browser in', async () => {
  await withServer({}, async (s) => {
    const first = await register(s, 'Ada', 'correct horse');
    const other = await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' });
    assert.equal((await call(s, 'POST', '/api/password', { current: 'x', next: 'brand new pass' })).status, 401, 'not logged in');
    const wrong = await call(s, 'POST', '/api/password', { current: 'wrong horse', next: 'brand new pass' }, { cookie: first.cookie! });
    assert.equal(wrong.status, 401);
    const weak = await call(s, 'POST', '/api/password', { current: 'correct horse', next: 'short' }, { cookie: first.cookie! });
    assert.equal(weak.status, 400);

    const changed = await call(s, 'POST', '/api/password', { current: 'correct horse', next: 'brand new pass' }, { cookie: first.cookie! });
    assert.equal(changed.status, 200);
    assert.equal(await me(s, first.cookie), null, 'the old session ended');
    assert.equal(await me(s, other.cookie), null, 'so did the other one');
    assert.equal((await me(s, changed.cookie))?.name, 'Ada', 'this browser got a fresh one');
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' })).status, 401);
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Ada', password: 'brand new pass' })).status, 200);
  });
});

test('cross-site posts are refused; the page\'s own origin and non-browsers pass', async () => {
  await withServer({}, async (s) => {
    const own = `http://localhost:${s.port}`;
    assert.equal((await call(s, 'POST', '/api/register', { name: 'Evil', password: 'correct horse' }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await call(s, 'POST', '/api/register', { name: 'Good', password: 'correct horse' }, { origin: own })).status, 200);
    assert.equal(s.store.findUserForLogin('Evil'), null);
  });
  await withServer({ allowedOrigins: ['https://game.example'] }, async (s) => {
    assert.equal((await call(s, 'POST', '/api/register', { name: 'Ada', password: 'correct horse' }, { origin: 'https://game.example' })).status, 200);
    assert.equal((await call(s, 'POST', '/api/register', { name: 'Bob', password: 'correct horse' }, { origin: `http://localhost:${s.port}` })).status, 403);
  });
});

test('closed registration; secure cookies', async () => {
  await withServer({ registrationOpen: false, secureCookies: true }, async (s) => {
    const closed = await register(s, 'Ada');
    assert.equal(closed.status, 403);
    assert.equal(closed.body.error.code, 'registration-closed');
    s.store.createUser('Ada', await hashPassword('correct horse'));
    const login = await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' });
    assert.equal(login.status, 200, 'logging in still works');
    assert.match(login.setCookie!, /; Secure/);
  });
});

test('guessing is throttled per name, even from many places', async () => {
  await withServer({ trustProxy: true }, async (s) => {
    await register(s, 'Ada', 'correct horse');
    let last = 0;
    for (let i = 0; i < 12; i++) {
      // A different address each time (as a proxy reports it): only the per-name limit can stop this.
      last = (await call(s, 'POST', '/api/login', { name: 'Ada', password: `guess number ${i}` }, { 'x-forwarded-for': `10.0.0.${i}` })).status;
    }
    assert.equal(last, 429);
    const right = await call(s, 'POST', '/api/login', { name: 'Ada', password: 'correct horse' }, { 'x-forwarded-for': '10.9.9.9' });
    assert.equal(right.status, 429, 'locked out for a while, right password or not');
  });
});

test('registrations are throttled per address', async () => {
  await withServer({}, async (s) => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await register(s, `User${i}`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  });
});

test('WebSocket: a good cookie connects as the account, anything else as a guest', async () => {
  await withServer({}, async (s, lines) => {
    const r = await register(s, 'Ada');
    const open = (cookie?: string) =>
      new Promise<void>((done, fail) => {
        const ws = new WsClient(`ws://localhost:${s.port}/ws`, { headers: cookie ? { cookie } : {} });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION })));
        ws.on('message', () => {
          ws.close();
          done();
        });
        ws.on('error', fail);
      });
    await open(r.cookie!);
    await open(`${SESSION_COOKIE}=forged`);
    await open();
    assert.deepEqual(
      lines.filter((l) => l.startsWith('connection from')),
      ['connection from account Ada', 'connection from a guest', 'connection from a guest'],
    );
  });
});

test('admin tool: create, reset, grant, disable, delete', async () => {
  await withServer({}, async (s) => {
    const out: string[] = [];
    const run = async (...args: string[]) => {
      out.length = 0;
      return runAdmin(args, s.store, (l) => out.push(l));
    };

    assert.equal(await run('create', 'Root', '--admin'), 0);
    const password = out[0].split('password: ')[1];
    assert.equal(s.store.findUserForLogin('Root')!.role, 'admin');
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Root', password })).status, 200, 'the printed password works');

    const session = await call(s, 'POST', '/api/login', { name: 'Root', password });
    assert.equal(await run('reset-password', 'root'), 0);
    const reset = out[0].split('"Root": ')[1];
    assert.notEqual(reset, password);
    assert.equal(await me(s, session.cookie), null, 'a reset ends their sessions');
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Root', password })).status, 401);
    assert.equal((await call(s, 'POST', '/api/login', { name: 'Root', password: reset })).status, 200);

    assert.equal(await run('create', 'Bob'), 0);
    assert.equal(await run('grant', 'Bob', 'generate-maps'), 0);
    assert.deepEqual(s.store.findUserForLogin('Bob')!.rights, ['generate-maps']);
    assert.equal(await run('revoke', 'Bob', 'generate-maps'), 0);
    assert.deepEqual(s.store.findUserForLogin('Bob')!.rights, []);
    assert.equal(await run('grant', 'Bob', 'fly'), 1);
    assert.equal(await run('role', 'Bob', 'admin'), 0);
    assert.equal(s.store.findUserForLogin('Bob')!.role, 'admin');
    assert.equal(await run('disable', 'Bob'), 0);
    assert.equal(s.store.findUserForLogin('Bob')!.disabled, true);
    assert.equal(await run('enable', 'Bob'), 0);

    assert.equal(await run('list'), 0);
    assert.equal(out.length, 2);
    assert.equal(await run('create', 'Bob'), 1, 'taken');
    assert.equal(await run('reset-password', 'Nobody'), 1);
    assert.equal(await run('delete', 'Bob'), 1, 'needs --yes');
    assert.equal(await run('delete', 'Bob', '--yes'), 0);
    assert.equal(s.store.findUserForLogin('Bob'), null);
    assert.equal(await run('bogus'), 1);
  });
});
