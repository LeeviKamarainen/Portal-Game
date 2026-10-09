import * as THREE from 'three';
import type { ArenaSim } from '../sim/ArenaSim';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { MoveState } from '../player/PlayerController';
import { BufferedCommands, IdleCommands, emptyCommand, type PlayerCommand } from '../player/PlayerCommand';
import { linkPortals, type Portal, type PortalColor } from '../portals/Portal';
import type { SessionEvent } from '../sim/SimEvents';
import { seqNewer } from './codec';
import { INPUT_REDUNDANCY, copyCommand, quantizeCommand, writeInput, type SeqCommand } from './commands';
import { Interpolation, type Pose, type PropPose } from './Interpolation';
import { readSnapshot, type NetPortal, type NetShot, type NetSound, type Snapshot } from './snapshot';
import type { RosterEntry, ServerMessage } from './protocol';

/** Predicted steps kept for checking against the server (2 s). */
const HISTORY = 128;
/** A prediction this close to the server's is left alone (m, m/s, rad). */
const POS_TOLERANCE = 0.03;
const VEL_TOLERANCE = 0.2;
const LOOK_TOLERANCE = 0.002;
/** A correction smaller than this is eased out on screen; a bigger one is a jump. */
const SMOOTH_LIMIT = 1;
/** Commands the client aims to keep waiting on the server: enough to ride out jitter, few enough to stay responsive. */
const TARGET_QUEUE = 3;
/**
 * At the start - and whenever the server has gone a while without our commands (this tab
 * was hidden, the page hitched) - the client runs this many steps ahead at once, so commands
 * are waiting on the server again straight away.
 */
const HEAD_START = TARGET_QUEUE - 1;
/** Steps the server may run without one of our commands before we jump ahead again. */
const STARVED = 6;
/** The client's clock runs at most this much faster or slower than real time to keep that. */
const MAX_TIME_SKEW = 0.03;

export interface NetSessionOptions {
  /**
   * Move your own player on your screen straight away (predicted, then checked against the
   * server). Off (`?predict=0`): it is drawn where the server had it, like everyone else.
   */
  predict?: boolean;
  /**
   * The scoreboard so far, in order, for a match joined in progress (it lists players who
   * have left, too).
   */
  scores?: readonly { id: string; name: string; score: number }[];
}

interface Predicted {
  seq: number;
  /** This screen's step count when it was made. */
  tick: number;
  cmd: PlayerCommand;
  external: THREE.Vector3;
  knocks: THREE.Vector3[];
  state: MoveState;
  passing: number;
}

export interface NetStats {
  snapshots: number;
  corrections: number;
  bytesIn: number;
  bytesOut: number;
  /** Commands waiting on the server, smoothed. */
  queue: number;
  timeScale: number;
  /** Snapshot bytes a second over the last second. */
  rateIn: number;
  /** Command bytes a second sent over the last second. */
  rateOut: number;
  /** Your own portal shots that opened a portal here and turned out differently on the server. */
  shotMisses: number;
  /** Steps everyone else is drawn behind the newest snapshot (it follows the connection). */
  delay: number;
  /** Snapshots that came too late: everyone else stood still a moment waiting for them. */
  late: number;
}

/** One snapshot's arrival, for the net stats overlay's graph. */
export interface SnapshotTrace {
  /** Milliseconds since the one before. */
  gap: number;
  bytes: number;
  /** It set off a correction of your own player. */
  fixed: boolean;
}

/** Snapshots kept in `trace` (4 s). */
const TRACE = 120;

/**
 * Your side of an online match. The game server runs the real match; this keeps a copy of
 * the arena (`sim`, in netClient mode) looking like it:
 *
 * - Every step your command goes to the server (with the previous few, in case one is
 *   lost) and - with prediction on - moves your own player here at once. Each snapshot
 *   says which command the server has used last; if your body was somewhere else after
 *   that one, it is put where the server had it and the commands since are run again.
 * - Everyone else is drawn a little in the past, between two snapshots (Interpolation),
 *   and so are the crates; their shots and sounds go off when their bodies are drawn there.
 * - Your own portal shots open your portal at once; until the server has used that
 *   command, what it says about that portal is older news and is left alone.
 * - Portals, orbs, scores and gravity are taken as they arrive. Hazards run on this
 *   screen's clock, and each snapshot catches them (and gravity) up from the server's state.
 * - Your clock runs a touch faster or slower so a few of your commands are always waiting
 *   on the server (never none, never many).
 *
 * It needs no renderer, so tests run it headless against a real server.
 */
