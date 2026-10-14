import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { NavGraph, type NavNode } from '../../src/bots/NavGraph';
import { EXIT_SPEEDS, flyOut } from '../../src/bots/TrapSpots';
import { FloorButton } from '../../src/world/hazards/FloorButton';
import { LaserReceiver } from '../../src/world/hazards/Laser';
import { Switch } from '../../src/world/hazards/Switch';
import type { HazardContext } from '../../src/world/hazards/Hazard';
import type { Face } from '../../src/world/Level';
import { PORTAL_HALF_H, PORTAL_HALF_W, PORTAL_HEIGHT, PORTAL_WIDTH } from '../../src/portals/Portal';
import { PLAYER_FEET_OFFSET } from '../../src/player/PlayerController';
import { expandPieces, footprint, isSymmetric, mapKind, mapToArena, rotated, withDefaults, type MapData, type Piece } from '../../src/world/maps/MapFormat';

/**
 * Can the level be finished (puzzle) or walked (combat)? The answer comes from the game's own
 * navigation: the bots' walk/jump/drop graph over the real colliders, plus portal hops worked
 * out the way an Ultra hard bot works them out - an exit in view that lands somewhere new, and
 * floor to put the way in beside the player. The model uses it as the validation a level
 * designer would do by playing: "is the exit reachable, and how many portal hops does it take?".
 *
 * It is a lower bound on what players can do: momentum flings and beams bent through portals
 * are not analysed, so a "no route" can mean "no route this analysis can see". Doors are assumed
 * to open (the map is analysed with them removed) and are reported separately, with whether a
 * beam or crate opens them while the level just runs.
 */

/** How far an exit portal can be shot from. */
const SHOT_RANGE = 45;
const EYE_HEIGHT = 1.6;
/** Exit candidates on portal floors are tried this far apart. */
const FLOOR_SPACING = 2;
/** Reached nodes are thinned to one per this many metres (and per storey) when looking for exits. */
const LOOK_CELL = 3;
/**
 * A shot has to meet its surface at least this steeply (the sine of the angle between the line
 * of fire and the surface): a floor across a pit is shot at a shallow angle, but not a grazing one.
 */
const GRAZING = 0.08;
/** A way in must be this near the player. */
const ENTRANCE_REACH = 3;
/** Wall and ceiling exits are tried this far apart. */
const WALL_SPACING = 2;
/** Landing harder than this (m/s into the floor) is not counted as a way: it hurts. */
const MAX_IMPACT = 16;
/** The analysis gives up (and says so) after this long. */
const BUDGET_MS = 25_000;
/** Seconds the real level runs untouched, then with every switch shot, for the door check. */
const DOOR_IDLE_SECONDS = 2;
const DOOR_RUN_SECONDS = 9;

export interface RouteStep {
  /** `walk`: on foot (stairs, jumps, drops included); `portal`: an exit shot from `from`, landing at `to`. */
  kind: 'walk' | 'portal';
  from: [number, number, number];
  to: [number, number, number];
  /** Words for the model: what is walked, or where the exit goes and what it lands on. */
  text: string;
}

export interface DoorStatus {
  /** Index of the door piece. */
  piece: number;
  /** The receiver or button id the door waits for. */
  waitsFor: string;
  /** The piece that opens it, when one has that id. */
  source: { piece: number; type: string } | null;
  /**
   * Found by running the real level: `itself` (a beam or a crate already opens it), `switches`
   * (it opens once the level's switches are shot, e.g. a crate dropper that lands on its button),
   * or `never` (nothing in the level opens it that a simulation can see).
   */
  opens: 'itself' | 'switches' | 'never';
  /** The route found to the exit goes through this door. */
  onRoute: boolean;
}

export interface Stranded {
  /** Bounding box of the region: min x, min z, max x, max z, and the height of its floor. */
  box: [number, number, number, number];
  y: number;
  nodes: number;
  /** The piece it is on or nearest to, in words. */
  near: string;
  /** The reached floor that comes closest to it: where, how far across, and how much higher the stranded floor is. */
  closest: { from: [number, number, number]; to: [number, number, number]; across: number; rise: number } | null;
}

