import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ArenaBuilder } from '../world/ArenaBuilder';
import type { Face, Level } from '../world/Level';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { AcidPool } from '../world/hazards/AcidPool';
import type { Hazard } from '../world/hazards/Hazard';
import { PORTAL_HALF_H, PORTAL_HALF_W } from '../portals/Portal';
import { FALL_DAMAGE_SCALE, FALL_DAMAGE_THRESHOLD } from '../player/PlayerController';

/** Candidate exits are tried this far apart on a surface. */
const SPACING = 1;
/** Someone dropping into a floor portal comes out at roughly these speeds (stepped in / fell in). */
export const EXIT_SPEEDS = [3, 7, 9];
const GRAVITY = 20;
const SIM_STEP = 0.04;
const SIM_TIME = 3;
/** Where the body's centre is when it has just come out. */
const OUT = 0.7;
/** A body this wide (a little more than a player's capsule) has to fit inside the hazard. */
const BODY_EDGE: ReadonlyArray<[number, number]> = [
  [0, 0],
  [0.6, 0],
  [-0.6, 0],
  [0, 0.6],
  [0, -0.6],
];
/** A fall that costs less than this is not worth a trap. */
const MIN_DAMAGE = 30;
/** Of the exits that only hurt, one is kept per this many metres of surface (the best of them). */
const THIN_CELL = 2;
/** From dropping into the floor portal to coming out of the exit: about this long, seconds. */
export const PORTAL_DELAY = 0.3;

export interface Flight {
  /** Where it first hit something (the body's centre path), or null. */
  land: THREE.Vector3 | null;
  /** The surface's normal there (up for a floor). */
  normal: THREE.Vector3 | null;
  /** Speed into that surface along its normal, m/s. */
  impact: number;
  /** Went below the kill plane. */
  fell: boolean;
  /** Seconds from coming out until it landed (or fell). */
  time: number;
  /** Where the flight ended (the landing, the point it fell out of the world at, or where time ran out). */
  end: THREE.Vector3;
}

/**
 * Something comes out of an exit portal at `point` (facing `normal`) at `speed`: follow its
 * centre under gravity until it hits something, falls out of the world, or time runs out.
 */
export function flyOut(physics: PhysicsWorld, killY: number, point: THREE.Vector3, normal: THREE.Vector3, speed: number): Flight {
  const pos = _a.copy(point).addScaledVector(normal, OUT);
  const vel = _v.copy(normal).multiplyScalar(speed);
  for (let t = 0; t < SIM_TIME; t += SIM_STEP) {
    const next = _b.copy(pos).addScaledVector(vel, SIM_STEP);
    next.y -= 0.5 * GRAVITY * SIM_STEP * SIM_STEP;
    vel.y -= GRAVITY * SIM_STEP;
    const hit = firstHit(physics, pos, next);
    if (hit) return { land: hit.point, normal: hit.normal, impact: Math.max(0, -vel.dot(hit.normal)), fell: false, time: t + SIM_STEP, end: hit.point };
    if (next.y < killY) return { land: null, normal: null, impact: 0, fell: true, time: t + SIM_STEP, end: next.clone() };
    pos.copy(next);
  }
  return { land: null, normal: null, impact: 0, fell: false, time: SIM_TIME, end: pos.clone() };
}

function firstHit(physics: PhysicsWorld, from: THREE.Vector3, to: THREE.Vector3): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
  _dir.copy(to).sub(from);
  const len = _dir.length();
  if (len < 1e-5) return null;
  _dir.divideScalar(len);
  const hit = physics.world.castRayAndGetNormal(
    new RAPIER.Ray(from, _dir),
    len,
    true,
    RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
    undefined,
    undefined,
    undefined,
    (c) => {
      const t = physics.getOwner(c.handle)?.type;
      return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel';
    },
  );
  if (!hit) return null;
  return { point: from.clone().addScaledVector(_dir, hit.timeOfImpact), normal: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) };
}

