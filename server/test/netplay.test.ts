/**
 * Online play end to end, headless: the game server on a random port and two clients that
 * each build their own copy of the arena and run a NetSession against it (prediction,
 * interpolation, hazards caught up), with scripted keyboards. Checks the wire formats on
 * their own first.
 *
 *   npm run test:server
 */
import { after, before, test } from 'node:test';
import * as THREE from 'three';
import assert from 'node:assert/strict';
import { startServer, type RunningServer } from '../main';
import { PROTOCOL_VERSION, BUILT_IN_ONLINE_MAPS, type ClientMessage, type ServerMessage } from '../../src/net/protocol';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { mapToArena } from '../../src/world/maps/MapFormat';
import { IdleCommands, emptyCommand, type PlayerCommand } from '../../src/player/PlayerCommand';
import { NetSession } from '../../src/net/NetSession';
import { quantizeCommand, readInput, writeInput } from '../../src/net/commands';
import { readSnapshot, writeSnapshot, writeWorld } from '../../src/net/snapshot';
import { InputQueue } from '../../src/room/InputQueue';
import { Interpolation } from '../../src/net/Interpolation';
import { BotController } from '../../src/bots/BotController';
import { BOT_SKILLS } from '../../src/bots/BotSkill';
import { DelayLine, type LineQuality } from '../../src/net/DelayLine';
import { Ram } from '../../src/world/hazards/Ram';
import { Trapdoor } from '../../src/world/hazards/Trapdoor';
import type { ArenaPlayer } from '../../src/game/ArenaPlayer';

let server: RunningServer;
const lines: string[] = [];

before(async () => {
  server = await startServer({ port: 0, staticDir: 'no-such-dir', log: (l) => lines.push(l) });
});
after(async () => {
  await server.close();
});

test('commands survive the wire exactly, and the input queue paces them', () => {
  const cmds = [0, 1, 2, 3].map((i) => {
    const c = emptyCommand();
    c.forward = i === 2 ? -1 : 0.37;
    c.right = 1;
    c.jump = i === 1;
    c.yaw = 0.0123456789 * (i + 1);
    c.pitch = -0.002;
    c.fire = i === 3 ? 'blue' : null;
    return { seq: (65534 + i) & 0xffff, cmd: quantizeCommand(c) };
  });
  const back = readInput(writeInput(cmds))!;
  assert.deepEqual(back, cmds, 'quantized commands come back bit for bit, across the seq wrap');
  assert.equal(readInput(new Uint8Array([1, 0, 0, 200])), null, 'a forged count is refused');

  const q = new InputQueue();
  q.push(cmds.slice(0, 2));
  q.push(cmds); // the first two again (redundancy): skipped
  assert.equal(q.queued, 4);
  const out = emptyCommand();
  for (let i = 0; i < 4; i++) q.read(out);
  assert.equal(q.executed, cmds[3].seq);
  assert.equal(out.fire, 'blue');
  assert.equal(q.ready(), false, 'nothing waiting: the player holds still for it');
  for (let i = 0; i < 29; i++) q.ready();
  assert.equal(q.ready(), true, 'half a second later the match goes on without them');
  q.read(out);
  assert.equal(q.idle, 1, 'an idle step');
  assert.equal(out.fire, null, 'an idle step never shoots');
  assert.equal(out.forward, 0, 'or moves');
  q.push([{ seq: (cmds[3].seq + 1) & 0xffff, cmd: cmds[0].cmd }]);
  assert.equal(q.ready(), true);
});

