import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { EYE_OFFSET, PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { NavGraph, NavNode } from './NavGraph';
import { exitInReach, exitRange, type ClimbSpot, type ClimbSpots } from './ClimbSpots';

/** Islands smaller than this many floor points (a ledge, a step) are no place to hop from. */
const MIN_ISLAND = 12;
/** Places to stand that each island is looked out from (spread over it). */
const VIEWPOINTS = 32;
/** Ways onward kept for each pair of islands (the nearest exits to the viewpoints first). */
const OPTIONS = 6;
/** What a hop costs, in route-cost units (about metres of walking): aim, two shots, the step in, the flight. */
export const HOP_COST = 20;

/** A hop to another island: stand at `from` (or anywhere it is in view from), and use `spot` as the exit. */
export interface HopOption {
  readonly from: NavNode;
  readonly spot: ClimbSpot;
}

export interface HopRoute {
  /** The first hop's choices, nearest the start first. */
  readonly first: readonly HopOption[];
  readonly hops: number;
}

const cache = new WeakMap<object, IslandHops>();
const _eye = new THREE.Vector3();
const _to = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Which island (NavGraph.island) can be hopped to from which, worked out once per arena from a
 * spread of places to stand on each one and the travel exits in view from there - so a bot
 * stranded on one block of Cubefield can plan its way, hop by hop, to an orb or a player on a
 * block it can't even see from where it stands (most of those are higher up: only a ceiling
 * exit gets you there). Routes are fewest hops.
 */
export class IslandHops {
  readonly buildMs: number;
  /** from island -> to island -> ways there. */
  private readonly edges = new Map<number, Map<number, HopOption[]>>();
  private readonly routes = new Map<string, HopRoute | null>();
  private readonly nav: NavGraph;

  static for(key: object, nav: NavGraph, travel: ClimbSpots, physics: PhysicsWorld): IslandHops {
    let h = cache.get(key);
    if (!h) {
      h = new IslandHops(nav, travel, physics);
      cache.set(key, h);
    }
    return h;
  }

  constructor(nav: NavGraph, travel: ClimbSpots, physics: PhysicsWorld) {
    const t0 = performance.now();
    this.nav = nav;
    const islands = new Map<number, NavNode[]>();
    for (const n of nav.nodes) {
      const id = nav.island(n);
      let list = islands.get(id);
      if (!list) islands.set(id, (list = []));
      list.push(n);
    }
    const spots = travel.spots.map((s) => ({ s, island: nav.island(s.node), reach: exitRange(s) }));
    for (const [id, nodes] of islands) {
      if (nodes.length < MIN_ISLAND) continue;
      // Open floor, away from the edges (a way in goes beside it), spread over the island.
      const good = nodes.filter((n) => n.penalty === 0 && !n.hazards.length);
      const pool = good.length ? good : nodes;
      const step = Math.max(1, Math.floor(pool.length / VIEWPOINTS));
      const out = new Map<number, { o: HopOption; d: number }[]>();
      for (let k = 0; k < pool.length; k += step) {
        const v = pool[k];
        _eye.set(v.x, v.y + PLAYER_FEET_OFFSET + EYE_OFFSET, v.z);
        for (const { s, island, reach } of spots) {
          if (island === id || nodesOf(islands, island) < MIN_ISLAND) continue;
          _to.copy(_eye).sub(s.point);
          const d = _to.length();
          if (d > reach || !exitInReach(s, _to, d)) continue;
          const list = out.get(island) ?? [];
          // (Only the nearest few per island pair are worth a ray.)
          if (list.length >= OPTIONS && d >= list[list.length - 1].d) continue;
          if (!clear(physics, _eye, s)) continue;
          list.push({ o: { from: v, spot: s }, d });
          list.sort((a, b) => a.d - b.d);
          if (list.length > OPTIONS) list.length = OPTIONS;
          out.set(island, list);
        }
      }
      const m = new Map<number, HopOption[]>();
      for (const [to, list] of out) m.set(to, list.map((x) => x.o));
      this.edges.set(id, m);
    }
    this.buildMs = performance.now() - t0;
  }

  /** Fewest hops from island `from` to island `to` (null: no way at all; zero hops on the same island). */
  route(from: number, to: number): HopRoute | null {
    if (from === to) return { first: [], hops: 0 };
    const key = `${from}>${to}`;
    if (this.routes.has(key)) return this.routes.get(key)!;
    // Breadth first from the start, remembering which first hop led where.
    const firstTo = new Map<number, number>();
    const depth = new Map<number, number>([[from, 0]]);
    let frontier = [from];
    let found: number | null = null;
    while (frontier.length && found === null) {
      const next: number[] = [];
      for (const i of frontier) {
        for (const j of this.edges.get(i)?.keys() ?? []) {
          if (depth.has(j)) continue;
          depth.set(j, depth.get(i)! + 1);
          firstTo.set(j, i === from ? j : firstTo.get(i)!);
          if (j === to) found = j;
          next.push(j);
        }
      }
      frontier = next;
    }
    const route = found === null ? null : { first: this.edges.get(from)!.get(firstTo.get(found)!)!, hops: depth.get(found)! };
    this.routes.set(key, route);
    return route;
  }

  /** The island of the floor under a body-centre position `p` (null: no floor near). */
  islandAt(p: THREE.Vector3): number | null {
    const n = this.nav.nearest(p, 2);
    return n ? this.nav.island(n) : null;
  }
}

function nodesOf(islands: Map<number, NavNode[]>, id: number): number {
  return islands.get(id)?.length ?? 0;
}

/** Nothing solid between the eye and the exit's spot. */
function clear(physics: PhysicsWorld, eye: THREE.Vector3, s: ClimbSpot): boolean {
  _to.copy(s.point).addScaledVector(s.normal, 0.05);
  _dir.copy(_to).sub(eye);
  const d = _dir.length();
  if (d < 1e-3) return true;
  const hit = physics.world.castRay(new RAPIER.Ray(eye, _dir.divideScalar(d)), d, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, (col) => physics.getOwner(col.handle)?.type === 'solid');
  return !hit || hit.timeOfImpact >= d - 0.1;
}
