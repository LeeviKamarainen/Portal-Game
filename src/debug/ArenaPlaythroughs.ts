import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { PortalColor } from '../portals/Portal';
import { Crusher, WARN_TIME } from '../world/hazards/Crusher';
import { ARENAS } from '../world/arenas';
import { EYE_OFFSET } from '../player/PlayerController';

/**
 * Scripted playthroughs: a bot plays every arena from its spawn pad to its exit using
 * only what a player has - movement keys, the look direction, the two portal buttons, and
 * what can be seen (a crusher's position, where a laser lands). An arena passes if the
 * exit is reached within the time limit without dying.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

class Failure extends Error {}

class Bot {
  readonly game: Game;
  time = 0;
  deaths: string[] = [];
  private lookYaw = 0;
  private lookPitch = 0;

  constructor(game: Game) {
    this.game = game;
  }

  get session() {
    return this.game.session!;
  }

  get pos(): THREE.Vector3 {
    return this.session.player.getPosition();
  }

  get teleports(): number {
    return this.session.system.teleportCount(this.session.player);
  }

  get done(): boolean {
    const s = (this.game as unknown as { state: string }).state;
    return s === 'complete' || s === 'finished';
  }

  /** One fixed step with the given keys held. Throws if the player dies. */
  step(keys: string[] = []): void {
    this.game.input.setScriptedKeys(keys);
    this.session.player.setLook(this.lookYaw, this.lookPitch);
    this.game.step(DT);
    this.time += DT;
    const state = (this.game as unknown as { state: string }).state;
    if (state === 'dying') {
      this.deaths.push(`t=${this.time.toFixed(1)}s at ${this.pos.toArray().map((n) => n.toFixed(1)).join(',')}`);
      throw new Failure(`died (${this.deaths[this.deaths.length - 1]})`);
    }
  }

  wait(seconds: number, keys: string[] = []): void {
    for (let t = 0; t < seconds; t += DT) {
      this.step(keys);
      if (this.done) return;
    }
  }

  waitUntil(pred: () => boolean, timeout: number, what: string): void {
    for (let t = 0; t < timeout; t += DT) {
      if (pred()) return;
      this.step();
    }
    throw new Failure(`timed out waiting for ${what}`);
  }

  face(yaw: number, pitch = 0): void {
    this.lookYaw = yaw;
    this.lookPitch = pitch;
    this.session.player.setLook(yaw, pitch);
  }

  lookAt(p: THREE.Vector3): void {
    const eye = this.pos.add(V(0, EYE_OFFSET, 0));
    const d = p.clone().sub(eye);
    this.face(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
  }

  /** Walks in a straight line to (x, z), steering every step. */
  walkTo(
    x: number,
    z: number,
    opts: { tol?: number; timeout?: number; jumpWhen?: (p: THREE.Vector3) => boolean; until?: () => boolean } = {},
  ): void {
    const tol = opts.tol ?? 0.5;
    const timeout = opts.timeout ?? 20;
    for (let t = 0; t < timeout; t += DT) {
      if (this.done || opts.until?.()) return;
      const p = this.pos;
      const dx = x - p.x;
      const dz = z - p.z;
      if (Math.hypot(dx, dz) < tol) return;
      this.face(Math.atan2(-dx, -dz), 0);
      const keys = ['KeyW'];
      if (opts.jumpWhen?.(p)) keys.push('Space');
      this.step(keys);
    }
    throw new Failure(`could not reach (${x}, ${z}); stuck at ${this.pos.toArray().map((n) => n.toFixed(2)).join(',')}`);
  }

  /** Aims at a point and pulls the trigger, as a click would. */
  fire(color: PortalColor, at: THREE.Vector3): void {
    this.lookAt(at);
    this.step();
    this.game.fire(color);
    this.step();
    if (!this.session.portals[color].placed) throw new Failure(`${color} portal did not place at ${at.toArray().join(',')}`);
  }

  /** Air steering toward a ground point while falling or flying. */
  steerTo(x: number, z: number, seconds: number, until?: () => boolean): void {
    for (let t = 0; t < seconds; t += DT) {
      if (this.done || until?.()) return;
      const p = this.pos;
      const dx = x - p.x;
      const dz = z - p.z;
      const dist = Math.hypot(dx, dz);
      const v = this.session.player.getVelocity();
      const toward = dist > 1e-3 ? (v.x * dx + v.z * dz) / dist : 0;
      this.face(Math.atan2(-dx, -dz), this.lookPitch);
      // Press toward the target, and ease off when already closing fast enough.
      const keys = dist > 0.4 && toward < Math.min(7, dist * 3) ? ['KeyW'] : toward > dist * 4 ? ['KeyS'] : [];
      this.step(keys);
    }
  }
}

