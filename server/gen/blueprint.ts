import { z } from 'zod';
import { expandPieces, type MapData, type MapKind, type Piece } from '../../src/world/maps/MapFormat';
import { inside, solidsOf } from './check';
import { slug } from './wire';

/**
 * The blueprint: the level on paper before any piece exists. The planner writes where each
 * part of the level is (a rectangle seen from above plus its heights), what it is for, how a
 * player gets from one part to the next, and where they start. Code then
 *
 *   1. checks it (`blueprintProblems`: inside the room, links that a player can really make,
 *      everything reachable from a spawn, a floor or islands to stand on),
 *   2. builds the structure from it (`scaffold`: room, floor slabs, ledges, platforms, stairs,
 *      walls, spawns, goal) so the structure cannot be forgotten or misplaced, and
 *   3. after the model has added hazards and detail, checks the map still has every part of it
 *      (`conformance`).
 *
 * Kept free of unions and optionals so it fits the model's structured-output limits.
 */

export const HAZARD_TYPES = ['acid', 'spikes', 'trapdoor', 'crusher', 'ram', 'laser', 'platform', 'dropper'] as const;
export const AREA_ROLES = ['ground', 'raised', 'floating', 'stairs', 'wall', 'hazard-zone'] as const;
export const LINK_KINDS = ['walk', 'jump', 'portal', 'drop'] as const;
export const CLIMBS = ['none', 'north', 'south', 'east', 'west'] as const;

export const AreaSchema = z.object({
  /** Short label that links, spawns and the goal refer to ("A", "L2"). */
  id: z.string(),
  role: z.enum(AREA_ROLES),
  /** What it is, in plain words ("central arena floor", "sniper ledge"). */
  what: z.string(),
  /** Centre of its rectangle seen from above. */
  x: z.number(),
  z: z.number(),
  /** Extent along x and along z. */
  width: z.number(),
  depth: z.number(),
  /** Underside (raised, stairs, walls start here; for a floating slab, its underside). */
  baseY: z.number(),
  /** The walkable top surface (a wall's top edge; stairs: the high end). */
  topY: z.number(),
  /** Stairs only: the direction the flight goes up toward; 'none' for everything else. */
  climbs: z.enum(CLIMBS),
  /** The top surface takes portals (a wall: both faces; raised: also its sides). */
  portals: z.boolean(),
  /** Symmetric levels: this area lies on the centre line and is not mirrored. */
  center: z.boolean(),
  /** Hazards that belong on or in this area. */
  hazards: z.array(z.enum(HAZARD_TYPES)),
});
export type Area = z.infer<typeof AreaSchema>;

export const LinkSchema = z.object({
  /** An area id, or FLOOR for the room's own floor. */
  from: z.string(),
  to: z.string(),
  how: z.enum(LINK_KINDS),
  note: z.string(),
});
export type Link = z.infer<typeof LinkSchema>;

export const BlueprintSchema = z.object({
  kind: z.enum(['combat', 'puzzle']),
  size: z.enum(['small', 'medium', 'large']),
  symmetric: z.boolean(),
  name: z.string(),
  hint: z.string(),
  concept: z.string(),
  roomWidth: z.number(),
  roomHeight: z.number(),
  roomDepth: z.number(),
  /** floor: the room's own floor is there, everything is built on it. void: no floor; the ground-level islands are areas. */
  ground: z.enum(['floor', 'void']),
  areas: z.array(AreaSchema),
  links: z.array(LinkSchema),
  spawns: z.array(z.object({ area: z.string(), x: z.number(), z: z.number() })),
  /** The exit of a puzzle; area is '' for a combat map. */
  goal: z.object({ area: z.string(), x: z.number(), z: z.number() }),
  /** What to tell the player: approximations, mechanics the game lacks. */
  notes: z.array(z.string()),
  /** Explicit, countable things the request asks for, which the review checks the finished map against. */
  requirements: z.array(z.string()),
});
export type Blueprint = z.infer<typeof BlueprintSchema>;

export type RoomSize = 'small' | 'medium' | 'large';

/** Room sizes by kind, as [width, height, depth] in metres. The blueprint's own numbers are judged against `RANGE`. */
const ROOMS: Record<MapKind, Record<RoomSize, [number, number, number]>> = {
  combat: { small: [32, 16, 32], medium: [48, 20, 48], large: [64, 28, 64] },
  puzzle: { small: [16, 6, 20], medium: [20, 8, 28], large: [28, 10, 40] },
};
export const roomSizeFor = (kind: MapKind, size: RoomSize): [number, number, number] => ROOMS[kind][size];
const RANGE: Record<MapKind, { w: [number, number]; h: [number, number]; d: [number, number] }> = {
  combat: { w: [24, 90], h: [10, 40], d: [24, 90] },
  puzzle: { w: [10, 40], h: [5, 14], d: [10, 50] },
};
/** A player needs this much space above a surface they stand on (the capsule is 2 m tall). */
const HEADROOM = 2.5;
export const FLOOR = 'FLOOR';
const MIN_ISLANDS = 0.12;
const MAX_AREAS = 30;

const WALKABLE = new Set<string>(['ground', 'raised', 'floating', 'stairs']);
export const isWalkable = (a: Area): boolean => WALKABLE.has(a.role);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const mirrorsOf = (bp: Blueprint): boolean => bp.symmetric && bp.kind === 'combat';
const FLIP: Record<Area['climbs'], Area['climbs']> = { none: 'none', north: 'south', south: 'north', east: 'west', west: 'east' };

interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
const rectOf = (a: { x: number; z: number; width: number; depth: number }): Rect => ({ minX: a.x - a.width / 2, maxX: a.x + a.width / 2, minZ: a.z - a.depth / 2, maxZ: a.z + a.depth / 2 });
const rectGap = (a: Rect, b: Rect): number => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ));
const room = (bp: Blueprint): Rect => rectOf({ x: 0, z: 0, width: bp.roomWidth, depth: bp.roomDepth });

/** Every area as built: the authored ones, and for a symmetric combat level their half-turn copies (ids end in "~"). */
export function expandAreas(bp: Blueprint): Area[] {
  const out = [...bp.areas];
  if (mirrorsOf(bp))
    for (const a of bp.areas) if (!a.center) out.push({ ...a, id: `${a.id}~`, x: -a.x, z: -a.z, climbs: FLIP[a.climbs] });
  return out;
}

// ------------------------------------------------------------------ problems with the plan itself

interface Surface {
  levels: number[];
  rect: Rect;
  portals: boolean;
}

function surfaceOf(bp: Blueprint, id: string): Surface | null {
  if (id === FLOOR) return bp.ground === 'floor' ? { levels: [0], rect: room(bp), portals: true } : null;
  const a = bp.areas.find((x) => x.id === id);
  if (!a || !isWalkable(a)) return null;
  return { levels: a.role === 'stairs' ? [a.baseY, a.topY] : [a.topY], rect: rectOf(a), portals: a.portals };
}

/** Can a player get from `a` to `b` (ab) and back (ba) the way `how` says? `why` explains a no, in numbers. */
function movement(a: Surface, b: Surface, how: Link['how']): { ab: boolean; ba: boolean; why: string } {
  const gap = rectGap(a.rect, b.rect);
  let dy = Infinity;
  for (const la of a.levels) for (const lb of b.levels) if (Math.abs(lb - la) < Math.abs(dy)) dy = lb - la;
  const step = (rise: number, g: number) => (rise <= 0.4 ? g <= 5 && -rise <= 10 : rise <= 1.8 && g <= 3.5);
  switch (how) {
    case 'walk': {
      const ok = gap <= 0.6 && Math.abs(dy) <= 0.4;
      return { ab: ok, ba: ok, why: `walking needs the areas to touch (gap at most 0.5 m) at nearly the same height (within 0.3 m), but they are ${r1(gap)} m apart with a ${r1(Math.abs(dy))} m height difference; use stairs, a jump or a portal` };
    }
    case 'jump':
      return { ab: step(dy, gap), ba: step(-dy, gap), why: `a jump climbs at most 1.8 m and crosses at most 3.5 m (5 m on the level, up to 10 m down), but these are ${r1(gap)} m apart with a ${r1(dy)} m height change` };
    case 'drop':
      return { ab: dy <= -0.5 && dy >= -12 && gap <= 6, ba: false, why: `a drop goes from a higher area down 0.5 to 12 m onto a lower one at most 6 m away; the height change from "from" to "to" is ${r1(dy)} m and the gap ${r1(gap)} m` };
    case 'portal':
      return { ab: a.portals && b.portals, ba: a.portals && b.portals, why: 'a portal link needs portals=true on both areas' };
  }
}

interface Analysis {
  problems: string[];
  /** Walkable areas no spawn can reach (authored ids). */
  unreachable: string[];
  /** Every node (area id, mirrored copy, FLOOR) a player can get to from a spawn. */
  reached: Set<string>;
}

/** What is wrong with the plan, in words the planner can act on. Empty means the plan is sound. */
export const blueprintProblems = (bp: Blueprint): string[] => analyse(bp).problems;

