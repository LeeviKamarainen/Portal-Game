import * as THREE from 'three';
import type { ArenaBuilder } from '../world/ArenaBuilder';
import type { Face, Level } from '../world/Level';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { PORTAL_HALF_H, PORTAL_HALF_W } from '../portals/Portal';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { NavGraph, NavNode } from './NavGraph';
import { EXIT_SPEEDS, flyOut } from './TrapSpots';

/** Candidate exits are tried this far apart on a surface (travel spots, many more of them: twice as far). */
const SPACING = 1;
const TRAVEL_SPACING = 2;
/** "High ground": floor at least this far above the lowest walkable floor. */
const HIGH = 5;
/** A wall exit is only worth simulating with high floor this far out in front of it, and this far below it. */
const WALL_FRONT = 1.2;
const WALL_BELOW = 3;
/**
 * Whoever lands has to have floor all round: a body coming straight down out of a ceiling
 * drifts (it steers in the air, and comes out up to a portal's half-length off its centre),
 * and one that comes out of a wall carries on a little - so a landing on a narrow bridge over
 * a pit is no climb, it is a coin toss. Floor this far out.
 */
const LAND_MARGIN_DROP = 2.4;
const LAND_MARGIN_WALL = 1.0;
/**
 * Floor exits (travel only): out of a floor portal - straight up at whatever speed it went in,
 * carrying some of its walking speed - and down again beside it. The hole is still open under
 * it, so there must be floor well clear of it all round to come down on. Tried this far apart
 * (the tops of big blocks are huge), and on faces at least this wide.
 */
const LAND_MARGIN_FLOOR = 3.5;
const FLOOR_SPACING = 4;
/** Exit points tried in all: a map with very many (or huge) portal faces tries each more loosely. */
const SAMPLE_BUDGET = 6000;

/** An exit portal that lands whoever comes out of it on walkable floor (high floor, for a wall). */
export interface ClimbSpot {
  readonly face: Face;
  /** Where the opening's centre should be, on the surface. */
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** Out of the ceiling (a drop), a wall (step out onto the floor) or a floor (up and back down beside it). */
  readonly kind: 'ceiling' | 'wall' | 'floor';
  /** Where it lands, and the floor there. */
  readonly land: THREE.Vector3;
  readonly node: NavNode;
  /** Fastest landing of the exit speeds tried, m/s (fall damage starts at 13). */
  readonly impact: number;
}

/**
 * high: exits that put someone on high ground (a climb) or drop them in from a ceiling.
 * any: every exit that lands someone on walkable floor, whatever tier - for getting about by portal.
 */
export type ClimbTier = 'high' | 'any';

const spotsFor = new WeakMap<object, ClimbSpots>();
const travelSpotsFor = new WeakMap<object, ClimbSpots>();

/**
 * Portal climbs for an arena, worked out once like the trap spots: points on portal-taking
 * walls and ceilings where something coming out - having dropped into a floor portal at
 * walking or falling speed - lands on walkable floor, the same tier either way (high floor,
 * for a wall: a climb; any floor, for a ceiling: a drop-in too). A bot puts its exit on one,
 * a portal on the floor beside itself, and walks in. Examples on Highwire: low on a room wall
 * just above a walkway, or any ceiling that takes portals (the slot over the pillar drops you
 * 10 m onto it - flash immunity takes the landing).
 *
 * Tier `'any'` is the same search without the high-ground requirement: every exit that lands
 * on safe walkable floor, whichever tier - the places an Ultra hard bot hops to (`portalTravel`).
 */
export class ClimbSpots {
  readonly spots: ClimbSpot[] = [];
  readonly buildMs: number;
  private readonly arena: ArenaBuilder;
  private readonly physics: PhysicsWorld;
  private readonly nav: NavGraph;
  private readonly high: number;
  private readonly spacing: number;
  private readonly faceSamples: number;
  private readonly floors: boolean;

  static for(key: object, arena: ArenaBuilder, level: Level, physics: PhysicsWorld, nav: NavGraph, tier: ClimbTier = 'high'): ClimbSpots {
    const cache = tier === 'any' ? travelSpotsFor : spotsFor;
    let c = cache.get(key);
    if (!c) {
      c = new ClimbSpots(arena, level, physics, nav, tier);
      cache.set(key, c);
    }
    return c;
  }