type Script = (bot: Bot) => void;

/** True when a crusher can be passed under right now with time to spare. */
function crusherClear(c: Crusher, margin = 0.6): boolean {
  if (c.underside < 2.6) return false;
  if (c.phaseName === 'warn') return WARN_TIME - c.timeInPhase > margin;
  return c.phaseName === 'up' || c.phaseName === 'rise';
}

const SCRIPTS: Record<string, Script> = {
  calibration(bot) {
    bot.walkTo(0, 12.2);
    // Over the divider, high on the far wall; then one on the wall right behind us.
    bot.fire('orange', V(0, 6.6, -14));
    bot.fire('blue', V(2.5, 1.4, 14));
    const n = bot.teleports;
    bot.walkTo(2.5, 15, { tol: 0.05, timeout: 4, until: () => bot.teleports > n });
    if (bot.teleports === n) throw new Failure('never went through the portal');
    bot.wait(1.0);
    bot.walkTo(0, -10, { tol: 0.6 });
  },

  'acid-moat'(bot) {
    const platform = bot.session.arena.hazards.find((h) => 'delta' in h) as unknown as { pos: THREE.Vector3; delta: THREE.Vector3 };
    const docked = (z: number) => Math.abs(platform.pos.z - z) < 0.05 && platform.delta.lengthSq() < 1e-8;
    // Ride the platform across the moat.
    bot.walkTo(-7, 7.2, { tol: 0.3 });
    bot.waitUntil(() => docked(4.45), 15, 'the platform at the south dock');
    bot.walkTo(-7, 4.4, { tol: 0.3 });
    bot.waitUntil(() => docked(-4.45), 15, 'the platform at the north dock');
    bot.walkTo(-7, -8.5, { tol: 0.4 });
    // From under the ledge: one portal high on the wall above it, one on the floor here.
    bot.fire('orange', V(0, 8.3, -18));
    bot.fire('blue', V(-3, 0, -8.5));
    const n = bot.teleports;
    bot.walkTo(-3, -8.5, { tol: 0.05, timeout: 4, until: () => bot.teleports > n });
    bot.waitUntil(() => bot.teleports > n, 3, 'the fall through the floor portal');
    bot.steerTo(0, -15, 1.5);
    bot.walkTo(0, -15, { tol: 0.6 });
  },

  'crusher-gallery'(bot) {
    const crushers = bot.session.arena.hazards.filter((h): h is Crusher => h instanceof Crusher);
    crushers.sort((a, b) => (b as unknown as { z: number }).z - (a as unknown as { z: number }).z);
    const stops = [14.6, 10.1, 5.9, 1.2];
    bot.walkTo(0, stops[0]);
    for (let i = 0; i < crushers.length; i++) {
      bot.waitUntil(() => crusherClear(crushers[i], 0.8), 8, `crusher ${i + 1}`);
      bot.walkTo(0, stops[i + 1], { tol: 0.3 });
    }
    // Bend the laser round: in where it strikes the west block, out at the target ring
    // on the east block, which faces the receiver.
    bot.walkTo(0, -2);
    bot.fire('orange', V(-4, 1.45, 2));
    bot.fire('blue', V(4, 1.45, 2));
    bot.waitUntil(() => bot.session.arena.hazards.some((h) => 'isOpen' in h && (h as { isOpen: boolean }).isOpen), 5, 'the door');
    bot.walkTo(0, -27.5, { tol: 0.6 });
  },

  'proving-grounds'(bot) {
    const crusher = bot.session.arena.hazards.find((h): h is Crusher => h instanceof Crusher)!;
    // West approach, clear of the drop zones, round to the foot of the north stairs.
    bot.walkTo(-27.5, 22);
    bot.walkTo(-27.5, -28);
    bot.walkTo(-20.4, -28, { tol: 0.3 });
    bot.waitUntil(() => crusherClear(crusher, 1.0), 10, 'the stair crusher');
    bot.walkTo(-14.5, -28, { tol: 0.3 });
    bot.walkTo(-8, -28, { tol: 0.4 });
    // Hop the tripwire - braking in the air, the gallery is only 7 m deep - and stop short
    // of its front edge.
    bot.walkTo(-6, -27.9, { tol: 0.3 });
    bot.face(Math.PI, 0);
    bot.step(['KeyW', 'Space']);
    for (let t = 0; t < 1.5 && !bot.session.player.isGrounded; t += DT) bot.step(bot.pos.z > -25.8 ? ['KeyS'] : ['KeyW']);
    bot.walkTo(-6, -24.3, { tol: 0.3 });
    bot.wait(0.5);
    bot.fire('orange', V(0, 7, 0));
    // The floor portal goes well out from the gallery's foot, aimed past its lip.
    bot.walkTo(-6, -23.75, { tol: 0.1 });
    bot.wait(0.4);
    bot.fire('blue', V(-6, 0, -19.4));
    // Step off the edge, fall into the floor portal, and come up out of the pillar.
    const n = bot.teleports;
    bot.walkTo(-6, -21, { tol: 0.1, timeout: 3, until: () => !bot.session.player.isGrounded });
    bot.steerTo(-6, -19.4, 2, () => bot.teleports > n);
    if (bot.teleports === n) throw new Failure('missed the floor portal');
    bot.steerTo(2.2, 2.2, 3);
    bot.walkTo(2.2, 2.2, { tol: 0.5, timeout: 5 });
  },
};

