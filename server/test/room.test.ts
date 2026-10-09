/**
 * Rooms over a real WebSocket: the server on a random port, clients using Node's own
 * WebSocket - create, join by code, the host's settings, map checks, errors, host hand-over,
 * and Start building the match.
 *
 *   npm run test:server
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../main';
import { PROTOCOL_VERSION, REJOIN_SECONDS, type ClientMessage, type LobbyState, type ServerMessage } from '../../src/net/protocol';
import { Room, type Conn } from '../../src/room/Room';
import { checkMap } from '../../src/room/mapCheck';
import { blankMap, blankPuzzle } from '../../src/editor/templates';

let server: RunningServer;
const lines: string[] = [];

before(async () => {
  server = await startServer({ port: 0, staticDir: 'no-such-dir', log: (l) => lines.push(l) });
});
after(async () => {
  await server.close();
});

/** A test client: sends messages and waits for the next one of a type. */
class Client {
  private readonly ws: WebSocket;
  private readonly inbox: ServerMessage[] = [];
  private waiters: (() => void)[] = [];
  lobby: LobbyState | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      // Snapshots once a match runs: not what these tests look at.
      if (typeof e.data !== 'string') return;
      const msg = JSON.parse(e.data) as ServerMessage;
      if (msg.type === 'lobby' || msg.type === 'joined') this.lobby = msg.lobby;
      this.inbox.push(msg);
      for (const w of this.waiters.splice(0)) w();
    });
  }

  static async connect(version = PROTOCOL_VERSION): Promise<Client> {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done);
      ws.addEventListener('error', fail);
    });
    const c = new Client(ws);
    c.send({ type: 'hello', version });
    return c;
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** The next message of `type` (skipping others), within 3 s. */
  async next<T extends ServerMessage['type']>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + 3000;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} message (inbox: ${this.inbox.map((m) => m.type).join(', ')})`);
      await new Promise<void>((done) => {
        const t = setTimeout(done, left);
        this.waiters.push(() => {
          clearTimeout(t);
          done();
        });
      });
    }
  }

  /** Waits until the lobby satisfies `ok`. */
  async lobbyWhere(ok: (l: LobbyState) => boolean): Promise<LobbyState> {
    for (;;) {
      if (this.lobby && ok(this.lobby)) return this.lobby;
      await this.next('lobby');
    }
  }

  close(): void {
    this.ws.close();
  }
}

async function roomWithHost(name = 'HOST'): Promise<{ host: Client; code: string }> {
  const host = await Client.connect();
  await host.next('welcome');
  host.send({ type: 'create', name, skin: 'b' });
  const joined = await host.next('joined');
  return { host, code: joined.lobby.code };
}

async function joinRoom(code: string, name: string): Promise<Client> {
  const c = await Client.connect();
  await c.next('welcome');
  c.send({ type: 'join', code: code.toLowerCase(), name, skin: 'c' });
  await c.next('joined');
  return c;
}

test('an old client is told to reload', async () => {
  const c = await Client.connect(PROTOCOL_VERSION - 1);
  const e = await c.next('error');
  assert.equal(e.code, 'version');
  c.close();
});

test('create a room, join it by code, and both see each other', async () => {
  const { host, code } = await roomWithHost('ALICE');
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{5}$/);
  assert.equal(host.lobby!.map.name, 'Highwire');
  assert.equal(host.lobby!.map.slots, 4);
  const guest = await joinRoom(code, '  bob <script> ');
  const seen = await host.lobbyWhere((l) => l.members.length === 2);
  assert.deepEqual(
    seen.members.map((m) => [m.name, m.host]),
    [
      ['ALICE', true],
      ['bob script', false],
    ],
  );
  assert.equal(guest.lobby!.you, seen.members[1].id);
  host.close();
  guest.close();
});

test('a wrong code is refused', async () => {
  const c = await Client.connect();
  await c.next('welcome');
  c.send({ type: 'join', code: 'ZZZZZ', name: 'X', skin: 'a' });
  assert.equal((await c.next('error')).code, 'no-room');
  c.send({ type: 'join', code: 'AEIOU', name: 'X', skin: 'a' });
  assert.equal((await c.next('error')).code, 'no-room');
  c.close();
});

test("the host's bot settings reach everyone; nobody else can change them", async () => {
  const { host, code } = await roomWithHost();
  const guest = await joinRoom(code, 'GUEST');
  host.send({ type: 'setBots', count: 9, difficulty: 'hard' });
  // Clamped to the free slots: 4 spawns, 2 humans.
  const l = await guest.lobbyWhere((x) => x.bots > 0);
  assert.equal(l.bots, 2);
  assert.equal(l.difficulty, 'hard');
  guest.send({ type: 'setBots', count: 0, difficulty: 'easy' });
  assert.equal((await guest.next('error')).code, 'not-host');
  // A third human takes a bot's place.
  const third = await joinRoom(code, 'THIRD');
  assert.equal((await host.lobbyWhere((x) => x.members.length === 3)).bots, 1);
  host.close();
  guest.close();
  third.close();
});

test('a full room is refused', async () => {
  const { host, code } = await roomWithHost();
  const guests = [await joinRoom(code, 'A'), await joinRoom(code, 'B'), await joinRoom(code, 'C')];
  const late = await Client.connect();
  await late.next('welcome');
  late.send({ type: 'join', code, name: 'LATE', skin: 'a' });
  assert.equal((await late.next('error')).code, 'full');
  for (const c of [host, late, ...guests]) c.close();
});

test('maps: a custom combat map is accepted; puzzle, broken and oversized maps are refused', async () => {
  const { host, code } = await roomWithHost();
  host.send({ type: 'setBots', count: 3, difficulty: 'normal' });
  await host.lobbyWhere((l) => l.bots === 3);

  // The blank combat template: one spawn, mirrored by its half-turn symmetry = 2 pads.
  host.send({ type: 'setMap', map: { kind: 'custom', data: blankMap() } });
  const l = await host.lobbyWhere((x) => x.map.builtin === null);
  assert.equal(l.map.name, 'New map');
  assert.equal(l.map.slots, 2);
  assert.equal(l.bots, 1, 'bots clamped to the smaller map');

  host.send({ type: 'setMap', map: { kind: 'custom', data: blankPuzzle() } });
  assert.match((await host.next('error')).message, /Puzzle maps are single-player/);

  const broken = blankMap();
  broken.pieces.push({ type: 'no-such-piece', at: [0, 0, 0] });
  host.send({ type: 'setMap', map: { kind: 'custom', data: broken } });
  assert.match((await host.next('error')).message, /didn't build/);

  const huge = blankMap();
  // Over the map limit, still under the frame limit.
  huge.hint = 'x'.repeat(257 * 1024);
  host.send({ type: 'setMap', map: { kind: 'custom', data: huge } });
  assert.match((await host.next('error')).message, /too big/);

  // Two humans on a two-pad map; a third can't join, and the map can't shrink below them.
  const guest = await joinRoom(code, 'GUEST');
  const late = await Client.connect();
  await late.next('welcome');
  late.send({ type: 'join', code, name: 'LATE', skin: 'a' });
  assert.equal((await late.next('error')).code, 'full');
  host.send({ type: 'setMap', map: { kind: 'builtin', id: 'highwire' } });
  assert.equal((await host.lobbyWhere((x) => x.map.builtin === 'highwire')).map.slots, 4);
  for (const c of [host, guest, late]) c.close();
});

test('when the host leaves, the next player becomes host; the last one out closes the room', async () => {
  const { host, code } = await roomWithHost('FIRST');
  const second = await joinRoom(code, 'SECOND');
  const third = await joinRoom(code, 'THIRD');
  host.close();
  const l = await second.lobbyWhere((x) => x.members.length === 2 && x.members[0].name === 'SECOND');
  assert.deepEqual(
    l.members.map((m) => [m.name, m.host]),
    [
      ['SECOND', true],
      ['THIRD', false],
    ],
  );
  second.send({ type: 'setBots', count: 1, difficulty: 'easy' });
  await third.lobbyWhere((x) => x.bots === 1);
  second.close();
  third.close();
  for (let i = 0; i < 50 && server.rooms.rooms.has(code); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(server.rooms.rooms.has(code), false);
});

test('Start builds the match on the server and tells everyone what to load', async () => {
  const { host, code } = await roomWithHost('HOST');
  host.send({ type: 'start' });
  assert.equal((await host.next('error')).code, 'not-enough', 'alone with no bots');
  const guest = await joinRoom(code, 'GUEST');
  host.send({ type: 'setBots', count: 2, difficulty: 'normal' });
  await guest.lobbyWhere((l) => l.bots === 2);
  guest.send({ type: 'start' });
  assert.equal((await guest.next('error')).code, 'not-host');
  host.send({ type: 'start' });
  const [a, b] = await Promise.all([host.next('matchStart'), guest.next('matchStart')]);
  assert.deepEqual(a.map, { builtin: 'highwire' });
  assert.deepEqual(
    a.roster.map((r) => [r.id, r.name, r.slot, r.bot]),
    [
      ['p1', 'HOST', 0, false],
      ['p2', 'GUEST', 1, false],
      ['p3', 'BOT 1', 2, true],
      ['p4', 'BOT 2', 3, true],
    ],
  );
  assert.equal(a.you, 'p1');
  assert.equal(b.you, 'p2');
  assert.equal(a.rules.scoreToWin, 100);
  assert.equal((await host.lobbyWhere((l) => l.phase === 'loading')).phase, 'loading');
  const room = server.rooms.rooms.get(code)!;
  assert.equal(room.sim?.players.length, 4);
  assert.ok(lines.some((l) => l.includes(`room ${code}: match built on Highwire`)));
  // Joining the match: the last bot makes room.
  const late = await Client.connect();
  await late.next('welcome');
  late.send({ type: 'join', code, name: 'LATE', skin: 'a' });
  const joined = await late.next('matchStart');
  assert.deepEqual(
    joined.roster.map((r) => [r.id, r.name, r.slot]),
    [
      ['p1', 'HOST', 0],
      ['p2', 'GUEST', 1],
      ['p3', 'BOT 1', 2],
      ['p5', 'LATE', 3],
    ],
  );
  // Full of humans now: nobody else gets in.
  const later = await Client.connect();
  await later.next('welcome');
  const fourth = await joinRoom(code, 'FOURTH').catch((e: Error) => e);
  assert.ok(!(fourth instanceof Error), 'one more fits (in place of BOT 1)');
  later.send({ type: 'join', code, name: 'LATER', skin: 'a' });
  assert.equal((await later.next('error')).code, 'full');
  for (const c of [host, guest, late, later, fourth as Client]) c.close();
});

test('a dropped player who never comes back loses their place after the grace; then the room closes', async () => {
  const map = await checkMap({ kind: 'builtin', id: 'highwire' });
  if (typeof map === 'string') throw new Error(map);
  const inbox: ServerMessage[][] = [[], []];
  const conn = (i: number): Conn => ({ send: (m) => inbox[i].push(m), sendBinary: () => {}, close: () => {} });
  const room = new Room('TESTS', map);
  const a = room.add(conn(0), 'ALPHA', 'a');
  const b = room.add(conn(1), 'BRAVO', 'b');
  await room.start(a);
  room.loaded(a);
  room.loaded(b);
  const run = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) room.tick(1 / 60);
  };
  run(4);
  assert.equal(room.phase, 'playing');
  room.drop(b);
  run(REJOIN_SECONDS - 1);
  assert.equal(room.members.length, 2, 'still holding their place');
  assert.ok(room.sim!.playerById('p2'), 'their body too');
  run(2);
  assert.deepEqual(room.members.map((m) => m.name), ['ALPHA'], 'gone after the grace');
  assert.equal(room.sim!.playerById('p2'), undefined);
  assert.ok(room.sim!.match!.player('p2'), 'their row stays on the scoreboard');
  const notices = inbox[0].flatMap((m) => (m.type === 'notice' ? [m.text] : []));
  assert.deepEqual(notices.slice(-2), ['BRAVO LOST CONNECTION', 'BRAVO LEFT']);
  room.drop(a);
  run(REJOIN_SECONDS + 1);
  assert.ok(room.empty, 'nobody left: the manager closes it');
  room.dispose();
});