function analyse(bp: Blueprint): Analysis {
  const out: string[] = [];
  const unreachable: string[] = [];
  const reached = new Set<string>();
  const add = (s: string) => out.push(s);
  const range = RANGE[bp.kind];
  const W = bp.roomWidth;
  const H = bp.roomHeight;
  const D = bp.roomDepth;
  if (W < range.w[0] || W > range.w[1]) add(`roomWidth ${W} is outside ${range.w[0]}-${range.w[1]} m for a ${bp.kind} level.`);
  if (H < range.h[0] || H > range.h[1]) add(`roomHeight ${H} is outside ${range.h[0]}-${range.h[1]} m for a ${bp.kind} level.`);
  if (D < range.d[0] || D > range.d[1]) add(`roomDepth ${D} is outside ${range.d[0]}-${range.d[1]} m for a ${bp.kind} level.`);
  if (out.length) return { problems: out, unreachable, reached }; // everything below is measured against the room

  if (bp.areas.length > MAX_AREAS) add(`There are ${bp.areas.length} areas; use at most ${MAX_AREAS} (merge small ones).`);
  const ids = new Set<string>();
  const label = (a: Area) => `area "${a.id}" (${a.what})`;
  const bounds = room(bp);
  for (const a of bp.areas) {
    if (!a.id.trim() || a.id === FLOOR || a.id.endsWith('~')) add(`${label(a)}: the id must be a short label that is not "${FLOOR}" and does not end in "~".`);
    if (ids.has(a.id)) add(`The id "${a.id}" is used by two areas; ids must be unique.`);
    ids.add(a.id);
    if (a.width <= 0 || a.depth <= 0) add(`${label(a)} has no size (width ${a.width}, depth ${a.depth}).`);
    const r = rectOf(a);
    if (r.minX < bounds.minX - 0.05 || r.maxX > bounds.maxX + 0.05 || r.minZ < bounds.minZ - 0.05 || r.maxZ > bounds.maxZ + 0.05)
      add(`${label(a)} spans x ${r1(r.minX)}..${r1(r.maxX)}, z ${r1(r.minZ)}..${r1(r.maxZ)}, which sticks out of the room (x ${r1(bounds.minX)}..${r1(bounds.maxX)}, z ${r1(bounds.minZ)}..${r1(bounds.maxZ)}).`);
    if (a.topY <= a.baseY + 0.05 && a.role !== 'hazard-zone') add(`${label(a)}: topY ${a.topY} must be above baseY ${a.baseY}.`);
    if (isWalkable(a)) {
      if (a.role !== 'stairs' && (a.width < 1.5 || a.depth < 1.5)) add(`${label(a)} is only ${r1(a.width)} x ${r1(a.depth)} m; walkable areas are at least 1.5 m in both directions.`);
      if (a.topY + HEADROOM > H) add(`${label(a)} has its surface at y=${a.topY}, too close to the ${H} m ceiling (a player needs ${HEADROOM} m above it); lower it or raise roomHeight.`);
    }
    if (a.role === 'stairs') {
      if (a.climbs === 'none') add(`${label(a)} is stairs but climbs is "none"; say which way it goes up (north is -z, south +z, east +x, west -x).`);
      else {
        const run = a.climbs === 'north' || a.climbs === 'south' ? a.depth : a.width;
        const rise = a.topY - a.baseY;
        if (run < rise) add(`${label(a)} rises ${r1(rise)} m over only ${r1(run)} m of run; make it at least as long as it is tall (or split the climb).`);
      }
    }
    for (const h of a.hazards) if (!(HAZARD_TYPES as readonly string[]).includes(h)) add(`${label(a)}: unknown hazard "${h}".`);
  }

  // The ground.
  if (bp.ground === 'void') {
    const islands = bp.areas.filter((a) => a.role === 'ground' && Math.abs(a.topY) <= 0.5);
    const covered = islands.reduce((s, a) => s + Math.max(0, a.width) * Math.max(0, a.depth), 0) * (mirrorsOf(bp) ? 2 : 1);
    const need = bp.roomWidth * bp.roomDepth * MIN_ISLANDS;
    if (islands.length === 0) add('ground is "void" (no room floor) but no area has role "ground" at topY 0: list the islands players can stand on, or set ground to "floor".');
    else if (covered < need) add(`ground is "void" but the ground islands cover only ${Math.round(covered)} m2 of the ${Math.round(bp.roomWidth * bp.roomDepth)} m2 room; make them cover at least ${Math.round(need)} m2, or set ground to "floor".`);
  }

  // Links, then what can be reached.
  const known = (id: string) => (id === FLOOR ? bp.ground === 'floor' : bp.areas.some((a) => a.id === id));
  const edges = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!edges.has(a)) edges.set(a, new Set());
    edges.get(a)!.add(b);
  };
  const mirror = (id: string): string => {
    if (id === FLOOR) return id;
    const a = bp.areas.find((x) => x.id === id);
    return !a || a.center || !mirrorsOf(bp) ? id : `${id}~`;
  };
  for (const l of bp.links) {
    if (!known(l.from) || !known(l.to)) {
      const bad = !known(l.from) ? l.from : l.to;
      add(`Link ${l.from} -> ${l.to} names "${bad}", which ${bad === FLOOR ? 'does not exist because ground is "void"' : 'is not an area id'} (ids: ${[...ids].join(', ')}${bp.ground === 'floor' ? `, ${FLOOR}` : ''}).`);
      continue;
    }
    const a = surfaceOf(bp, l.from);
    const b = surfaceOf(bp, l.to);
    if (!a || !b) {
      add(`Link ${l.from} -> ${l.to}: links join walkable areas (ground, raised, floating, stairs), not walls or hazard zones.`);
      continue;
    }
    const m = movement(a, b, l.how);
    if (!m.ab && !m.ba) {
      add(`Link ${l.from} -> ${l.to} (${l.how}) does not work: ${m.why}.`);
      continue;
    }
    for (const copy of mirrorsOf(bp) ? [false, true] : [false]) {
      const f = copy ? mirror(l.from) : l.from;
      const t = copy ? mirror(l.to) : l.to;
      if (m.ab) link(f, t);
      if (m.ba) link(t, f);
    }
  }
  if (bp.ground === 'floor')
    for (const a of bp.areas) {
      // Anything up to a standing jump (1.5 m) above the floor can be climbed onto from it.
      if (!isWalkable(a) || a.topY > 1.5 || a.role === 'stairs') continue;
      link(FLOOR, a.id);
      link(a.id, FLOOR);
      if (mirrorsOf(bp) && !a.center) {
        link(FLOOR, `${a.id}~`);
        link(`${a.id}~`, FLOOR);
      }
    }

  // Spawns and the goal.
  const starts: string[] = [];
  let spawnCount = 0;
  const spawnSpots: { x: number; z: number; level: number }[] = [];
  for (const s of bp.spawns) {
    const surf = surfaceOf(bp, s.area);
    const area = bp.areas.find((a) => a.id === s.area);
    if (!known(s.area) || !surf) {
      add(`A spawn at (${s.x}, ${s.z}) is on "${s.area}", which is not a walkable area${bp.ground === 'floor' ? ` (or ${FLOOR})` : ''}.`);
      continue;
    }
    if (area?.role === 'stairs') add(`A spawn at (${s.x}, ${s.z}) is on stairs "${s.area}"; put spawns on flat areas.`);
    const r = surf.rect;
    if (s.x < r.minX - 0.3 || s.x > r.maxX + 0.3 || s.z < r.minZ - 0.3 || s.z > r.maxZ + 0.3)
      add(`A spawn at (${s.x}, ${s.z}) is not inside "${s.area}" (x ${r1(r.minX)}..${r1(r.maxX)}, z ${r1(r.minZ)}..${r1(r.maxZ)}).`);
    starts.push(s.area);
    const doubled = mirrorsOf(bp) && area && !area.center;
    if (doubled) starts.push(`${s.area}~`);
    spawnCount += doubled ? 2 : 1;
    spawnSpots.push({ x: s.x, z: s.z, level: surf.levels[0] });
  }
  for (let i = 0; i < spawnSpots.length; i++)
    for (let j = i + 1; j < spawnSpots.length; j++)
      if (Math.hypot(spawnSpots[i].x - spawnSpots[j].x, spawnSpots[i].z - spawnSpots[j].z) < 3 && Math.abs(spawnSpots[i].level - spawnSpots[j].level) < 2)
        add(`Spawns at (${spawnSpots[i].x}, ${spawnSpots[i].z}) and (${spawnSpots[j].x}, ${spawnSpots[j].z}) are less than 3 m apart; spread them out.`);
  if (bp.kind === 'combat') {
    if (spawnCount < 2) add(`A combat level needs at least 2 spawn points (the plan gives ${spawnCount}${mirrorsOf(bp) ? '; a spawn on a mirrored area counts twice' : ''}).`);
    if (bp.goal.area) add('A combat level has no goal: set goal.area to an empty string.');
  } else {
    if (bp.spawns.length < 1) add('A puzzle needs a spawn point.');
    const g = bp.goal;
    const surf = surfaceOf(bp, g.area);
    if (!g.area || !surf) add(`A puzzle needs a goal on a walkable area (goal.area "${g.area}" is not one).`);
    else {
      const r = surf.rect;
      if (g.x < r.minX - 0.3 || g.x > r.maxX + 0.3 || g.z < r.minZ - 0.3 || g.z > r.maxZ + 0.3) add(`The goal at (${g.x}, ${g.z}) is not inside "${g.area}".`);
      if (bp.areas.find((a) => a.id === g.area)?.role === 'stairs') add('The goal is on stairs; put it on a flat area.');
    }
  }

  // Nobody starts or finishes in acid or on spikes (a ledge standing above the pool is fine).
  const harmful = bp.areas.filter((a) => a.role === 'hazard-zone' && a.hazards.some((h) => h === 'acid' || h === 'spikes'));
  const inZone = (x: number, z: number, level: number, m: number) =>
    harmful.find((a) => level <= a.topY + 0.3 && x >= a.x - a.width / 2 - m && x <= a.x + a.width / 2 + m && z >= a.z - a.depth / 2 - m && z <= a.z + a.depth / 2 + m);
  for (const s of bp.spawns) {
    const zone = inZone(s.x, s.z, surfaceOf(bp, s.area)?.levels[0] ?? 0, 0.5);
    if (zone) add(`The spawn at (${s.x}, ${s.z}) is inside hazard zone "${zone.id}" (${zone.what}); move the spawn or shrink the zone.`);
  }
  if (bp.goal.area) {
    const zone = inZone(bp.goal.x, bp.goal.z, surfaceOf(bp, bp.goal.area)?.levels[0] ?? 0, 0.5);
    if (zone) add(`The goal at (${bp.goal.x}, ${bp.goal.z}) is inside hazard zone "${zone.id}" (${zone.what}); move the goal or shrink the zone.`);
  }

  // Everything walkable must be reachable from a spawn.
  if (starts.length) {
    const seen = reached;
    for (const st of starts) seen.add(st);
    const queue = [...starts];
    while (queue.length) {
      const here = queue.pop()!;
      for (const next of edges.get(here) ?? []) if (!seen.has(next)) (seen.add(next), queue.push(next));
    }
    for (const a of bp.areas) {
      if (!isWalkable(a) || seen.has(a.id)) continue;
      unreachable.push(a.id);
      add(`${label(a)} at y=${a.topY} cannot be reached from any spawn. Add a link from an area a player can already reach (walk if they touch at the same height, stairs, a jump of at most 1.8 m up, or a portal between two areas with portals=true).`);
    }
  }
  return { problems: out, unreachable, reached };
}