test('the drawing delay follows the connection: short when snapshots come steadily, longer when they bunch up', () => {
  const interp = new Interpolation();
  let tick = 0;
  let step = 0;
  /** `seconds` of game steps; a snapshot is sent every 2nd and arrives `lateBy(n)` steps after it was sent. */
  const run = (seconds: number, lateBy: (n: number) => number) => {
    const inFlight: { at: number; tick: number }[] = [];
    for (let i = 0; i < seconds * 60; i++, step++) {
      if (step % 2 === 0) {
        tick += 2;
        const last = inFlight[inFlight.length - 1];
        // In order, as over TCP: a late one holds up those behind it.
        inFlight.push({ at: Math.max(last?.at ?? 0, step + lateBy(tick / 2)), tick });
      }
      while (inFlight.length > 0 && inFlight[0].at <= step) interp.push(inFlight.shift()!.tick, []);
      interp.advance();
    }
  };
  run(20, () => 0);
  assert.equal(interp.delay, 4, `a steady line: drawn 4 steps behind (${interp.delay})`);
  assert.equal(interp.late, 0);
  // Every 40th snapshot held up 200 ms (a resend over TCP).
  run(6, (n) => (n % 40 === 0 ? 12 : 0));
  assert.ok(interp.delay >= 8, `bunched snapshots: further behind (${interp.delay})`);
  const late = interp.late;
  run(20, () => 0);
  assert.equal(interp.delay, 4, `steady again: back to 4 (${interp.delay})`);
  assert.equal(interp.late, late, 'and nothing late meanwhile');
});

test('a snapshot reads back what the server wrote', async () => {
  const sim = await ArenaSim.load(mapToArena(BUILT_IN_ONLINE_MAPS[0].data), {});
  const players = [0, 1, 2].map((slot) => {
    const bot = new BotController(BOT_SKILLS.hard, slot + 1);
    const p = sim.addPlayer({ id: `p${slot + 1}`, name: `B${slot}` }, bot, null, { slot, local: false });
    bot.attach(sim, p);
    return p;
  });
  const shots = [];
  const sounds = [];
  for (let i = 0; i < 1200; i++) {
    sim.step(1 / 60);
    shots.push(...sim.shots);
    sounds.push(...sim.sounds.filter((s) => s.source !== 'hazard'));
  }
  const data = writeSnapshot(sim, { tick: 1200, you: players[1], ack: 77, idle: 1, queued: 3, hazards: true, world: writeWorld(sim) }, shots.slice(-5), sounds.slice(-5));
  const s = readSnapshot(data);
  assert.equal(s.tick, 1200);
  assert.equal(s.ack, 77);
  assert.equal(s.players.length, 3);
  const own = s.players.find((p) => p.slot === 1)!;
  assert.ok(own.own, 'the full-precision block is for the player it is written for');
  assert.ok(own.position.distanceTo(players[1].controller.getPosition()) < 1e-4);
  const other = s.players.find((p) => p.slot === 0)!;
  assert.equal(other.own, null);
  assert.ok(other.position.distanceTo(players[0].controller.getPosition()) < 0.01, 'remote positions within 1 cm');
  assert.equal(s.portals!.length, 6);
  for (const np of s.portals!) {
    const portal = sim.portalsByNetId.get(np.netId)!;
    assert.equal(np.placement !== null, portal.placed);
    if (np.placement) assert.ok(np.placement.center.distanceTo(portal.surfaceCenter) < 1e-4);
  }
  const states = sim.arena.hazards.filter((h) => h.netState).map((h) => h.netState!());
  assert.deepEqual(s.hazards, states, 'hazard states exactly (whole numbers as bytes, the rest in full)');
  assert.ok(s.hazards!.length >= 7, 'Highwire: rams, spikes, the trapdoor and switches');
  console.log(`snapshot bytes: full ${data.length}`);
  assert.ok(data.length < 1400, `a 3-player snapshot with hazards, 5 shots and 5 sounds is ${data.length} bytes`);
  const lean = writeSnapshot(sim, { tick: 1202, you: players[1], ack: 78, idle: 0, queued: 3, hazards: false, world: null }, [], []);
  const leanRead = readSnapshot(lean);
  assert.equal(leanRead.hazards, null);
  assert.equal(leanRead.portals, null, 'portals and orbs left out');
  assert.equal(leanRead.orbs, null);
  assert.equal(leanRead.players.length, 3);
  console.log(`snapshot bytes: lean ${lean.length}`);
  assert.ok(lean.length < 200, `without hazards, portals, orbs, shots or sounds: ${lean.length} bytes`);
  sim.dispose();
});

