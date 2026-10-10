import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ArenaBuilder } from '../world/ArenaBuilder';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Hazard } from '../world/hazards/Hazard';
import { Trapdoor } from '../world/hazards/Trapdoor';
import { PLAYER_FEET_OFFSET, PLAYER_HEIGHT, PLAYER_RADIUS } from '../player/PlayerController';

/** Grid spacing, metres. */
const CELL = 1;
/** Highest step a walk link may have between samples half a cell apart (the controller autosteps 0.3). */
const STEP = 0.4;
/** Height differences a walk link may cover in one cell (stairs climb ~0.4 per metre). */
const WALK_DY = 0.65;
/**
 * Drops up to ~4 m are free of fall damage (13 m/s impact); longer ones hurt but can be
 * survived (an 8 m one costs ~20 of 100 health). They are in the graph so that no tier is a
 * trap to be stuck on for good (a bridge only a ceiling portal gets you to), at a price per
 * point of damage high enough that nobody drops for convenience.
 */
const MAX_HURT_DROP = 12;
const HURT_COST = 8;
const GRAVITY = 20;
const SAFE_IMPACT = 13;
const IMPACT_DAMAGE = 4;
/** A jump clears about 2 m; ledges up to this are worth trying. */
const MAX_JUMP_UP = 1.4;
/** Gap jumps: this many cells across at most (a running jump carries ~6 m). */
const MAX_GAP_CELLS = 3;
/** Extra cost per metre on a cell next to deadly floor, and on floor a timed hazard covers. */
const EDGE_PENALTY = 1.5;
const HAZARD_PENALTY = 4;
/** Floor is checked this far either side of a walk link's centre line (most of a body's radius). */
const BODY_HALF = 0.3;
/** Extra cost of stepping onto floor that is dangerous at the moment of planning. */
const BLOCKED_COST = 25;

export type LinkKind = 'walk' | 'drop' | 'jump';

/** Damage from falling `height` metres from rest (what the player controller deals on landing). */
function fallDamage(height: number): number {
  const speed = Math.sqrt(2 * GRAVITY * Math.max(0, height));
  return Math.max(0, (speed - SAFE_IMPACT) * IMPACT_DAMAGE);
}

export interface NavLink {
  readonly to: number;
  readonly kind: LinkKind;
  readonly cost: number;
}

export interface NavNode {
  readonly id: number;
  /** The floor's surface point at the cell centre. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Timed hazards over this floor (crushers, spikes, trapdoors): blocked while they're dangerous. */
  readonly hazards: Hazard[];
  /** Extra cost per metre of moving onto it. */
  penalty: number;
  readonly links: NavLink[];
}

export interface NavPath {
  readonly nodes: NavNode[];
  /** links[i] goes from nodes[i] to nodes[i + 1]. */
  readonly links: NavLink[];
}

const _from = new THREE.Vector3();
const _dir = new THREE.Vector3();
const DIRS: ReadonlyArray<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const graphs = new WeakMap<object, NavGraph>();

/**
 * Where a player can go in an arena, worked out once when it loads: a 1 m grid of walkable
 * floor - every tier of it - linked by walking (stairs included), dropping off ledges (no
 * higher than is free of fall damage), and jumping (up onto ledges, or across gaps).
 * Deadly floor (acid) is left out; floor under timed hazards stays in, but costs more and
 * is avoided while its warning shows. Portal moves are not in it yet.
 */
export class NavGraph {
  readonly nodes: NavNode[] = [];
  /** Milliseconds the build took. */
  readonly buildMs: number;
  /** Rays and shape tests used to build it. */
  queries = 0;
  private readonly columns = new Map<number, number[]>();
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly physics: PhysicsWorld;
  private readonly arena: ArenaBuilder;

  /** The graph for an arena (built on first use, shared by every bot in it). */
  static for(key: object, arena: ArenaBuilder, physics: PhysicsWorld): NavGraph {
    let g = graphs.get(key);
    if (!g) {
      g = new NavGraph(arena, physics);
      graphs.set(key, g);
    }
    return g;
  }