// ------------------------------------------------------------------ mechanical repairs of a plan

const half = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * Settles the plan's arithmetic without a model call: the planner reasons well about what a
 * level should contain and badly about metres, and these slips are all unambiguous. Heights
 * are rounded to 0.1 m, islands sit at y=0, areas are pulled inside the room, stairs
 * get the run their rise needs, links that cannot work are retyped to one that can (or
 * dropped), spawns are pulled inside their area, and an area nothing reaches is joined to the
 * nearest reachable one (by the cheapest way that works, a portal pair if nothing else does).
 */
export function repairBlueprint(input: Blueprint): { plan: Blueprint; fixes: string[] } {
  const bp = structuredClone(input);
  const fixes: string[] = [];
  const note = (s: string) => fixes.push(s);
  const W = bp.roomWidth;
  const D = bp.roomDepth;

  // A symmetric plan lists one half. If an area's half-turn image is another listed area, both
  // halves were written out: the plan is complete as it stands and must not be mirrored again.
  if (bp.symmetric && bp.kind === 'combat') {
    const twin = (a: Area, b: Area) =>
      a !== b && !a.center && !b.center && a.role === b.role && Math.hypot(a.x + b.x, a.z + b.z) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.depth - b.depth) <= 1 && Math.abs(a.topY - b.topY) <= 0.5;
    if (bp.areas.some((a) => bp.areas.some((b) => twin(a, b)))) {
      bp.symmetric = false;
      note('the plan lists both halves of the level, so it is not mirrored again');
    }
  }

  for (const a of bp.areas) {
    const before = JSON.stringify([a.x, a.z, a.width, a.depth, a.baseY, a.topY]);
    a.width = clamp(Math.max(0.5, half(a.width)), 0.5, W);
    a.depth = clamp(Math.max(0.5, half(a.depth)), 0.5, D);
    a.x = clamp(half(a.x), -W / 2 + a.width / 2, W / 2 - a.width / 2);
    a.z = clamp(half(a.z), -D / 2 + a.depth / 2, D / 2 - a.depth / 2);
    a.baseY = half(a.baseY);
    a.topY = half(a.topY);
    if (a.role === 'ground' && a.topY !== 0) {
      note(`area "${a.id}" is an island at floor level: top set to y=0 (was ${a.topY})`);
      a.topY = 0;
    }
    if (a.role !== 'hazard-zone' && a.topY <= a.baseY) a.baseY = a.role === 'ground' ? -1 : a.topY - 0.5;
    if (a.role === 'hazard-zone' && a.topY < a.baseY) a.topY = a.baseY;
    if (a.role !== 'stairs') a.climbs = 'none';
    if (before !== JSON.stringify([a.x, a.z, a.width, a.depth, a.baseY, a.topY])) note(`area "${a.id}": numbers tidied to 0.1 m and put inside the room`);
  }
  // A wall stands on the ground it is built on; a base a little off it buries the bottom of the
  // portal opening or leaves a step nobody can climb into it.
  for (const a of bp.areas) {
    if (a.role !== 'wall') continue;
    const rect = rectOf(a);
    const under = bp.areas
      .filter((g) => g !== a && isWalkable(g) && g.role !== 'stairs' && g.topY <= a.topY - 1 && rectGap(rectOf(g), rect) <= 0.6)
      .sort((p, q) => (rectGap(rectOf(p), rect) === rectGap(rectOf(q), rect) ? Math.abs(p.topY - a.baseY) - Math.abs(q.topY - a.baseY) : rectGap(rectOf(p), rect) - rectGap(rectOf(q), rect)))[0];
    const level = under ? under.topY : bp.ground === 'floor' && Math.abs(a.baseY) <= 1.5 ? 0 : null;
    if (level !== null && Math.abs(level - a.baseY) > 0.02 && Math.abs(level - a.baseY) <= 1.5) {
      note(`wall "${a.id}" stands level with the ground beside it: base y=${r1(a.baseY)} -> y=${r1(level)}`);
      a.baseY = level;
    }
  }
  for (const a of bp.areas) {
    if (a.role !== 'stairs' || a.climbs === 'none') continue;
    const alongZ = a.climbs === 'north' || a.climbs === 'south';
    const rise = a.topY - a.baseY;
    const run = alongZ ? a.depth : a.width;
    if (run >= rise) continue;
    const want = Math.min(Math.ceil(rise), alongZ ? D : W);
    if (alongZ) {
      a.depth = want;
      a.z = clamp(a.z, -D / 2 + want / 2, D / 2 - want / 2);
    } else {
      a.width = want;
      a.x = clamp(a.x, -W / 2 + want / 2, W / 2 - want / 2);
    }
    note(`stairs "${a.id}" lengthened to ${want} m so the climb of ${r1(rise)} m is not steeper than 45 degrees`);
  }

  // Links: keep the ones that work, retype the ones that can work another way, drop the rest.
  const kept: Link[] = [];
  for (const l of bp.links) {
    const a = surfaceOf(bp, l.from);
    const b = surfaceOf(bp, l.to);
    if (!a || !b) {
      note(`link ${l.from} -> ${l.to} dropped: it joins something that is not a walkable area`);
      continue;
    }
    const ok = (how: Link['how']) => {
      const m = movement(a, b, how);
      return m.ab || m.ba;
    };
    if (ok(l.how)) {
      kept.push(l);
      continue;
    }
    const other = (['walk', 'jump', 'drop', 'portal'] as const).find((h) => h !== l.how && ok(h));
    if (other) {
      note(`link ${l.from} -> ${l.to} changed from ${l.how} to ${other}, the way that works between them`);
      kept.push({ ...l, how: other });
      continue;
    }
    note(`link ${l.from} -> ${l.to} (${l.how}) dropped: ${movement(a, b, l.how).why}`);
  }
  bp.links = kept;

  // Spawns and the goal stand inside their area.
  const inset = (id: string, p: { x: number; z: number }, what: string) => {
    const surf = surfaceOf(bp, id);
    if (!surf) return;
    const r = surf.rect;
    const x = clamp(half(p.x), r.minX + 0.5, r.maxX - 0.5);
    const z = clamp(half(p.z), r.minZ + 0.5, r.maxZ - 0.5);
    if (x !== p.x || z !== p.z) note(`${what} moved to (${x}, ${z}) so it is inside "${id}"`);
    p.x = x;
    p.z = z;
  };
  for (const s of bp.spawns) inset(s.area, s, 'a spawn');
  if (bp.goal.area) inset(bp.goal.area, bp.goal, 'the goal');

  // Nobody starts or finishes inside a hazard zone: move them to the nearest dry spot of their area.
  const zones = bp.areas.filter((a) => a.role === 'hazard-zone' && a.hazards.some((h) => h === 'acid' || h === 'spikes'));
  const wet = (x: number, z: number, level: number, m: number) =>
    zones.some((a) => level <= a.topY + 0.3 && x >= a.x - a.width / 2 - m && x <= a.x + a.width / 2 + m && z >= a.z - a.depth / 2 - m && z <= a.z + a.depth / 2 + m);
  const dodge = (areaId: string, p: { x: number; z: number }, what: string, others: { x: number; z: number }[]) => {
    const surf = surfaceOf(bp, areaId);
    if (!surf) return;
    const level = surf.levels[0];
    if (!wet(p.x, p.z, level, 0.5)) return;
    const r = surf.rect;
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let x = Math.ceil(r.minX + 1); x <= r.maxX - 1; x += 1)
      for (let z = Math.ceil(r.minZ + 1); z <= r.maxZ - 1; z += 1) {
        if (wet(x, z, level, 1.5) || others.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) continue;
        const d = Math.hypot(x - p.x, z - p.z);
        if (d < bestD) (best = { x, z }), (bestD = d);
      }
    if (!best) return;
    note(`${what} moved from (${p.x}, ${p.z}) to (${best.x}, ${best.z}), out of the hazard zone`);
    p.x = best.x;
    p.z = best.z;
  };
  bp.spawns.forEach((s, i) => dodge(s.area, s, 'a spawn', bp.spawns.filter((_, j) => j !== i)));
  if (bp.goal.area) dodge(bp.goal.area, bp.goal, 'the goal', bp.spawns);

  // Parts nothing reaches get a way in.
  const joined = new Set<string>();
  for (let guard = 0; guard < 30; guard++) {
    const an = analyse(bp);
    if (an.reached.size === 0) break;
    const next = an.unreachable.find((id) => !joined.has(id));
    if (next === undefined) break;
    joined.add(next);
    const target = bp.areas.find((a) => a.id === next)!;
    const ts = surfaceOf(bp, target.id)!;
    const candidates: { id: string; surf: Surface }[] = [];
    for (const a of bp.areas) if (a.id !== target.id && isWalkable(a) && an.reached.has(a.id)) candidates.push({ id: a.id, surf: surfaceOf(bp, a.id)! });
    if (bp.ground === 'floor' && an.reached.has(FLOOR)) candidates.push({ id: FLOOR, surf: surfaceOf(bp, FLOOR)! });
    if (candidates.length === 0) break;
    const dist = (c: { surf: Surface }) => rectGap(c.surf.rect, ts.rect) + Math.abs(c.surf.levels[0] - ts.levels[0]) * 0.25;
    candidates.sort((a, b) => dist(a) - dist(b));
    let done = false;
    for (const c of candidates) {
      // From what is reachable onto the lost part: the way back down does not help.
      const how = (['walk', 'jump', 'drop'] as const).find((h) => movement(c.surf, ts, h).ab);
      if (how) {
        bp.links.push({ from: c.id, to: target.id, how, note: 'added automatically so the area can be reached' });
        note(`"${target.id}" could not be reached: joined to "${c.id}" by a ${how}`);
        done = true;
        break;
      }
    }
    if (!done) {
      const c = candidates[0];
      target.portals = true;
      const other = bp.areas.find((a) => a.id === c.id);
      if (other) other.portals = true;
      bp.links.push({ from: c.id, to: target.id, how: 'portal', note: 'added automatically so the area can be reached' });
      note(`"${target.id}" could not be reached: joined to "${c.id}" by a portal pair (both take portals now)`);
    }
  }
  return { plan: bp, fixes };
}