/** A player's screen, without the screen: its own arena and a NetSession, over a real WebSocket. */
class HeadlessClient {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  net: NetSession | null = null;
  private waiters: (() => void)[] = [];
  /** A pretend bad connection, each way (off until `badLine`). */
  private incoming = new DelayLine({ lag: 0, jitter: 0, loss: 0 });
  private outgoing = new DelayLine({ lag: 0, jitter: 0, loss: 0 });

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => this.incoming.send(() => this.arrive(e.data)));
  }

  private arrive(data: unknown): void {
    if (typeof data !== 'string') {
      this.net?.receiveBinary(data as ArrayBuffer);
      return;
    }
    const msg = JSON.parse(data) as ServerMessage;
    this.net?.receive(msg);
    this.inbox.push(msg);
    for (const w of this.waiters.splice(0)) w();
  }

  badLine(q: LineQuality): void {
    this.incoming = new DelayLine(q);
    this.outgoing = new DelayLine(q);
  }

  sendBinary(bytes: Uint8Array<ArrayBuffer>): void {
    this.outgoing.send(() => this.ws.readyState === WebSocket.OPEN && this.ws.send(bytes));
  }

  static async connect(): Promise<HeadlessClient> {
    const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
    await new Promise((done, fail) => {
      ws.addEventListener('open', done);
      ws.addEventListener('error', fail);
    });
    const c = new HeadlessClient(ws);
    c.send({ type: 'hello', version: PROTOCOL_VERSION });
    await c.next('welcome');
    return c;
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  async next<T extends ServerMessage['type']>(type: T, ms = 10000): Promise<Extract<ServerMessage, { type: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`no ${type} message`);
      await new Promise<void>((done) => {
        const t = setTimeout(done, left);
        this.waiters.push(() => {
          clearTimeout(t);
          done();
        });
      });
    }
  }

  /** Builds the match it was told to and says it is ready. */
  async load(start: Extract<ServerMessage, { type: 'matchStart' }>): Promise<void> {
    const data = 'builtin' in start.map ? BUILT_IN_ONLINE_MAPS.find((m) => m.id === (start.map as { builtin: string }).builtin)!.data : start.map.custom;
    const sim = await ArenaSim.load(mapToArena(data), start.rules);
    let local = null;
    for (const r of start.roster) {
      const mine = r.id === start.you;
      const p = sim.addPlayer({ id: r.id, name: r.name }, new IdleCommands(), null, { slot: r.slot, local: mine });
      if (mine) local = p;
    }
    this.net = new NetSession(sim, local, (bytes) => this.sendBinary(bytes), { scores: start.scores });
    this.send({ type: 'loaded' });
  }

  close(): void {
    this.net?.close();
    this.net?.sim.dispose();
    this.ws.close();
  }
}

/**
 * Each client's game loop for `seconds` of real time: 60 steps a second, sped up or slowed
 * down by its session's clock sync, like the browser's Loop.
 */
