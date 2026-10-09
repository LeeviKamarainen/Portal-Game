/**
 * The SQLite store: accounts, rights, sessions and saved maps, in memory and on disk.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../store/SqliteStore';
import { MAPS_PER_USER, StoreError, hasRight, userNameProblem, type StoreErrorCode } from '../store/Store';
import { MAP_JSON_MAX } from '../../src/net/protocol';

/** A store on a clock the test moves. */
function fresh() {
  const clock = { t: 1_000_000 };
  const store = new SqliteStore(':memory:', { now: () => clock.t });
  return { store, clock };
}

function throwsCode(fn: () => unknown, code: StoreErrorCode): void {
  assert.throws(fn, (e) => e instanceof StoreError && e.code === code);
}

test('accounts: names are checked and unique ignoring case', () => {
  const { store } = fresh();
  const ada = store.createUser('Ada', 'hash-a');
  assert.equal(ada.role, 'user');
  assert.deepEqual(ada.rights, []);
  assert.equal(ada.disabled, false);
  throwsCode(() => store.createUser('ada', 'x'), 'name-taken');
  throwsCode(() => store.createUser('ab', 'x'), 'bad-name');
  throwsCode(() => store.createUser('has space', 'x'), 'bad-name');
  throwsCode(() => store.createUser('x'.repeat(17), 'x'), 'bad-name');
  assert.equal(userNameProblem('Valid_name-1'), null);
});

test('login lookup ignores case and carries the hash; the public user does not', () => {
  const { store } = fresh();
  const ada = store.createUser('Ada', 'hash-a');
  const found = store.findUserForLogin('ADA');
  assert.equal(found?.id, ada.id);
  assert.equal(found?.passwordHash, 'hash-a');
  assert.equal('passwordHash' in store.getUser(ada.id)!, false);
  assert.equal(store.findUserForLogin('nobody'), null);
});

test('rights and roles: admins have every right, users only what is granted', () => {
  const { store } = fresh();
  const user = store.createUser('Bob', 'h');
  const admin = store.createUser('Root', 'h', 'admin');
  assert.equal(hasRight(user, 'generate-maps'), false);
  assert.equal(hasRight(admin, 'generate-maps'), true);

  store.setRights(user.id, ['generate-maps', 'generate-maps']);
  assert.deepEqual(store.getUser(user.id)!.rights, ['generate-maps']);
  assert.equal(hasRight(store.getUser(user.id)!, 'generate-maps'), true);
  store.setRights(user.id, []);
  assert.deepEqual(store.getUser(user.id)!.rights, []);

  store.setRole(user.id, 'admin');
  assert.equal(store.getUser(user.id)!.role, 'admin');
  assert.throws(() => store.setRights(user.id, ['fly' as never]), /Unknown right/);
  throwsCode(() => store.setRole(999, 'admin'), 'no-such-user');
  throwsCode(() => store.setRights(999, []), 'no-such-user');
});

test('sessions: live until they expire; a password reset or disabling ends them', () => {
  const { store, clock } = fresh();
  const ada = store.createUser('Ada', 'h');
  store.createSession(ada.id, 'tok1', 1000);
  assert.equal(store.userForSession('tok1')?.id, ada.id);
  assert.equal(store.userForSession('nope'), null);

  clock.t += 1000;
  assert.equal(store.userForSession('tok1'), null, 'expired');
  assert.equal(store.purgeExpiredSessions(), 1);

  store.createSession(ada.id, 'tok2', 60_000);
  store.createSession(ada.id, 'tok3', 60_000);
  store.setPasswordHash(ada.id, 'new-hash');
  assert.equal(store.userForSession('tok2'), null, 'reset logs the user out everywhere');
  assert.equal(store.findUserForLogin('Ada')!.passwordHash, 'new-hash');

  store.createSession(ada.id, 'tok4', 60_000);
  store.setDisabled(ada.id, true);
  assert.equal(store.userForSession('tok4'), null);
  store.createSession(ada.id, 'tok5', 60_000);
  assert.equal(store.userForSession('tok5'), null, 'a disabled account never resolves');
  store.setDisabled(ada.id, false);
  assert.equal(store.userForSession('tok5')?.id, ada.id);

  store.deleteSession('tok5');
  assert.equal(store.userForSession('tok5'), null);
  throwsCode(() => store.setPasswordHash(999, 'x'), 'no-such-user');
});

