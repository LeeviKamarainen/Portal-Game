import { ArenaSim } from '../sim/ArenaSim';
import { mapToArena } from '../world/maps/MapFormat';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS } from '../bots/BotSkill';
import {
  COUNTDOWN_SECONDS,
  REJOIN_SECONDS,
  RESULTS_SECONDS,
  SNAPSHOT_EVERY,
  type BotDifficulty,
  type ErrorCode,
  type LobbyState,
  type RoomPhase,
  type RosterEntry,
  type ServerMessage,
} from '../net/protocol';
import { readInput } from '../net/commands';
import { sameBytes, writeSnapshot, writeWorld } from '../net/snapshot';
import type { SessionEvent, SimShot, SimSound } from '../sim/SimEvents';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import { InputQueue } from './InputQueue';
import type { CheckedMap } from './mapCheck';

/** One connected client, whatever carries it (a WebSocket on the server, a loopback in tests). */
export interface Conn {
  send(msg: ServerMessage): void;
  /** Per-step messages (snapshots). */
  sendBinary(data: Uint8Array): void;
  close(): void;
  /** The account behind the connection, when the client logged in; guests have none. */
  readonly user?: { id: number; name: string };
}

/** A human's place in the match: their player and the commands waiting for it. */
interface Seat {
  /** Their player id in the match (and on the scoreboard). */
  id: string;
  slot: number;
  /** Their body: from the start for those who started the match, once loaded for anyone joining later. */
  player: ArenaPlayer | null;
  queue: InputQueue;
  /** Coming back after a dropped connection (everyone hears so once they have loaded). */
  back?: boolean;
}

/** A bot in the match. */
interface BotSeat {
  id: string;
  name: string;
  skin: string;
  slot: number;
}

/** The match starts this long after Start even if someone never finishes loading (s). */
const LOAD_TIMEOUT = 20;
/** A player's shot sounds travel as the shot itself (each screen plays them from it). */
const SHOT_SOUNDS: ReadonlySet<string> = new Set(['shootOrange', 'shootBlue', 'portalOpen', 'fizzle']);
/** Your own portal trips are already heard on your screen: they aren't sent back to you. */
const HEARD_LOCALLY: ReadonlySet<string> = new Set(['teleport']);
/** Hazards run on every screen by themselves, exactly as here: their state goes out every this many snapshots (and straight after a switch). */
const HAZARDS_EVERY = 15;
/**
 * Portals and orbs go out in this many snapshots in a row after they change (one lost on
 * the way is made up by the next), and with the hazards otherwise.
 */
const WORLD_REPEAT = 4;
/** Steps after loading the match during which a player gets everything in every snapshot. */
const FRESH_STEPS = 30;

export interface Member {
  readonly id: string;
  /** Their connection (a new one when they come back after losing it). */
  conn: Conn;
  readonly name: string;
  readonly skin: string;
  /** Proof of identity for coming back after a dropped connection. */
  readonly token: string;
  /** Seconds since their connection dropped mid-match, or -1 while connected. */
  awayFor: number;
  /** Until this room step (just after they loaded the match) their snapshots carry everything. */
  freshUntil: number;
}

/** Thrown by room operations a client isn't allowed to do; the manager reports it to them. */
export class RoomError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

let nextMember = 1;
const newToken = (): string => globalThis.crypto.randomUUID();
/** Bots get characters from the far end of the pack, so they rarely look like a human player. */
const BOT_SKINS = 'rqponm';

/**
 * A room: the lobby where friends gather (humans, bots to fill in, the map, the host's
 * Start) and then the match they play. Friends can join a match in progress (a bot makes
 * room if it is full), someone whose connection drops keeps their place for a while, and
 * once a match is won the room goes back to its lobby for a rematch. Plain TypeScript with
 * no networking of its own, so it runs on the game server and, for tests, inside a page.
 */