// ------------------------------------------------------------------ the plan as text

const dirWord = (c: Area['climbs']) => (c === 'none' ? '' : ` climbing ${c}`);

/** One line per part of the plan, for the prompts and for showing the user. */
export function blueprintLines(bp: Blueprint): string[] {
  const lines: string[] = [];
  for (const a of bp.areas) {
    const where = `x=${r1(a.x)} z=${r1(a.z)}, ${r1(a.width)} x ${r1(a.depth)} m`;
    const heights = a.role === 'stairs' ? `rises y=${r1(a.baseY)} to y=${r1(a.topY)}${dirWord(a.climbs)}` : a.role === 'wall' ? `y=${r1(a.baseY)} to y=${r1(a.topY)}` : a.role === 'hazard-zone' ? `at y=${r1(a.topY)}` : `top y=${r1(a.topY)}${a.baseY !== 0 ? `, underside y=${r1(a.baseY)}` : ''}`;
    const flags = [a.portals ? 'takes portals' : '', a.center ? 'on the centre line' : '', a.hazards.length ? `hazards: ${a.hazards.join(', ')}` : ''].filter(Boolean).join('; ');
    lines.push(`${a.id}: ${a.role} - ${a.what} (${where}; ${heights}${flags ? `; ${flags}` : ''})`);
  }
  for (const l of bp.links) lines.push(`${l.from} -> ${l.to}: ${l.how}${l.note ? ` - ${l.note}` : ''}`);
  for (const s of bp.spawns) lines.push(`spawn on ${s.area} at (${r1(s.x)}, ${r1(s.z)})`);
  if (bp.goal.area) lines.push(`goal on ${bp.goal.area} at (${r1(bp.goal.x)}, ${r1(bp.goal.z)})`);
  return lines;
}