test('recordLogin stamps the time', () => {
  const { store, clock } = fresh();
  const ada = store.createUser('Ada', 'h');
  assert.equal(ada.lastLoginAt, null);
  clock.t += 5;
  store.recordLogin(ada.id);
  assert.equal(store.getUser(ada.id)!.lastLoginAt, clock.t);
});

test('maps: owner-only changes, visibility, and the public list', () => {
  const { store, clock } = fresh();
  const ada = store.createUser('Ada', 'h');
  const bob = store.createUser('Bob', 'h');

  const m = store.saveMap(ada.id, '  Arena One ', '{"pieces":[]}');
  assert.equal(m.name, 'Arena One');
  assert.equal(m.visibility, 'private');
  assert.equal(m.ownerName, 'Ada');
  assert.equal(m.json, '{"pieces":[]}');
  assert.equal(store.getMap(m.id)!.json, m.json);

  assert.equal(store.updateMap(m.id, bob.id, { name: 'Stolen' }), null, "not Bob's");
  assert.equal(store.deleteMap(m.id, bob.id), false);
  clock.t += 10;
  const updated = store.updateMap(m.id, ada.id, { visibility: 'public', json: '{"pieces":[1]}' })!;
  assert.equal(updated.visibility, 'public');
  assert.equal(updated.json, '{"pieces":[1]}');
  assert.equal(updated.name, 'Arena One', 'unchanged fields stay');
  assert.equal(updated.updatedAt, clock.t);

  clock.t += 10;
  store.saveMap(ada.id, 'Hidden', '{}', 'unlisted');
  clock.t += 10;
  const newer = store.saveMap(bob.id, 'Newer', '{}', 'public');
  assert.deepEqual(store.listPublicMaps(10).map((s) => s.id), [newer.id, m.id], 'public only, newest first');
  assert.deepEqual(store.listPublicMaps(1, 1).map((s) => s.id), [m.id]);
  assert.equal(store.listMapsOf(ada.id).length, 2);
  assert.equal('json' in store.listMapsOf(ada.id)[0], false, 'lists leave the map out');

  assert.equal(store.deleteMap(m.id, ada.id), true);
  assert.equal(store.getMap(m.id), null);

  store.setDisabled(bob.id, true);
  assert.deepEqual(store.listPublicMaps(10), [], "a disabled user's maps leave the shared list");
});

test('maps: name, size and count limits', () => {
  const { store } = fresh();
  const ada = store.createUser('Ada', 'h');
  throwsCode(() => store.saveMap(ada.id, '   ', '{}'), 'bad-map-name');
  throwsCode(() => store.saveMap(ada.id, 'x'.repeat(41), '{}'), 'bad-map-name');
  throwsCode(() => store.saveMap(ada.id, 'Big', 'x'.repeat(MAP_JSON_MAX + 1)), 'map-too-big');
  throwsCode(() => store.saveMap(999, 'Orphan', '{}'), 'no-such-user');
  const m = store.saveMap(ada.id, 'Ok', '{}');
  throwsCode(() => store.updateMap(m.id, ada.id, { json: 'x'.repeat(MAP_JSON_MAX + 1) }), 'map-too-big');
  throwsCode(() => store.updateMap(m.id, ada.id, { name: '' }), 'bad-map-name');

  for (let i = 1; i < MAPS_PER_USER; i++) store.saveMap(ada.id, `Map ${i}`, '{}');
  throwsCode(() => store.saveMap(ada.id, 'One too many', '{}'), 'map-limit');
});