export class Room {
  readonly code: string;
  phase: RoomPhase = 'lobby';
  /** Humans in join order; the first is the host. */
  readonly members: Member[] = [];
  bots = 0;
  difficulty: BotDifficulty = 'normal';
  map: CheckedMap;
  /** The match, once started. */
  sim: ArenaSim | null = null;
  /** Steps since the countdown began (snapshots are numbered by it). */
  step = 0;
  /** Bytes of snapshots sent, for the server's log. */
  bytesOut = 0;
  private readonly log: (line: string) => void;
  private readonly seats = new Map<Member, Seat>();
  private matchBots: BotSeat[] = [];
  /** Still loading the match. */
  private readonly loading = new Set<Member>();
  private phaseTime = 0;
  /** Player ids are never reused within a match (the scoreboard keeps everyone who played). */
  private nextPlayer = 1;
  private shots: SimShot[] = [];
  private sounds: SimSound[] = [];
  private events: SessionEvent[] = [];
  /** The portals and orbs as last written, and the step they last changed on. */
  private world: Uint8Array | null = null;
  private worldChanged = 0;

  constructor(code: string, map: CheckedMap, log: (line: string) => void = () => {}) {
    this.code = code;
    this.map = map;
    this.log = log;
  }

  get host(): Member | undefined {
    return this.members[0];
  }

  get empty(): boolean {
    return this.members.length === 0;
  }

  /** A match is being loaded or played (not yet won). */
  private get inMatch(): boolean {
    return this.phase === 'loading' || this.phase === 'countdown' || this.phase === 'playing';
  }

  member(id: string): Member | undefined {
    return this.members.find((m) => m.id === id);
  }

  /** The member holding `token`, if any (someone coming back). */
  memberByToken(token: unknown): Member | undefined {
    return typeof token === 'string' && token ? this.members.find((m) => m.token === token) : undefined;
  }

  /**
   * Someone new. In the lobby (or while a result is up) they wait for the next match; during
   * a match they get a free slot - a bot makes room if there is none - and load it.
   */
  add(conn: Conn, name: string, skin: string): Member {
    if (this.members.length >= this.map.slots) throw new RoomError('full', `The room is full (${this.map.slots} players).`);
    const m: Member = { id: `m${nextMember++}`, conn, name, skin, token: newToken(), awayFor: -1, freshUntil: 0 };
    if (this.inMatch) {
      let slot = this.freeSlot();
      if (slot < 0) {
        const bot = this.matchBots.pop()!;
        this.sim!.removePlayer(bot.id);
        slot = bot.slot;
        this.log(`room ${this.code}: ${bot.name} made room for ${name}`);
      }
      const queue = new InputQueue();
      this.seats.set(m, { id: `p${this.nextPlayer++}`, slot, player: null, queue });
      if (this.phase === 'loading') this.loading.add(m);
    }
    this.members.push(m);
    // A bot steps aside for every friend who turns up.
    this.bots = Math.min(this.bots, this.map.slots - this.members.length);
    this.log(`room ${this.code}: ${name} joined (${this.members.length} in the room)`);
    return m;
  }

  /** The lowest match slot nobody holds, or -1. */
  private freeSlot(): number {
    for (let slot = 0; slot < this.map.slots; slot++) {
      if (![...this.seats.values()].some((s) => s.slot === slot) && !this.matchBots.some((b) => b.slot === slot)) return slot;
    }
    return -1;
  }

  /**
   * After `m` has been told they are in the room: what to load, if a match is under way
   * (someone joining it, or coming back to it).
   */
  welcome(m: Member): void {
    const seat = this.seats.get(m);
    if (!seat || !this.inMatch || !this.sim) return;
    const map = this.map.builtin ? { builtin: this.map.builtin } : { custom: this.map.data };
    const scores = this.sim.match!.players.map((p) => ({ id: p.id, name: p.name, score: p.score }));
    m.conn.send({ type: 'matchStart', mode: 'combat', map, roster: this.rosterFor(m), you: seat.id, rules: this.sim.match!.rules, scores });
  }

  /** Everyone in the match with a body, plus `m` themselves (about to load it), by slot. */
  private rosterFor(m: Member | null): RosterEntry[] {
    const roster: RosterEntry[] = [];
    for (const [member, seat] of this.seats) {
      if (seat.player || member === m) roster.push({ id: seat.id, name: member.name, skin: member.skin, slot: seat.slot, bot: false });
    }
    for (const b of this.matchBots) roster.push({ id: b.id, name: b.name, skin: b.skin, slot: b.slot, bot: true });
    return roster.sort((a, b) => a.slot - b.slot);
  }