/** The plan as the model reads it in the drawing and repair prompts. */
export function blueprintText(bp: Blueprint): string {
  const head = [
    `Level "${bp.name}": ${bp.concept}`,
    `Kind: ${bp.kind}. Room: ${bp.roomWidth} x ${bp.roomHeight} x ${bp.roomDepth} m (x, y, z), centred on x=0, z=0, floor at y=0.`,
    bp.ground === 'floor'
      ? `Ground: the room has its own floor at y=0 (a room piece without "skip"); ${FLOOR} is that floor.`
      : 'Ground: there is no floor (the room piece skips the floor); the ground areas are islands above a deadly drop.',
    mirrorsOf(bp) ? 'Symmetric: rotate180. Only one half is authored; every area not on the centre line is copied by x -> -x, z -> -z.' : 'Not mirrored.',
  ];
  const areas = bp.areas.map((a) => a.id);
  return `${head.join('\n')}\nParts (ids: ${areas.join(', ')}):\n${blueprintLines(bp).map((l) => `- ${l}`).join('\n')}`;
}

// ------------------------------------------------------------------ the structure, built from the plan

const ROT_OF: Record<Exclude<Area['climbs'], 'none'>, number> = { north: 0, west: 90, south: 180, east: 270 };
const faceCentre = (x: number, z: number): number => {
  if (Math.hypot(x, z) < 1) return 0;
  return ((Math.round((Math.atan2(x, z) * 180) / Math.PI / 5) * 5) % 360 + 360) % 360;
};