export interface RouteReport {
  kind: 'puzzle' | 'combat';
  /**
   * Puzzle: the goal can be reached from the spawn, with every door taken as open. Combat:
   * every spawn can be reached from the first.
   */
  connected: boolean;
  /** Doors on the route that nothing in the level opens (puzzle). */
  blockedByDoor: DoorStatus | null;
  /** Fewest portal hops (exit shot, entrance beside the player, step in) on the best route; 0 is a walk. Null when not connected. */
  hops: number | null;
  steps: RouteStep[];
  /** Walkable floor no route from the spawn reaches, even with portals (most important first). */
  stranded: Stranded[];
  /** Combat: spawns the first spawn cannot reach, as coordinates. */
  unreachableSpawns: [number, number, number][];
  doors: DoorStatus[];
  /** Things the analysis could not see or assumed. */
  notes: string[];
  stats: { nodes: number; reached: number; exits: number; portalFaces: number; ms: number };
}

interface Exit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  node: NavNode;
  kind: 'wall' | 'ceiling' | 'floor';
}

type Via =
  | { how: 'start' }
  | { how: 'link'; from: number; pad?: boolean }
  | { how: 'portal'; from: number; exit: Exit; shotFrom: number };

const r1 = (n: number) => Math.round(n * 10) / 10;
const at = (v: { x: number; y: number; z: number }): [number, number, number] => [r1(v.x), r1(v.y), r1(v.z)];
const fmt = (v: ArrayLike<number>) => `[${Array.from(v).map(r1).join(', ')}]`;

/** Sample offsets across -half..half, about `spacing` apart, always including both ends (or just 0 for a thin face). */
function spread(half: number, spacing: number): number[] {
  if (half <= 0.05) return [0];
  const n = Math.max(1, Math.ceil((2 * half) / spacing));
  return Array.from({ length: n + 1 }, (_, k) => -half + (2 * half * k) / n);
}

/** The piece at a point (or the nearest below it), in words: "block #4" - for telling the model where a route goes. */
export function pieceAt(map: MapData, p: { x: number; y: number; z: number }): string {
  const mirrored = isSymmetric(map);
  let best: { text: string; d: number } | null = null;
  const consider = (piece: Piece, label: string) => {
    if (!Array.isArray(piece.size) || !['block', 'portal-wall', 'wall', 'floor', 'stairs', 'slope', 'glass', 'room'].includes(piece.type)) return;
    if (piece.type === 'room') return;
    const { min, max } = footprint(piece);
    const dx = Math.max(min.x - p.x, 0, p.x - max.x);
    const dz = Math.max(min.z - p.z, 0, p.z - max.z);
    const dy = Math.max(min.y - p.y, 0, p.y - max.y);
    const d = Math.hypot(dx, dz, dy);
    if (!best || d < best.d) best = { text: label, d };
  };
  map.pieces.forEach((raw, i) => {
    const piece = withDefaults(raw);
    consider(piece, `${piece.type} #${i}`);
    if (mirrored && !piece.center) consider(rotated(piece), `${piece.type} #${i} (its mirror copy)`);
  });
  const found = best as { text: string; d: number } | null;
  if (!found) return 'the room';
  return found.d < 0.6 ? found.text : found.d < 3 ? `near ${found.text}` : 'open floor of the room';
}

/** Whether a portal fits on the face in some orientation. */
const fits = (f: Face) => (f.width >= PORTAL_WIDTH + 0.05 && f.height >= PORTAL_HEIGHT + 0.05) || (f.height >= PORTAL_WIDTH + 0.05 && f.width >= PORTAL_HEIGHT + 0.05);