  /**
   * `m`'s connection dropped. In the lobby they are gone; during a match their player holds
   * still, out of reach, for REJOIN_SECONDS in case they come back.
   */
  drop(m: Member): void {
    if (!this.members.includes(m)) return;
    if (this.phase === 'lobby' || this.phase === 'finished') {
      this.remove(m);
      return;
    }
    m.awayFor = 0;
    const seat = this.seats.get(m);
    if (seat) seat.queue.paused = true;
    if (this.loading.delete(m) && this.phase === 'loading' && this.loading.size === 0) this.beginCountdown();
    this.notice(`${m.name} LOST CONNECTION`);
    this.log(`room ${this.code}: ${m.name} lost connection (${REJOIN_SECONDS} s to come back)`);
  }

  /** `m` is back on a new connection (see `drop`); `welcome` them next. */
  rejoin(m: Member, conn: Conn): void {
    const old = m.conn;
    m.conn = conn;
    if (old !== conn) old.close();
    const wasAway = m.awayFor >= 0;
    m.awayFor = -1;
    const seat = this.seats.get(m);
    if (seat && this.phase === 'loading') this.loading.add(m);
    if (seat && wasAway) seat.back = true;
    if (wasAway) this.log(`room ${this.code}: ${m.name} is back`);
  }

  /** Someone left for good; the next person in line becomes host if it was the host. */
  remove(m: Member): void {
    const i = this.members.indexOf(m);
    if (i < 0) return;
    this.members.splice(i, 1);
    // Their body leaves the match (the scoreboard keeps their row).
    const seat = this.seats.get(m);
    if (seat?.player) this.sim?.removePlayer(seat.id);
    this.seats.delete(m);
    this.loading.delete(m);
    if (this.phase === 'loading' && this.loading.size === 0 && !this.empty) this.beginCountdown();
    if (seat && this.inMatch) this.notice(`${m.name} LEFT`);
    this.log(`room ${this.code}: ${m.name} left${i === 0 && this.host ? `, ${this.host.name} is host now` : ''}`);
  }

  private requireHost(m: Member): void {
    if (m !== this.host) throw new RoomError('not-host', 'Only the host can change that.');
    if (this.phase !== 'lobby') throw new RoomError('in-progress', 'The match has already started.');
  }

  setMap(m: Member, map: CheckedMap): void {
    this.requireHost(m);
    if (this.members.length > map.slots) {
      throw new RoomError('too-many', `${map.name} has room for ${map.slots} players; there are ${this.members.length} in the room.`);
    }
    this.map = map;
    this.bots = Math.min(this.bots, map.slots - this.members.length);
  }

  setBots(m: Member, count: number, difficulty: BotDifficulty): void {
    this.requireHost(m);
    this.bots = Math.max(0, Math.min(Math.floor(count), this.map.slots - this.members.length));
    this.difficulty = difficulty;
  }

  /**
   * The host starts the match: the arena is built on the server with everyone in it -
   * humans in join order, then the bots - and every client is told what to load.
   */
  async start(m: Member): Promise<void> {
    this.requireHost(m);
    if (this.members.length + this.bots < 2) throw new RoomError('not-enough', 'A match needs at least two players: add a bot or wait for a friend.');
    this.phase = 'loading';
    const t0 = performance.now();
    let sim: ArenaSim;
    try {
      sim = await ArenaSim.load(mapToArena(this.map.data), {});
    } catch (e) {
      this.phase = 'lobby';
      throw new RoomError('bad-map', `The map didn't build: ${(e as Error).message}`);
    }
    // Everyone may have left while it built.
    if (this.empty) {
      sim.dispose();
      return;
    }
    this.seats.clear();
    this.loading.clear();
    this.matchBots = [];
    this.members.forEach((member, slot) => {
      const id = `p${slot + 1}`;
      const queue = new InputQueue();
      const player = sim.addPlayer({ id, name: member.name }, queue, null, { slot, local: false });
      this.seats.set(member, { id, slot, player, queue });
      this.loading.add(member);
    });
    for (let i = 0; i < this.bots; i++) {
      const slot = this.members.length + i;
      const id = `p${slot + 1}`;
      const name = this.bots === 1 ? 'BOT' : `BOT ${i + 1}`;
      const bot = new BotController(BOT_SKILLS[this.difficulty]);
      bot.attach(sim, sim.addPlayer({ id, name }, bot, null, { slot, local: false }));
      this.matchBots.push({ id, name, skin: BOT_SKINS[i % BOT_SKINS.length], slot });
    }
    this.nextPlayer = this.members.length + this.bots + 1;
    this.sim = sim;
    this.step = 0;
    this.world = null;
    this.phaseTime = 0;
    sim.onNotice = (text, seconds) => this.notice(text, seconds);
    this.log(
      `room ${this.code}: match built on ${this.map.name} in ${(performance.now() - t0).toFixed(0)} ms ` +
        `(${this.members.length} human${this.members.length === 1 ? '' : 's'}, ${this.bots} ${this.difficulty} bot${this.bots === 1 ? '' : 's'})`,
    );
    for (const member of this.members) this.welcome(member);
    this.broadcast();
  }