function pieceOfArea(a: Area): Piece | null {
  const centre = a.center ? { center: true as const } : {};
  const top = a.portals ? ['top'] : [];
  switch (a.role) {
    case 'ground': {
      const t = Math.max(0.5, Math.min(1.5, a.topY - a.baseY));
      return { type: 'block', at: [a.x, r2(a.topY - t), a.z], size: [a.width, t, a.depth], ...(top.length ? { portal: top } : {}), ...centre };
    }
    case 'raised':
      return { type: 'block', at: [a.x, a.baseY, a.z], size: [a.width, r2(a.topY - a.baseY), a.depth], ...(a.portals ? { portal: ['top', 'sides'] } : {}), ...centre };
    case 'floating': {
      const t = Math.max(0.3, Math.min(1, a.topY - a.baseY));
      return { type: 'block', at: [a.x, r2(a.topY - t), a.z], size: [a.width, t, a.depth], ...(top.length ? { portal: top } : {}), ...centre };
    }
    case 'stairs': {
      if (a.climbs === 'none') return null;
      const alongZ = a.climbs === 'north' || a.climbs === 'south';
      return { type: 'stairs', at: [a.x, a.baseY, a.z], size: [alongZ ? a.width : a.depth, r2(a.topY - a.baseY), alongZ ? a.depth : a.width], rot: ROT_OF[a.climbs], ...centre };
    }
    case 'wall': {
      const h = r2(a.topY - a.baseY);
      const along = a.width >= a.depth;
      const type = a.portals ? 'portal-wall' : 'wall';
      return { type, at: [a.x, a.baseY, a.z], size: along ? [a.width, h, a.depth] : [a.depth, h, a.width], ...(along ? {} : { rot: 90 }), ...centre };
    }
    case 'hazard-zone':
      return null;
  }
}

/** The map's structure, exactly as planned: room, every area, acid pools and spike patches, spawns and goal. Moving hazards, wiring and detail are the model's to add. */
export function scaffold(bp: Blueprint): MapData {
  const pieces: Piece[] = [
    { type: 'room', at: [0, 0, 0], size: [bp.roomWidth, bp.roomHeight, bp.roomDepth], center: true, portal: ['walls'], ...(bp.ground === 'void' ? { skip: ['floor'] } : {}) },
    // Written out here so the tidy-up that adds lights to a map without any does not shift every piece after it by one.
    { type: 'lights', at: [0, bp.roomHeight, 0], size: [bp.roomWidth, 0, bp.roomDepth], center: true },
  ];
  for (const a of bp.areas) {
    const p = pieceOfArea(a);
    if (p) pieces.push(p);
  }
  // The hazards that are just a patch of the area: an acid pool fills its zone, spikes take a
  // patch of an area nobody spawns on. Anything with moving parts or wiring is the model's.
  const occupied = new Set([...bp.spawns.map((s) => s.area), bp.goal.area]);
  for (const a of bp.areas) {
    const centre = a.center ? { center: true as const } : {};
    if (a.role === 'hazard-zone' && a.hazards.includes('acid')) pieces.push({ type: 'acid', at: [a.x, a.topY, a.z], size: [a.width, 0, a.depth], ...centre });
    if (a.role === 'hazard-zone' && a.hazards.includes('spikes')) pieces.push({ type: 'spikes', at: [a.x, a.topY, a.z], size: [a.width, 0, a.depth], ...centre });
    if (isWalkable(a) && a.role !== 'stairs' && a.hazards.includes('spikes') && !occupied.has(a.id))
      pieces.push({ type: 'spikes', at: [a.x, a.topY, a.z], size: [r1(Math.min(6, a.width * 0.5)), 0, r1(Math.min(6, a.depth * 0.5))], ...centre });
  }
  const topOf = (id: string): number => (id === FLOOR ? 0 : (bp.areas.find((a) => a.id === id)?.topY ?? 0));
  const centreOf = (id: string): boolean => id === FLOOR || !!bp.areas.find((a) => a.id === id)?.center;
  for (const s of bp.spawns)
    pieces.push({ type: 'spawn', at: [r1(s.x), r2(topOf(s.area)), r1(s.z)], rot: faceCentre(s.x, s.z), ...(centreOf(s.area) ? { center: true } : {}) });
  if (bp.kind === 'puzzle' && bp.goal.area) pieces.push({ type: 'goal', at: [r1(bp.goal.x), r2(topOf(bp.goal.area)), r1(bp.goal.z)] });
  return {
    id: `${slug(bp.name)}-${Math.random().toString(36).slice(2, 6)}`,
    name: bp.name.slice(0, 40) || 'Generated map',
    hint: bp.hint,
    kind: bp.kind,
    symmetry: mirrorsOf(bp) ? 'rotate180' : 'none',
    fog: { color: '#0b0e14', near: 30, far: 150 },
    killY: -6,
    pieces,
  };
}