test('deleting a user takes their sessions and maps with them', () => {
  const { store } = fresh();
  const ada = store.createUser('Ada', 'h');
  const m = store.saveMap(ada.id, 'Mine', '{}');
  store.createSession(ada.id, 'tok', 60_000);
  store.setRights(ada.id, ['generate-maps']);
  store.deleteUser(ada.id);
  assert.equal(store.getUser(ada.id), null);
  assert.equal(store.getMap(m.id), null);
  assert.equal(store.userForSession('tok'), null);
  assert.equal(store.createUser('Ada', 'h2').rights.length, 0, 'a new Ada starts clean');
});

test('on disk: data and the schema version survive a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-store-'));
  try {
    const path = join(dir, 'nested', 'game.db');
    const first = new SqliteStore(path);
    const ada = first.createUser('Ada', 'h', 'admin');
    first.setRights(ada.id, ['generate-maps']);
    const m = first.saveMap(ada.id, 'Kept', '{"a":1}', 'public');
    first.close();

    const second = new SqliteStore(path);
    assert.equal(second.getUser(ada.id)!.role, 'admin');
    assert.deepEqual(second.getUser(ada.id)!.rights, ['generate-maps']);
    assert.equal(second.getMap(m.id)!.json, '{"a":1}');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generation jobs: the quota counts running and spent runs, not free failures or lost ones', () => {
  const { store, clock } = fresh();
  const ada = store.createUser('Ada', 'h');
  const bob = store.createUser('Bob', 'h');
  const day = 24 * 3600 * 1000;

  store.startGeneration(ada.id, 'g1', 'a pvp map', 'auto');
  assert.equal(store.countGenerationsSince(ada.id, clock.t - day), 1, 'a running job counts');
  store.finishGeneration('g1', { status: 'ok', attempts: 2, tokensIn: 20_000, tokensOut: 3_000 });

  store.startGeneration(ada.id, 'g2', 'refused', 'auto');
  store.finishGeneration('g2', { status: 'failed', attempts: 0, tokensIn: 0, tokensOut: 0, error: 'refusal' });
  store.startGeneration(ada.id, 'g3', 'lost to a restart', 'auto');
  assert.equal(store.interruptRunningGenerations(), 1);
  store.startGeneration(ada.id, 'g4', 'cancelled after spending', 'puzzle');
  store.finishGeneration('g4', { status: 'cancelled', attempts: 1, tokensIn: 9_000, tokensOut: 100 });
  assert.equal(store.countGenerationsSince(ada.id, clock.t - day), 2, 'g1 and g4: the free failure and the interrupted run are not charged');

  store.startGeneration(bob.id, 'g5', 'bob', 'combat');
  store.finishGeneration('g5', { status: 'partial', attempts: 3, tokensIn: 50_000, tokensOut: 5_000 });
  assert.equal(store.countGenerationsSince(bob.id, clock.t - day), 1, 'per user');
  assert.equal(store.tokensUsedSince(clock.t - day), 23_000 + 9_100 + 55_000, 'everyone, for the global ceiling');

  clock.t += 2 * day;
  assert.equal(store.countGenerationsSince(ada.id, clock.t - day), 0, 'a day later the quota is back');
  assert.equal(store.tokensUsedSince(clock.t - day), 0);

  const recent = store.recentGenerations(ada.id, 10);
  assert.deepEqual(recent.map((r) => r.id), ['g4', 'g3', 'g2', 'g1']);
  assert.equal(recent.find((r) => r.id === 'g2')!.error, 'refusal');
  assert.equal(recent.find((r) => r.id === 'g3')!.status, 'interrupted');
});

test('generation jobs go with their user, and the schema upgrades an existing database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'portal-store-'));
  try {
    const path = join(dir, 'game.db');
    const first = new SqliteStore(path);
    const ada = first.createUser('Ada', 'h');
    first.startGeneration(ada.id, 'g1', 'p', 'auto');
    first.deleteUser(ada.id);
    assert.equal(first.tokensUsedSince(0), 0);
    assert.deepEqual(first.recentGenerations(ada.id, 5), []);
    first.close();
    const again = new SqliteStore(path);
    assert.equal(again.interruptRunningGenerations(), 0, 'reopening an up-to-date database changes nothing');
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
