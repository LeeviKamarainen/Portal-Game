import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ArenaSim } from '../sim/ArenaSim';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { Portal, PortalColor } from '../portals/Portal';
import type { PlayerCommand } from '../player/PlayerCommand';
import { EYE_OFFSET, FALL_DAMAGE_THRESHOLD, PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { BotSkill } from './BotSkill';
import type { KnownEnemy, Perception } from './Perception';
import type { NavGraph, NavNode } from './NavGraph';
import type { PathFollower } from './PathFollower';
import type { LookController } from './LookController';
import { PORTAL_DELAY, trapValue, type TrapSpot, type TrapSpots } from './TrapSpots';
import type { ClimbSpot, ClimbSpots } from './ClimbSpots';

export type Goal = 'idle' | 'escape' | 'climb' | 'trap' | 'steal' | 'orb' | 'hunt' | 'explore';

/** Where it wants to look, and whether to shoot when it gets there. */
export interface AimIntent {
  key: string;
  point: THREE.Vector3;
  fire: PortalColor | null;
  /** Fire once this close, radians (default: the skill's aim tolerance) - tighter for small targets. */
  tolerance?: number;
  /** A shot it planned before it could see the mark (out of a climb): no reaction delay. */
  planned?: boolean;
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
/**
 * An exit is worth taking if it kills or takes at least this share of what health the enemy
 * has left (damage stays: health doesn't come back, so a second drop finishes them).
 */
const MIN_TRAP_VALUE = 0.45;
/**
 * Choosing among exits, in points: a sure kill always beats a fall (whatever is in view); of
 * falls, the more damage the better, a ceiling drop a good deal ahead (it lands the victim
 * right under the slot, in view and in reach of a second one - and often off a narrow
 * walkway); each metre of distance costs a little (further is harder to hit).
 */
const KILL_SCORE = 100;
const TIMED_SCORE = 90;
const FALL_SCORE = 30;
const DROP_BONUS = 12;
const EXIT_DISTANCE_COST = 0.4;
/** Candidates that get the (ray-casting) look: this many of the best-scored at most. */
const EXIT_RAYS = 80;
/** Working out whether a trap exit can be seen from a climb's landing: this many tried. */
const TRAP_VIEW_TRIES = 30;
/** A timed hazard (cycling spikes) is only worth waiting for if its window opens within this long, seconds. */
const TIMED_WAIT = 2;
/**
 * How far off the mark a trap shot may land, metres. A floor portal is about 2 m long and
 * lies along the line of fire, so a miss along the ground is forgiven up to this; but that
 * one metre is a tiny angle from far off and low down (a hair of aim error at 25 m is 6 m
 * of floor), so the angle it has to hold - and how far away it tries - follows from this.
 */
const FLOOR_SLACK = 0.8;
const EXIT_SLACK = 0.5;
/** Never asked to hold the view closer than this, radians (a hand is not steadier). */
const MIN_ANGLE = 0.0026;
/** Give up on a trap if the enemy has been out of sight this long, or it all takes too long. */
const TRAP_PATIENCE = 1.5;
const TRAP_TIME_LIMIT = 6;
const TRAP_TIME_LIMIT_TIMED = 9;
/** Sprung trap: long enough for the victim to drop through and come out the other side. */
const PORTAL_HOLD = 1.6;
/** Its own floor portal this close is a step away: a new exit would make it a live trap for itself. */
const OWN_ENTRANCE_NEAR = 3.6;
/** Setting a trap exit in advance (`anticipate`): tries this often, and gives up on a shot after this long. */
const PREP_EVERY = 1.5;
const PREP_TIME_LIMIT = 3;
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
/** A sidestep needs safe floor all the way to where it would end up (running speed times DODGE_TIME, plus this much), metres. */
const DODGE_MARGIN = 1;
/** A floor trap goes no nearer than this to where it is, or will be in this long (it may be walking), m / s. */
const OWN_FLOOR_CLEAR = 3;
const OWN_FLOOR_AHEAD = 0.6;
/** Keep this far from an open floor portal's centre: half its length, a body's width and a margin. */
const FLOOR_PORTAL_CLEAR = 2.2;
/** ...but never nearer than this (half its length): that is on it. */
const FLOOR_PORTAL_EDGE = 1.3;
/** An escape is over once this far from where it set off. */
const ESCAPE_REACH = 6;
/** Too close to a laser beam. */
const LASER_CLEARANCE = 0.9;
/** Steals portals up to this far away, and gives up on one after this long. */
const STEAL_RANGE = 32;
const STEAL_TIME_LIMIT = 3;
/** The same portal is gone for this many times at most in this long (stealing it back and forth never ends). */
const STEAL_REPEAT = 2;
const STEAL_REPEAT_TIME = 30;
/** A portal this close to a trap exit spot is someone's trap exit. */
const AT_TRAP_SPOT = 1.6;
/** Strafing while it aims: this far to the side, metres (plus up to 2 more). */
const STRAFE = 3;
/** Portal climbs: an enemy at least this much higher, an exit this near, landing this far from them. */
const CLIMB_UP = 3.5;
const CLIMB_RANGE = 45;
const CLIMB_LAND_MIN = 3;
const CLIMB_LAND_MAX = 22;
const CLIMB_LAND_BEST = 9;
/** A climb with no deadly trap exit in view on the way down counts as this many metres worse. */
const NO_TRAP_VIEW = 12;
/** The floor portal it walks into: this far from where it stands. */
const ENTRANCE_RINGS = [2.4, 3.2];
/** Give up on a climb after this long (walking into the entrance: after this long). */
const CLIMB_TIME_LIMIT = 14;
const CLIMB_WALK_LIMIT = 3;
/** No clear line to a climb shot's mark for this long: look for another (or give up). */
const CLIMB_BLOCKED = 0.7;
/** Through: this close to the exit, up on the high floor. */
const CLIMB_THROUGH = 4;
/** Climb shots wait until the view is within this much of the mark (at the mark's distance), metres. */
const CLIMB_AIM = 0.3;
/** After a climb it tries to trap them straight away for this long (in the air, then landing). */
const AFTER_CLIMB = 2;
/** A drop-in for show waits this long after a trap on someone was last tried (a retry is quicker). */
const COMBO_AFTER_TRAP = 2;
/** Ceiling drop-ins for the fun of it (`comboChance`, rolled every `comboEvery`): they're this far from where it lands at most. */
const COMBO_REACH = 30;
/** Looking at where a planned shot landed: the next moment (others: the skill's `checkDelay`). */
const CHECK_AFTER_PLANNED = 0.04;
/** Who to go after: nearness (out to this far) and their score count about equally; the current one gets a little extra. */
const FOCUS_RANGE = 50;
const FOCUS_STICKY = 0.15;
const FOCUS_WOUNDED = 0.15;
/** Looking for somewhere to shoot an exit from: this many floor points tried, this far off at most. */
const VANTAGE_TRIES = 60;
const VANTAGE_RANGE = 30;
/** No vantage point found: look again after this long. */
const VANTAGE_RETRY = 2;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _eye = new THREE.Vector3();

export interface BrainContext {
  session: ArenaSim;
  self: ArenaPlayer;
  skill: BotSkill;
  random: () => number;
  perception: Perception;
  nav: NavGraph;
  follower: PathFollower;
  look: LookController;
  traps: TrapSpots;
  /** Portal climbs onto high ground (only for skills with `portalClimb`). */
  climbs: ClimbSpots | null;
}

interface ClimbPlan {
  /** approach: walking to somewhere it can shoot the exit from (and has floor for a way in). */
  stage: 'approach' | 'exit' | 'entrance' | 'walk';
  spot: ClimbSpot;
  enemy: string;
  /** Where its floor portal (the way in) goes (picked on arrival, when approaching). */
  entrance: THREE.Vector3 | null;
  /** When this stage's shot was fired (0: not yet), and when the stage began. */
  firedAt: number;
  stageAt: number;
  startedAt: number;
  key: string;
  /** This stage's shot missed once already. */
  retried: boolean;
  /** Since when this stage's shot has had no clear line (0: it has). */
  blockedSince: number;
  /** Up to someone on high ground, or a drop-in from a ceiling for the fun of it. */
  why: 'high' | 'combo';
  /** Floor height it set off from. */
  fromFeet: number;
}

interface TrapPlan {
  stage: 'exit' | 'floor' | 'check';
  spot: TrapSpot;
  enemy: string;
  /** Last time it had a shot for this stage (a clear line to the exit spot / their floor). */
  lastChance: number;
  /** When a shot was fired (stage 'check': when to look at the result). */
  firedAt: number;
  startedAt: number;
  /** Planned before a climb (or a skill that decides for itself): the shots come with no reaction delay. */
  planned: boolean;
  /** Just setting the exit up in advance, no enemy yet (`anticipate`). */
  prep: boolean;
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
 *  1b. Climb (`portalClimb` skills): an enemy on higher ground - an exit portal up there (low
 *     on a wall over their floor, or a ceiling above it), a portal on the floor beside itself,
 *     walk in, and set a trap on them on the way down (flashing immunity for a hard landing).
 *     Now and then (`comboChance`) the same through a ceiling just to drop in on someone.
 *  2. Trap: an enemy it can see stands on floor that takes portals - put the exit somewhere
 *     deadly to come out of (see TrapSpots), then a portal under the enemy's feet.
 *  3. Steal: an enemy portal it can see - someone's trap exit becomes its own exit, a floor
 *     portal its own floor trap, anything else at least stops working for them.
 *  4. Orb: the nearest orb it knows of that an enemy isn't much closer to.
 *  5. Hunt: no orb known - go where it last saw or heard someone (or close in on someone in
 *     sight but too far off to trap).
 *  6. Explore: nothing known - head somewhere it hasn't been, eyes open for orbs.
 * Who it goes after, with more than one enemy about, balances who is nearest against who is
 * winning (see priority). It moves through its PathFollower and aims and shoots through the
 * same command a person would use. Lining up a shot it stands still, unless its skill keeps
 * it moving.
 */
export class BotBrain {
  goal: Goal = 'idle';
  aim: AimIntent | null = null;
  readonly log: BrainRecord[] = [];
  /** The exit portal it put at a trap spot, if still there. */
  exitSpot: TrapSpot | null = null;
  /** The enemy it last went after (trap, climb, hunt): kept to unless another is clearly better. */
  focusId: string | null = null;
  /** Running totals (the log only keeps the last few hundred records): climbs made, traps started on whom. */
  readonly stats = { climbs: 0, dropIns: 0, trapsOn: new Map<string, number>(), sprung: new Map<string, number>() };

  private readonly c: BrainContext;
  private nextThink = 0;
  private trap: TrapPlan | null = null;
  private trapReadyAt = 0;
  private trapRollAt = 0;
  private trapRolled = false;
  private prepAt = 0;
  /** After springing a trap: its portals are left as they are until the victim has been through (or this long). */
  private holdPortalsUntil = 0;
  private holdFor: string | null = null;
  /** Last time a trap on someone was on (started, failed, given up): drop-ins for show wait for a retry first. */
  private trapActiveAt = -Infinity;
  /** Damage its own traps have done to each enemy, and which life of theirs it was (what it can know without seeing health). */
  private readonly hurt = new Map<string, { damage: number; life: number }>();
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
  /** Which way the sidestep goes, in the world (the head may turn meanwhile): unit, horizontal. */
  private readonly dodgeDir = new THREE.Vector3();
  /** Floor portals it knows of (its own and seen ones): routes never step on them. */
  private floorPortals: THREE.Vector3[] = [];
  /** Which colour the last trap shot was, and where it was aimed (to check where it landed). */
  private shotWas: PortalColor = 'blue';
  private readonly shotAt = new THREE.Vector3();
  private steal: StealPlan | null = null;
  private stealReadyAt = 0;
  private steals = 0;
  /** Portals it has gone for, how often lately: the same one back and forth is a stalemate, not a plan. */
  private readonly stealTries = new Map<Portal, { n: number; at: number }>();
  /** Whether to go for each enemy portal, decided once per placement. */
  private readonly stealCalls = new Map<Portal, { at: THREE.Vector3; go: boolean }>();
  private strafeDir = 1;
  private climb: ClimbPlan | null = null;
  private readonly escapeFrom = new THREE.Vector3();
  /** Just came through a climb: trap this enemy as soon as it can, until then. */
  private afterClimb: { enemy: string; until: number } | null = null;
  private climbReadyAt = 0;
  private comboRollAt = 0;
  private climbs = 0;
  private readonly badClimbs = new Map<ClimbSpot, number>();
  private readonly climbTrapView = new Map<ClimbSpot, boolean>();

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
    if (this.climb && this.planClimb(now)) return;
    if (this.trapAfterClimb(now)) return;
    // A trap under way carries on; a sure kill in reach comes before a drop-in for show (the
    // quickest kill first) - but a mere fall doesn't: the drop-in's trap on the way down kills.
    if ((this.trap || this.sureKillAvailable()) && this.planTrap(now)) return;
    if (this.planCombo(now)) return;
    if (this.planTrap(now)) return;
    if (this.planClimb(now)) return;
    if (this.planSteal(now)) return;
    if (this.goForOrb(now)) return;
    if (this.hunt(now)) return;
    this.explore();
  }

  /**
   * Dead: whatever it was in the middle of is over (it comes back on its spawn pad with its
   * portals closed) - a climb it still believed in would have it stand there staring at a
   * floor portal it no longer has, until it gave up.
   */
  died(): void {
    if (this.goal === 'idle' && !this.trap && !this.steal && !this.climb) return;
    this.trap = null;
    this.steal = null;
    this.climb = null;
    this.afterClimb = null;
    this.hasOrbTarget = false;
    this.dodgeUntil = -Infinity;
    this.aim = null;
    this.goal = 'idle';
    this.nextThink = 0;
    this.trapReadyAt = 0;
    this.c.follower.stop();
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
    for (const [s, until] of this.badClimbs) if (until <= now) this.badClimbs.delete(s);
    for (let i = this.badOrbs.length - 1; i >= 0; i--) if (this.badOrbs[i].until <= now) this.badOrbs.splice(i, 1);
  }

  private refreshFloorPortals(): void {
    const own = Object.values(this.c.self.portals);
    // (One whose partner isn't placed takes nobody anywhere: not in the way.)
    this.floorPortals = [
      ...own.filter((p) => p.isOpen && p.normal.y > 0.7).map((p) => p.surfaceCenter),
      ...[...this.c.perception.portals.entries()].filter(([p]) => p.isOpen && p.normal.y > 0.7).map(([, at]) => at),
    ];
  }

  /**
   * Floor on or beside an open floor portal (it may lie either way round; a body is ~0.8 m
   * wide). Already inside that margin (a portal opened right by it - say, someone's trap),
   * the way out has to stay open: only floor nearer the portal than it stands now is off limits.
   */
  private onFloorPortal(n: NavNode): boolean {
    const pos = this.pos;
    return this.floorPortals.some((p) => {
      if (Math.abs(p.y - n.y) >= 0.6) return false;
      const mine = Math.hypot(p.x - pos.x, p.z - pos.z);
      const clear = mine < FLOOR_PORTAL_CLEAR && Math.abs(p.y - (pos.y - PLAYER_FEET_OFFSET)) < 0.6 ? Math.max(mine - 0.15, FLOOR_PORTAL_EDGE) : FLOOR_PORTAL_CLEAR;
      return Math.hypot(p.x - n.x, p.z - n.z) < clear;
    });
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
        this.climb = null;
        follower.goTo(nav.standAt(safe));
        this.escapeFrom.copy(pos);
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
          this.climb = null;
          follower.goTo(nav.standAt(out));
          this.escapeFrom.copy(pos);
          return true;
        }
      }
    }
    // Carry on getting clear - unless knocked well away from it (then the danger is behind it).
    const going = follower.status === 'moving' || follower.status === 'waiting';
    return this.goal === 'escape' && going && pos.distanceTo(this.escapeFrom) < ESCAPE_REACH;
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

  /**
   * How much it wants to go after `e`: how near they are and how well they're doing count
   * about equally - whoever is close is the easy chance, the leader the one to stop (early
   * on, a few points ahead counts for little) - plus a little for the one it's already after.
   */
  priority(e: KnownEnemy): number {
    const near = 1 - Math.min(e.position.distanceTo(this.pos), FOCUS_RANGE) / FOCUS_RANGE;
    const match = this.c.session.match;
    let lead = 0;
    if (match) {
      const top = Math.max(match.rules.scoreToWin * 0.25, ...match.players.map((p) => p.score));
      lead = (match.player(e.id)?.score ?? 0) / top;
    }
    // Someone already hurt is the nearer kill (a fall's damage stays).
    const wounded = (1 - this.healthOf(e.id) / 100) * FOCUS_WOUNDED;
    return near + lead + wounded + (e.id === this.focusId ? FOCUS_STICKY : 0);
  }

  /** The one of `among` it would most like to go after. */
  private target(among: Iterable<KnownEnemy>, weight: (e: KnownEnemy) => number = () => 1): KnownEnemy | null {
    let best: KnownEnemy | null = null;
    let bestP = -Infinity;
    for (const e of among) {
      const p = this.priority(e) * weight(e);
      if (p > bestP) {
        bestP = p;
        best = e;
      }
    }
    return best;
  }

  /** The visible enemy it would trap. */
  private visibleEnemy(): KnownEnemy | null {
    return this.target([...this.c.perception.enemies.values()].filter((e) => e.visible));
  }

  private planTrap(now: number): boolean {
    const { skill, random } = this.c;
    if (this.trap) {
      const tr = this.trap;
      if (tr.prep) return this.keepPrepping(now);
      const e = this.c.perception.enemies.get(tr.enemy);
      // (An omniscient bot always knows where they are: what counts is having a shot.)
      const lost = !e?.visible || now - tr.lastChance > TRAP_PATIENCE;
      const tooLong = now - tr.startedAt > (tr.spot.kind === 'timed' ? TRAP_TIME_LIMIT_TIMED : TRAP_TIME_LIMIT);
      if ((lost || tooLong) && tr.stage !== 'check') {
        this.record('trap:abandon', lost ? 'no shot' : 'took too long');
        this.trap = null;
        this.trapReadyAt = now + 1;
        this.trapActiveAt = now;
        return false;
      }
      // Moved out of sight of the exit spot it was going for: another one, if there is one.
      if (tr.stage === 'exit' && !this.c.perception.clearShot(_w.copy(tr.spot.point).addScaledVector(tr.spot.normal, 0.05))) {
        const other = this.pickSpot(this.healthOf(tr.enemy));
        if (other) tr.spot = other;
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
    if (enemy && this.startTrap(enemy, now, false)) return true;
    return skill.anticipate && this.prepareExit(now);
  }

  /**
   * A kill (not just damage) is on offer against the enemy it would go after: a lethal or
   * timed exit set or in view, and a trap possible now. A look only - nothing is started.
   */
  private sureKillAvailable(): boolean {
    if (this.climb || this.steal || this.afterClimb) return false;
    const enemy = this.visibleEnemy();
    if (!enemy) return false;
    const health = this.healthOf(enemy.id);
    const have = this.exitStillThere() ? this.exitSpot : null;
    if (have && this.usable(have, health) && trapValue(have, health) >= 0.9) return true;
    const found = this.pickSpot(health);
    return !!found && trapValue(found, health) >= 0.9;
  }

  /** Eye height above the floor under `at`, at least a metre (a low shot gets nowhere). */
  private heightAbove(at: THREE.Vector3, feetOffset: number): number {
    return Math.max(1, this.c.perception.eye(_eye).y - (at.y - feetOffset));
  }

  /**
   * The furthest it can lay a floor portal under `enemy` and expect to be near enough: the
   * distance at which the angle the slack leaves (FLOOR_SLACK, a glancing shot) is as small
   * as its hand holds. From higher ground the angle is steeper and it reaches further.
   */
  private floorReach(enemy: KnownEnemy): number {
    const { skill } = this.c;
    const hold = Math.max(skill.aimWobble * 1.5, MIN_ANGLE);
    const reach = Math.sqrt((FLOOR_SLACK * this.heightAbove(enemy.position, PLAYER_FEET_OFFSET)) / hold);
    return Math.min(skill.trapRange, reach);
  }

  /** The angle within which a shot at `point` (on the floor, `onFloor`) lands within the slack. */
  private shotTolerance(point: THREE.Vector3, onFloor: boolean): number {
    const eye = this.c.perception.eye(_eye);
    const d = Math.max(1, eye.distanceTo(point));
    const tol = onFloor ? (FLOOR_SLACK * Math.max(1, eye.y - point.y)) / (d * d) : EXIT_SLACK / d;
    return Math.min(this.c.skill.aimTolerance, Math.max(tol, MIN_ANGLE * 0.6));
  }

  /**
   * What it believes someone's health to be: Hard (omniscient) knows; the others know only
   * the damage their own traps did to them (it stays: health doesn't come back).
   */
  private healthOf(id: string): number {
    const p = this.c.session.playerById(id);
    if (this.c.skill.omniscient) return p?.controller.health.value ?? 100;
    const h = this.hurt.get(id);
    // (A new life starts at full health.)
    if (!h || !p || h.life !== p.respawns) return 100;
    return Math.max(1, 100 - h.damage);
  }

  /**
   * A trap on `enemy`, if one works from here: they stand on portal-taking floor it has a
   * clear shot at, and a good exit is set or in view. `straightAway` (just out of a portal
   * climb, maybe still in the air): even if they're close.
   */
  private startTrap(enemy: KnownEnemy, now: number, straightAway: boolean): boolean {
    const { skill, perception } = this.c;
    const no = (why: string) => {
      if (straightAway && this.log[this.log.length - 1]?.detail !== why) this.record('trap:none', why);
      return false;
    };
    const d = enemy.position.distanceTo(this.pos);
    if ((!straightAway && d < TRAP_MIN) || d > this.floorReach(enemy) || Math.abs(enemy.velocity.y) > 1.5) return no('out of range');
    const floor = this.floorUnder(enemy);
    if (!floor) {
      if (enemy.velocity.lengthSq() < 1) this.notTrappable.set(enemy.id, { at: enemy.position.clone(), until: now + NOT_TRAPPABLE_TIME });
      return no('no portal floor under them');
    }
    // (An omniscient bot knows where they are through walls - it still needs a clear shot.)
    if (!perception.clearShot(floor.setY(floor.y + 0.05))) return no('no clear shot at their floor');
    this.notTrappable.delete(enemy.id);
    // The exit it has set, if it is as good as any in view (a shot saved); else the best one in view.
    const health = this.healthOf(enemy.id);
    const have = this.exitStillThere() ? this.exitSpot! : null;
    const haveValue = have && this.usable(have, health) ? trapValue(have, health) : 0;
    let spot: TrapSpot | null = have && haveValue >= 0.9 ? have : null;
    if (!spot) {
      const found = this.pickSpot(health);
      spot = found && trapValue(found, health) > haveValue + 0.2 ? found : haveValue >= MIN_TRAP_VALUE ? have : found;
    }
    if (!spot) return no('no deadly exit in view');
    const ready = spot === have;
    // A new exit re-links its floor portal: not while one of its own is open right beside it.
    if (!ready && this.ownFloorPortalNear()) return no('its own floor portal is too close');
    this.trap = { stage: ready ? 'floor' : 'exit', spot, enemy: enemy.id, lastChance: now, firedAt: 0, startedAt: now, planned: straightAway || skill.decisive, prep: false };
    this.trapActiveAt = now;
    this.focusId = enemy.id;
    this.stats.trapsOn.set(enemy.id, (this.stats.trapsOn.get(enemy.id) ?? 0) + 1);
    this.steal = null;
    this.setGoal('trap', enemy.id);
    this.record('trap:start', `${spot.kind}/${spot.cause} ${ready ? 'exit already set' : 'placing exit'}${straightAway ? ' (straight after a climb)' : ''}`);
    this.whileAiming(enemy.position);
    return true;
  }

  /**
   * Hard: no one to trap right now, so put the exit up now - in the best deadly spot it can
   * see - and the trap is a single shot when someone steps on good floor.
   */
  private prepareExit(now: number): boolean {
    const { perception } = this.c;
    if (now < this.prepAt || this.climb || this.steal || this.exitStillThere() || this.ownFloorPortalNear() || this.portalsBusy(now)) return false;
    this.prepAt = now + PREP_EVERY;
    // Against a full-health body (it doesn't know yet who it will meet).
    const spot = this.pickSpot(100);
    if (!spot || perception.enemies.size === 0) return false;
    this.trap = { stage: 'exit', spot, enemy: '', lastChance: now, firedAt: 0, startedAt: now, planned: true, prep: true };
    this.record('trap:prepare', `${spot.kind}/${spot.cause}`);
    return true;
  }

  /** A pre-set exit goes on while it still has the shot; a real chance cancels it. */
  private keepPrepping(now: number): boolean {
    const tr = this.trap!;
    if (tr.stage === 'check') return true;
    const lost = now - tr.startedAt > PREP_TIME_LIMIT || now - tr.lastChance > 0.5;
    if (lost) {
      this.record('trap:prepare-abandon');
      this.trap = null;
      return false;
    }
    const enemy = this.visibleEnemy();
    if (enemy) {
      // Someone to trap: drop the prep (the trap takes the exit shot over, or just starts).
      this.trap = null;
      if (this.startTrap(enemy, now, false)) return true;
      this.trap = tr;
    }
    this.whileAiming(null);
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

  /**
   * Whether a portal it has just used for a trap is still at work: moving either of them now
   * (a climb's exit, a steal, a new exit) would send the victim somewhere else, or nowhere.
   */
  private portalsBusy(now: number): boolean {
    if (now >= this.holdPortalsUntil) return false;
    // Dead (or gone): the trap has done what it will.
    const victim = this.holdFor ? this.c.session.playerById(this.holdFor) : null;
    if (!victim || victim.dead) {
      this.holdPortalsUntil = 0;
      return false;
    }
    return true;
  }

  /** An open floor portal of its own within a few steps (a climb's way in it left behind, say). */
  private ownFloorPortalNear(): boolean {
    const o = this.c.self.portals.orange;
    return o.placed && o.normal.y > 0.7 && o.surfaceCenter.distanceTo(this.pos) < OWN_ENTRANCE_NEAR;
  }

  private exitStillThere(): boolean {
    const exit = this.c.self.portals.blue;
    return !!this.exitSpot && exit.placed && exit.owner === this.c.self.id && exit.surfaceCenter.distanceTo(this.exitSpot.point) < 1.6;
  }

  /**
   * Whether the exit is any use: a kill or enough damage - a timed one only if its window
   * opens soon (and can still be hit).
   */
  private usable(s: TrapSpot, health: number): boolean {
    if (trapValue(s, health) < MIN_TRAP_VALUE) return false;
    if (s.kind !== 'timed') return true;
    const t = this.timing(s);
    return !!t && t.earliest <= TIMED_WAIT && t.latest >= 0.2;
  }

  /**
   * When a floor portal has to be shot for whoever drops through to land in the hazard's
   * deadly window: `earliest` .. `latest` seconds from now. Null if the window is too short for
   * the spread of flight times (or not coming).
   */
  private timing(s: TrapSpot): { earliest: number; latest: number } | null {
    const w = s.hazard?.deadlyWindow?.();
    if (!w) return null;
    const earliest = Math.max(0, w.from - (s.flight[0] + PORTAL_DELAY));
    const latest = w.to - (s.flight[1] + PORTAL_DELAY);
    return latest >= earliest ? { earliest, latest } : null;
  }

  /**
   * The best exit it can shoot from here against someone with `health`: a sure kill over a
   * fall, the nearer of equals, a ceiling drop a little ahead (it lands right under the
   * slot, in view, for a second drop).
   */
  private pickSpot(health: number): TrapSpot | null {
    const { perception, traps, session } = this.c;
    perception.eye(_eye);
    const cands: { s: TrapSpot; score: number }[] = [];
    for (const s of traps.spots) {
      if (this.badSpots.has(s)) continue;
      const value = trapValue(s, health);
      if (value < MIN_TRAP_VALUE) continue;
      _v.copy(_eye).sub(s.point);
      const d = _v.length();
      if (d > EXIT_RANGE || s.normal.dot(_v) < 0.25 * d) continue;
      if (s.kind === 'timed' && !this.usable(s, health)) continue;
      const base = value >= 1 ? KILL_SCORE : s.kind === 'timed' ? TIMED_SCORE : value * FALL_SCORE + (s.drop ? DROP_BONUS : 0);
      cands.push({ s, score: base - d * EXIT_DISTANCE_COST });
    }
    cands.sort((a, b) => b.score - a.score);
    // (The nearest are often right behind something: a budget of rays, not a short list.)
    for (const { s } of cands.slice(0, EXIT_RAYS)) {
      if (!perception.clearShot(_w.copy(s.point).addScaledVector(s.normal, 0.05))) continue;
      if (session.noPortalNear(s.point, perception.orbs)) continue;
      return s;
    }
    return null;
  }

  /** The point on portal-taking floor under where the enemy will be, or null. */
  private floorUnder(e: KnownEnemy): THREE.Vector3 | null {
    const { session } = this.c;
    const point = this.portalFloor(_v.copy(e.position).addScaledVector(_w.copy(e.velocity).setY(0), LEAD));
    // Never under (or about to be under) its own feet, nor where no portal may go (orbs it
    // knows of, spawn pads).
    const pos = this.pos;
    if (!point || point.distanceTo(pos) < OWN_FLOOR_CLEAR) return null;
    if (point.distanceTo(_w.copy(this.c.self.controller.getVelocity()).setY(0).multiplyScalar(OWN_FLOOR_AHEAD).add(pos)) < OWN_FLOOR_CLEAR) return null;
    if (session.noPortalNear(point, this.c.perception.orbs)) return null;
    return point;
  }

  /** Portal-taking floor under `at` (a body-centre height point), or null. */
  private portalFloor(at: THREE.Vector3): THREE.Vector3 | null {
    const { session } = this.c;
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
    return face ? point : null;
  }

  // --- Portal climbs ------------------------------------------------------------------------

  private planClimb(now: number): boolean {
    const { climbs, skill, follower, perception, self } = this.c;
    const cl = this.climb;
    if (cl) {
      const pos = this.pos;
      if (cl.stage === 'walk' && this.cameThrough(cl)) return this.climbThrough(now);
      const e = perception.enemies.get(cl.enemy);
      // Came down off the high ground (or, for a drop-in, wandered off from where it lands).
      const away = (k: KnownEnemy) =>
        cl.why === 'high' ? k.position.y - pos.y < CLIMB_UP - 1 : Math.hypot(k.position.x - cl.spot.land.x, k.position.z - cl.spot.land.z) > COMBO_REACH + 6;
      const gone = cl.stage !== 'walk' && (!e || away(e));
      const tooLong = now - cl.startedAt > CLIMB_TIME_LIMIT || (cl.stage === 'walk' && now - cl.stageAt > CLIMB_WALK_LIMIT);
      if (gone || tooLong) {
        this.record('climb:abandon', gone ? (cl.why === 'high' ? 'they came down' : 'they moved off') : 'took too long');
        if (tooLong) this.badClimbs.set(cl.spot, now + BAD_SPOT_TIME);
        this.climb = null;
        this.climbReadyAt = now + this.c.skill.climbCooldown;
        return false;
      }
      if (cl.stage === 'approach') {
        // There (or as near as it gets): shoot from here if it can.
        const status = follower.status;
        if (status === 'moving' || status === 'waiting') return true;
        if (status !== 'arrived') {
          // Couldn't walk there: look for another place shortly.
          this.record('climb:abandon', `couldn't get to the vantage point (${status})`);
          this.climb = null;
          this.climbReadyAt = now + 1;
          return false;
        }
        // The exit it came here for, if it's in view as hoped; else whatever is.
        perception.eye(_eye);
        _v.copy(_eye).sub(cl.spot.point);
        const planned = _v.length() <= CLIMB_RANGE && cl.spot.normal.dot(_v) > 0.25 * _v.length() && perception.clearShot(_w.copy(cl.spot.point).addScaledVector(cl.spot.normal, 0.05));
        const spot = planned ? cl.spot : e ? this.pickClimb(e) : null;
        const entrance = spot ? this.pickEntrance() : null;
        if (!spot || !entrance) {
          this.record('climb:abandon', `no shot from the vantage point (${status}${spot ? ', no floor for a way in' : ''})`);
          this.badClimbs.set(cl.spot, now + BAD_SPOT_TIME);
          this.climb = null;
          this.climbReadyAt = now + this.c.skill.climbCooldown;
          return false;
        }
        this.climb = { ...cl, stage: 'exit', spot, entrance, firedAt: 0, stageAt: now };
        this.record('climb:exit-in-view', `${spot.kind} at ${spot.point.toArray().map((v) => v.toFixed(0)).join(',')}`);
      }
      follower.stop();
      return true;
    }
    if (!climbs || !skill.portalClimb || now < this.climbReadyAt || !self.controller.isGrounded || this.portalsBusy(now)) return false;
    const pos = this.pos;
    // Someone well above it, that a trap from down here can't reach.
    const enemy = this.target([...perception.enemies.values()].filter((e) => e.visible && e.position.y - pos.y >= CLIMB_UP));
    if (!enemy) return false;
    const spot = this.pickClimb(enemy);
    // With orbs to collect, climbing is only worth it if a trap can follow.
    if (spot && perception.orbs.length && !this.trapInView(spot)) {
      this.climbReadyAt = now + VANTAGE_RETRY;
      return false;
    }
    const entrance = spot ? this.pickEntrance() : null;
    if (!spot || !entrance) {
      // Nothing to shoot from here: walk somewhere that has an exit in view.
      const vantage = this.findVantage(enemy);
      this.climbReadyAt = now + (vantage ? 0 : VANTAGE_RETRY);
      if (!vantage || follower.goTo(vantage.at) === 'no-path') return false;
      this.climb = {
        stage: 'approach',
        spot: vantage.spot,
        enemy: enemy.id,
        entrance: null,
        firedAt: 0,
        stageAt: now,
        startedAt: now,
        key: `climb:${this.climbs++}`,
        retried: false,
        blockedSince: 0,
        why: 'high',
        fromFeet: pos.y - PLAYER_FEET_OFFSET,
      };
      this.focusId = enemy.id;
      this.trap = null;
      this.steal = null;
      this.setGoal('climb', `walking to a spot to shoot a ${vantage.spot.kind} exit from`);
      this.record('climb:approach', vantage.at.toArray().map((v) => v.toFixed(0)).join(','));
      return true;
    }
    this.startClimb(spot, enemy, entrance, 'high', now);
    return true;
  }

  private startClimb(spot: ClimbSpot, enemy: KnownEnemy, entrance: THREE.Vector3, why: ClimbPlan['why'], now: number): void {
    const key = `climb:${this.climbs++}`;
    this.climb = { stage: 'exit', spot, enemy: enemy.id, entrance, firedAt: 0, stageAt: now, startedAt: now, key, retried: false, blockedSince: 0, why, fromFeet: this.pos.y - PLAYER_FEET_OFFSET };
    this.focusId = enemy.id;
    this.trap = null;
    this.steal = null;
    this.setGoal('climb', `${why === 'combo' ? 'drop-in' : `${spot.kind} exit`} on ${enemy.id}`);
    this.record('climb:start', `${why === 'combo' ? 'drop-in, ' : ''}${spot.kind} at ${spot.point.toArray().map((v) => v.toFixed(0)).join(',')}`);
    this.c.follower.stop();
  }

  /** Out of the exit: right by it (just popped out), or up on the floor it lands on. */
  private cameThrough(cl: ClimbPlan): boolean {
    const pos = this.pos;
    if (pos.distanceTo(cl.spot.point) < CLIMB_THROUGH) return true;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    return feet > cl.fromFeet + 3 && feet > cl.spot.node.y - 1.5 && Math.hypot(pos.x - cl.spot.land.x, pos.z - cl.spot.land.z) < CLIMB_THROUGH + 2;
  }

  /** Through: straight on with a trap on them - in the air, as soon as it has a clear shot. */
  private climbThrough(now: number): boolean {
    const cl = this.climb!;
    this.record('climb:through', `${cl.spot.kind}${cl.why === 'combo' ? ' (drop-in)' : ''}`);
    if (cl.why === 'combo') this.stats.dropIns++;
    else this.stats.climbs++;
    this.climb = null;
    this.climbReadyAt = now + this.c.skill.climbCooldown;
    this.afterClimb = { enemy: cl.enemy, until: now + AFTER_CLIMB };
    return this.trapAfterClimb(now);
  }

  /**
   * A drop-in for the fun of it (`comboChance`, rolled every few seconds - high ground or
   * not): an exit in a ceiling it can see that comes down near someone whose floor takes a
   * portal, with that floor and a deadly trap exit in view on the way down; then a portal
   * beside itself, in, and the trap on them as it falls.
   */
  private planCombo(now: number): boolean {
    const { climbs, skill, random, self, perception, session } = this.c;
    if (!climbs || !skill.comboChance || this.climb || this.trap || this.steal || this.portalsBusy(now)) return false;
    if (now - this.trapActiveAt < COMBO_AFTER_TRAP) return false;
    if (now < this.climbReadyAt || now < this.comboRollAt || !self.controller.isGrounded) return false;
    this.comboRollAt = now + skill.comboEvery;
    if (random() >= skill.comboChance) return false;
    const enemy = this.target([...perception.enemies.values()].filter((e) => e.visible));
    if (!enemy) return false;
    const floor = this.portalFloor(_v.copy(enemy.position));
    if (!floor || session.noPortalNear(floor, perception.orbs)) {
      this.record('combo:none', 'no portal floor under them');
      return false;
    }
    const spot = this.pickCombo(enemy, floor);
    const entrance = spot ? this.pickEntrance() : null;
    if (!spot || !entrance) {
      this.record('combo:none', spot ? 'no floor for a way in' : 'no ceiling exit in view that drops in on them');
      return false;
    }
    this.startClimb(spot, enemy, entrance, 'combo', now);
    return true;
  }

  /** The ceiling exit for a drop-in on `enemy` (standing on `floor`), in clear view from here. */
  private pickCombo(enemy: KnownEnemy, floor: THREE.Vector3): ClimbSpot | null {
    const { climbs, perception, session, self } = this.c;
    const canFlash = self.controller.immunityCooldownFraction() >= 1;
    const eye = perception.eye(new THREE.Vector3());
    const target = floor.clone().setY(floor.y + 0.05);
    let best: ClimbSpot | null = null;
    let bestScore = Infinity;
    for (const s of climbs!.spots) {
      if (s.kind !== 'ceiling' || this.badClimbs.has(s)) continue;
      if (s.impact > FALL_DAMAGE_THRESHOLD && !canFlash) continue;
      const toThem = Math.hypot(s.land.x - enemy.position.x, s.land.z - enemy.position.z);
      if (toThem < CLIMB_LAND_MIN || toThem > COMBO_REACH) continue;
      _v.copy(eye).sub(s.point);
      const d = _v.length();
      if (d > CLIMB_RANGE || s.normal.dot(_v) < 0.25 * d) continue;
      const score = Math.abs(toThem - CLIMB_LAND_BEST) + d * 0.15;
      if (score >= bestScore || !this.trapInView(s)) continue;
      // Their floor in view halfway down, where it shoots from.
      if (!this.solidClear(s.point.clone().lerp(s.land, 0.5).setY((s.point.y + s.land.y) / 2 + 0.5), target)) continue;
      if (session.noPortalNear(s.point, perception.orbs)) continue;
      if (!perception.clearShot(_w.copy(s.point).addScaledVector(s.normal, 0.05))) continue;
      best = s;
      bestScore = score;
    }
    return best;
  }

  /** Nothing solid between `from` and `to` (players, crates and portals don't count). */
  private solidClear(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const physics = this.c.session.physics;
    const dir = to.clone().sub(from);
    const d = dir.length();
    if (d < 1e-3) return true;
    const hit = physics.world.castRay(new RAPIER.Ray(from, dir.divideScalar(d)), d, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, (col) => physics.getOwner(col.handle)?.type === 'solid');
    return !hit || hit.timeOfImpact >= d - 0.1;
  }

  /**
   * Exits that would put it on their floor a little way from them, best first: with a deadly
   * trap exit in view on the way down (so the trap can follow) much preferred, nearer (to
   * `from`, if given) a little.
   */
  private climbCandidates(enemy: KnownEnemy, from: THREE.Vector3 | null): { s: ClimbSpot; score: number }[] {
    const { climbs, session, perception, self } = this.c;
    const theirFloor = enemy.position.y - PLAYER_FEET_OFFSET;
    // A hard landing only with flash immunity ready to take it.
    const canFlash = self.controller.immunityCooldownFraction() >= 1;
    const scored: { s: ClimbSpot; score: number }[] = [];
    for (const s of climbs!.spots) {
      if (this.badClimbs.has(s) || Math.abs(s.node.y - theirFloor) > 1.5) continue;
      if (s.impact > FALL_DAMAGE_THRESHOLD && !canFlash) continue;
      const toThem = Math.hypot(s.land.x - enemy.position.x, s.land.z - enemy.position.z);
      if (toThem < CLIMB_LAND_MIN || toThem > CLIMB_LAND_MAX) continue;
      let score = Math.abs(toThem - CLIMB_LAND_BEST);
      if (from) {
        _v.copy(from).sub(s.point);
        const d = _v.length();
        if (d > CLIMB_RANGE || s.normal.dot(_v) < 0.25 * d) continue;
        score += d * 0.15;
      }
      scored.push({ s, score });
    }
    scored.sort((a, b) => a.score - b.score);
    for (const c of scored.slice(0, 24)) if (!this.trapInView(c.s)) c.score += NO_TRAP_VIEW;
    scored.sort((a, b) => a.score - b.score);
    return scored.filter((c) => !session.noPortalNear(c.s.point, perception.orbs));
  }

  /** Just through a climb: a trap on them the moment there's a clear shot (for a short while). */
  private trapAfterClimb(now: number): boolean {
    const after = this.afterClimb;
    if (!after || this.trap) return false;
    if (now > after.until) {
      this.afterClimb = null;
      return false;
    }
    const e = this.c.perception.enemies.get(after.enemy);
    if (!e || !this.startTrap(e, now, true)) return false;
    this.afterClimb = null;
    return true;
  }

  /** The exit to climb by, in clear view from here. */
  private pickClimb(enemy: KnownEnemy): ClimbSpot | null {
    const { perception } = this.c;
    perception.eye(_eye);
    // Line of sight only for the best few (it's a ray each).
    for (const { s } of this.climbCandidates(enemy, _eye).slice(0, 12)) {
      if (perception.clearShot(_w.copy(s.point).addScaledVector(s.normal, 0.05))) return s;
    }
    return null;
  }

  /**
   * Somewhere on its own level, not far, with a good exit in clear view and portal-taking
   * floor to walk in by - for when there's no shot from where it stands.
   */
  private findVantage(enemy: KnownEnemy): { at: THREE.Vector3; spot: ClimbSpot } | null {
    const { nav, random } = this.c;
    const worthIt = (c: ClimbSpot) => !this.c.perception.orbs.length || this.trapInView(c);
    const spots = this.climbCandidates(enemy, null).filter((c) => worthIt(c.s)).slice(0, 8).map((c) => c.s);
    if (!spots.length) return null;
    const pos = this.pos;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    const eye = new THREE.Vector3();
    let best: { at: THREE.Vector3; spot: ClimbSpot; score: number } | null = null;
    for (let i = 0; i < VANTAGE_TRIES; i++) {
      const n = nav.nodes[Math.floor(random() * nav.nodes.length)];
      if (!n || n.hazards.length || n.penalty > 0 || Math.abs(n.y - feet) > 1) continue;
      const away = Math.hypot(n.x - pos.x, n.z - pos.z);
      if (away > VANTAGE_RANGE || (best && away >= best.score)) continue;
      eye.set(n.x, n.y + PLAYER_FEET_OFFSET + EYE_OFFSET, n.z);
      if (!this.portalFloor(_v.set(n.x, n.y + PLAYER_FEET_OFFSET, n.z))) continue;
      const spot = spots.find((s) => {
        _v.copy(eye).sub(s.point);
        const d = _v.length();
        if (d > CLIMB_RANGE || s.normal.dot(_v) < 0.25 * d) return false;
        return this.solidClear(eye, _w.copy(s.point).addScaledVector(s.normal, 0.05));
      });
      if (spot) best = { at: nav.standAt(n), spot, score: away };
    }
    return best;
  }

  /**
   * Whether a deadly trap exit (TrapSpots) can be seen on the way down from this climb exit
   * or from where it lands - map knowledge, worked out once per climb spot.
   */
  private trapInView(c: ClimbSpot): boolean {
    let known = this.climbTrapView.get(c);
    if (known !== undefined) return known;
    const { traps } = this.c;
    const eyes = [c.land.clone().setY(c.land.y + PLAYER_FEET_OFFSET + EYE_OFFSET), c.point.clone().lerp(c.land, 0.5).setY((c.point.y + c.land.y) / 2 + 0.5)];
    // Any exit worth shooting counts (against someone at full health), the best-looking first.
    const worth = traps.spots.filter((t) => trapValue(t, 100) >= MIN_TRAP_VALUE);
    known = eyes.some((eye) => {
      const near: { t: TrapSpot; d: number }[] = [];
      for (const t of worth) {
        _v.copy(eye).sub(t.point);
        const d = _v.length();
        if (d > EXIT_RANGE || t.normal.dot(_v) < 0.25 * d) continue;
        near.push({ t, d });
      }
      near.sort((a, b) => b.t.damage - a.t.damage || a.d - b.d);
      return near.slice(0, TRAP_VIEW_TRIES).some(({ t }) => this.solidClear(eye, _w.copy(t.point).addScaledVector(t.normal, 0.05)));
    });
    this.climbTrapView.set(c, known);
    return known;
  }

  /** Floor beside it that takes a portal it can walk into: same level, safe, in clear view. */
  private pickEntrance(): THREE.Vector3 | null {
    const { nav, perception, session, random } = this.c;
    const pos = this.pos;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    const turn = random() * Math.PI * 2;
    for (const r of ENTRANCE_RINGS) {
      for (let k = 0; k < 8; k++) {
        const a = turn + (k * Math.PI) / 4;
        const floor = this.portalFloor(_v.set(pos.x + Math.cos(a) * r, pos.y, pos.z + Math.sin(a) * r));
        if (!floor || Math.abs(floor.y - feet) > 0.3) continue;
        const n = nav.nearest(_w.copy(floor).setY(floor.y + PLAYER_FEET_OFFSET), 0);
        if (!n || n.hazards.length || nav.blocked(n) || Math.abs(n.y - floor.y) > 0.3) continue;
        if (session.noPortalNear(floor, perception.orbs)) continue;
        if (!perception.clearShot(_w.copy(floor).setY(floor.y + 0.05))) continue;
        return floor;
      }
    }
    return null;
  }

  private actClimb(cmd: PlayerCommand, now: number): void {
    const cl = this.climb!;
    const { self, perception } = this.c;
    if (cl.stage === 'walk' && this.cameThrough(cl)) {
      this.climbThrough(now);
      return;
    }
    if (cl.stage === 'walk' && cl.entrance) {
      // Walk onto the floor portal (and drop in), looking at it.
      this.aim = { key: `${cl.key}:in`, point: cl.entrance, fire: null, planned: true };
      const pos = this.pos;
      const dx = cl.entrance.x - pos.x;
      const dz = cl.entrance.z - pos.z;
      const len = Math.hypot(dx, dz) || 1;
      const yaw = self.controller.lookYaw;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      cmd.forward = (dx * fx + dz * fz) / len;
      cmd.right = (dx * -fz + dz * fx) / len;
      return;
    }
    if (cl.stage === 'approach' || !cl.entrance) return; // walking there (the follower steers)
    const exit = cl.stage === 'exit';
    const color: PortalColor = exit ? 'blue' : 'orange';
    const target = exit ? cl.spot.point : cl.entrance;
    if (!cl.firedAt) {
      const clear = perception.clearShot(_w.copy(target).addScaledVector(exit ? cl.spot.normal : _v.set(0, 1, 0), 0.05));
      if (clear) {
        cl.blockedSince = 0;
      } else if (!cl.blockedSince) {
        cl.blockedSince = now;
      } else if (now - cl.blockedSince > CLIMB_BLOCKED) {
        // Nothing but a wall in the way for a while (it has shifted since it chose): another floor spot, or give up.
        const entrance = exit ? null : this.pickEntrance();
        cl.blockedSince = 0;
        if (entrance) {
          cl.entrance = entrance;
          this.record('climb:entrance-moved');
        } else {
          this.record('climb:abandon', 'no clear line to the mark');
          if (exit) this.badClimbs.set(cl.spot, now + BAD_SPOT_TIME);
          this.climb = null;
          this.climbReadyAt = now + 1;
          return;
        }
      }
      // Exits are often on small slots far off: line up within ~0.3 m of the mark.
      const tolerance = Math.atan2(CLIMB_AIM, perception.eye(_eye).distanceTo(target));
      // (It chose these marks itself: no reaction time before it turns to them.)
      this.aim = { key: `${cl.key}:${cl.stage}`, point: target, fire: clear ? color : null, tolerance, planned: true };
      return;
    }
    if (now < cl.firedAt + CHECK_AFTER_PLANNED) return;
    const portal = self.portals[color];
    const landed = portal.placed && portal.owner === self.id && portal.surfaceCenter.distanceTo(target) < 1.6;
    if (!landed) {
      // One more go, then leave that spot alone for a while.
      this.record(`climb:${cl.stage}-failed`);
      if (!cl.retried) {
        this.climb = { ...cl, firedAt: 0, retried: true };
        return;
      }
      if (exit) this.badClimbs.set(cl.spot, now + BAD_SPOT_TIME);
      this.climb = null;
      this.climbReadyAt = now + 1;
      return;
    }
    this.record(`climb:${cl.stage}-set`);
    this.climb = { ...cl, stage: exit ? 'entrance' : 'walk', firedAt: 0, stageAt: now, retried: false, blockedSince: 0 };
  }

  /**
   * Coming down too fast to land unhurt, with the ground just below: flash immunity (the
   * same Shift a person presses) takes the fall damage.
   */
  private flashLanding(cmd: PlayerCommand): void {
    const { self, session } = this.c;
    const c = self.controller;
    if (!this.c.skill.portalClimb || c.isGrounded) return;
    const vy = c.getVelocity().y;
    if (vy > -FALL_DAMAGE_THRESHOLD) return;
    const pos = this.pos;
    const hit = session.physics.world.castRay(
      new RAPIER.Ray(pos, { x: 0, y: -1, z: 0 }),
      PLAYER_FEET_OFFSET - vy * 0.2,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (col) => session.physics.getOwner(col.handle)?.type === 'solid',
    );
    if (hit && !c.isImmune()) {
      cmd.immunity = true;
      this.record('flash-landing', `${(-vy).toFixed(0)} m/s`);
    }
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
    if (now < this.stealReadyAt || this.portalsBusy(now)) return false;
    const { perception, random, skill } = this.c;
    let best: StealPlan | null = null;
    let bestValue = -Infinity;
    for (const [p, front] of perception.portals) {
      if (!this.stealable(p)) continue;
      const tried = this.stealTries.get(p);
      if (tried && now - tried.at < STEAL_REPEAT_TIME && tried.n >= STEAL_REPEAT) continue;
      // Go for this one at all? Decided once per placement.
      let call = this.stealCalls.get(p);
      if (!call || call.at.distanceToSquared(front) > 0.25) {
        call = { at: front.clone(), go: random() < skill.stealChance };
        this.stealCalls.set(p, call);
      }
      if (!call.go) continue;
      const spot = this.trapSpotAt(p.surfaceCenter);
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
    const prev = this.stealTries.get(best.portal);
    this.stealTries.set(best.portal, { n: prev && now - prev.at < STEAL_REPEAT_TIME ? prev.n + 1 : 1, at: now });
    this.steal = best;
    const what = `${best.portal.owner}:${best.portal.color} as ${best.color}${best.spot ? ' (trap exit)' : ''}`;
    this.setGoal('steal', what);
    this.record('steal:start', what);
    this.whileAiming(best.portal.surfaceCenter);
    return true;
  }

  /** The best trap exit spot right at `at` (a portal someone put there), if any. */
  private trapSpotAt(at: THREE.Vector3): TrapSpot | null {
    let best: TrapSpot | null = null;
    let bestValue = 0;
    for (const t of this.c.traps.spots) {
      if (t.point.distanceTo(at) >= AT_TRAP_SPOT) continue;
      const v = trapValue(t, 100);
      if (v > bestValue) {
        bestValue = v;
        best = t;
      }
    }
    return bestValue >= MIN_TRAP_VALUE ? best : null;
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
    // Just seen somewhere no trap works, and still there: no point going back for them. Of the
    // rest, the one it most wants to go after - and is surest where they are.
    const worth = [...perception.enemies.values()].filter((e) => {
      const skip = this.notTrappable.get(e.id);
      return !(skip && now < skip.until && skip.at.distanceTo(e.position) < 3);
    });
    const best = this.target(worth, (e) => 0.5 + 0.5 * e.confidence);
    if (!best) return false;
    // In sight: close in while too far off to trap them (near enough, the trap decides).
    const close = this.floorReach(best) * (this.goal === 'hunt' ? HUNT_CLOSE - 0.2 : HUNT_CLOSE);
    if (best.visible && best.position.distanceTo(this.pos) < close) return false;
    if (this.goal !== 'hunt' || follower.status !== 'moving') {
      if (follower.goTo(best.position) === 'no-path') return false;
      this.focusId = best.id;
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
    this.flashLanding(cmd);
    if (this.climb) {
      this.actClimb(cmd, now);
      return;
    }
    if (this.steal) {
      this.actSteal(now);
      return;
    }
    const t = this.trap;
    if (!t) return;
    if (t.stage === 'check') {
      if (now < t.firedAt + (t.planned ? CHECK_AFTER_PLANNED : this.c.skill.checkDelay)) return;
      this.checkShot(now);
      return;
    }
    if (t.stage === 'exit') {
      // Hold fire while something is in the way (it may be walking).
      const clear = this.c.perception.clearShot(_w.copy(t.spot.point).addScaledVector(t.spot.normal, 0.05));
      if (clear) t.lastChance = now;
      this.aim = { key: `exit:${t.spot.point.toArray().join(',')}`, point: t.spot.point, fire: clear ? 'blue' : null, tolerance: this.shotTolerance(t.spot.point, false), planned: t.planned };
      return;
    }
    const e = this.c.perception.enemies.get(t.enemy);
    const floor = e?.visible ? this.floorUnder(e) : null;
    if (!floor) return; // wait for them to step back onto good floor (or give up in think)
    const clear = this.c.perception.clearShot(_w.copy(floor).setY(floor.y + 0.05));
    if (clear) t.lastChance = now;
    // A hazard that only kills in its window: hold the shot until they would come down in it.
    let timed = true;
    if (t.spot.kind === 'timed') {
      const when = this.timing(t.spot);
      timed = !!when && when.earliest <= 0.03 && when.latest >= 0.03;
    }
    this.aim = { key: `floor:${t.enemy}`, point: floor, fire: clear && timed ? 'orange' : null, tolerance: this.shotTolerance(floor, true), planned: t.planned };
  }

  private actSteal(now: number): void {
    const st = this.steal!;
    if (!st.firedAt) {
      const front = this.c.perception.portals.get(st.portal);
      if (!front) return; // seen gone: think() gives up on it
      this.aim = { key: st.key, point: st.portal.surfaceCenter, fire: this.c.perception.clearShot(front) ? st.color : null };
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
    if (look.offTarget(eye, yaw, pitch) > Math.min(skill.aimTolerance, aim.tolerance ?? Infinity)) return;
    cmd.fire = aim.fire;
    this.lastShot = now;
    if (this.climb) {
      this.record(`shot:climb-${this.climb.stage}`, aim.point.toArray().map((v) => v.toFixed(1)).join(','));
      this.climb = { ...this.climb, firedAt: now };
    } else if (this.steal) {
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
        if (t.prep) {
          // Set in advance: the trap is one shot when someone turns up.
          this.trap = null;
          this.record('trap:prepared', `${t.spot.kind}/${t.spot.cause}`);
          return;
        }
        this.trap = { ...t, stage: 'floor', lastChance: now };
        this.record('trap:exit-set');
      } else {
        this.badSpots.set(t.spot, now + BAD_SPOT_TIME);
        this.record('trap:exit-failed');
        this.trap = null;
        this.trapReadyAt = now + 0.15;
        this.trapActiveAt = now;
      }
      return;
    }
    const sprung = portal.placed && portal.surfaceCenter.distanceTo(this.shotAt) < 1.6;
    this.record(sprung ? 'trap:sprung' : 'trap:floor-failed', `${t.spot.kind}/${t.spot.cause}`);
    if (sprung) {
      this.holdPortalsUntil = now + PORTAL_HOLD;
      this.holdFor = t.enemy;
      this.stats.sprung.set(t.spot.cause, (this.stats.sprung.get(t.spot.cause) ?? 0) + 1);
      // Whatever it did stays on them (a kill resets it: they come back at full health).
      const victim = this.c.session.playerById(t.enemy);
      if (t.spot.kind === 'fall' && victim) {
        const h = this.hurt.get(t.enemy);
        const damage = (h && h.life === victim.respawns ? h.damage : 0) + t.spot.damage;
        this.hurt.set(t.enemy, { damage, life: victim.respawns });
      }
    }
    this.trap = null;
    this.trapReadyAt = now + this.c.skill.trapCooldown;
    this.trapActiveAt = now;
  }

  /**
   * Someone it can see aims at the floor right under it - about to open a portal there:
   * sidestep for a moment, to a side with safe floor all the way (or not at all).
   */
  private dodge(cmd: PlayerCommand, now: number): void {
    const { skill, session, random } = this.c;
    if (now < this.dodgeUntil) {
      this.steerWorld(cmd, this.dodgeDir);
      return;
    }
    if (!skill.dodges || now < this.dodgeUntil + DODGE_REST || (this.trap && !this.trap.prep) || this.steal || this.climb) return;
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
      const mine = this.c.self.controller.lookYaw;
      this.dodgeDir.set(Math.cos(mine) * side, 0, -Math.sin(mine) * side);
      this.steerWorld(cmd, this.dodgeDir);
      this.record('dodge', e.id);
      return;
    }
  }

  /** Run along `dir` (a horizontal unit vector in the world), whichever way the head has turned. */
  private steerWorld(cmd: PlayerCommand, dir: THREE.Vector3): void {
    const yaw = this.c.self.controller.lookYaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    cmd.forward = dir.x * fx + dir.z * fz;
    cmd.right = dir.x * -fz + dir.z * fx;
  }

  /** Which way (1 right, -1 left, as it looks now) has safe floor for a sidestep - `prefer` first - or 0. */
  private safeSide(prefer: number): number {
    const { nav, self, skill } = this.c;
    const pos = this.pos;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    const yaw = self.controller.lookYaw;
    // A faster body slides further in the half second it sidesteps.
    const reach = Math.ceil(skill.moveSpeed * 7 * DODGE_TIME + DODGE_MARGIN);
    const steps = Array.from({ length: reach }, (_, i) => i + 1);
    for (const side of [prefer, -prefer]) {
      const ok = steps.every((k) => {
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