/** How far `p` is from the face's rectangle (0 on it), and whether it is on the front side. */
function faceDistance(f: Face, p: THREE.Vector3): { d: number; front: boolean } {
  const d = p.clone().sub(f.center);
  const x = d.dot(f.right);
  const y = d.dot(f.up);
  const z = d.dot(f.normal);
  const cx = Math.max(0, Math.abs(x) - f.width / 2);
  const cy = Math.max(0, Math.abs(y) - f.height / 2);
  return { d: Math.hypot(cx, cy, z), front: z > -0.2 };
}

export async function analyzeRoutes(map: MapData): Promise<RouteReport> {
  const t0 = performance.now();
  const kind = mapKind(map);
  const notes: string[] = [];
  // Doors are assumed to open: the level is analysed without them (they are reported below).
  const doorless: MapData = { ...map, pieces: map.pieces.filter((p) => p.type !== 'door') };
  const sim = await ArenaSim.load(mapToArena(doorless), null);
  try {
    const arena = sim.arena;
    const nav = NavGraph.for(sim, arena, sim.physics);
    const portalFaces = sim.level.faces.filter((f) => f.portalable && fits(f));
    const exits: Exit[] = [];
    // Exits on portal floors: the way across a gap or a pit - a portal on the far floor lands you on it.
    for (const f of portalFaces) {
      if (f.normal.y < 0.7) continue;
      for (const y of spread(f.height / 2 - 0.9, FLOOR_SPACING)) {
        for (const x of spread(f.width / 2 - 0.9, FLOOR_SPACING)) {
          const point = f.toWorld(x, y);
          const node = nav.nearest(point.clone().setY(point.y + PLAYER_FEET_OFFSET), 0);
          if (!node || node.hazards.length || Math.abs(node.y - point.y) > 0.4) continue;
          exits.push({ point, normal: f.normal.clone(), node, kind: 'floor' });
        }
      }
    }
    // Exits on walls and ceilings: whoever comes out flies on under gravity and lands somewhere.
    for (const f of portalFaces) {
      const kind = f.normal.y < -0.7 ? 'ceiling' : Math.abs(f.normal.y) < 0.3 ? 'wall' : null;
      if (!kind) continue;
      // A ceiling portal turns to face away from whoever shoots it, so it has to fit at any angle.
      const m = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + 0.05;
      const mx = kind === 'ceiling' ? m : PORTAL_HALF_W + 0.05;
      const my = kind === 'ceiling' ? m : PORTAL_HALF_H + 0.05;
      const hw = f.width / 2 - mx;
      const hh = f.height / 2 - my;
      if (hw < 0 || hh < 0) continue;
      for (const y of spread(hh, WALL_SPACING)) {
        for (const x of spread(hw, WALL_SPACING)) {
          const point = f.toWorld(x, y);
          for (const speed of EXIT_SPEEDS) {
            const fl = flyOut(sim.physics, arena.killY, point, f.normal, speed);
            if (!fl.land || !fl.normal || fl.normal.y < 0.7 || fl.impact > MAX_IMPACT) continue;
            const node = nav.nearest(fl.land.clone().setY(fl.land.y + PLAYER_FEET_OFFSET), 1);
            if (!node || node.hazards.length || Math.abs(node.y - fl.land.y) > 0.6) continue;
            exits.push({ point, normal: f.normal.clone(), node, kind });
            break;
          }
        }
      }
    }

    const physics = sim.physics;
    const sees = (from: THREE.Vector3, to: THREE.Vector3): boolean => {
      const dir = to.clone().sub(from);
      const dist = dir.length();
      if (dist < 1e-3) return true;
      dir.divideScalar(dist);
      const hit = physics.world.castRay(new RAPIER.Ray(from, dir), dist, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, (c) => {
        const t = physics.getOwner(c.handle)?.type;
        return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel' && t !== 'ramp';
      });
      return !hit || hit.timeOfImpact >= dist - 0.08;
    };

    const spawnNodes: NavNode[] = [];
    const spawnPositions: THREE.Vector3[] = [];
    const stuckSpawns: [number, number, number][] = [];
    const seen = new Set<string>();
    for (const s of arena.spawns) {
      const key = s.position.toArray().map(r1).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const n = nav.nearest(s.position, 1);
      spawnPositions.push(s.position);
      if (n) spawnNodes.push(n);
      else {
        stuckSpawns.push(at({ x: s.position.x, y: s.position.y - PLAYER_FEET_OFFSET, z: s.position.z }));
        notes.push(`The spawn at ${fmt([s.position.x, s.position.y - PLAYER_FEET_OFFSET, s.position.z])} is not on floor a player can walk from (no walkable floor under it, or no room to stand).`);
      }
    }
    const goal = arena.goal;
    const goalNodes = goal ? nav.nodes.filter((n) => Math.hypot(n.x - goal.position.x, n.z - goal.position.z) < 1.5 && Math.abs(n.y - goal.position.y) < 0.8) : [];
    if (kind === 'puzzle' && goal && goalNodes.length === 0)
      notes.push(`The goal at ${fmt([goal.position.x, goal.position.y, goal.position.z])} has no standing floor under it (or no headroom), so nobody can step on it.`);

    // Jump pads throw whoever steps on them to a floor spot: a one-way link from the pad's floor to where it lands.
    const padFrom = new Map<number, NavNode[]>();
    for (const p of expandPieces(doorless)) {
      if (p.type !== 'jump-pad' || !Array.isArray(p.size) || !Array.isArray(p.to)) continue;
      const { min, max } = footprint(p);
      const target = nav.nearest(new THREE.Vector3(p.to[0], p.to[1] + PLAYER_FEET_OFFSET, p.to[2]), 2);
      if (!target) {
        notes.push(`The jump pad at ${fmt(p.at)} lands at ${fmt(p.to)}, which is not walkable floor.`);
        continue;
      }
      // (The plate itself is not floor the navigation graph keeps, so the way on to it is the floor around it.)
      for (const n of nav.nodes) {
        if (n.x < min.x - 1.6 || n.x > max.x + 1.6 || n.z < min.z - 1.6 || n.z > max.z + 1.6 || Math.abs(n.y - p.at[1]) > 0.6) continue;
        (padFrom.get(n.id) ?? padFrom.set(n.id, []).get(n.id)!).push(target);
      }
    }

    // ---- Reachability, layer by layer: a closure on foot, then every exit that can be shot from the reached floor.
    const via = new Map<number, Via>();
    const layerOf = new Map<number, number>();
    const closure = (seeds: { id: number; via: Via }[], layer: number): number[] => {
      const added: number[] = [];
      const queue: number[] = [];
      for (const s of seeds) {
        if (via.has(s.id)) continue;
        via.set(s.id, s.via);
        layerOf.set(s.id, layer);
        queue.push(s.id);
        added.push(s.id);
      }
      while (queue.length) {
        const id = queue.pop()!;
        for (const link of nav.nodes[id].links) {
          if (via.has(link.to)) continue;
          via.set(link.to, { how: 'link', from: id });
          layerOf.set(link.to, layer);
          queue.push(link.to);
          added.push(link.to);
        }
        for (const t of padFrom.get(id) ?? []) {
          if (via.has(t.id)) continue;
          via.set(t.id, { how: 'link', from: id, pad: true });
          layerOf.set(t.id, layer);
          queue.push(t.id);
          added.push(t.id);
        }
      }
      return added;
    };

    const entranceFaces = portalFaces.filter((f) => f.normal.y > -0.5);
    const entranceCache = new Map<number, boolean>();
    const hasEntrance = (n: NavNode): boolean => {
      let ok = entranceCache.get(n.id);
      if (ok === undefined) {
        const centre = new THREE.Vector3(n.x, n.y + 0.9, n.z);
        ok = entranceFaces.some((f) => {
          const r = faceDistance(f, centre);
          return r.front && r.d <= ENTRANCE_REACH;
        });
        entranceCache.set(n.id, ok);
      }
      return ok;
    };

    const start = spawnNodes[0];
    let fresh: number[] = start ? closure([{ id: start.id, via: { how: 'start' } }], 0) : [];
    const used = new Set<Exit>();
    let layer = 0;
    let timedOut = false;
    const goalReached = () => goalNodes.some((n) => via.has(n.id));
    const done = () => (kind === 'puzzle' ? goalReached() : spawnNodes.every((n) => via.has(n.id)));

    while (!done() && fresh.length) {
      if (performance.now() - t0 > BUDGET_MS) {
        timedOut = true;
        break;
      }
      layer++;
      // One look-out per few metres and storey among the nodes the last step reached.
      const looks = new Map<string, NavNode>();
      for (const id of fresh) {
        const n = nav.nodes[id];
        const key = `${Math.floor(n.x / LOOK_CELL)},${Math.floor(n.z / LOOK_CELL)},${Math.round(n.y / 1.5)}`;
        if (!looks.has(key) && hasEntrance(n)) looks.set(key, n);
      }
      const seeds: { id: number; via: Via }[] = [];
      for (const exit of exits) {
        if (used.has(exit) || via.has(exit.node.id)) continue;
        for (const n of looks.values()) {
          const eye = new THREE.Vector3(n.x, n.y + EYE_HEIGHT, n.z);
          const to = exit.point.clone().addScaledVector(exit.normal, 0.05);
          const d = eye.distanceTo(to);
          if (d > SHOT_RANGE || exit.normal.dot(eye.clone().sub(exit.point)) < GRAZING * d) continue;
          if (!sees(eye, to)) continue;
          used.add(exit);
          seeds.push({ id: exit.node.id, via: { how: 'portal', from: n.id, exit, shotFrom: n.id } });
          break;
        }
      }
      if (!seeds.length) break;
      fresh = closure(seeds, layer);
    }
    if (timedOut) notes.push('The analysis ran out of time before it was finished; a "not reachable" may be wrong.');

    // ---- What the player has to do.
    const steps: RouteStep[] = [];
    const targetNode = kind === 'puzzle' ? goalNodes.find((n) => via.has(n.id)) : null;
    if (targetNode) {
      const chain: { id: number; via: Via }[] = [];
      for (let id = targetNode.id; ; ) {
        const v = via.get(id)!;
        chain.unshift({ id, via: v });
        if (v.how === 'start') break;
        id = v.from;
      }
      let walkFrom = nav.nodes[chain[0].id];
      let walkLast = walkFrom;
      let counts = { walk: 0, jump: 0, drop: 0, pad: 0 };
      const flushWalk = (to: NavNode | null) => {
        const end = to ?? walkLast;
        if (end !== walkFrom) {
          const parts = [counts.walk ? `${counts.walk} m on foot` : '', counts.jump ? `${counts.jump} jump${counts.jump === 1 ? '' : 's'}` : '', counts.drop ? `${counts.drop} drop${counts.drop === 1 ? '' : 's'}` : '', counts.pad ? `${counts.pad} jump pad${counts.pad === 1 ? '' : 's'}` : ''].filter(Boolean);
          steps.push({ kind: 'walk', from: at(walkFrom), to: at(end), text: `walk from ${fmt(at(walkFrom))} to ${fmt(at(end))} (${parts.join(', ') || 'a few steps'}); ends on ${pieceAt(map, end)}` });
        }
      };
      for (let i = 1; i < chain.length; i++) {
        const node = nav.nodes[chain[i].id];
        const v = chain[i].via;
        if (v.how === 'link') {
          const prev = nav.nodes[v.from];
          const link = prev.links.find((l) => l.to === node.id);
          if (v.pad) counts.pad++;
          else if (link?.kind === 'jump') counts.jump++;
          else if (link?.kind === 'drop') counts.drop++;
          else counts.walk += 1;
          walkLast = node;
        } else if (v.how === 'portal') {
          const shot = nav.nodes[v.shotFrom];
          flushWalk(shot);
          const where = v.exit.kind === 'ceiling' ? 'on a ceiling' : v.exit.kind === 'floor' ? 'on the floor' : 'on a wall';
          steps.push({
            kind: 'portal',
            from: at(shot),
            to: at(node),
            text: `from ${fmt(at(shot))}: shoot an exit portal ${where} at ${fmt(at(v.exit.point))} (${pieceAt(map, v.exit.point)}), an entrance beside you, step in; you come out at ${fmt(at(node))} on ${pieceAt(map, node)}`,
          });
          walkFrom = node;
          walkLast = node;
          counts = { walk: 0, jump: 0, drop: 0, pad: 0 };
        }
      }
      flushWalk(null);
    }

    // ---- What no route reaches.
    const stranded: Stranded[] = [];
    const left = nav.nodes.filter((n) => !via.has(n.id));
    const group = new Map<number, number>();
    let groups = 0;
    const adjacency = new Map<number, number[]>();
    for (const n of nav.nodes) for (const l of n.links) {
      (adjacency.get(n.id) ?? adjacency.set(n.id, []).get(n.id)!).push(l.to);
      (adjacency.get(l.to) ?? adjacency.set(l.to, []).get(l.to)!).push(n.id);
    }
    for (const n of left) {
      if (group.has(n.id)) continue;
      const g = groups++;
      const queue = [n.id];
      group.set(n.id, g);
      while (queue.length) {
        const id = queue.pop()!;
        for (const to of adjacency.get(id) ?? []) if (!via.has(to) && !group.has(to)) {
          group.set(to, g);
          queue.push(to);
        }
      }
    }
    const regions = new Map<number, NavNode[]>();
    for (const n of left) (regions.get(group.get(n.id)!) ?? regions.set(group.get(n.id)!, []).get(group.get(n.id)!)!).push(n);
    for (const nodes of regions.values()) {
      if (nodes.length < 4) continue;
      const xs = nodes.map((n) => n.x);
      const zs = nodes.map((n) => n.z);
      const y = Math.max(...nodes.map((n) => n.y));
      const c = nodes.reduce((a, n) => a.set(a.x + n.x / nodes.length, a.y + n.y / nodes.length, a.z + n.z / nodes.length), new THREE.Vector3());
      stranded.push({ box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)].map(r1) as [number, number, number, number], y: r1(y), nodes: nodes.length, near: pieceAt(map, c), closest: null });
    }
    stranded.sort((a, b) => b.nodes - a.nodes);
    // For the biggest few: where reached floor comes nearest, so the model sees what separates them.
    const reachedNodes = nav.nodes.filter((n) => via.has(n.id));
    for (const region of stranded.slice(0, 3)) {
      const inside = left.filter((n) => n.x >= region.box[0] - 0.01 && n.x <= region.box[2] + 0.01 && n.z >= region.box[1] - 0.01 && n.z <= region.box[3] + 0.01 && !via.has(n.id));
      let best: { a: NavNode; b: NavNode; d: number } | null = null;
      for (const b of inside) {
        for (const a of reachedNodes) {
          const d = Math.hypot(a.x - b.x, a.z - b.z) + Math.abs(a.y - b.y) * 0.5;
          if (!best || d < best.d) best = { a, b, d };
        }
      }
      if (best) region.closest = { from: at(best.a), to: at(best.b), across: r1(Math.hypot(best.a.x - best.b.x, best.a.z - best.b.z)), rise: r1(best.b.y - best.a.y) };
    }

    // ---- Doors: do they open while the level just runs?
    const routePoints: THREE.Vector3[] = [];
    if (targetNode) for (let id = targetNode.id; ; ) {
      const n = nav.nodes[id];
      routePoints.push(new THREE.Vector3(n.x, n.y, n.z));
      const v = via.get(id)!;
      if (v.how === 'start') break;
      id = v.from;
    }
    const doors = await doorStatus(map, routePoints);

    const blockedByDoor = kind === 'puzzle' && targetNode ? (doors.find((d) => d.onRoute && d.opens === 'never') ?? null) : null;
    const unreachableSpawns = [...stuckSpawns, ...spawnNodes.filter((n) => !via.has(n.id)).map((n) => at(n))];
    const hops = kind === 'puzzle' ? (targetNode ? layerOf.get(targetNode.id)! : null) : done() ? Math.max(0, ...spawnNodes.map((n) => layerOf.get(n.id) ?? 0)) : null;
    if (kind === 'puzzle' && !goal) notes.push('The map has no goal.');
    if (map.pieces.some((p) => p.type === 'platform')) notes.push('Moving platforms are not analysed: floor that is only reached by riding one shows as unreachable.');
    return {
      kind,
      connected: kind === 'puzzle' ? !!targetNode : done() && stuckSpawns.length === 0,
      blockedByDoor,
      hops,
      steps,
      stranded: stranded.slice(0, 5),
      unreachableSpawns,
      doors,
      notes,
      stats: { nodes: nav.nodes.length, reached: via.size, exits: exits.length, portalFaces: portalFaces.length, ms: Math.round(performance.now() - t0) },
    };
  } finally {
    sim.dispose();
  }
}