  /** How each human's commands have been arriving: steps without one, and ones dropped for crowding. */
  inputStats(): { name: string; starved: number; dropped: number; held: number }[] {
    return [...this.seats].map(([m, seat]) => ({ name: m.name, starved: seat.queue.starved, dropped: seat.queue.dropped, held: seat.queue.held }));
  }

  /**
   * `m`'s screen has the match loaded. At the start that counts toward the countdown; anyone
   * joining later (or coming back) steps in now - a newcomer gets their body - and is told
   * how long the countdown has left, or to go.
   */
  loaded(m: Member): void {
    const seat = this.seats.get(m);
    if (!seat || !this.sim || !this.inMatch) return;
    // Their commands count from the first again (a new screen starts from scratch).
    seat.queue = new InputQueue();
    m.freshUntil = this.step + FRESH_STEPS;
    if (seat.player) {
      seat.player.controller.commands = seat.queue;
      if (seat.back) this.notice(`${m.name} IS BACK`);
      seat.back = false;
    } else {
      seat.player = this.sim.addPlayer({ id: seat.id, name: m.name }, seat.queue, null, { slot: seat.slot, local: false });
      this.sim.respawnPlayer(seat.player);
      const entry = this.rosterFor(m).find((r) => r.id === seat.id)!;
      for (const other of this.members) if (other !== m && other.awayFor < 0) other.conn.send({ type: 'playerJoined', player: entry });
      this.notice(`${m.name} JOINED`);
      this.broadcast();
    }
    if (this.phase === 'loading') {
      if (this.loading.delete(m) && this.loading.size === 0) this.beginCountdown();
    } else if (this.phase === 'countdown') {
      m.conn.send({ type: 'countdown', seconds: COUNTDOWN_SECONDS - this.phaseTime });
    } else {
      m.conn.send({ type: 'go' });
    }
  }

  private beginCountdown(): void {
    this.phase = 'countdown';
    this.phaseTime = 0;
    this.loading.clear();
    for (const m of this.members) if (m.awayFor < 0) m.conn.send({ type: 'countdown', seconds: COUNTDOWN_SECONDS });
    this.broadcast();
  }

  /** An arena-wide line on everyone's HUD. */
  private notice(text: string, seconds = 2.5): void {
    for (const m of this.members) if (m.awayFor < 0) m.conn.send({ type: 'notice', text, seconds });
  }

  /** An input message from `m` (unchecked bytes). */
  input(m: Member, data: Uint8Array): void {
    const seat = this.seats.get(m);
    const commands = seat ? readInput(data) : null;
    if (seat && commands) seat.queue.push(commands);
  }