  constructor(arena: ArenaBuilder, physics: PhysicsWorld) {
    const t0 = performance.now();
    this.arena = arena;
    this.physics = physics;
    const b = arena.bounds;
    this.minX = b.min.x;
    this.minZ = b.min.z;
    this.nx = Math.max(1, Math.floor((b.max.x - b.min.x) / CELL));
    this.nz = Math.max(1, Math.floor((b.max.z - b.min.z) / CELL));
    const deadly = new Set<number>();
    for (let iz = 0; iz < this.nz; iz++) {
      for (let ix = 0; ix < this.nx; ix++) this.sampleColumn(ix, iz, deadly);
    }
    for (const n of this.nodes) {
      const [ix, iz] = this.cellOf(n.x, n.z);
      // Next to deadly floor: a misstep costs a life, so keep a little away from it.
      if (DIRS.some(([dx, dz]) => deadly.has(this.key(ix + dx, iz + dz)))) n.penalty += EDGE_PENALTY;
      if (n.hazards.length) n.penalty += HAZARD_PENALTY;
    }
    for (const n of this.nodes) this.linkNode(n);
    this.buildMs = performance.now() - t0;
  }

  // --- Building -----------------------------------------------------------------------

  private key(ix: number, iz: number): number {
    return ix < 0 || iz < 0 || ix >= this.nx || iz >= this.nz ? -1 : iz * this.nx + ix;
  }

  private cellOf(x: number, z: number): [number, number] {
    return [Math.floor((x - this.minX) / CELL), Math.floor((z - this.minZ) / CELL)];
  }

  private walkable(c: RAPIER.Collider): boolean {
    const owner = this.physics.getOwner(c.handle);
    return owner?.type === 'solid' || (owner?.type === 'hazard' && owner.ref instanceof Trapdoor);
  }

  private ignore = (c: RAPIER.Collider): boolean => {
    const t = this.physics.getOwner(c.handle)?.type;
    return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel';
  };

  /** Every floor in a column, top to bottom, that a player can stand on. */
  private sampleColumn(ix: number, iz: number, deadly: Set<number>): void {
    const b = this.arena.bounds;
    const x = this.minX + (ix + 0.5) * CELL;
    const z = this.minZ + (iz + 0.5) * CELL;
    const top = b.max.y - 0.1;
    const heights: number[] = [];
    this.queries++;
    this.physics.world.intersectionsWithRay(
      new RAPIER.Ray({ x, y: top, z }, { x: 0, y: -1, z: 0 }),
      top - b.min.y + 1,
      true,
      (hit) => {
        if (hit.normal.y > 0.7 && this.walkable(hit.collider)) heights.push(top - hit.timeOfImpact);
        return true;
      },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      this.ignore,
    );
    heights.sort((a, c) => c - a);
    const key = this.key(ix, iz);
    let last = Infinity;
    for (const y of heights) {
      if (last - y < 0.1) continue; // two boxes' tops meeting
      last = y;
      // On the roof outside the room, or below the kill plane.
      if (y + PLAYER_HEIGHT > b.max.y || y < this.arena.killY + 0.3) continue;
      const floor = new THREE.Vector3(x, y, z);
      const over = this.arena.hazards.filter((h) => h.covers?.(floor));
      if (over.some((h) => !h.dangerNow || h.alwaysDeadly)) {
        deadly.add(key);
        continue;
      }
      if (!this.headroom(floor)) continue;
      const id = this.nodes.length;
      this.nodes.push({ id, x, y, z, hazards: over, penalty: 0, links: [] });
      let col = this.columns.get(key);
      if (!col) this.columns.set(key, (col = []));
      col.push(id);
    }
  }