  constructor(arena: ArenaBuilder, level: Level, physics: PhysicsWorld, nav: NavGraph, tier: ClimbTier = 'high') {
    const t0 = performance.now();
    this.arena = arena;
    this.physics = physics;
    this.nav = nav;
    // (Any tier: no floor is too low for a wall exit to land on.)
    this.high = tier === 'any' ? -Infinity : Math.min(...nav.nodes.map((n) => n.y)) + HIGH;
    this.spacing = tier === 'any' ? TRAVEL_SPACING : SPACING;
    this.faceSamples = Math.max(24, SAMPLE_BUDGET / Math.max(1, level.faces.filter((f) => f.portalable && f.normal.y <= 0.5).length));
    this.floors = tier === 'any';
    for (const face of level.faces) if (face.portalable) this.sampleFace(face);
    this.buildMs = performance.now() - t0;
  }

  private sampleFace(face: Face): void {
    const kind = face.normal.y < -0.7 ? 'ceiling' : Math.abs(face.normal.y) < 0.3 ? 'wall' : face.normal.y > 0.7 && this.floors ? 'floor' : null;
    if (!kind) return;
    const flat = kind !== 'wall';
    // A ceiling portal turns to face away from whoever shoots it, so it has to fit at any
    // angle (small slots that fit it only one way round are left out); a wall one stands upright.
    const m = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + 0.05;
    const mx = flat ? m : PORTAL_HALF_W + 0.05;
    const my = flat ? m : PORTAL_HALF_H + 0.05;
    const hw = face.width / 2 - mx;
    const hh = face.height / 2 - my;
    if (hw < 0 || hh < 0) return;
    const probe = new THREE.Vector3();
    // (A huge face is tried more loosely: the work per face is capped.)
    const step = kind === 'floor' ? FLOOR_SPACING : Math.max(this.spacing, Math.sqrt((4 * hw * hh) / this.faceSamples));
    for (let y = -hh; y <= hh + 1e-6; y += step) {
      for (let x = -hw; x <= hw + 1e-6; x += step) {
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
  private tryExit(face: Face, point: THREE.Vector3, kind: ClimbSpot['kind']): void {
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
    const margin = kind === 'floor' ? LAND_MARGIN_FLOOR : kind === 'ceiling' ? LAND_MARGIN_DROP : LAND_MARGIN_WALL;
    if (node && land && this.roomAround(land, margin, node.y)) {
      this.spots.push({ face, point, normal: face.normal.clone(), kind, land, node, impact });
    }
  }

  /** Walkable, safe floor at the same height in every direction `margin` out from `at`. */
  private roomAround(at: THREE.Vector3, margin: number, floorY: number): boolean {
    const probe = new THREE.Vector3();
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      probe.set(at.x + Math.cos(a) * margin, floorY + PLAYER_FEET_OFFSET, at.z + Math.sin(a) * margin);
      const n = this.nav.nearest(probe, 0);
      if (!n || n.hazards.length || Math.abs(n.y - floorY) > 0.6) return false;
    }
    return true;
  }
}

/**
 * An exit is in view seen at least this steeply (sine of the angle) - a floor exit (the top of
 * a far block) from a graze: the top is big enough that a shot a little long still lands on it.
 */
const EXIT_VIEW = 0.25;
const FLOOR_EXIT_VIEW = 0.07;
export function exitInView(s: ClimbSpot, toEye: THREE.Vector3, d: number): boolean {
  return s.normal.dot(toEye) >= (s.kind === 'floor' ? FLOOR_EXIT_VIEW : EXIT_VIEW) * d;
}
/**
 * How far off an exit is worth shooting: a ceiling slot overhead much further (a big room's
 * ceiling is a long way up, and a slot there is a big target) than anything else.
 */
export const EXIT_REACH = 45;
const CEILING_RANGE = 80;
export function exitRange(s: ClimbSpot): number {
  return s.kind === 'ceiling' ? CEILING_RANGE : EXIT_REACH;
}
/** In range and in view (`toEye`: from the exit to the eye, `d` long). */
export function exitInReach(s: ClimbSpot, toEye: THREE.Vector3, d: number): boolean {
  return d <= exitRange(s) && exitInView(s, toEye, d);
}