export class NetSession {
  readonly sim: ArenaSim;
  readonly local: ArenaPlayer | null;
  readonly predict: boolean;
  /** Deaths, scores, steals, the win: for the game to show, in order. */
  readonly events: SessionEvent[] = [];
  /** The match is on (the server said go). */
  started = false;
  /** Seconds of countdown the server announced (0 once it is over). */
  countdown = 0;
  /** Your player came back after dying (the game clears it once it has reacted). */
  respawned = false;
  readonly stats: NetStats = {
    snapshots: 0,
    corrections: 0,
    bytesIn: 0,
    bytesOut: 0,
    queue: TARGET_QUEUE,
    timeScale: 1,
    rateIn: 0,
    rateOut: 0,
    shotMisses: 0,
    delay: 0,
    late: 0,
  };
  /** The latest snapshots' arrivals, oldest first. */
  readonly trace: SnapshotTrace[] = [];
  /** Shots and sounds from the server, for whoever draws and plays the match. */
  onShot: ((shot: NetShot, shooter: ArenaPlayer) => void) | null = null;
  onSound: ((sound: NetSound) => void) | null = null;
  /** Someone joined the match in progress: their body is in the arena now (give it a look). */
  onPlayerJoined: ((player: ArenaPlayer, entry: RosterEntry) => void) | null = null;

