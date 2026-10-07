import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Session } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { Portal, PortalColor } from '../portals/Portal';
import type { PlayerCommand } from '../player/PlayerCommand';
import { EYE_OFFSET, PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { BotSkill } from './BotSkill';
import type { KnownEnemy, Perception } from './Perception';
import type { NavGraph, NavNode } from './NavGraph';
import type { PathFollower } from './PathFollower';
import type { LookController } from './LookController';
import type { TrapSpot, TrapSpots } from './TrapSpots';

export type Goal = 'idle' | 'escape' | 'trap' | 'steal' | 'orb' | 'hunt' | 'explore';

/** Where it wants to look, and whether to shoot when it gets there. */
export interface AimIntent {
  key: string;
  point: THREE.Vector3;
  fire: PortalColor | null;
}

export interface BrainRecord {
  time: number;
  what: string;
  detail: string;
}

/** Traps: the enemy has to be at least this far away (and within the skill's trap range). */
const TRAP_MIN = 4;
/** Furthest it will shoot an exit portal. */
const EXIT_RANGE = 45;
/** After springing a trap (or giving one up), wait this long before the next. */
const TRAP_COOLDOWN = 3;
/** Give up on a trap if the enemy has been out of sight this long, or it all takes too long. */
const TRAP_PATIENCE = 1.5;
const TRAP_TIME_LIMIT = 6;
/** An exit spot that didn't work is left alone this long. */
const BAD_SPOT_TIME = 15;
/** Lead a walking target by this much of its velocity. */
const LEAD = 0.15;
/**
 * An orb an enemy is much closer to and heading for (or standing right by) is contested:
 * it counts this many times as far.
 */
const CONTESTED = 0.6;
const CONTESTED_COST = 2.5;
/** Changes orb only for one at most this fraction as far as the one it is going for. */
const SWITCH_ORB = 0.6;
/** Someone in a spot it can't trap them in isn't worth hunting down again for this long, unless they move. */
const NOT_TRAPPABLE_TIME = 12;
/** Hunting someone in sight goes on until this fraction of its trap range away. */
const HUNT_CLOSE = 0.8;
/** Where it has been: a breadcrumb every few seconds, for exploring somewhere new. */
const TRAIL_EVERY = 3;
const TRAIL_LENGTH = 12;
/** Explore: somewhere this far off. */
const EXPLORE_MIN = 12;
const EXPLORE_MAX = 45;
/** Sidestep for this long when someone aims at it, then not again for a moment. */
const DODGE_TIME = 0.5;
const DODGE_REST = 1;
/** Someone is lining up a floor portal on it when their aim meets its floor this close to its feet. */
const AIMED_AT = 1.8;
/** A sidestep needs safe floor this far out to that side, metres. */
const DODGE_CLEAR = [1, 2, 3];
/** Too close to a laser beam. */
const LASER_CLEARANCE = 0.9;
/** Steals portals up to this far away, and gives up on one after this long. */
const STEAL_RANGE = 32;
const STEAL_TIME_LIMIT = 3;
/** A portal this close to a trap exit spot is someone's trap exit. */
const AT_TRAP_SPOT = 1.6;
/** Strafing while it aims: this far to the side, metres (plus up to 2 more). */
const STRAFE = 3;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _eye = new THREE.Vector3();

export interface BrainContext {
  session: Session;
  self: ArenaPlayer;
  skill: BotSkill;
  random: () => number;
  perception: Perception;
  nav: NavGraph;
  follower: PathFollower;
  look: LookController;
  traps: TrapSpots;
}

interface TrapPlan {
  stage: 'exit' | 'floor' | 'check';
  spot: TrapSpot;
  enemy: string;
  lastSeen: number;
  /** When a shot was fired (stage 'check': when to look at the result). */
  firedAt: number;
  startedAt: number;
}

interface StealPlan {
  portal: Portal;
  color: PortalColor;
  /** The trap exit spot it is at, if any (stolen with blue, it becomes this bot's exit). */
  spot: TrapSpot | null;
  key: string;
  firedAt: number;
  startedAt: number;
}

/**
 * What a bot decides to do, from what its Perception knows - nothing more:
 *  1. Escape: off floor a hazard is about to (or does) cover, out of a laser beam, and a
 *     sidestep (to a side with safe floor) when someone it can see aims at the floor under it.
 *  2. Trap: an enemy it can see stands on floor that takes portals - put the exit somewhere
 *     deadly to come out of (see TrapSpots), then a portal under the enemy's feet.
 *  3. Steal: an enemy portal it can see - someone's trap exit becomes its own exit, a floor
 *     portal its own floor trap, anything else at least stops working for them.
 *  4. Orb: the nearest orb it knows of that an enemy isn't much closer to.
 *  5. Hunt: no orb known - go where it last saw or heard someone (or close in on someone in
 *     sight but too far off to trap).
 *  6. Explore: nothing known - head somewhere it hasn't been, eyes open for orbs.
 * It moves through its PathFollower and aims and shoots through the same command a person
 * would use. Lining up a shot it stands still, unless its skill keeps it moving.
 */
export class BotBrain {
  goal: Goal = 'idle';
  aim: AimIntent | null = null;
  readonly log: BrainRecord[] = [];
  /** The exit portal it put at a trap spot, if still there. */
  exitSpot: TrapSpot | null = null;

  private readonly c: BrainContext;
  private nextThink = 0;
  private trap: TrapPlan | null = null;
  private trapReadyAt = 0;
  private trapRollAt = 0;
  private trapRolled = false;
  private lastShot = -Infinity;
  private readonly badSpots = new Map<TrapSpot, number>();
  private readonly badOrbs: { at: THREE.Vector3; until: number }[] = [];
  private readonly orbTarget = new THREE.Vector3();
  private hasOrbTarget = false;
  /** Where it has been lately (breadcrumbs) and where it last set off exploring for. */
  private readonly visited: THREE.Vector3[] = [];
  private trailAt = 0;
  /** Enemies last seen where no trap works (spawn pads, near orbs, no portal floor). */
  private readonly notTrappable = new Map<string, { at: THREE.Vector3; until: number }>();
  private dodgeUntil = -Infinity;
  private dodgeDir = 1;
  /** Floor portals it knows of (its own and seen ones): routes never step on them. */
  private floorPortals: THREE.Vector3[] = [];
  /** Which colour the last trap shot was, and where it was aimed (to check where it landed). */
  private shotWas: PortalColor = 'blue';
  private readonly shotAt = new THREE.Vector3();
  private steal: StealPlan | null = null;
  private stealReadyAt = 0;
  private steals = 0;
  /** Whether to go for each enemy portal, decided once per placement. */
  private readonly stealCalls = new Map<Portal, { at: THREE.Vector3; go: boolean }>();
  private strafeDir = 1;

  constructor(c: BrainContext) {
    this.c = c;
    c.follower.avoid = (n) => this.onFloorPortal(n);
  }

  private record(what: string, detail = ''): void {
    this.log.push({ time: this.c.session.time, what, detail });
    if (this.log.length > 400) this.log.splice(0, 100);
  }

  private get pos(): THREE.Vector3 {
    return this.c.self.controller.getPosition();
  }

  // --- Thinking (a few times a second) ---------------------------------------------------

  think(now: number): void {
    if (now < this.nextThink) return;
    this.nextThink = now + this.c.skill.thinkInterval;
    this.refreshFloorPortals();
    this.pruneBad(now);
    this.dropCrumb(now);
    if (this.escape()) return;
    if (this.planTrap(now)) return;
    if (this.planSteal(now)) return;
    if (this.goForOrb(now)) return;
    if (this.hunt(now)) return;
    this.explore();
  }

  private setGoal(g: Goal, detail = ''): void {
    if (g !== this.goal) this.record(`goal:${g}`, detail);
    this.goal = g;
  }

  private dropCrumb(now: number): void {
    if (now < this.trailAt) return;
    this.trailAt = now + TRAIL_EVERY;
    this.visited.push(this.pos);
    if (this.visited.length > TRAIL_LENGTH) this.visited.shift();
  }

  private pruneBad(now: number): void {
    for (const [s, until] of this.badSpots) if (until <= now) this.badSpots.delete(s);
    for (let i = this.badOrbs.length - 1; i >= 0; i--) if (this.badOrbs[i].until <= now) this.badOrbs.splice(i, 1);
  }

  private refreshFloorPortals(): void {
    const own = Object.values(this.c.self.portals);
    this.floorPortals = [
      ...own.filter((p) => p.placed && p.normal.y > 0.7).map((p) => p.surfaceCenter),
      ...[...this.c.perception.portals.entries()].filter(([p]) => p.normal.y > 0.7).map(([, at]) => at),
    ];
  }

  private onFloorPortal(n: NavNode): boolean {
    return this.floorPortals.some((p) => Math.abs(p.x - n.x) < 1.5 && Math.abs(p.z - n.z) < 1.8 && Math.abs(p.y - n.y) < 0.6);
  }

  /** Off dangerous floor, out of a beam. */
  private escape(): boolean {
    const { nav, follower, session } = this.c;
    const pos = this.pos;
    const here = nav.nearest(pos, 1);
    if (here && nav.blocked(here)) {
      const safe = this.safeNodeNear(here);
      if (safe) {
        this.setGoal('escape', 'hazard');
        this.trap = null;
        this.steal = null;
        follower.goTo(nav.standAt(safe));
        return true;
      }
    }
    _v.copy(pos).setY(pos.y + 0.3);
    for (const laser of session.arena.lasers) {
      for (const s of laser.segments) {
        if (distanceToSegment(_v, s.from, s.to) > LASER_CLEARANCE) continue;
        // Step out sideways from the beam.
        _w.copy(s.to).sub(s.from).setY(0);
        const side = new THREE.Vector3(-_w.z, 0, _w.x).normalize();
        if (side.dot(_v.clone().sub(s.from)) < 0) side.negate();
        const out = nav.nearest(pos.clone().addScaledVector(side, 2.5), 2);
        if (out) {
          this.setGoal('escape', 'laser');
          this.trap = null;
          this.steal = null;
          follower.goTo(nav.standAt(out));
          return true;
        }
      }
    }
    return this.goal === 'escape' && (follower.status === 'moving' || follower.status === 'waiting');
  }

  /** Nearest floor (by links) that no hazard covers and no floor portal is on. */
  private safeNodeNear(start: NavNode): NavNode | null {
    const { nav } = this.c;
    const seen = new Set([start.id]);
    const queue = [start];
    while (queue.length && seen.size < 200) {
      const n = queue.shift()!;
      if (n !== start && n.hazards.length === 0 && !this.onFloorPortal(n)) return n;
      for (const l of n.links) {
        if (seen.has(l.to)) continue;
        seen.add(l.to);
        queue.push(nav.nodes[l.to]);
      }
    }
    return null;
  }

  // --- Traps ------------------------------------------------------------------------------

  /** The visible enemy it would trap, nearest first. */
  private visibleEnemy(): KnownEnemy | null {
    let best: KnownEnemy | null = null;
    let bestD = Infinity;
    for (const e of this.c.perception.enemies.values()) {
      if (!e.visible) continue;
      const d = e.position.distanceTo(this.pos);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  private planTrap(now: number): boolean {
    const { skill, random } = this.c;
    if (this.trap) {
      const e = this.c.perception.enemies.get(this.trap.enemy);
      if (e?.visible) this.trap.lastSeen = now;
      const lost = now - this.trap.lastSeen > TRAP_PATIENCE;
      const tooLong = now - this.trap.startedAt > TRAP_TIME_LIMIT;
      if ((lost || tooLong) && this.trap.stage !== 'check') {
        this.record('trap:abandon', lost ? 'lost sight' : 'took too long');
        this.trap = null;
        this.trapReadyAt = now + 1;
        return false;
      }
      // Moved out of sight of the exit spot it was going for: another one, if there is one.
      if (this.trap.stage === 'exit' && !this.c.perception.lineOfSight(_w.copy(this.trap.spot.point).addScaledVector(this.trap.spot.normal, 0.05))) {
        const other = this.pickSpot();
        if (other) this.trap.spot = other;
      }
      this.whileAiming(e?.position ?? null);
      return true;
    }
    if (now < this.trapReadyAt) return false;
    // Easier bots don't always see the chance (re-rolled every few seconds).
    if (now >= this.trapRollAt) {
      this.trapRolled = random() < skill.trapChance;
      this.trapRollAt = now + 3;
    }
    if (!this.trapRolled) return false;
    const enemy = this.visibleEnemy();
    if (!enemy) return false;
    const d = enemy.position.distanceTo(this.pos);
    if (d < TRAP_MIN || d > skill.trapRange || Math.abs(enemy.velocity.y) > 1.5) return false;
    if (!this.floorUnder(enemy)) {
      if (enemy.velocity.lengthSq() < 1) this.notTrappable.set(enemy.id, { at: enemy.position.clone(), until: now + NOT_TRAPPABLE_TIME });
      return false;
    }
    this.notTrappable.delete(enemy.id);
    const ready = this.exitStillThere();
    const spot = ready ? this.exitSpot! : this.pickSpot();
    if (!spot) return false;
    this.trap = { stage: ready ? 'floor' : 'exit', spot, enemy: enemy.id, lastSeen: now, firedAt: 0, startedAt: now };
    this.steal = null;
    this.setGoal('trap', enemy.id);
    this.record('trap:start', ready ? 'exit already set' : 'placing exit');
    this.whileAiming(enemy.position);
    return true;
  }

  /**
   * Lining up a shot: stand still - or, with the skill for it, keep moving: on along the
   * route it was on, else a few metres to one side of the line to `toward` and back.
   */
  private whileAiming(toward: THREE.Vector3 | null): void {
    const { follower, skill, nav, random } = this.c;
    if (!skill.moveWhileAiming) {
      follower.stop();
      return;
    }
    if (follower.status === 'moving' || follower.status === 'waiting') return;
    const pos = this.pos;
    if (toward) _v.copy(toward).sub(pos).setY(0);
    else _v.set(1, 0, 0);
    if (_v.lengthSq() < 1e-4) _v.set(1, 0, 0);
    _v.normalize();
    this.strafeDir = -this.strafeDir;
    _w.set(-_v.z, 0, _v.x).multiplyScalar(this.strafeDir * (STRAFE + 2 * random())).add(pos);
    const n = nav.nearest(_w, 2);
    if (n && !n.hazards.length && !nav.blocked(n) && !this.onFloorPortal(n)) follower.goTo(nav.standAt(n));
  }

  private exitStillThere(): boolean {
    const exit = this.c.self.portals.blue;
    return !!this.exitSpot && exit.placed && exit.owner === this.c.self.id && exit.surfaceCenter.distanceTo(this.exitSpot.point) < 1.6;
  }

  /** The nearest trap exit it can shoot from here. */
  private pickSpot(): TrapSpot | null {
    const { perception, traps } = this.c;
    perception.eye(_eye);
    let best: TrapSpot | null = null;
    let bestD = Infinity;
    for (const s of traps.spots) {
      if (this.badSpots.has(s)) continue;
      _v.copy(_eye).sub(s.point);
      const d = _v.length();
      if (d > EXIT_RANGE || d >= bestD || s.normal.dot(_v) < 0.25 * d) continue;
      if (!perception.lineOfSight(_w.copy(s.point).addScaledVector(s.normal, 0.05))) continue;
      if (this.c.session.noPortalNear(s.point, perception.orbs)) continue;
      best = s;
      bestD = d;
    }
    return best;
  }

  /** The point on portal-taking floor under where the enemy will be, or null. */
  private floorUnder(e: KnownEnemy): THREE.Vector3 | null {
    const { session } = this.c;
    const at = _v.copy(e.position).addScaledVector(_w.copy(e.velocity).setY(0), LEAD);
    const hit = session.physics.world.castRay(
      new RAPIER.Ray(at, { x: 0, y: -1, z: 0 }),
      PLAYER_FEET_OFFSET + 1.5,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => session.physics.getOwner(c.handle)?.type === 'solid',
    );
    if (!hit) return null;
    const point = at.clone().setY(at.y - hit.timeOfImpact);
    const solid = session.level.solidOf(hit.collider.handle);
    const face = solid?.faces.find((f) => {
      if (!f.portalable || f.normal.y < 0.9) return false;
      const l = f.toLocal(point);
      return Math.abs(l.x) <= f.width / 2 && Math.abs(l.y) <= f.height / 2 && Math.abs(l.z) < 0.05;
    });
    // Never under its own feet, nor where no portal may go (orbs it knows of, spawn pads).
    if (!face || point.distanceTo(this.pos) < 2.5) return null;
    if (session.noPortalNear(point, this.c.perception.orbs)) return null;
    return point;
  }

  // --- Stealing ---------------------------------------------------------------------------

  private planSteal(now: number): boolean {
    const st = this.steal;
    if (st) {
      if (st.firedAt) return true; // looking at the result (act)
      const tooLong = now - st.startedAt > STEAL_TIME_LIMIT;
      if (tooLong || !this.stealable(st.portal)) {
        this.record('steal:abandon', tooLong ? 'took too long' : 'out of sight');
        this.steal = null;
        this.stealReadyAt = now + 1;
        return false;
      }
      this.whileAiming(st.portal.surfaceCenter);
      return true;
    }
    if (now < this.stealReadyAt) return false;
    const { perception, traps, random, skill } = this.c;
    let best: StealPlan | null = null;
    let bestValue = -Infinity;
    for (const [p, front] of perception.portals) {
      if (!this.stealable(p)) continue;
      // Go for this one at all? Decided once per placement.
      let call = this.stealCalls.get(p);
      if (!call || call.at.distanceToSquared(front) > 0.25) {
        call = { at: front.clone(), go: random() < skill.stealChance };
        this.stealCalls.set(p, call);
      }
      if (!call.go) continue;
      const spot = traps.spots.find((t) => t.point.distanceTo(p.surfaceCenter) < AT_TRAP_SPOT) ?? null;
      const floor = p.normal.y > 0.7;
      const ownExit = this.exitStillThere();
      // Someone's trap exit becomes its own exit (or, with one already set, just isn't theirs
      // any more); a floor portal becomes its own floor - a trap, once its exit is set.
      const color: PortalColor = floor || ownExit ? 'orange' : 'blue';
      const value = (spot ? 3 : floor ? 2 : 1) - front.distanceTo(this.pos) / STEAL_RANGE;
      if (value > bestValue) {
        bestValue = value;
        best = { portal: p, color, spot: color === 'blue' ? spot : null, key: `steal:${this.steals}`, firedAt: 0, startedAt: now };
      }
    }
    if (!best) return false;
    this.steals++;
    this.steal = best;
    const what = `${best.portal.owner}:${best.portal.color} as ${best.color}${best.spot ? ' (trap exit)' : ''}`;
    this.setGoal('steal', what);
    this.record('steal:start', what);
    this.whileAiming(best.portal.surfaceCenter);
    return true;
  }

  /** An enemy portal it can see right now, near enough and facing it squarely enough to hit. */
  private stealable(p: Portal): boolean {
    const { perception, self } = this.c;
    const front = perception.portals.get(p);
    if (!front || p.owner === self.id) return false;
    perception.eye(_eye);
    _v.copy(_eye).sub(front);
    const d = _v.length();
    return d <= STEAL_RANGE && p.normal.dot(_v) > 0.3 * d && perception.canSee(front);
  }

  // --- Orbs, hunting, exploring ---------------------------------------------------------

  private goForOrb(now: number): boolean {
    const { perception, follower } = this.c;
    const pos = this.pos;
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const o of perception.orbs) {
      if (this.badOrbs.some((b) => b.at.distanceToSquared(o) < 0.25)) continue;
      let mine = o.distanceTo(pos) + Math.abs(o.y - pos.y) * 2;
      // Someone much closer and on their way (or already there) will likely get it first.
      const contested = [...perception.enemies.values()].some((e) => {
        if (e.confidence <= 0.3) return false;
        const d = e.position.distanceTo(o);
        const heading = e.velocity.dot(_v.copy(o).sub(e.position).setY(0).normalize()) > 1.5;
        return d < mine * CONTESTED && (d < 4 || heading);
      });
      if (contested) mine *= CONTESTED_COST;
      // Stick with the orb it is already going for unless another is clearly nearer (as the
      // crow flies, two orbs on far sides of a tier take turns looking nearer).
      if (this.hasOrbTarget && this.orbTarget.distanceToSquared(o) > 0.25) mine /= SWITCH_ORB;
      if (mine >= bestD) continue;
      best = o;
      bestD = mine;
    }
    if (!best) {
      this.hasOrbTarget = false;
      return false;
    }
    const fresh = !this.hasOrbTarget || this.orbTarget.distanceToSquared(best) > 0.25;
    // Got there and it's still "there" (it can't be): don't keep walking on the spot.
    if (!fresh && follower.status === 'arrived') {
      this.badOrbs.push({ at: best.clone(), until: now + 5 });
      this.hasOrbTarget = false;
      return false;
    }
    if (fresh || follower.status === 'idle' || follower.status === 'stuck' || follower.status === 'no-path') {
      // Gave up on the way there (blocked for good, or going nowhere): leave it a while.
      const gaveUp = !fresh && follower.status === 'stuck';
      this.orbTarget.copy(best);
      this.hasOrbTarget = true;
      const status = gaveUp ? 'stuck' : follower.goTo(best);
      if (status === 'no-path' || gaveUp) {
        this.badOrbs.push({ at: best.clone(), until: now + 10 });
        this.hasOrbTarget = false;
        return false;
      }
      this.setGoal('orb', best.toArray().map((v) => v.toFixed(0)).join(','));
    }
    return true;
  }

  private hunt(now: number): boolean {
    const { perception, follower } = this.c;
    let best: KnownEnemy | null = null;
    for (const e of perception.enemies.values()) {
      // Just seen somewhere no trap works, and still there: no point going back for them.
      const skip = this.notTrappable.get(e.id);
      if (skip && now < skip.until && skip.at.distanceTo(e.position) < 3) continue;
      if (!best || e.confidence > best.confidence) best = e;
    }
    if (!best) return false;
    // In sight: close in while too far off to trap them (near enough, the trap decides).
    if (best.visible && best.position.distanceTo(this.pos) < this.c.skill.trapRange * HUNT_CLOSE) return false;
    if (this.goal !== 'hunt' || follower.status !== 'moving') {
      if (follower.goTo(best.position) === 'no-path') return false;
      this.setGoal('hunt', best.id);
    }
    return true;
  }

  private explore(): void {
    const { follower, nav, random } = this.c;
    if (this.goal === 'explore' && (follower.status === 'moving' || follower.status === 'waiting')) return;
    const pos = this.pos;
    let pick: NavNode | null = null;
    let pickScore = -Infinity;
    for (let i = 0; i < 16; i++) {
      const n = nav.nodes[Math.floor(random() * nav.nodes.length)];
      if (!n || n.hazards.length || this.onFloorPortal(n)) continue;
      const d = Math.hypot(n.x - pos.x, n.y - pos.y, n.z - pos.z);
      if (d < EXPLORE_MIN || d > EXPLORE_MAX) continue;
      // Somewhere it hasn't been lately.
      const novelty = Math.min(...this.visited.map((v) => Math.hypot(v.x - n.x, v.y - n.y, v.z - n.z)), 50);
      if (novelty > pickScore) {
        pickScore = novelty;
        pick = n;
      }
    }
    if (!pick) {
      this.setGoal('idle');
      return;
    }
    const target = nav.standAt(pick);
    if (follower.goTo(target) !== 'no-path') {
      this.visited.push(target);
      if (this.visited.length > TRAIL_LENGTH) this.visited.shift();
      this.setGoal('explore');
    }
  }

  // --- Acting (every step) --------------------------------------------------------------

  /** Sidesteps, and sets where to aim (a trap shot) for this step. */
  act(cmd: PlayerCommand, now: number): void {
    this.aim = null;
    this.dodge(cmd, now);
    if (this.steal) {
      this.actSteal(now);
      return;
    }
    const t = this.trap;
    if (!t) return;
    if (t.stage === 'check') {
      if (now < t.firedAt + 0.15) return;
      this.checkShot(now);
      return;
    }
    if (t.stage === 'exit') {
      // Hold fire while something is in the way (it may be walking).
      const clear = this.c.perception.lineOfSight(_w.copy(t.spot.point).addScaledVector(t.spot.normal, 0.05));
      this.aim = { key: `exit:${t.spot.point.toArray().join(',')}`, point: t.spot.point, fire: clear ? 'blue' : null };
      return;
    }
    const e = this.c.perception.enemies.get(t.enemy);
    const floor = e?.visible ? this.floorUnder(e) : null;
    if (!floor) return; // wait for them to step back onto good floor (or give up in think)
    this.aim = { key: `floor:${t.enemy}`, point: floor, fire: 'orange' };
  }

  private actSteal(now: number): void {
    const st = this.steal!;
    if (!st.firedAt) {
      const front = this.c.perception.portals.get(st.portal);
      if (!front) return; // seen gone: think() gives up on it
      this.aim = { key: st.key, point: st.portal.surfaceCenter, fire: this.c.perception.lineOfSight(front) ? st.color : null };
      return;
    }
    if (now < st.firedAt + 0.15) return;
    const mine = st.portal.owner === this.c.self.id;
    if (mine && st.spot) this.exitSpot = st.spot;
    if (!mine) this.stealCalls.set(st.portal, { at: st.portal.surfaceCenter.clone(), go: false });
    this.record(mine ? 'steal:done' : 'steal:failed', mine && st.spot ? 'now its trap exit' : '');
    this.steal = null;
    this.stealReadyAt = now + 1;
  }

  /** After the look update: shoot if on the mark. */
  fire(cmd: PlayerCommand, now: number, eye: THREE.Vector3, yaw: number, pitch: number): void {
    const aim = this.aim;
    const { look, skill } = this.c;
    if (!aim?.fire || look.target !== aim.key || now - this.lastShot < skill.shotCooldown) return;
    if (look.offTarget(eye, yaw, pitch) > skill.aimTolerance) return;
    cmd.fire = aim.fire;
    this.lastShot = now;
    if (this.steal) {
      this.record('shot:steal', aim.point.toArray().map((v) => v.toFixed(1)).join(','));
      this.steal = { ...this.steal, firedAt: now };
    } else if (this.trap) {
      this.record(`shot:${this.trap.stage}`, aim.point.toArray().map((v) => v.toFixed(1)).join(','));
      this.trap = { ...this.trap, stage: 'check', firedAt: now };
      this.shotWas = aim.fire;
      this.shotAt.copy(aim.point);
    }
  }

  private checkShot(now: number): void {
    const t = this.trap!;
    const portal = this.c.self.portals[this.shotWas];
    if (this.shotWas === 'blue') {
      if (portal.placed && portal.surfaceCenter.distanceTo(t.spot.point) < 1.6) {
        this.exitSpot = t.spot;
        this.trap = { ...t, stage: 'floor' };
        this.record('trap:exit-set');
      } else {
        this.badSpots.set(t.spot, now + BAD_SPOT_TIME);
        this.record('trap:exit-failed');
        this.trap = null;
        this.trapReadyAt = now + 0.5;
      }
      return;
    }
    this.record(portal.placed && portal.surfaceCenter.distanceTo(this.shotAt) < 1.6 ? 'trap:sprung' : 'trap:floor-failed');
    this.trap = null;
    this.trapReadyAt = now + TRAP_COOLDOWN;
  }

  /**
   * Someone it can see aims at the floor right under it - about to open a portal there:
   * sidestep for a moment, to a side with safe floor all the way (or not at all).
   */
  private dodge(cmd: PlayerCommand, now: number): void {
    const { skill, session, random } = this.c;
    if (now < this.dodgeUntil) {
      cmd.forward = 0;
      cmd.right = this.dodgeDir;
      return;
    }
    if (!skill.dodges || now < this.dodgeUntil + DODGE_REST || this.trap || this.steal) return;
    const pos = this.pos;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    for (const e of this.c.perception.enemies.values()) {
      if (!e.visible || e.position.distanceTo(pos) > 30) continue;
      const body = session.playerById(e.id)?.controller;
      if (!body) continue;
      // Where they look - their head and gun show it - meets the floor it stands on.
      const yaw = body.lookYaw;
      const pitch = body.lookPitch;
      _v.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
      const eyeY = e.position.y + EYE_OFFSET;
      if (_v.y > -0.02 || eyeY <= feet) continue;
      const t = (feet - eyeY) / _v.y;
      if (Math.hypot(e.position.x + _v.x * t - pos.x, e.position.z + _v.z * t - pos.z) > AIMED_AT) continue;
      const side = this.safeSide(random() < 0.5 ? -1 : 1);
      if (!side) return;
      this.dodgeUntil = now + DODGE_TIME;
      this.dodgeDir = side;
      cmd.forward = 0;
      cmd.right = side;
      this.record('dodge', e.id);
      return;
    }
  }

  /** Which way (1 right, -1 left, as it looks now) has safe floor for a sidestep - `prefer` first - or 0. */
  private safeSide(prefer: number): number {
    const { nav, self } = this.c;
    const pos = this.pos;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    const yaw = self.controller.lookYaw;
    for (const side of [prefer, -prefer]) {
      const ok = DODGE_CLEAR.every((k) => {
        const n = nav.nearest(_w.set(pos.x + Math.cos(yaw) * side * k, pos.y, pos.z - Math.sin(yaw) * side * k), 0);
        return !!n && !n.hazards.length && !nav.blocked(n) && !this.onFloorPortal(n) && Math.abs(n.y - feet) < 0.7;
      });
      if (ok) return side;
    }
    return 0;
  }
}

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = _w.copy(b).sub(a);
  const t = THREE.MathUtils.clamp(_eye.copy(p).sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}