  /**
   * Room to stand: a body-sized capsule from just above step height (the next stair up
   * is within a body's radius and the controller steps onto it) to head height.
   */
  private headroom(floor: THREE.Vector3): boolean {
    this.queries++;
    const r = PLAYER_RADIUS - 0.05;
    const bottom = STEP + 0.05;
    const top = PLAYER_HEIGHT + 0.05;
    const hit = this.physics.world.intersectionWithShape(
      { x: floor.x, y: floor.y + (bottom + top) / 2, z: floor.z },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Capsule((top - bottom) / 2 - r, r),
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      this.ignore,
    );
    return hit === null;
  }

  /** The walkable floor height under (x, z) at most `below` under `fromY`, or null. */
  private floorAt(x: number, z: number, fromY: number, below: number): number | null {
    this.queries++;
    const hit = this.physics.world.castRayAndGetNormal(
      new RAPIER.Ray({ x, y: fromY, z }, { x: 0, y: -1, z: 0 }),
      below,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      this.ignore,
    );
    if (!hit || hit.timeOfImpact < 1e-3 || hit.normal.y < 0.7 || !this.walkable(hit.collider)) return null;
    return fromY - hit.timeOfImpact;
  }

  /** Nothing solid on the straight line between two points. */
  private clear(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    this.queries++;
    _from.set(ax, ay, az);
    _dir.set(bx - ax, by - ay, bz - az);
    const len = _dir.length();
    if (len < 1e-4) return true;
    _dir.divideScalar(len);
    const hit = this.physics.world.castRay(
      new RAPIER.Ray(_from, _dir),
      len,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      this.ignore,
    );
    return hit === null;
  }

  private linkNode(a: NavNode): void {
    const [ix, iz] = this.cellOf(a.x, a.z);
    for (const [dx, dz] of DIRS) {
      let reached = false;
      for (const id of this.columns.get(this.key(ix + dx, iz + dz)) ?? []) {
        const b = this.nodes[id];
        const kind = this.linkKind(a, b);
        if (!kind) continue;
        reached ||= kind === 'walk';
        const hurt = kind === 'drop' ? fallDamage(a.y - b.y) : 0;
        const cost = CELL * (1 + b.penalty) + (kind === 'drop' ? 1 + (a.y - b.y) * 0.3 + hurt * HURT_COST : kind === 'jump' ? 2 : 0);
        a.links.push({ to: b.id, kind, cost });
      }
      // Across a gap: only where there is no floor at this height in between.
      if (!reached) this.gapJumps(a, ix, iz, dx, dz);
    }
  }

  private linkKind(a: NavNode, b: NavNode): LinkKind | null {
    const dy = b.y - a.y;
    const hi = Math.max(a.y, b.y);
    if (Math.abs(dy) <= WALK_DY) {
      // Floor all the way, in steps the controller can take - across the body's width too
      // (stepping onto stairs from the side meets the next step up as well).
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const px = (b.z - a.z) * BODY_HALF;
      const pz = (a.x - b.x) * BODY_HALF;
      for (const s of [0, 1, -1]) {
        const m = this.floorAt(mx + px * s, mz + pz * s, hi + 0.8, 1.6);
        if (m === null || Math.abs(m - a.y) > STEP || Math.abs(b.y - m) > STEP) return null;
      }
      return this.clear(a.x, hi + 1.0, a.z, b.x, hi + 1.0, b.z) && this.clear(a.x, hi + 1.7, a.z, b.x, hi + 1.7, b.z) ? 'walk' : null;
    }
    if (dy < 0 && -dy <= MAX_HURT_DROP) {
      // Walk off the edge at our height, then fall clear.
      return this.clear(a.x, a.y + 1.0, a.z, b.x, a.y + 1.0, b.z) && this.clear(b.x, a.y + 1.0, b.z, b.x, b.y + 0.1, b.z) ? 'drop' : null;
    }
    if (dy > 0 && dy <= MAX_JUMP_UP) {
      // Room to jump, and nothing between us and the top of the ledge.
      return this.clear(a.x, a.y + 1.8, a.z, a.x, a.y + 1.8 + MAX_JUMP_UP, a.z) && this.clear(a.x, b.y + 0.6, a.z, b.x, b.y + 0.6, b.z) && this.clear(a.x, b.y + 1.6, a.z, b.x, b.y + 1.6, b.z)
        ? 'jump'
        : null;
    }
    return null;
  }