/** Makes the room piece agree with the plan's ground: a floor level keeps its floor, a void level has none. */
export function applyGround(bp: Blueprint, input: MapData): { map: MapData; fixes: string[] } {
  const map = structuredClone(input);
  const fixes: string[] = [];
  const roomPiece = map.pieces.find((p) => p.type === 'room');
  if (!roomPiece) return { map, fixes };
  const skip = Array.isArray(roomPiece.skip) ? (roomPiece.skip as string[]) : [];
  const skipsFloor = skip.includes('floor');
  if (bp.ground === 'floor' && skipsFloor) {
    const rest = skip.filter((s) => s !== 'floor');
    if (rest.length) roomPiece.skip = rest;
    else delete roomPiece.skip;
    fixes.push('kept the room floor (the plan has a floor; the map had left it out)');
  } else if (bp.ground === 'void' && !skipsFloor) {
    roomPiece.skip = [...skip, 'floor'];
    fixes.push('left out the room floor (the plan is islands over a void)');
  }
  return { map, fixes };
}

// ------------------------------------------------------------------ does the built map match the plan?

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

/** What the finished map lacks of its plan, with coordinates. Empty means every planned part is there. */
export function conformance(bp: Blueprint, map: MapData): string[] {
  const out: string[] = [];
  let placed: Piece[];
  try {
    placed = expandPieces(map);
  } catch {
    return out;
  }
  const solids = solidsOf(map, placed);
  const spots = (a: Area): [number, number][] => {
    const dx = a.width * 0.3;
    const dz = a.depth * 0.3;
    return a.width < 3 || a.depth < 3 ? [[a.x, a.z]] : [[a.x, a.z], [a.x - dx, a.z - dz], [a.x + dx, a.z - dz], [a.x - dx, a.z + dz], [a.x + dx, a.z + dz]];
  };
  for (const a of expandAreas(bp)) {
    const where = `${a.id.endsWith('~') ? `the mirrored copy of "${a.id.slice(0, -1)}"` : `area "${a.id}"`} (${a.what}) at x=${r1(a.x)}, z=${r1(a.z)}, ${r1(a.width)} x ${r1(a.depth)} m`;
    if (a.role === 'ground' || a.role === 'raised' || a.role === 'floating') {
      const pts = spots(a);
      const hits = pts.filter(([x, z]) => solids.some((s) => s.type !== 'stairs' && inside(s, x, z) && near(s.top, a.topY, 0.35))).length;
      if (hits < Math.ceil(pts.length * 0.6)) {
        const there = solids.filter((s) => inside(s, a.x, a.z)).map((s) => s.top);
        out.push(`${where} is missing: the plan has a ${a.role === 'floating' ? 'floating platform' : a.role === 'ground' ? 'floor island' : 'raised block'} with its top at y=${r1(a.topY)} covering x ${r1(a.x - a.width / 2)}..${r1(a.x + a.width / 2)}, z ${r1(a.z - a.depth / 2)}..${r1(a.z + a.depth / 2)}, but the map has ${there.length ? `surfaces at y=${[...new Set(there.map(r1))].join(', ')} there` : 'nothing there'}. Add a block (at.y = ${r1(a.topY)} minus its height) with that top.`);
      }
    } else if (a.role === 'stairs') {
      const ok = solids.some((s) => s.stairs && inside(s, a.x, a.z) && near(s.top, a.topY, 0.6));
      if (!ok) out.push(`${where} is missing: the plan has stairs rising from y=${r1(a.baseY)} to y=${r1(a.topY)}${dirWord(a.climbs)} there, but no stairs piece covers that spot.`);
    } else if (a.role === 'wall') {
      const ok = solids.some((s) => s.type !== 'room floor' && inside(s, a.x, a.z) && s.top >= a.topY - 0.6);
      if (!ok) out.push(`${where} is missing: the plan has a wall up to y=${r1(a.topY)} there.`);
    }
    const r = rectOf(a);
    for (const h of new Set(a.hazards)) {
      const found = placed.some((p) => {
        if (p.type !== h) return false;
        if (h === 'laser' || h === 'dropper') return true; // mounted on walls and ceilings, not on the area itself
        const s = p.size;
        const half = Array.isArray(s) ? [s[0] / 2, s[2] / 2] : [0, 0];
        return p.at[0] + half[0] >= r.minX - 1 && p.at[0] - half[0] <= r.maxX + 1 && p.at[2] + half[1] >= r.minZ - 1 && p.at[2] - half[1] <= r.maxZ + 1;
      });
      if (!found) out.push(`${where} should have ${h === 'acid' || h === 'spikes' ? h : `a ${h}`} (the plan lists it as a hazard there), but the map has no ${h} piece within 1 m of x ${r1(r.minX)}..${r1(r.maxX)}, z ${r1(r.minZ)}..${r1(r.maxZ)}.`);
    }
  }
  const wanted = bp.spawns.length;
  const have = placed.filter((p) => p.type === 'spawn').length;
  if (have < wanted) out.push(`The plan has ${wanted} spawn point${wanted === 1 ? '' : 's'} but the map has ${have}.`);
  return out;
}