/**
 * Runs the real level (doors and all) with nobody touching anything and notes which receivers
 * and buttons light; then shoots every switch and runs it again, so "the switch drops a crate
 * on the button" is actually played out.
 */
async function doorStatus(map: MapData, route: THREE.Vector3[]): Promise<DoorStatus[]> {
  const doors = map.pieces.map((p, i) => ({ p: withDefaults(p), i })).filter((x) => x.p.type === 'door');
  if (doors.length === 0) return [];
  const sources = map.pieces.map((p, i) => ({ p: withDefaults(p), i })).filter((x) => x.p.type === 'receiver' || x.p.type === 'button');
  const sim = await ArenaSim.load(mapToArena(map), null);
  try {
    const receivers = sim.arena.hazards.filter((h): h is LaserReceiver => h instanceof LaserReceiver);
    const buttons = sim.arena.hazards.filter((h): h is FloorButton => h instanceof FloorButton);
    const switches = sim.arena.hazards.filter((h): h is Switch => h instanceof Switch && h.effect === 'trigger');
    const dt = 1 / 60;
    const run = (seconds: number, into: { receiver: boolean[]; button: boolean[] }) => {
      for (let t = 0; t < seconds / dt; t++) {
        sim.step(dt);
        receivers.forEach((r, k) => (into.receiver[k] ||= r.powered));
        buttons.forEach((b, k) => (into.button[k] ||= b.powered));
      }
    };
    const alone = { receiver: receivers.map(() => false), button: buttons.map(() => false) };
    run(DOOR_IDLE_SECONDS, alone);
    // Every switch shot once, as a player who walked up to each would: crates are released, hazards set off.
    const ctx = (sim as unknown as { hazardCtx: HazardContext }).hazardCtx;
    for (const sw of switches) sw.shoot(ctx);
    const after = { receiver: [...alone.receiver], button: [...alone.button] };
    run(DOOR_RUN_SECONDS, after);

    const order = { receiver: 0, button: 0 };
    const state = new Map<number, 'itself' | 'switches' | 'never'>();
    for (const s of sources) {
      const type = s.p.type as 'receiver' | 'button';
      const k = order[type]++;
      state.set(s.i, alone[type][k] ? 'itself' : after[type][k] ? 'switches' : 'never');
    }
    return doors.map(({ p, i }) => {
      const id = String(p.receiver ?? '');
      const src = sources.find((s) => String(s.p.id ?? '') === id || String(s.p.id ?? '') === id.replace(/~+$/, ''));
      const box = Array.isArray(p.size) ? footprint(p) : null;
      const onRoute = !!box && route.some((q) => q.x >= box.min.x - 1.2 && q.x <= box.max.x + 1.2 && q.z >= box.min.z - 1.2 && q.z <= box.max.z + 1.2 && q.y >= box.min.y - 0.6 && q.y <= box.max.y);
      return { piece: i, waitsFor: id, source: src ? { piece: src.i, type: src.p.type } : null, opens: src ? (state.get(src.i) ?? 'never') : 'never', onRoute };
    });
  } finally {
    sim.dispose();
  }
}

