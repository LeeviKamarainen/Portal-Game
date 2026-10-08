import * as THREE from 'three';
import type { ArenaBuilder } from '../world/ArenaBuilder';
import type { Face, Level } from '../world/Level';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { PORTAL_HALF_H, PORTAL_HALF_W } from '../portals/Portal';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { NavGraph, NavNode } from './NavGraph';
import { EXIT_SPEEDS, flyOut } from './TrapSpots';

/** Candidate exits are tried this far apart on a surface. */
const SPACING = 1;
/** "High ground": floor at least this far above the lowest walkable floor. */
const HIGH = 5;
/** A wall exit is only worth simulating with high floor this far out in front of it, and this far below it. */
const WALL_FRONT = 1.2;
const WALL_BELOW = 3;

/** An exit portal that lands whoever comes out of it on walkable floor (high floor, for a wall). */
export interface ClimbSpot {
  readonly face: Face;
  /** Where the opening's centre should be, on the surface. */
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Out of the ceiling (a drop), or a wall (step out onto the floor). */
  readonly kind: 'ceiling' | 'wall';
  /** Where it lands, and the floor there. */
  readonly land: THREE.Vector3;
  readonly node: NavNode;
  /** Fastest landing of the exit speeds tried, m/s (fall damage starts at 13). */
  readonly impact: number;
}

const spotsFor = new WeakMap<object, ClimbSpots>();

/**
 * Portal climbs for an arena, worked out once like the trap spots: points on portal-taking
 * walls and ceilings where something coming out - having dropped into a floor portal at
 * walking or falling speed - lands on walkable floor, the same tier either way (high floor,
 * for a wall: a climb; any floor, for a ceiling: a drop-in too). A bot puts its exit on one,
 * a portal on the floor beside itself, and walks in. Examples on Highwire: low on a room wall
 * just above a walkway, or any ceiling that takes portals (the slot over the pillar drops you
 * 10 m onto it - flash immunity takes the landing).
 */
export class ClimbSpots {
  readonly spots: ClimbSpot[] = [];
  readonly buildMs: number;
  private readonly arena: ArenaBuilder;
  private readonly physics: PhysicsWorld;
  private readonly nav: NavGraph;
  private readonly high: number;

  static for(key: object, arena: ArenaBuilder, level: Level, physics: PhysicsWorld, nav: NavGraph): ClimbSpots {
    let c = spotsFor.get(key);
    if (!c) {
      c = new ClimbSpots(arena, level, physics, nav);
      spotsFor.set(key, c);
    }
    return c;
  }

  constructor(arena: ArenaBuilder, level: Level, physics: PhysicsWorld, nav: NavGraph) {
    const t0 = performance.now();
    this.arena = arena;
    this.physics = physics;
    this.nav = nav;
    this.high = Math.min(...nav.nodes.map((n) => n.y)) + HIGH;
    for (const face of level.faces) if (face.portalable) this.sampleFace(face);
    this.buildMs = performance.now() - t0;
  }

  private sampleFace(face: Face): void {
    const kind = face.normal.y < -0.7 ? 'ceiling' : Math.abs(face.normal.y) < 0.3 ? 'wall' : null;
    if (!kind) return;
    // A ceiling portal turns to face away from whoever shoots it, so it has to fit at any
    // angle (small slots that fit it only one way round are left out); a wall one stands upright.
    const m = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + 0.05;
    const mx = kind === 'ceiling' ? m : PORTAL_HALF_W + 0.05;
    const my = kind === 'ceiling' ? m : PORTAL_HALF_H + 0.05;
    const hw = face.width / 2 - mx;
    const hh = face.height / 2 - my;
    if (hw < 0 || hh < 0) return;
    const probe = new THREE.Vector3();
    for (let y = -hh; y <= hh + 1e-6; y += SPACING) {
      for (let x = -hw; x <= hw + 1e-6; x += SPACING) {
        const point = face.toWorld(x, y);
        if (kind === 'wall') {
          // Cheap test first: high floor just in front, a little below the opening's centre.
          probe.copy(point).addScaledVector(face.normal, WALL_FRONT);
          probe.y += PLAYER_FEET_OFFSET;
          const n = this.nav.nearest(probe, 0);
          if (!n || n.y < this.high || point.y - n.y > WALL_BELOW || point.y < n.y + PORTAL_HALF_H - 0.2) continue;
        }
        this.tryExit(face, point, kind);
      }
    }
  }

  /** Lands on the same high floor at every exit speed, not too hard: keep it. */
  private tryExit(face: Face, point: THREE.Vector3, kind: 'ceiling' | 'wall'): void {
    let node: NavNode | null = null;
    let land: THREE.Vector3 | null = null;
    let impact = 0;
    for (const speed of EXIT_SPEEDS) {
      const f = flyOut(this.physics, this.arena.killY, point, face.normal, speed);
      // However hard the landing: flash immunity takes the fall damage (see BotBrain).
      if (!f.land || !f.normal || f.normal.y < 0.7) return;
      const n = this.nav.nearest(f.land.clone().setY(f.land.y + PLAYER_FEET_OFFSET), 1);
      if (!n || (kind === 'wall' && n.y < this.high) || n.hazards.length || Math.abs(n.y - f.land.y) > 0.6) return;
      if (node && Math.abs(node.y - n.y) > 0.5) return;
      node ??= n;
      land ??= f.land;
      impact = Math.max(impact, f.impact);
    }
    if (node && land) this.spots.push({ face, point, normal: face.normal.clone(), kind, land, node, impact });
  }
}