  /**
   * One step for the whole room (the server's tick loop calls every room): the match, and
   * the clocks on people who lost their connection and on the result. May leave the room
   * empty (everyone gone for good).
   */
  tick(dt: number): void {
    let left = false;
    for (const m of [...this.members]) {
      if (m.awayFor < 0) continue;
      m.awayFor += dt;
      if (m.awayFor < REJOIN_SECONDS) continue;
      this.remove(m);
      left = true;
    }
    if (left) this.broadcast();
    const sim = this.sim;
    if (!sim || this.phase === 'lobby') return;
    this.phaseTime += dt;
    if (this.phase === 'loading') {
      if (this.phaseTime >= LOAD_TIMEOUT) this.beginCountdown();
      return;
    }
    if (this.phase === 'finished' && this.phaseTime >= RESULTS_SECONDS) {
      this.backToLobby();
      return;
    }
    if (this.phase === 'countdown' && this.phaseTime >= COUNTDOWN_SECONDS) {
      this.phase = 'playing';
      this.phaseTime = 0;
      for (const m of this.members) if (m.awayFor < 0) m.conn.send({ type: 'go' });
      this.broadcast();
    }
    this.step++;
    if (this.phase !== 'countdown') {
      sim.step(dt);
      this.shots.push(...sim.shots);
      this.sounds.push(...sim.sounds.filter((s) => s.source !== 'hazard' && !(s.source && SHOT_SOUNDS.has(s.name))));
      for (const e of sim.events.splice(0)) {
        this.events.push(e);
        if (e.type === 'win') {
          this.phase = 'finished';
          this.phaseTime = 0;
          this.log(`room ${this.code}: ${sim.match?.player(e.player)?.name ?? e.player} won`);
        }
      }
    }
    if (this.step % SNAPSHOT_EVERY === 0) this.sendSnapshots();
  }

  /** The result has been up long enough: the match goes, and everyone is back in the lobby for another. */
  private backToLobby(): void {
    for (const m of this.members.filter((x) => x.awayFor >= 0)) this.remove(m);
    this.sim?.dispose();
    this.sim = null;
    this.seats.clear();
    this.loading.clear();
    this.matchBots = [];
    this.phase = 'lobby';
    this.phaseTime = 0;
    this.bots = Math.min(this.bots, this.map.slots - this.members.length);
    this.log(`room ${this.code}: back to the lobby`);
    this.broadcast();
  }

  private sendSnapshots(): void {
    const sim = this.sim!;
    const hazards = sim.hazardsTouched || this.step % (SNAPSHOT_EVERY * HAZARDS_EVERY) === 0;
    sim.hazardsTouched = false;
    const world = writeWorld(sim);
    if (!sameBytes(world, this.world)) {
      this.world = world;
      this.worldChanged = this.step;
    }
    const worldNow = hazards || this.shots.length > 0 || this.step - this.worldChanged < SNAPSHOT_EVERY * WORLD_REPEAT;
    for (const m of this.members) {
      if (m.awayFor >= 0) continue;
      const seat = this.seats.get(m);
      const you = seat?.player ?? null;
      const sounds = this.sounds.filter((s) => !(you && s.source === you.id && HEARD_LOCALLY.has(s.name)));
      const fresh = this.step < m.freshUntil;
      const data = writeSnapshot(
        sim,
        {
          tick: this.step,
          you,
          ack: seat?.queue.executed ?? 0,
          idle: seat?.queue.idle ?? 0,
          queued: seat?.queue.queued ?? 0,
          hazards: hazards || fresh,
          world: worldNow || fresh ? world : null,
        },
        this.shots,
        sounds,
      );
      this.bytesOut += data.length;
      m.conn.sendBinary(data);
      if (this.events.length > 0) m.conn.send({ type: 'events', events: this.events });
    }
    const finished = this.events.some((e) => e.type === 'win');
    this.shots = [];
    this.sounds = [];
    this.events = [];
    if (finished) this.broadcast();
  }

  lobbyFor(m: Member): LobbyState {
    return {
      code: this.code,
      phase: this.phase,
      members: this.members.map((x) => ({ id: x.id, name: x.name, skin: x.skin, host: x === this.host, away: x.awayFor >= 0 })),
      you: m.id,
      bots: this.inMatch || this.phase === 'finished' ? this.matchBots.length : this.bots,
      difficulty: this.difficulty,
      map: { name: this.map.name, builtin: this.map.builtin, slots: this.map.slots },
    };
  }

  /** Everyone gets the latest lobby. */
  broadcast(): void {
    for (const m of this.members) if (m.awayFor < 0) m.conn.send({ type: 'lobby', lobby: this.lobbyFor(m) });
  }

  dispose(): void {
    this.sim?.dispose();
    this.sim = null;
  }
}