/** The report as the model reads it. Short on purpose: every line is something it can act on. */
export function describeRoutes(r: RouteReport): string {
  const lines: string[] = [];
  const doorWords = (d: DoorStatus): string => {
    const src = d.source ? `${d.source.type} #${d.source.piece}` : 'nothing (no piece has that id)';
    const how =
      d.opens === 'itself'
        ? 'it opens by itself while the level runs (a beam or crate already reaches it)'
        : d.opens === 'switches'
          ? 'it opens once the switches are shot (verified by running the level: the crate or beam does reach it)'
          : 'it never opens in the simulation, with or without the switches shot: nothing reaches it without the player placing portals - if a beam or a crate is meant to come through portals, play that out with playtest';
    return `door #${d.piece}${d.onRoute ? ' (on the route to the exit)' : ''} waits for "${d.waitsFor}" (${src}): ${how}`;
  };
  if (r.kind === 'puzzle') {
    if (r.connected) {
      lines.push(
        r.hops === 0
          ? r.doors.some((d) => d.onRoute)
            ? 'With every door taken as open, the exit can be reached without any portal (hops 0).'
            : 'The exit can be reached on foot: no portals are needed (hops 0). If the request asks for a puzzle, this level is not one yet.'
          : `With every door taken as open, the exit can be reached with ${r.hops} portal hop${r.hops === 1 ? '' : 's'} (a hop is: shoot an exit portal where you can see it, an entrance beside you, step in). That is the fewest this analysis finds.`,
      );
      for (const [i, s] of r.steps.entries()) lines.push(`  ${i + 1}. ${s.text}`);
      if (r.blockedByDoor) lines.push(`BUT the route goes through ${doorWords(r.blockedByDoor)}. As it stands the level cannot be finished.`);
    } else {
      lines.push('The exit CANNOT be reached from the spawn by walking, jumping, dropping, jump pads or portal hops, even with every door taken as open (doors are not what is in the way). The level is not solvable as it stands.');
    }
  } else if (r.connected) {
    lines.push(r.hops === 0 ? 'Every spawn can reach every other on foot.' : `Every spawn can be reached; the furthest needs ${r.hops} portal hop${r.hops === 1 ? '' : 's'}.`);
  } else {
    lines.push(`These spawns cannot be reached from the first spawn: ${r.unreachableSpawns.map((s) => fmt(s)).join(', ')}.`);
  }
  if (r.stranded.length) {
    lines.push('Floor that no route found here reaches (a ledge, island or stairs with no way on to it):');
    for (const s of r.stranded) {
      const c = s.closest;
      const gap = c ? `; nearest reached floor is at ${fmt(c.from)}, ${c.across} m across and the stranded floor is ${Math.abs(c.rise)} m ${c.rise >= 0 ? 'higher' : 'lower'}` : '';
      lines.push(`  - x ${s.box[0]}..${s.box[2]}, z ${s.box[1]}..${s.box[3]}, floor at y=${s.y} (${s.nodes} m², ${s.near})${gap}`);
    }
  }
  const others = r.doors.filter((d) => d !== r.blockedByDoor);
  for (const d of others) lines.push(`  ${doorWords(d)}`);
  for (const n of r.notes) lines.push(`Note: ${n}`);
  lines.push(`(Analysis: ${r.stats.nodes} floor cells, ${r.stats.reached} reachable, ${r.stats.exits} candidate exits, ${r.stats.portalFaces} portal surfaces, ${r.stats.ms} ms. Momentum flings and beams bent through portals are not analysed.)`);
  return lines.join('\n');
}