  private readonly send: (data: Uint8Array<ArrayBuffer>) => void;
  private readonly commands = new BufferedCommands();
  private readonly interp = new Interpolation();
  private readonly outbox: SeqCommand[] = [];
  private readonly history: Predicted[] = [];
  private readonly bySlot = new Map<number, ArenaPlayer>();
  private readonly pose: Pose = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), yaw: 0, pitch: 0, dead: false, grounded: false };
  private readonly propPose: PropPose = { visible: true, position: new THREE.Vector3(), rotation: new THREE.Quaternion(), passing: -1 };
  /** Your latest portal shot of each colour that opened a portal here, until the server has used it (its seq). */
  private readonly pending: Record<PortalColor, number | null> = { orange: null, blue: null };
  /** Other players' shots and sounds, waiting for the drawing clock to reach the step they happened on. */
  private readonly scheduled: { tick: number; run: () => void }[] = [];
  /** The latest corrections and what set them off (for the net stats overlay and tests). */
  readonly why: string[] = [];
  private closed = false;
  private seq = 0;
  /** A prediction has been checked against the server at least once. */
  private checked = false;
  /** Steps to run ahead at the next step (see HEAD_START), and whether that is already under way. */
  private headStart = HEAD_START;
  private starving = false;
  private rateFrom = 0;
  private rateBytes = 0;
  private rateBytesOut = 0;
  private lastArrival = 0;
  private tick = 0;
  private dt = 1 / 60;
  private respawns = -1;

  /**
   * `sim` has every player of the match in it, `local` (yours, or null to watch) among
   * them; `send` takes binary messages for the server.
   */
  constructor(sim: ArenaSim, local: ArenaPlayer | null, send: (data: Uint8Array<ArrayBuffer>) => void, options: NetSessionOptions = {}) {
    this.sim = sim;
    this.local = local;
    this.send = send;
    this.predict = options.predict ?? true;
    sim.netClient = true;
    for (const p of sim.players) {
      this.bySlot.set(p.slot, p);
      if (p === local && this.predict) continue;
      this.makePuppet(p);
    }
    const match = sim.match;
    if (match && options.scores) {
      // In the server's order; anyone it hadn't listed yet (you, just joining) after them.
      const order = options.scores.map((r) => r.id);
      const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
      for (const r of options.scores) match.addPlayer(r.id, r.name).score = r.score;
      match.players.sort((a, b) => rank(a.id) - rank(b.id));
    }
    if (local) {
      const c = local.controller;
      c.commands = this.commands;
      // Everyone else is drawn in the past: your body walks through where they were drawn,
      // and the server decides any real bump.
      const portalFilter = sim.system.filterFor(c);
      c.filter = (col) => portalFilter(col) && sim.physics.getOwner(col.handle)?.type !== 'player';
    }
    // Crates are where the server says.
    for (const prop of sim.arena.props) {
      prop.setFrozen(true);
      sim.system.unregister(prop);
    }
  }

  /** Someone else's body: placed from the snapshots, not simulated. */
  private makePuppet(p: ArenaPlayer): void {
    p.puppet = true;
    this.sim.system.unregister(p.controller);
  }

  /** Someone joined the match in progress (in place of whoever had their slot - a bot that made room). */
  private addPlayer(entry: RosterEntry): void {
    const old = this.bySlot.get(entry.slot);
    if (old === this.local) return;
    if (old) this.sim.removePlayer(old.id);
    const p = this.sim.addPlayer({ id: entry.id, name: entry.name }, new IdleCommands(), null, { slot: entry.slot, local: false });
    this.bySlot.set(entry.slot, p);
    this.makePuppet(p);
    this.onPlayerJoined?.(p, entry);
  }

  /** Done with the match (its arena is about to go): anything still arriving is ignored. */
  close(): void {
    this.closed = true;
  }

  /** A JSON message from the server about the match. */
  receive(msg: ServerMessage): void {
    if (this.closed) return;
    switch (msg.type) {
      case 'countdown':
        this.countdown = msg.seconds;
        break;
      case 'go':
        this.started = true;
        this.countdown = 0;
        break;
      case 'notice':
        this.sim.showNotice(msg.text, msg.seconds);
        break;
      case 'playerJoined':
        this.addPlayer(msg.player);
        break;
      case 'events':
        for (const e of msg.events) {
          if (e.type === 'death' && this.local && e.player === this.local.id) this.local.dead = true;
          if (e.type === 'win') {
            const match = this.sim.match;
            if (match) match.winner = match.player(e.player) ?? null;
            this.sim.endMatch();
          }
          this.events.push(e);
        }
        break;
      default:
        break;
    }
  }

  /**
   * One game step. `input` is what you want to do (null: nothing). Sends it, moves your own
   * player, places everyone else, and runs the arena.
   */
  step(dt: number, input: PlayerCommand | null): void {
    if (this.closed) return;
    this.dt = dt;
    if (this.countdown > 0) this.countdown = Math.max(0, this.countdown - dt);
    this.placePuppets();
    if (!this.started) return;
    const steps = 1 + this.headStart;
    this.headStart = 0;
    for (let i = 0; i < steps; i++) this.predictStep(dt, i === 0 ? input : null);
  }

  /** Sends one command and moves your own player by it. */
  private predictStep(dt: number, input: PlayerCommand | null): void {
    const cmd = quantizeCommand(input ? copyCommand(input, emptyCommand()) : emptyCommand());
    this.seq = (this.seq + 1) & 0xffff;
    this.outbox.push({ seq: this.seq, cmd });
    if (this.outbox.length > INPUT_REDUNDANCY) this.outbox.shift();
    const data = writeInput(this.outbox);
    this.stats.bytesOut += data.length;
    this.send(data);
    copyCommand(cmd, this.commands.next);

    this.sim.step(dt);

    const local = this.local;
    for (const shot of this.sim.shots) {
      if (shot.player === local?.id && shot.outcome === 'placed') this.pending[shot.color] = this.seq;
    }
    if (local && !local.puppet) {
      const c = local.controller;
      this.history.push({
        seq: this.seq,
        tick: this.tick,
        cmd,
        external: c.usedExternal.clone(),
        knocks: c.stepKnocks,
        state: c.saveMove(),
        passing: c.passing?.netId ?? -1,
      });
      if (this.history.length > HISTORY) this.history.shift();
    }
    this.tick++;
  }

  /** How fast this screen's clock should run (1 = real time): see TARGET_QUEUE. */
  get timeScale(): number {
    return this.stats.timeScale;
  }

  /** A binary message from the server (a snapshot). */
  receiveBinary(data: ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    let s: Snapshot;
    try {
      s = readSnapshot(data);
    } catch {
      return;
    }
    this.stats.snapshots++;
    this.stats.bytesIn += data.byteLength;
    this.rateBytes += data.byteLength;
    const now = performance.now();
    if (now - this.rateFrom >= 1000) {
      this.stats.rateIn = this.rateFrom > 0 ? (this.rateBytes * 1000) / (now - this.rateFrom) : 0;
      this.stats.rateOut = this.rateFrom > 0 ? ((this.stats.bytesOut - this.rateBytesOut) * 1000) / (now - this.rateFrom) : 0;
      this.rateFrom = now;
      this.rateBytes = 0;
      this.rateBytesOut = this.stats.bytesOut;
    }
    const fixes = this.stats.corrections;
    this.interp.push(s.tick, s.players, s.props);
    this.stats.delay = this.interp.delay;
    this.stats.late = this.interp.late;
    this.syncPlayers(s);
    if (s.portals) this.applyPortals(s.portals, s.ack);
    if (s.orbs) this.sim.orbs?.setNetState(s.orbs);
    // The server's state is from the step that used our command `ack`; this screen has run
    // `since` steps after that one. Hazards and gravity are caught up by as many.
    const since = this.stepsSince(s.ack);
    const regravitated = this.sim.syncGravity(s.gravity.factor, Math.max(0, s.gravity.steps - (since ?? 0)));
    if (s.hazards) this.sim.syncHazards(s.hazards, since ?? 0, this.dt);
    this.reconcile(s, regravitated);
    this.scheduleEffects(s);
    this.trace.push({ gap: this.lastArrival > 0 ? now - this.lastArrival : 0, bytes: data.byteLength, fixed: this.stats.corrections > fixes });
    if (this.trace.length > TRACE) this.trace.shift();
    this.lastArrival = now;

    // Clock sync: steer the number of our commands waiting on the server toward the target.
    // A server that has run dry gets a burst to start it off again.
    if (this.started && s.idle >= STARVED && !this.starving) {
      this.starving = true;
      this.headStart = HEAD_START;
    } else if (s.idle === 0) {
      this.starving = false;
    }
    const waiting = s.idle > 0 ? -1 : s.queued;
    this.stats.queue += (waiting - this.stats.queue) * 0.1;
    this.stats.timeScale = THREE.MathUtils.clamp(1 + (TARGET_QUEUE - this.stats.queue) * 0.01, 1 - MAX_TIME_SKEW, 1 + MAX_TIME_SKEW);
  }

  /** Scores, health and deaths; players who left go. */
  private syncPlayers(s: Snapshot): void {
    const match = this.sim.match;
    const present = new Set<number>();
    for (const np of s.players) {
      present.add(np.slot);
      const p = this.bySlot.get(np.slot);
      if (!p) continue;
      const row = match?.player(p.id);
      if (row) row.score = np.score;
      if (p !== this.local) continue;
      p.controller.health.set(np.health);
      p.dead = np.dead;
    }
    for (const [slot, p] of this.bySlot) {
      if (present.has(slot) || p === this.local) continue;
      this.sim.removePlayer(p.id);
      this.bySlot.delete(slot);
    }
  }

  /** One of your portal shots came out differently on the server (for the stats overlay and tests). */
  private missed(portal: Portal, how: string): void {
    this.stats.shotMisses++;
    this.why.push(`${portal.color} portal shot: ${how}`);
    if (this.why.length > 20) this.why.shift();
  }

  /** Steps this screen has run since the one that used command `seq` (null: not in the history any more, or not yet). */
  private stepsSince(seq: number): number | null {
    const entry = this.started ? this.history.find((h) => h.seq === seq) : undefined;
    return entry ? Math.max(0, this.tick - 1 - entry.tick) : null;
  }

  /**
   * The shots and sounds in a snapshot. Other players' wait until their bodies are drawn
   * where they made them (so a shot leaves the gun it came from); your own shots were shown
   * when you fired, and anything else is heard at once.
   */
  private scheduleEffects(s: Snapshot): void {
    const local = this.local && !this.local.puppet ? this.local : null;
    for (const shot of s.shots) {
      const shooter = this.bySlot.get(shot.slot);
      if (!shooter || shooter === local) continue;
      this.scheduled.push({
        tick: s.tick,
        run: () => {
          if (!this.sim.players.includes(shooter)) return;
          if (shot.outcome === 'stolen') this.flashAt(shot.to);
          this.onShot?.(shot, shooter);
        },
      });
    }
    for (const sound of s.sounds) {
      const maker = sound.slot === null ? undefined : this.bySlot.get(sound.slot);
      if (maker?.puppet) this.scheduled.push({ tick: s.tick, run: () => this.onSound?.(sound) });
      else this.onSound?.(sound);
    }
  }

  /** The stolen flash on whichever portal is open at `point` (someone else's steal, as their shot lands). */
  private flashAt(point: THREE.Vector3): void {
    let best: Portal | null = null;
    let nearest = 1.5;
    for (const p of this.sim.system.portals) {
      const d = p.placed ? p.surfaceCenter.distanceTo(point) : Infinity;
      if (d < nearest) {
        best = p;
        nearest = d;
      }
    }
    best?.flashStolen();
  }

  /** Everyone else and the crates, where the interpolation clock says they were; then whatever they did there. */
  private placePuppets(): void {
    this.interp.advance();
    if (this.interp.renderTick < 0) return;
    let moved = false;
    for (const p of this.sim.players) {
      if (!p.puppet || !this.interp.sample(p.slot, this.pose)) continue;
      const q = this.pose;
      p.controller.setPuppetPose(q.position, q.velocity, q.yaw, q.pitch, q.grounded);
      if (p !== this.local) p.dead = q.dead;
      moved = true;
    }
    this.sim.arena.props.forEach((prop, i) => {
      const q = this.propPose;
      if (!this.interp.sampleProp(i, q)) return;
      if (prop.visible !== q.visible) prop.setVisible(q.visible);
      prop.setPose(q.position, q.rotation);
      prop.passing = q.passing >= 0 ? (this.sim.portalsByNetId.get(q.passing) ?? null) : null;
      moved = true;
    });
    if (moved) this.sim.physics.world.propagateModifiedBodyPositionsToColliders();
    while (this.scheduled.length > 0 && this.scheduled[0].tick <= this.interp.renderTick) this.scheduled.shift()!.run();
  }

  /**
   * Who holds which portal (stealing moves them between players) and where each is open -
   * except your own portal of a colour you have just shot, until the server has used that
   * shot's command (`ack`): till then this screen is ahead of it.
   */
  private applyPortals(list: readonly NetPortal[], ack: number): void {
    const sim = this.sim;
    const local = this.local;
    const ahead = new Set<Portal>();
    /** Portals whose shot the server has just caught up with: from now on it says where they are. */
    const caughtUp = new Set<Portal>();
    for (const color of ['orange', 'blue'] as const) {
      const seq = this.pending[color];
      if (seq !== null && !seqNewer(seq, ack)) {
        this.pending[color] = null;
        if (local) caughtUp.add(local.portals[color]);
      }
      if (this.pending[color] !== null && local) ahead.add(local.portals[color]);
    }
    const placements: [Portal, NetPortal][] = [];
    for (const np of list) {
      const portal = sim.portalsByNetId.get(np.netId);
      const owner = this.bySlot.get(np.ownerSlot);
      if (!portal || !owner) continue;
      if (ahead.has(portal) || (owner === local && this.pending[np.color] !== null)) continue;
      if (portal.owner !== owner.id || portal.color !== np.color) {
        // Your own steal flashes now; anyone else's as their shot lands (scheduleEffects).
        if (owner === local && portal.owner !== owner.id && portal.placed && np.placement) portal.flashStolen();
        portal.owner = owner.id;
        portal.color = np.color;
        portal.setTint(owner.palette[np.color]);
      }
      owner.portals[np.color] = portal;
      placements.push([portal, np]);
    }
    for (const p of sim.players) linkPortals(p.portals.orange, p.portals.blue);
    for (const [portal, np] of placements) {
      const at = np.placement;
      if (!at) {
        if (!portal.placed) continue;
        if (caughtUp.has(portal)) this.missed(portal, 'closed on the server');
        portal.unplace();
        continue;
      }
      const face = sim.level.faces[at.face];
      if (!face) continue;
      if (portal.placed && portal.face === face && portal.surfaceCenter.distanceToSquared(at.center) < 1e-6 && portal.up.dot(at.up) > 0.99999) continue;
      if (caughtUp.has(portal)) this.missed(portal, portal.placed ? `${portal.surfaceCenter.distanceTo(at.center).toFixed(2)} m off` : 'not open here');
      const right = new THREE.Vector3().crossVectors(at.up, face.normal).normalize();
      portal.place(sim.physics, face, at.center, right, at.up);
    }
  }

  /**
   * Checks the prediction against the server, and puts it right if it went astray. `redo`:
   * replay the commands since anyway (gravity changed under them).
   */
  private reconcile(s: Snapshot, redo = false): void {
    const local = this.local;
    if (!local || !this.started) return;
    const np = s.players.find((p) => p.slot === local.slot);
    if (!np?.own) return;
    const c = local.controller;
    const server: MoveState = { position: np.position, velocity: np.velocity, yaw: np.yaw, pitch: np.pitch, grounded: np.grounded };

    while (this.history.length > 0 && seqNewer(s.ack, this.history[0].seq)) this.history.shift();
    if (local.puppet) return;
    // The step the server has just used: what is left in the history comes after it.
    const entry = this.history[0]?.seq === s.ack ? this.history.shift()! : null;

    // Back on the spawn pad: start again from where the server put us, then redo the
    // commands it hasn't used yet (made while this screen still had us dead).
    if (np.respawns !== this.respawns) {
      const first = this.respawns < 0;
      this.respawns = np.respawns;
      if (first) return;
      this.sim.respawnPlayer(local);
      this.respawned = true;
      c.inputEnabled = true;
      this.correct(server, -1, false);
      c.viewCorrection.set(0, 0, 0);
      return;
    }
    if (np.dead || local.dead || !entry) return;

    const predicted = entry.state;
    const loose = s.idle > 0 ? 20 : 1;
    const moved =
      predicted.position.distanceTo(server.position) > POS_TOLERANCE * loose ||
      predicted.velocity.distanceTo(server.velocity) > VEL_TOLERANCE * loose ||
      Math.abs(predicted.yaw - server.yaw) > LOOK_TOLERANCE * loose ||
      Math.abs(predicted.pitch - server.pitch) > LOOK_TOLERANCE * loose;
    const state = s.idle === 0 && (predicted.grounded !== server.grounded || entry.passing !== np.own.passing);
    if (!moved && !state) {
      if (redo) this.correct(server, np.own.passing, false);
      return;
    }
    this.why.push(
      `#${s.ack}: ${predicted.position.distanceTo(server.position).toFixed(3)} m, ${predicted.velocity.distanceTo(server.velocity).toFixed(2)} m/s` +
        (Math.abs(predicted.yaw - server.yaw) > LOOK_TOLERANCE ? `, look ${Math.abs(predicted.yaw - server.yaw).toFixed(3)}` : '') +
        (predicted.grounded !== server.grounded ? `, grounded ${predicted.grounded}/${server.grounded}` : '') +
        (entry.passing !== np.own.passing ? `, portal ${entry.passing}/${np.own.passing}` : '') +
        (s.idle > 0 ? `, ${s.idle} idle` : '') +
        (entry.knocks.length > 0 || entry.external.lengthSq() > 0 ? ', pushed' : '') +
        (this.history.some((h) => h.knocks.length > 0 || h.external.lengthSq() > 0) ? ', pushed later' : ''),
    );
    if (this.why.length > 20) this.why.shift();
    // Only a visible miss counts: the first step (the server let us settle on the pad
    // before our first command came) and a portal we hadn't heard of yet are put right quietly.
    this.correct(server, np.own.passing, moved && this.checked);
    this.checked = true;
  }

  /** Puts your body where the server had it and runs the commands since then again. */
  private correct(server: MoveState, passing: number, counts = true): void {
    const local = this.local!;
    const c = local.controller;
    const sim = this.sim;
    const drawnAt = c.getPosition();
    c.restoreMove(server);
    sim.system.resync(c);
    c.passing = passing >= 0 ? (sim.portalsByNetId.get(passing) ?? null) : null;

    const onTeleport = sim.system.onTeleport;
    sim.system.onTeleport = null;
    sim.quiet = true;
    try {
      c.replay(this.history.length, (i) => {
        const h = this.history[i];
        copyCommand(h.cmd, this.commands.next);
        c.replayStep(this.dt, h.external, h.knocks);
        sim.system.stepEntity(c, this.dt);
        c.replayPost();
        h.state = c.saveMove();
        h.passing = c.passing?.netId ?? -1;
      });
    } finally {
      sim.system.onTeleport = onTeleport;
      sim.quiet = false;
    }
    const jump = drawnAt.sub(c.getPosition());
    if (jump.length() < SMOOTH_LIMIT) c.viewCorrection.add(jump);
    else c.viewCorrection.set(0, 0, 0);
    if (counts) this.stats.corrections++;
  }
}