export interface PlaythroughResult {
  arena: string;
  pass: boolean;
  time: number;
  detail: string;
}

const stateOf = (game: Game) => (game as unknown as { state: string }).state;

/**
 * Lets the game leave a finished arena on its own (the goal fade, or R on the final screen),
 * the way a player does it, and waits for whatever it loads. Returns the error that path
 * threw, if any.
 */
async function leaveArena(game: Game, pressRestart: boolean): Promise<string | null> {
  try {
    if (pressRestart) (game.input as unknown as { presses: Set<string> }).presses.add('KeyR');
    for (let t = 0; t < 4 && stateOf(game) !== 'loading'; t += DT) game.step(DT);
    for (let k = 0; k < 100 && stateOf(game) === 'loading'; k++) await new Promise((r) => setTimeout(r, 50));
    for (let t = 0; t < 0.5; t += DT) game.step(DT);
    game.renderNow();
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function runArenaPlaythroughs(game: Game): Promise<{ text: string; results: PlaythroughResult[] }> {
  const results: PlaythroughResult[] = [];
  for (let i = 0; i < ARENAS.length; i++) {
    const def = ARENAS[i];
    // After the first arena, the previous one's goal should already have brought us here.
    if (i === 0 || game.arenaIndex !== i) await game.loadArena(i);
    const bot = new Bot(game);
    bot.session.player.setLook(bot.session.arena.spawnYaw, 0);
    bot.face(bot.session.arena.spawnYaw, 0);
    // Let the arena fade in.
    bot.wait(0.5);
    let detail = '';
    try {
      SCRIPTS[def.id](bot);
      bot.wait(0.3);
      if (!bot.done) throw new Failure(`ended at ${bot.pos.toArray().map((n) => n.toFixed(2)).join(',')} without reaching the exit`);
      detail = 'reached the exit';
    } catch (e) {
      if (!(e instanceof Failure)) throw e;
      detail = e.message;
    }
    const pass = bot.done && bot.deaths.length === 0;
    results.push({ arena: `${i + 1}. ${def.name}`, pass, time: bot.time, detail });
    if (!pass) continue;

    // Completing the arena must carry on to the next one (and R on the final screen
    // back to the first), with the game running and the fade cleared.
    game.input.setScriptedKeys([]);
    const last = i === ARENAS.length - 1;
    const err = await leaveArena(game, last);
    const expected = last ? 0 : i + 1;
    const arrived = !err && game.arenaIndex === expected && stateOf(game) === 'playing' && !!game.session;
    results.push({
      arena: last ? `   final screen, R -> 1. ${ARENAS[0].name}` : `   exit -> ${expected + 1}. ${ARENAS[expected].name}`,
      pass: arrived,
      time: 0,
      detail: err ? `threw: ${err}` : `arena ${game.arenaIndex + 1}, state ${stateOf(game)}`,
    });
  }
  game.input.setScriptedKeys(null);
  const lines = [`Arena playthroughs: ${results.filter((r) => r.pass).length}/${results.length} pass`];
  for (const r of results) lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.arena} (${r.time.toFixed(1)} s): ${r.detail}`);
  return { text: lines.join('\n'), results };
}