async function runFor(seconds: number, clients: readonly HeadlessClient[], input: (i: number, k: number) => PlayerCommand): Promise<void> {
  const dt = 1 / 60;
  const t0 = performance.now();
  let last = t0;
  const acc = clients.map(() => 0);
  const steps = clients.map(() => 0);
  while (performance.now() - t0 < seconds * 1000) {
    const now = performance.now();
    const frame = (now - last) / 1000;
    last = now;
    clients.forEach((c, k) => {
      acc[k] += frame * c.net!.timeScale;
      while (acc[k] >= dt) {
        c.net!.step(dt, input(steps[k]++, k));
        acc[k] -= dt;
      }
    });
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * Waits (up to 2 s) for `check` to find nothing wrong: the server keeps playing while we
 * look, and so do the clients (standing still).
 */
async function settles(check: () => string[], clients: readonly HeadlessClient[] = []): Promise<string[]> {
  let wrong = check();
  for (let i = 0; i < 40 && wrong.length > 0; i++) {
    await runFor(0.05, clients, () => emptyCommand());
    wrong = check();
  }
  return wrong;
}

/** A scripted keyboard and mouse: wander, turn, jump now and then, and shoot portals. */
function script(i: number, phase: number): PlayerCommand {
  const c = emptyCommand();
  const t = i / 60 + phase;
  c.forward = Math.sin(t * 0.7) > -0.3 ? 1 : 0;
  c.right = Math.sin(t * 1.3) > 0.6 ? 1 : 0;
  c.yaw = Math.sin(t * 0.9) * 0.03;
  c.pitch = Math.sin(t * 0.5) * 0.004;
  c.jump = i % 97 === 0;
  if (i % 151 === 0) c.fire = i % 302 === 0 ? 'orange' : 'blue';
  return c;
}

test('two players and two bots play online: predictions hold, everyone agrees on the match', async () => {
  const host = await HeadlessClient.connect();
  host.send({ type: 'create', name: 'HOST', skin: 'b' });
  const code = (await host.next('joined')).lobby.code;
  const guest = await HeadlessClient.connect();
  guest.send({ type: 'join', code, name: 'GUEST', skin: 'c' });
  await guest.next('joined');
  host.send({ type: 'setBots', count: 2, difficulty: 'normal' });
  await host.next('lobby');
  host.send({ type: 'start' });
  const [a, b] = await Promise.all([host.next('matchStart'), guest.next('matchStart')]);
  await Promise.all([host.load(a), guest.load(b)]);
  await Promise.all([host.next('countdown'), guest.next('countdown')]);

  const clients = [host, guest];
  // Countdown, then 20 s of play.
  const seconds = 23;
  await runFor(seconds, clients, (i, k) => script(i, k * 3.1));

  for (const c of clients) {
    const net = c.net!;
    const st = net.stats;
    const played = seconds - 3;
    const perMinute = (st.corrections / played) * 60;
    const kbIn = st.bytesIn / played / 1024;
    console.log(`client: ${st.snapshots} snapshots, ${st.corrections} corrections (${perMinute.toFixed(1)}/min), ${st.shotMisses} own shots placed differently, ${kbIn.toFixed(1)} KB/s in, ${(st.bytesOut / played / 1024).toFixed(2)} KB/s out, queue ${st.queue.toFixed(1)}, clock ×${st.timeScale.toFixed(3)}, drawn ${st.delay} steps behind, ${st.late} late`);
    for (const w of net.why) console.log(`  ${w}`);
    assert.ok(net.started, 'the match started');
    assert.ok(st.snapshots > played * 25, `about 30 snapshots a second (${st.snapshots})`);
    assert.ok(kbIn < 15, `under 15 KB/s down (${kbIn.toFixed(1)})`);
    // Left: someone else's portal opening under you before you hear of it, bumping into
    // other players, and contact-order differences between the two physics worlds - usually
    // 0-9 a minute, mostly a few centimetres (eased out on screen).
    assert.ok(perMinute < 30, `few corrections at zero latency (${perMinute.toFixed(1)}/min)`);
    // A miss: the spot was nudged round something this screen didn't know of yet (a portal a
    // bot had just opened there) - put right a round trip later. Usually none.
    assert.ok(st.shotMisses <= 2, `your own portals open where the server opens them (${st.shotMisses} misses)`);
    const p = net.local!.controller.getPosition();
    assert.ok(Number.isFinite(p.x + p.y + p.z));
  }
  // Both screens agree with the server: scores, where everyone is (others are drawn
  // ~100 ms in the past: within a few metres), and every portal - who holds it, where it is.
  const room = server.rooms.rooms.get(code)!;
  console.log('server inputs:', JSON.stringify(room.inputStats()));
  const wrong = await settles(() => {
    const out: string[] = [];
    const truth = room.sim!.match!.players.map((p) => p.score).join('/');
    for (const [k, c] of clients.entries()) {
      const seen = c.net!.sim.match!.players.map((p) => p.score).join('/');
      if (seen !== truth) out.push(`client ${k} scores ${seen}, server ${truth}`);
      for (const p of room.sim!.players) {
        const mine = c.net!.sim.playerById(p.id)!;
        // (This client stopped sending commands: the server walks its player on meanwhile.)
        if (p.dead || mine.dead || mine === c.net!.local) continue;
        const d = mine.controller.getPosition().distanceTo(p.controller.getPosition());
        if (d > 3) out.push(`client ${k} draws ${p.id} ${d.toFixed(2)} m off`);
      }
      for (const [id, portal] of room.sim!.portalsByNetId) {
        const mine = c.net!.sim.portalsByNetId.get(id)!;
        if (mine.placed !== portal.placed) out.push(`client ${k}: portal ${id} ${portal.placed ? 'not open' : 'still open'}`);
        else if (portal.placed && mine.surfaceCenter.distanceTo(portal.surfaceCenter) > 1e-3) out.push(`client ${k}: portal ${id} elsewhere`);
        if (mine.owner !== portal.owner) out.push(`client ${k}: portal ${id} held by ${mine.owner}, not ${portal.owner}`);
      }
    }
    return out;
  }, clients);
  assert.deepEqual(wrong, [], 'every screen agrees with the server');
  host.close();
  guest.close();
});

test('over a bad connection (150 ms, ±30 ms, 2% held back) predictions still hold', async () => {
  const c = await HeadlessClient.connect();
  c.send({ type: 'create', name: 'LAGGY', skin: 'b' });
  const code = (await c.next('joined')).lobby.code;
  c.send({ type: 'setBots', count: 3, difficulty: 'normal' });
  await c.next('lobby');
  c.send({ type: 'start' });
  await c.load(await c.next('matchStart'));
  await c.next('countdown');
  c.badLine({ lag: 150, jitter: 30, loss: 2 });
  const seconds = 23;
  await runFor(seconds, [c], (i) => script(i, 1.7));
  const st = c.net!.stats;
  const perMinute = (st.corrections / (seconds - 3)) * 60;
  console.log(`bad line: ${st.corrections} corrections (${perMinute.toFixed(1)}/min), queue ${st.queue.toFixed(1)}, clock ×${st.timeScale.toFixed(3)}, drawn ${st.delay} steps behind, ${st.late} late`);
  for (const w of c.net!.why) console.log(`  ${w}`);
  const room = server.rooms.rooms.get(code)!;
  console.log('server inputs:', JSON.stringify(room.inputStats()));
  assert.ok(perMinute < 30, `under a correction every 2 s (${perMinute.toFixed(1)}/min)`);
  c.close();
});

/** Puts `p` somewhere on the server, alive and standing still (a respawn, as far as their screen can tell). */
function teleport(room: { sim: ArenaSim | null }, p: ArenaPlayer, at: THREE.Vector3, yaw = 0): void {
  room.sim!.respawnPlayer(p);
  p.controller.respawn(at, yaw);
  room.sim!.system.resync(p.controller);
}

test('switch effects and hazards: gravity, a ram and a trapdoor hit you on your screen as on the server', async () => {
  const c = await HeadlessClient.connect();
  c.send({ type: 'create', name: 'SOLO', skin: 'b' });
  const code = (await c.next('joined')).lobby.code;
  c.send({ type: 'setBots', count: 1, difficulty: 'easy' });
  await c.next('lobby');
  c.send({ type: 'start' });
  await c.load(await c.next('matchStart'));
  await c.next('countdown');
  const room = server.rooms.rooms.get(code)!;
  const sim = room.sim!;
  const me = sim.playerById(c.net!.local!.id)!;
  const idle = () => emptyCommand();
  await runFor(4, [c], (i) => script(i, 0.4));
  const fixes = () => c.net!.stats.corrections;

  // Heavy gravity for 3 s (as the blue switch does), while running and jumping.
  let before = fixes();
  let heaviest = 1;
  sim.setGravity(1.8, 3);
  await runFor(5, [c], (i) => {
    heaviest = Math.max(heaviest, c.net!.sim.gravity.factor);
    return script(i, 0.4);
  });
  console.log(`gravity: ${fixes() - before} corrections, client saw ×${heaviest}`);
  assert.equal(heaviest, 1.8, 'the client felt it');
  assert.equal(c.net!.sim.gravity.factor, 1, 'and it ran out');
  assert.ok(fixes() - before <= 1, `heavy gravity coming and going is predicted (${fixes() - before} corrections)`);

  // In front of a ram on the high walkway, standing still until it throws us off.
  const ram = sim.arena.hazards.find((h) => h instanceof Ram && (h as unknown as { reach: number }).reach > 5) as unknown as { mount: THREE.Vector3; facing: THREE.Vector3; phase: string };
  // (Not while its head is out: that would crush us.)
  while (ram.phase !== 'rest') await runFor(0.1, [c], idle);
  before = fixes();
  teleport(room, me, ram.mount.clone().addScaledVector(ram.facing, 1.2).setY(16 + 1.02));
  let thrown = 0;
  await runFor(7, [c], () => {
    thrown = Math.max(thrown, Math.hypot(me.controller.getVelocity().x, me.controller.getVelocity().z));
    return idle();
  });
  console.log(`ram: ${fixes() - before} corrections, thrown at ${thrown.toFixed(1)} m/s`);
  assert.ok(thrown > 5, 'the ram threw us');
  assert.ok(fixes() - before <= 1, `the ram's shove is predicted (${fixes() - before} corrections)`);

  // On the trapdoor when its switch is shot.
  const trap = sim.arena.hazards.find((h) => h instanceof Trapdoor)!;
  teleport(room, me, new THREE.Vector3(20, 8 + 1.02, 16));
  await runFor(1, [c], idle);
  before = fixes();
  let lowest = Infinity;
  (trap as Trapdoor).trigger();
  sim.hazardsTouched = true;
  await runFor(4, [c], () => {
    lowest = Math.min(lowest, me.controller.getPosition().y);
    return idle();
  });
  console.log(`trapdoor: ${fixes() - before} corrections, fell to ${lowest.toFixed(1)}`);
  assert.ok(lowest < 6, 'it dropped us');
  assert.ok(fixes() - before <= 1, `the drop is predicted (${fixes() - before} corrections)`);
  for (const w of c.net!.why) console.log(`  ${w}`);
  c.close();
});

test('crates are drawn smoothly a little in the past, through portals, and come to rest where the server has them', async () => {
  // Highwire with a crate on the spawn ledge.
  const data = structuredClone(BUILT_IN_ONLINE_MAPS[0].data);
  data.name = 'Highwire + crate';
  data.pieces.push({ type: 'crate', at: [8, 9, 37] } as (typeof data.pieces)[number]);
  const c = await HeadlessClient.connect();
  c.send({ type: 'create', name: 'CRATES', skin: 'b' });
  const code = (await c.next('joined')).lobby.code;
  c.send({ type: 'setMap', map: { kind: 'custom', data } });
  await c.next('lobby');
  c.send({ type: 'setBots', count: 1, difficulty: 'easy' });
  await c.next('lobby');
  c.send({ type: 'start' });
  await c.load(await c.next('matchStart'));
  await c.next('countdown');
  const room = server.rooms.rooms.get(code)!;
  const sim = room.sim!;
  const me = sim.playerById(c.net!.local!.id)!;
  const crate = sim.arena.props[0];
  const drawn = c.net!.sim.arena.props[0];
  // During the countdown (the arena holds still): a floor portal under the crate and its
  // partner in the free-standing portal wall. At GO it drops through and comes out the wall.
  const orange = me.gun.fire('orange', new THREE.Vector3(8, 14, 37), new THREE.Vector3(0, -1, 0));
  const blue = me.gun.fire('blue', new THREE.Vector3(-8, 3, 28), new THREE.Vector3(0, 0, -1));
  assert.ok(orange.placed && blue.placed, 'portals placed on the server');
  let through = false;
  let jumps = 0;
  let last = drawn.getPosition();
  await runFor(7, [c], () => {
    through ||= drawn.passing !== null;
    const now = drawn.getPosition();
    if (now.distanceTo(last) > 0.6) jumps++;
    last = now;
    return emptyCommand();
  });
  const trips = sim.system.teleportCount(crate);
  const off = drawn.getPosition().distanceTo(crate.getPosition());
  console.log(`crate: ${trips} trips on the server; drawn passing ${through}, ${jumps} jumps, ${off.toFixed(4)} m off at rest`);
  assert.ok(trips >= 1, 'it went through on the server');
  assert.ok(through, 'drawn halfway through the portal (the far-side copy shows)');
  assert.ok(jumps <= trips, `no jumps but the portal trip (${jumps})`);
  assert.ok(off < 0.01, `at rest where the server has it (${off.toFixed(4)} m)`);
  c.close();
});

/** Scoreboards as `name score` lists. */
const board = (sim: ArenaSim) => sim.match!.players.map((p) => `${p.name} ${p.score}`).join(', ');

test('a friend joins a full match in progress: a bot makes room, and everyone sees them', async () => {
  const host = await HeadlessClient.connect();
  host.send({ type: 'create', name: 'HOST', skin: 'b' });
  const code = (await host.next('joined')).lobby.code;
  host.send({ type: 'setBots', count: 3, difficulty: 'easy' });
  await host.next('lobby');
  host.send({ type: 'start' });
  await host.load(await host.next('matchStart'));
  await host.next('countdown');
  await runFor(4, [host], (i) => script(i, 0.2));
  const room = server.rooms.rooms.get(code)!;
  (room.sim!.match!.player('p4')!).score = 25;
  await runFor(0.5, [host], (i) => script(i, 0.2));

  const guest = await HeadlessClient.connect();
  guest.send({ type: 'join', code, name: 'LATE', skin: 'c' });
  await guest.next('joined');
  const start = await guest.next('matchStart');
  assert.deepEqual(start.roster.map((r) => r.name), ['HOST', 'BOT 1', 'BOT 2', 'LATE'], 'the last bot made room');
  assert.equal(start.you, 'p5', 'a new player id (the bot keeps its row on the scoreboard)');
  await guest.load(start);
  await guest.next('go');
  const joined = await host.next('playerJoined');
  assert.equal(joined.player.name, 'LATE');
  await runFor(3, [host, guest], (i, k) => script(i, k * 2.3));
  const truth = board(room.sim!);
  assert.equal(board(host.net!.sim), truth, 'the host sees the same scoreboard');
  assert.equal(board(guest.net!.sim), truth, 'and so does the newcomer (BOT 3 and its 25 points included)');
  assert.ok(truth.includes('BOT 3 25'));
  assert.deepEqual(
    host.net!.sim.players.map((p) => p.name).sort(),
    ['BOT 1', 'BOT 2', 'HOST', 'LATE'],
    "the host's arena has the newcomer in it, and BOT 3 gone",
  );
  host.close();
  guest.close();
});

test('a dropped connection keeps your place: back within the grace, same player, same score', async () => {
  const a = await HeadlessClient.connect();
  a.send({ type: 'create', name: 'FLAKY', skin: 'b' });
  const joined = await a.next('joined');
  const code = joined.lobby.code;
  a.send({ type: 'setBots', count: 1, difficulty: 'easy' });
  await a.next('lobby');
  a.send({ type: 'start' });
  const first = await a.next('matchStart');
  await a.load(first);
  await a.next('countdown');
  await runFor(4, [a], (i) => script(i, 0.9));
  const room = server.rooms.rooms.get(code)!;
  const me = room.sim!.playerById(first.you!)!;
  room.sim!.match!.player(first.you!)!.score = 35;

  // The connection drops: the player holds still on the server, out of reach.
  a.close();
  for (let i = 0; i < 50 && room.members[0].awayFor < 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(room.members[0].awayFor >= 0, 'marked away, not gone');
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(me.waiting, 'held: nothing moves or hurts them meanwhile');
  assert.equal(server.rooms.rooms.has(code), true, 'the room stays open for them');

  const b = await HeadlessClient.connect();
  b.send({ type: 'join', code, name: 'FLAKY', skin: 'b', token: joined.token });
  await b.next('joined');
  const again = await b.next('matchStart');
  assert.equal(again.you, first.you, 'the same player');
  await b.load(again);
  await b.next('go');
  await runFor(3, [b], (i) => script(i, 0.9));
  assert.equal(room.sim!.playerById(first.you!), me, 'the same body on the server');
  assert.equal(b.net!.sim.match!.player(first.you!)!.score, room.sim!.match!.player(first.you!)!.score);
  assert.ok(room.sim!.match!.player(first.you!)!.score >= 35, 'the score kept');
  assert.ok(!me.waiting, 'playing again');
  assert.ok(b.net!.stats.snapshots > 60);
  b.close();
});

test('after the win the room goes back to its lobby, and the host can start a rematch', async () => {
  const c = await HeadlessClient.connect();
  c.send({ type: 'create', name: 'CHAMP', skin: 'b' });
  const code = (await c.next('joined')).lobby.code;
  c.send({ type: 'setBots', count: 1, difficulty: 'easy' });
  await c.next('lobby');
  c.send({ type: 'start' });
  const first = await c.next('matchStart');
  await c.load(first);
  await c.next('countdown');
  await runFor(4, [c], (i) => script(i, 0.3));
  const room = server.rooms.rooms.get(code)!;
  // Points straight to the winning score.
  c.inbox.length = 0;
  (room.sim as unknown as { score(id: string, points: number, reason: string): void }).score(first.you!, 100, 'orb');
  await runFor(0.5, [c], () => emptyCommand());
  assert.equal(room.phase, 'finished');
  assert.equal(c.net!.sim.match!.winner?.id, first.you, 'the win reached the client');
  const lobby = await c.next('lobby', 12000).then(async function until(l): Promise<typeof l> {
    return l.lobby.phase === 'lobby' ? l : until(await c.next('lobby', 12000));
  });
  assert.equal(lobby.lobby.phase, 'lobby', 'back in the lobby');
  assert.equal(lobby.lobby.bots, 1, 'with the same settings');
  assert.ok(room.sim === null, 'the old match is gone');
  c.net!.close();
  c.net!.sim.dispose();
  c.net = null;
  c.send({ type: 'start' });
  const rematch = await c.next('matchStart');
  assert.deepEqual(rematch.scores.map((r) => r.score), [0, 0], 'a fresh scoreboard');
  c.close();
});

// A whole match, two humans and two bots to the winning score (a minute or two): `FULL=1 npm run test:server`.
test('a whole online match: two players and two bots play to the end, and everyone sees the same result', { skip: !process.env.FULL }, async () => {
  const host = await HeadlessClient.connect();
  host.send({ type: 'create', name: 'HOST', skin: 'b' });
  const code = (await host.next('joined')).lobby.code;
  const guest = await HeadlessClient.connect();
  guest.send({ type: 'join', code, name: 'GUEST', skin: 'c' });
  await guest.next('joined');
  host.send({ type: 'setBots', count: 2, difficulty: 'hard' });
  await host.next('lobby');
  host.send({ type: 'start' });
  const [a, b] = await Promise.all([host.next('matchStart'), guest.next('matchStart')]);
  await Promise.all([host.load(a), guest.load(b)]);
  await Promise.all([host.next('countdown'), guest.next('countdown')]);
  const clients = [host, guest];
  const room = server.rooms.rooms.get(code)!;
  const t0 = performance.now();
  for (let chunk = 0; chunk < 30 && room.phase !== 'finished'; chunk++) await runFor(10, clients, (i, k) => script(i, k * 3.1));
  await runFor(1, clients, (i, k) => script(i, k * 3.1));
  const winner = room.sim!.match!.winner;
  assert.ok(winner, 'someone won');
  const truth = room.sim!.match!.players.map((p) => `${p.name} ${p.score}`).join(', ');
  console.log(`full match in ${((performance.now() - t0) / 1000).toFixed(0)} s: ${truth} - ${winner.name} won`);
  for (const c of clients) {
    const net = c.net!;
    assert.equal(net.sim.match!.players.map((p) => `${p.name} ${p.score}`).join(', '), truth, 'the same scoreboard');
    assert.equal(net.sim.match!.winner?.id, winner.id, 'the same winner');
    assert.ok(net.events.some((e) => e.type === 'win'), 'the win was announced');
    console.log(`  client: ${net.stats.corrections} corrections, ${(net.stats.bytesIn / net.sim.time / 1024).toFixed(1)} KB/s`);
  }
  host.close();
  guest.close();
});
