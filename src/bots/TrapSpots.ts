import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ArenaBuilder } from '../world/ArenaBuilder';
import type { Face, Level } from '../world/Level';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { AcidPool } from '../world/hazards/AcidPool';
import { PORTAL_HALF_H, PORTAL_HALF_W } from '../portals/Portal';

/** Candidate exits are tried this far apart on a surface. */
const SPACING = 1;
/** Only surfaces this close (horizontally) to something deadly are worth simulating. */
const REACH = 7;
/** Someone dropping into a floor portal comes out at roughly these speeds (stepped in / fell in). */
const EXIT_SPEEDS = [3, 7];
const GRAVITY = 20;
const SIM_STEP = 0.04;
const SIM_TIME = 2.5;
/** Where the body's centre is when it has just come out. */
const OUT = 0.7;

/** Somewhere an exit portal sends whoever comes out of it to their death. */
export interface TrapSpot {
  readonly face: Face;
  /** Where the opening's centre should be, on the surface. */
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
}

const spotsFor = new WeakMap<object, TrapSpots>();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Portal-trap exits for an arena, worked out once like the navigation graph: points on
 * portal-taking surfaces near acid (or a long fall) where something coming out - having
 * dropped into a floor portal at walking or falling speed - flies into the acid either way.
 * Classic example on Highwire: low on the central pillar's side, facing out over the acid.
 * Static map knowledge, the same a person learns by playing the map.
 */
export class TrapSpots {
  readonly spots: TrapSpot[] = [];
  readonly buildMs: number;
  private readonly arena: ArenaBuilder;
  private readonly physics: PhysicsWorld;
  private readonly pools: AcidPool[];

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
    this.pools = arena.hazards.filter((h): h is AcidPool => h instanceof AcidPool);
    if (this.pools.length) {
      for (const face of level.faces) if (face.portalable) this.sampleFace(face);
    }
    this.buildMs = performance.now() - t0;
  }

  /** Horizontal distance from (x, z) to the nearest acid. */
  private toAcid(x: number, z: number): number {
    let best = Infinity;
    for (const p of this.pools) {
      const dx = Math.max(p.min.x - x, 0, x - p.max.x);
      const dz = Math.max(p.min.y - z, 0, z - p.max.y);
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  private sampleFace(face: Face): void {
    // Floors fling things straight up and back down again: no use as an exit.
    if (face.normal.y > 0.5) return;
    const m = Math.max(PORTAL_HALF_W, PORTAL_HALF_H) + 0.05;
    const mx = Math.abs(face.normal.y) > 0.5 ? m : PORTAL_HALF_W + 0.05;
    const my = Math.abs(face.normal.y) > 0.5 ? m : PORTAL_HALF_H + 0.05;
    const hw = face.width / 2 - mx;
    const hh = face.height / 2 - my;
    if (hw < 0 || hh < 0) return;
    const lowest = Math.min(...this.pools.map((p) => p.surfaceY));
    for (let y = -hh; y <= hh + 1e-6; y += SPACING) {
      for (let x = -hw; x <= hw + 1e-6; x += SPACING) {
        const point = face.toWorld(x, y);
        if (this.toAcid(point.x, point.z) > REACH || point.y < lowest - 0.5 || point.y > lowest + 14) continue;
        if (EXIT_SPEEDS.every((v) => this.deadlyExit(point, face.normal, v))) {
          this.spots.push({ face, point, normal: face.normal.clone() });
        }
      }
    }
  }

  /** Fly out of `point` along `normal` at `speed` and see where it lands. */
  private deadlyExit(point: THREE.Vector3, normal: THREE.Vector3, speed: number): boolean {
    const pos = _a.copy(point).addScaledVector(normal, OUT);
    const vel = _v.copy(normal).multiplyScalar(speed);
    for (let t = 0; t < SIM_TIME; t += SIM_STEP) {
      const next = _b.copy(pos).addScaledVector(vel, SIM_STEP);
      next.y -= 0.5 * GRAVITY * SIM_STEP * SIM_STEP;
      vel.y -= GRAVITY * SIM_STEP;
      const land = this.firstHit(pos, next);
      if (land) return this.deadlyAt(land);
      if (next.y < this.arena.killY) return true;
      pos.copy(next);
    }
    return false;
  }

  private firstHit(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 | null {
    _dir.copy(to).sub(from);
    const len = _dir.length();
    if (len < 1e-5) return null;
    _dir.divideScalar(len);
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(from, _dir),
      len,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => {
        const t = this.physics.getOwner(c.handle)?.type;
        return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel';
      },
    );
    return hit ? from.clone().addScaledVector(_dir, hit.timeOfImpact) : null;
  }

  /** Landing in acid (the pit floor under it counts) or below the kill plane. */
  private deadlyAt(p: THREE.Vector3): boolean {
    if (p.y < this.arena.killY) return true;
    return this.pools.some((pool) => pool.covers(p));
  }
}