/**
 * What waits for whoever comes out of the exit:
 *  - lethal: something that kills on contact whatever the moment - acid, static spikes, the
 *    kill plane, or a fall long enough to be fatal from full health.
 *  - timed: a hazard with phases (a cycling spike bed) that kills only inside a window - the
 *    floor portal has to be timed so they land in it.
 *  - fall: nothing deadly, but the landing hurts (a long drop - ceiling exits over floor,
 *    high wall exits); the damage stays, health does not come back.
 */
export type TrapKind = 'lethal' | 'timed' | 'fall';

/** Somewhere an exit portal sends whoever comes out of it to their death, or at least to harm. */
export interface TrapSpot {
  readonly face: Face;
  /** Where the opening's centre should be, on the surface. */
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly kind: TrapKind;
  /** What does it: 'acid', 'spikes', 'void' (the kill plane) or 'fall'. */
  readonly cause: string;
  /** The least damage whoever comes out takes at the speeds tried (100 or more: dies). */
  readonly damage: number;
  /** Where they come down (at the first speed tried). */
  readonly land: THREE.Vector3;
  /** Soonest and latest seconds from coming out of the exit to coming down, over the speeds tried. */
  readonly flight: readonly [number, number];
  /** 'timed' only: the hazard that has to be deadly when they land. */
  readonly hazard: Hazard | null;
  /** Whether it comes straight down (a ceiling exit): it lands right under the exit. */
  readonly drop: boolean;
}

interface Landing {
  lethal: boolean;
  hazard: Hazard | null;
  damage: number;
  cause: string;
}

const spotsFor = new WeakMap<object, TrapSpots>();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Portal-trap exits for an arena, worked out once like the navigation graph: points on any
 * portal-taking wall or ceiling where something coming out - having dropped into a floor
 * portal at walking or falling speed - flies on to somewhere that kills it or hurts badly.
 * What kills is read off the arena's own hazards (acid, spikes) and its kill plane, plus the
 * fall itself (the same damage the game deals), so it works on any map: low on a pillar over
 * acid, a ceiling slot over a pit or just a long way up, a wall over a spike bed. Static map
 * knowledge, the same a person learns by playing the map.
 */
export class TrapSpots {
  readonly spots: TrapSpot[] = [];
  readonly buildMs: number;
  private readonly arena: ArenaBuilder;
  private readonly physics: PhysicsWorld;
  private readonly hazards: Hazard[];

  static for(key: object, arena: ArenaBuilder, level: Level, physics: PhysicsWorld): TrapSpots {
    let t = spotsFor.get(key);
    if (!t) {
      t = new TrapSpots(arena, level, physics);
      spotsFor.set(key, t);
    }
    return t;
  }

  constructor(arena: ArenaBuilder, level: Level, physics: PhysicsWorld) {
    const t0 = performance.now();
    this.arena = arena;
    this.physics = physics;
    this.hazards = arena.hazards.filter((h) => !!h.covers);
    const hurt = new Map<string, TrapSpot>();
    level.faces.forEach((face, i) => {
      if (face.portalable) this.sampleFace(face, `${i}`, hurt);
    });
    // The exits that only hurt come in great numbers (every high wall): keep the best of each patch.
    this.spots.push(...hurt.values());
    this.buildMs = performance.now() - t0;
  }