  private gapJumps(a: NavNode, ix: number, iz: number, dx: number, dz: number): void {
    for (let k = 2; k <= MAX_GAP_CELLS; k++) {
      // Every cell in between must be a hole at this height (no floor within half a metre).
      let gap = true;
      for (let j = 1; j < k && gap; j++) {
        for (const id of this.columns.get(this.key(ix + dx * j, iz + dz * j)) ?? []) {
          if (Math.abs(this.nodes[id].y - a.y) < 0.6) gap = false;
        }
      }
      if (!gap) return;
      for (const id of this.columns.get(this.key(ix + dx * k, iz + dz * k)) ?? []) {
        const b = this.nodes[id];
        const dy = b.y - a.y;
        if (dy > 0.5 || dy < -2) continue;
        if (!this.clear(a.x, a.y + 1.0, a.z, b.x, a.y + 1.0, b.z) || !this.clear(a.x, a.y + 1.9, a.z, b.x, a.y + 1.9, b.z)) continue;
        a.links.push({ to: b.id, kind: 'jump', cost: k * CELL * (1 + b.penalty) + 3 });
        return;
      }
    }
  }

  // --- Queries ------------------------------------------------------------------------

  /**
   * Wide open floor at height `y` (a floor's surface): every cell within `reach` of (x, z)
   * has safe, unpenalised floor at that height - no edge, drop, wall, acid or hazard nearby.
   */
  openFloor(x: number, y: number, z: number, reach: number): boolean {
    const [ix, iz] = this.cellOf(x, z);
    for (let jz = -reach; jz <= reach; jz++) {
      for (let jx = -reach; jx <= reach; jx++) {
        const col = this.columns.get(this.key(ix + jx, iz + jz));
        const ok = col?.some((id) => {
          const n = this.nodes[id];
          return Math.abs(n.y - y) < 0.3 && n.penalty === 0 && !n.hazards.length;
        });
        if (!ok) return false;
      }
    }
    return true;
  }

  /** Deadly right now (a timed hazard over it is in its warning or active). */
  blocked(n: NavNode): boolean {
    return n.hazards.some((h) => h.dangerNow?.() ?? true);
  }

  /** The node a player whose body centre is at `p` stands on (or nearest to), or null. */
  nearest(p: THREE.Vector3, reach = 2): NavNode | null {
    const feet = p.y - PLAYER_FEET_OFFSET;
    const [ix, iz] = this.cellOf(p.x, p.z);
    let best: NavNode | null = null;
    let bestScore = Infinity;
    for (let r = 0; r <= reach && !best; r++) {
      for (let jz = -r; jz <= r; jz++) {
        for (let jx = -r; jx <= r; jx++) {
          if (Math.max(Math.abs(jx), Math.abs(jz)) !== r) continue;
          for (const id of this.columns.get(this.key(ix + jx, iz + jz)) ?? []) {
            const n = this.nodes[id];
            const dy = feet - n.y;
            // Standing on it, or falling toward it (not floors well overhead).
            if (dy < -0.6 || dy > 6) continue;
            const score = Math.hypot(n.x - p.x, n.z - p.z) + Math.abs(dy) * 2;
            if (score < bestScore) {
              bestScore = score;
              best = n;
            }
          }
        }
      }
    }
    return best;
  }

  /** Body-centre position for standing on `n`. */
  standAt(n: NavNode, out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(n.x, n.y + PLAYER_FEET_OFFSET + 0.02, n.z);
  }

  /**
   * Cheapest route from the node under `from` to the node nearest `to` (both body-centre
   * positions), preferring to go round anything dangerous right now and never stepping on
   * what `avoid` names (open floor portals). Null if there is none.
   */
  findPath(from: THREE.Vector3 | NavNode, to: THREE.Vector3 | NavNode, avoid?: (n: NavNode) => boolean): NavPath | null {
    const start = 'links' in from ? from : this.nearest(from);
    const goal = 'links' in to ? to : this.nearest(to, 3);
    if (!start || !goal) return null;
    const g = new Map<number, number>([[start.id, 0]]);
    const came = new Map<number, { from: number; link: NavLink }>();
    const h = (n: NavNode) => Math.hypot(n.x - goal.x, n.y - goal.y, n.z - goal.z);
    const open = new MinHeap();
    open.push(start.id, h(start));
    const closed = new Set<number>();
    while (open.size) {
      const id = open.pop();
      if (id === goal.id) break;
      if (closed.has(id)) continue;
      closed.add(id);
      const gi = g.get(id)!;
      for (const link of this.nodes[id].links) {
        const next = this.nodes[link.to];
        if (closed.has(next.id) || avoid?.(next)) continue;
        // Dangerous right now is only for a moment: dearer (take another way if there is one),
        // but still a way - the follower waits for it.
        const cost = gi + link.cost + (this.blocked(next) ? BLOCKED_COST : 0);
        if (cost >= (g.get(next.id) ?? Infinity)) continue;
        g.set(next.id, cost);
        came.set(next.id, { from: id, link });
        open.push(next.id, cost + h(next));
      }
    }
    if (start !== goal && !came.has(goal.id)) return null;
    const nodes: NavNode[] = [goal];
    const links: NavLink[] = [];
    for (let id = goal.id; id !== start.id; ) {
      const step = came.get(id)!;
      links.unshift(step.link);
      id = step.from;
      nodes.unshift(this.nodes[id]);
    }
    return { nodes, links };
  }

  /** Points for the nodes and coloured lines for the links (`?debug=nav`). */
  debugObject(): THREE.Object3D {
    const group = new THREE.Group();
    const pts: number[] = [];
    const ptColors: number[] = [];
    const lines: Record<LinkKind, number[]> = { walk: [], drop: [], jump: [] };
    for (const n of this.nodes) {
      pts.push(n.x, n.y + 0.06, n.z);
      const c = n.hazards.length ? [1, 0.45, 0.1] : n.penalty > 0 ? [1, 0.9, 0.2] : [0.3, 1, 0.5];
      ptColors.push(...c);
      for (const l of n.links) {
        const m = this.nodes[l.to];
        lines[l.kind].push(n.x, n.y + 0.08, n.z, m.x, m.y + 0.08, m.z);
      }
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    pg.setAttribute('color', new THREE.Float32BufferAttribute(ptColors, 3));
    group.add(new THREE.Points(pg, new THREE.PointsMaterial({ size: 0.12, vertexColors: true, depthTest: true })));
    const colors: Record<LinkKind, number> = { walk: 0x8fa3b8, drop: 0x3aa0ff, jump: 0xffd23a };
    for (const kind of ['walk', 'drop', 'jump'] as const) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lines[kind], 3));
      group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: colors[kind], transparent: true, opacity: kind === 'walk' ? 0.35 : 0.9 })));
    }
    return group;
  }
}

/** Binary min-heap of node ids by priority. */
class MinHeap {
  private readonly ids: number[] = [];
  private readonly pri: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  push(id: number, p: number): void {
    const ids = this.ids;
    const pri = this.pri;
    let i = ids.length;
    ids.push(id);
    pri.push(p);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (pri[parent] <= p) break;
      ids[i] = ids[parent];
      pri[i] = pri[parent];
      i = parent;
    }
    ids[i] = id;
    pri[i] = p;
  }

  pop(): number {
    const ids = this.ids;
    const pri = this.pri;
    const top = ids[0];
    const lastId = ids.pop()!;
    const lastP = pri.pop()!;
    if (ids.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        let mp = lastP;
        if (l < ids.length && pri[l] < mp) {
          m = l;
          mp = pri[l];
        }
        if (r < ids.length && pri[r] < mp) m = r;
        if (m === i) break;
        ids[i] = ids[m];
        pri[i] = pri[m];
        i = m;
      }
      ids[i] = lastId;
      pri[i] = lastP;
    }
    return top;
  }
}