  private sampleFace(face: Face, id: string, hurt: Map<string, TrapSpot>): void {
    // Floors fling things straight up and back down again: no use as an exit.
    if (face.normal.y > 0.5) return;
    const ceiling = face.normal.y < -0.5;
    // A ceiling portal turns to face away from whoever shoots it, so it has to fit at any
    // angle; a wall one stands upright.
    const m = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + 0.05;
    const mx = ceiling ? m : PORTAL_HALF_W + 0.05;
    const my = ceiling ? m : PORTAL_HALF_H + 0.05;
    const hw = face.width / 2 - mx;
    const hh = face.height / 2 - my;
    if (hw < 0 || hh < 0) return;
    for (let y = -hh; y <= hh + 1e-6; y += SPACING) {
      for (let x = -hw; x <= hw + 1e-6; x += SPACING) {
        const point = face.toWorld(x, y);
        const spot = this.evaluate(face, point, ceiling);
        if (!spot) continue;
        if (spot.kind !== 'fall') {
          this.spots.push(spot);
          continue;
        }
        const key = `${id}:${Math.round(x / THIN_CELL)}:${Math.round(y / THIN_CELL)}`;
        const kept = hurt.get(key);
        if (!kept || kept.damage < spot.damage) hurt.set(key, spot);
      }
    }
  }

  /** Fly out of `point` along the face's normal at each exit speed and see what's there. */
  private evaluate(face: Face, point: THREE.Vector3, ceiling: boolean): TrapSpot | null {
    // Every speed has to do something: a miss at one of them is a miss.
    let allLethal = true;
    let allKill = true;
    let hazard: Hazard | null = null;
    let damage = Infinity;
    let cause = '';
    let first: THREE.Vector3 | null = null;
    let soonest = Infinity;
    let latest = 0;
    for (const speed of EXIT_SPEEDS) {
      const f = flyOut(this.physics, this.arena.killY, point, face.normal, speed);
      const l = this.landing(f);
      if (!l || (!l.lethal && !l.hazard && l.damage < MIN_DAMAGE)) return null;
      if (l.hazard) {
        if (hazard && hazard !== l.hazard) return null;
        hazard = l.hazard;
      }
      allLethal &&= l.lethal;
      allKill &&= l.lethal || !!l.hazard;
      damage = Math.min(damage, l.damage);
      cause ||= l.cause;
      first ??= f.land ?? point;
      soonest = Math.min(soonest, f.time);
      latest = Math.max(latest, f.time);
    }
    const timed = allKill && !allLethal && !!hazard;
    const kind: TrapKind = allLethal ? 'lethal' : timed ? 'timed' : 'fall';
    return {
      face,
      point,
      normal: face.normal.clone(),
      kind,
      cause: kind === 'fall' ? 'fall' : cause,
      damage: kind === 'fall' ? damage : Math.max(100, damage),
      land: first!.clone(),
      flight: [soonest, latest],
      hazard: timed ? hazard : null,
      drop: ceiling,
    };
  }

  /** What a body that comes down here meets - null when it never lands in the time simulated. */
  private landing(f: Flight): Landing | null {
    if (!f.fell && (!f.land || !f.normal)) return null;
    // The whole body has to be inside it: one that comes down on the very edge stands on the rim.
    for (const h of this.hazards) {
      if (!BODY_EDGE.every(([dx, dz]) => h.covers!(_p.set(f.end.x + dx, f.end.y, f.end.z + dz)))) continue;
      const always = h.alwaysDeadly === true || !h.dangerNow;
      if (always) return { lethal: true, hazard: null, damage: 100, cause: h instanceof AcidPool ? 'acid' : 'spikes' };
      if (h.deadlyWindow) return { lethal: false, hazard: h, damage: 100, cause: 'spikes' };
    }
    if (f.fell || f.end.y < this.arena.killY) return { lethal: true, hazard: null, damage: 100, cause: 'void' };
    // Only a landing on something walkable counts as a fall (a flight into a wall is no drop).
    const hard = f.normal!.y > 0.7 ? Math.max(0, (f.impact - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_SCALE) : 0;
    return { lethal: hard >= 100, hazard: null, damage: hard, cause: 'fall' };
  }
}

/**
 * How much of a kill an exit is worth against someone with `health`: 1 if it kills them
 * (or will, given a trap timed right), else the share of their health it takes.
 */
export function trapValue(spot: TrapSpot, health: number): number {
  if (spot.kind === 'lethal') return 1;
  if (spot.kind === 'timed') return 0.9;
  return Math.min(1, spot.damage / health);
}
