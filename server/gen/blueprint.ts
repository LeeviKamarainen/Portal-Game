import { z } from 'zod';
import { expandPieces, footprint, type MapData, type MapKind, type Piece } from '../../src/world/maps/MapFormat';
import { inside, solidsOf } from './check';
import { slug } from './wire';

/**
 * The blueprint: the level on paper before any piece exists. The planner first reads the
 * request into `features` (what was asked for, in terms code can measure), then writes where
 * each part of the level is (a rectangle seen from above plus its heights), what it is for,
 * how a player gets from one part to the next, and where they start. Code then
 *
 *   1. resolves the parts that are written as relations rather than coordinates
 *      (`resolveAreas`: stairs from one area up to another, a bridge between two areas, a moat
 *      around an area), so their geometry is right by construction,
 *   2. checks it (`blueprintProblems`: inside the room, links that a player can really make,
 *      everything reachable from a spawn, a floor or islands to stand on),
 *   3. builds the structure from it (`scaffold`: room, the floor around any pits, ledges,
 *      platforms, stairs, bridges, walls, pools, spawns, goal) so the structure cannot be
 *      forgotten or misplaced, and
 *   4. after the model has added hazards and detail, checks the map still has every part of it
 *      (`conformance`). Whether the features are there is `featureProblems` (features.ts).
 *
 * Kept free of unions and optionals so it fits the model's structured-output limits.
 */

export const HAZARD_TYPES = ['acid', 'spikes', 'trapdoor', 'crusher', 'ram', 'laser', 'platform', 'dropper'] as const;
export const AREA_ROLES = ['ground', 'raised', 'floating', 'stairs', 'bridge', 'wall', 'pit', 'pool', 'moat', 'hazard-zone'] as const;
export const LINK_KINDS = ['walk', 'jump', 'portal', 'drop'] as const;
export const CLIMBS = ['none', 'north', 'south', 'east', 'west'] as const;
export const FEATURE_KINDS = ['hole', 'pool', 'moat', 'bridge', 'platforms', 'levels', 'tower', 'height-spread', 'stairs', 'hazard', 'hazard-on-each-platform', 'portal-walls', 'void'] as const;
export const PLACES = ['anywhere', 'center', 'north', 'south', 'east', 'west'] as const;
export const SIZES = ['any', 'small', 'medium', 'large'] as const;
const HAZARD_OR_NONE = ['none', ...HAZARD_TYPES] as const;

/** One thing the request asks for, in terms code can measure on a plan and on a finished map. */
export const FeatureSchema = z.object({
  what: z.enum(FEATURE_KINDS),
  /** Where in the room (a moat: where the thing it surrounds is). */
  where: z.enum(PLACES),
  /** How big, for holes, pools and moats. */
  size: z.enum(SIZES),
  /** How many, for counted features; 0 when the request gives no number. */
  count: z.number(),
  /** Metres, for a tower's height or a height spread; 0 when the request gives none. */
  metres: z.number(),
  /** The hazard of a "hazard" feature; "acid" for an acid moat; otherwise "none". */
  hazard: z.enum(HAZARD_OR_NONE),
  /** The words of the request it comes from. */
  words: z.string(),
});
export type Feature = z.infer<typeof FeatureSchema>;

export const AreaSchema = z.object({
  /** Short label that links, spawns and the goal refer to ("A", "L2"). */
  id: z.string(),
  role: z.enum(AREA_ROLES),
  /** What it is, in plain words ("central arena floor", "sniper ledge"). */
  what: z.string(),
  /** Centre of its rectangle seen from above. For stairs and bridges with from/to: only a hint where along the edge to put them. */
  x: z.number(),
  z: z.number(),
  /** Extent along x and along z. Stairs or a bridge with from/to: width is how wide the flight or deck is, depth the run of the stairs (0: as needed). A moat: width is how wide the ring is. */
  width: z.number(),
  depth: z.number(),
  /** Underside (raised, stairs, walls start here; for a floating slab, its underside). */
  baseY: z.number(),
  /** The walkable top surface (a wall's top edge; stairs: the high end; a pool: the acid surface). */
  topY: z.number(),
  /** Stairs given by coordinates only: the direction the flight goes up toward; 'none' for everything else. */
  climbs: z.enum(CLIMBS),
  /** The top surface takes portals (a wall: both faces; raised: also its sides). */
  portals: z.boolean(),
  /** Symmetric levels: this area lies on the centre line and is not mirrored. */
  center: z.boolean(),
  /** Hazards that belong on or in this area (an acid moat lists acid). */
  hazards: z.array(z.enum(HAZARD_TYPES)),
  /** Stairs and bridges: the area (or FLOOR) they start from and the one they arrive at; '' otherwise. */
  from: z.string(),
  to: z.string(),
  /** A moat: the area it surrounds; '' otherwise. */
  around: z.string(),
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
  /**
   * Written first: what the request asks for, before any of it is laid out. The structured
   * output does not hold the model to the enums (they travel as descriptions), so a feature it
   * cannot name reads as null and is dropped (`tidyFeatures`) instead of failing the whole plan.
   */
  features: z.array(FeatureSchema.nullable().catch(null)),
  kind: z.enum(['combat', 'puzzle']),
  size: z.enum(['small', 'medium', 'large']),
  symmetric: z.boolean(),
  name: z.string(),
  hint: z.string(),
  concept: z.string(),
  roomWidth: z.number(),
  roomHeight: z.number(),
  roomDepth: z.number(),
  /** floor: the room has its own floor (except under pits), everything is built on it. void: no floor; the ground-level islands are areas. */
  ground: z.enum(['floor', 'void']),
  areas: z.array(AreaSchema),
  links: z.array(LinkSchema),
  spawns: z.array(z.object({ area: z.string(), x: z.number(), z: z.number() })),
  /** The exit of a puzzle; area is '' for a combat map. */
  goal: z.object({ area: z.string(), x: z.number(), z: z.number() }),
  /** What to tell the player: approximations, mechanics the game lacks. */
  notes: z.array(z.string()),
  /** Explicit things the request asks for that the features cannot say, which the review checks the finished map against. */
  requirements: z.array(z.string()),
});
/** The plan as the model answers it, unreadable features as null. */
export type PlanAnswer = z.infer<typeof BlueprintSchema>;
export type Blueprint = Omit<PlanAnswer, 'features'> & { features: Feature[] };

export type RoomSize = 'small' | 'medium' | 'large';

/** The kinds of map the generator makes (speedrun courses are made by hand). */
export type GenKind = Exclude<MapKind, 'speedrun'>;
/** A map's kind as the generator's checks see it: a speedrun is judged like a puzzle (solo, one way through). */
export const genKind = (kind: MapKind): GenKind => (kind === 'combat' ? 'combat' : 'puzzle');

/** Room sizes by kind, as [width, height, depth] in metres. The blueprint's own numbers are judged against `RANGE`. */
const ROOMS: Record<GenKind, Record<RoomSize, [number, number, number]>> = {
  combat: { small: [32, 16, 32], medium: [48, 20, 48], large: [64, 28, 64] },
  puzzle: { small: [16, 6, 20], medium: [20, 8, 28], large: [28, 10, 40] },
};
export const roomSizeFor = (kind: GenKind, size: RoomSize): [number, number, number] => ROOMS[kind][size];
const RANGE: Record<GenKind, { w: [number, number]; h: [number, number]; d: [number, number] }> = {
  combat: { w: [24, 90], h: [10, 40], d: [24, 90] },
  puzzle: { w: [10, 40], h: [5, 14], d: [10, 50] },
};
/** A player needs this much space above a surface they stand on (the capsule is 2 m tall). */
const HEADROOM = 2.5;
export const FLOOR = 'FLOOR';
const MIN_ISLANDS = 0.12;
const MAX_AREAS = 30;

const WALKABLE = new Set<string>(['ground', 'raised', 'floating', 'stairs', 'bridge']);
export const isWalkable = (a: Pick<Area, 'role'>): boolean => WALKABLE.has(a.role);
/** Flat surfaces stairs and bridges can start from or arrive at. */
const LANDINGS = new Set<string>(['ground', 'raised', 'floating', 'bridge']);
/** Parts written as a relation to other parts: code works out where they go. */
const isConnector = (a: Area): boolean => a.role === 'bridge' || (a.role === 'stairs' && (!!a.from || !!a.to));
const isRelational = (a: Area): boolean => isConnector(a) || a.role === 'moat';
const isAcid = (a: Area): boolean => a.role === 'pool' || (a.role === 'hazard-zone' && a.hazards.includes('acid'));
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const mirrorsOf = (bp: Blueprint): boolean => bp.symmetric && bp.kind === 'combat';
const FLIP: Record<Area['climbs'], Area['climbs']> = { none: 'none', north: 'south', south: 'north', east: 'west', west: 'east' };

export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}
export const rectOf = (a: { x: number; z: number; width: number; depth: number }): Rect => ({ minX: a.x - a.width / 2, maxX: a.x + a.width / 2, minZ: a.z - a.depth / 2, maxZ: a.z + a.depth / 2 });
const rectGap = (a: Rect, b: Rect): number => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ));
const overlapArea = (a: Rect, b: Rect): number => Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX)) * Math.max(0, Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ));
const within = (inner: Rect, outer: Rect, tol = 0.05): boolean => inner.minX >= outer.minX - tol && inner.maxX <= outer.maxX + tol && inner.minZ >= outer.minZ - tol && inner.maxZ <= outer.maxZ + tol;
const pointIn = (x: number, z: number, r: Rect, tol = 0): boolean => x >= r.minX - tol && x <= r.maxX + tol && z >= r.minZ - tol && z <= r.maxZ + tol;
const room = (bp: Blueprint): Rect => rectOf({ x: 0, z: 0, width: bp.roomWidth, depth: bp.roomDepth });
const fromRect = (r: Rect) => ({ x: r2((r.minX + r.maxX) / 2), z: r2((r.minZ + r.maxZ) / 2), width: r2(r.maxX - r.minX), depth: r2(r.maxZ - r.minZ) });
const span = (r: Rect) => `x ${r1(r.minX)}..${r1(r.maxX)}, z ${r1(r.minZ)}..${r1(r.maxZ)}`;

const mirrorArea = (a: Area): Area => ({ ...a, id: `${a.id}~`, x: -a.x, z: -a.z, climbs: FLIP[a.climbs] });
const expand = (bp: Blueprint, areas: Area[]): Area[] => (mirrorsOf(bp) ? [...areas, ...areas.filter((a) => !a.center).map(mirrorArea)] : [...areas]);

// ------------------------------------------------------------------ parts written as relations

export interface Resolution {
  /** The written areas with every relation turned into a rectangle (a moat becomes the pits or pools around its area). */
  areas: Area[];
  /** Relations that cannot be built, in words the planner can act on. */
  problems: string[];
}

/** Turns stairs, bridges and moats written as relations into rectangles. Pure: the plan is not changed. */
export function resolveAreas(bp: Blueprint): Resolution {
  const problems: string[] = [];
  const out: Area[] = [];
  const label = (a: Area) => `${a.role} "${a.id}" (${a.what})`;
  for (const a of bp.areas) {
    if (isRelational(a)) continue;
    out.push(a.role === 'pool' ? { ...a, hazards: ['acid'] } : { ...a });
  }
  const bounds = room(bp);
  for (const a of bp.areas.filter((x) => x.role === 'moat')) {
    const t = out.find((x) => x.id === a.around && LANDINGS.has(x.role));
    if (!t) {
      problems.push(`${label(a)}: "around" must name the ground, raised or floating area the moat surrounds (it is "${a.around}").`);
      continue;
    }
    const w = clamp(a.width > 0 ? a.width : 4, 1, 20);
    const r = rectOf(t);
    const acid = a.hazards.includes('acid');
    const strips: [string, Rect][] = [
      ['north', { minX: r.minX - w, maxX: r.maxX + w, minZ: r.minZ - w, maxZ: r.minZ }],
      ['south', { minX: r.minX - w, maxX: r.maxX + w, minZ: r.maxZ, maxZ: r.maxZ + w }],
      ['west', { minX: r.minX - w, maxX: r.minX, minZ: r.minZ, maxZ: r.maxZ }],
      ['east', { minX: r.maxX, maxX: r.maxX + w, minZ: r.minZ, maxZ: r.maxZ }],
    ];
    for (const [side, s] of strips) {
      const c = { minX: Math.max(s.minX, bounds.minX), maxX: Math.min(s.maxX, bounds.maxX), minZ: Math.max(s.minZ, bounds.minZ), maxZ: Math.min(s.maxZ, bounds.maxZ) };
      if (c.maxX - c.minX < 0.5 || c.maxZ - c.minZ < 0.5) continue;
      const base = a.baseY;
      out.push({ ...a, ...fromRect(c), id: `${a.id}.${side[0]}`, what: `${a.what} (${side} side)`, role: acid ? 'pool' : 'pit', baseY: base, topY: acid ? Math.max(a.topY, base + 0.3) : base, center: t.center, hazards: acid ? ['acid'] : [], climbs: 'none', portals: false, around: '' });
    }
  }
  for (const a of bp.areas.filter((x) => x.role === 'bridge')) {
    const r = placeBridge(a, out);
    if ('why' in r) problems.push(`${label(a)} from "${a.from}" to "${a.to}" cannot be built: ${r.why}.`);
    else out.push(r.area);
  }
  for (const a of bp.areas.filter((x) => x.role === 'stairs' && isConnector(x))) {
    const r = placeStairs(bp, a, out);
    if ('area' in r) {
      out.push(r.area);
      continue;
    }
    problems.push(`${label(a)} from "${a.from}" to "${a.to}" cannot be built: ${r.why}.`);
    // Keep it where it was written, so the rest of the plan can still be checked and shown.
    out.push({ ...a, climbs: a.climbs === 'none' ? 'north' : a.climbs, width: a.width > 0 ? a.width : 3, depth: a.depth > 0 ? a.depth : 3 });
  }
  return { areas: out, problems };
}

function placeBridge(a: Area, placed: Area[]): { area: Area } | { why: string } {
  const land = (id: string) => placed.find((x) => x.id === id && LANDINGS.has(x.role));
  if (!a.from || !a.to) return { why: 'give both from and to, the two areas it joins' };
  const f = land(a.from);
  const t = land(a.to);
  if (!f || !t) return { why: `"${!f ? a.from : a.to}" is not a ground, raised or floating area (a bridge cannot start on the floor or on stairs)` };
  if (Math.abs(f.topY - t.topY) > 0.4) return { why: `"${f.id}" is at y=${r1(f.topY)} and "${t.id}" at y=${r1(t.topY)}; a bridge is level, so use stairs (from/to) or put both at one height` };
  const A = rectOf(f);
  const B = rectOf(t);
  const w = clamp(a.width >= 1.5 ? a.width : 2, 1.5, 8);
  const gapX = Math.max(B.minX - A.maxX, A.minX - B.maxX);
  const gapZ = Math.max(B.minZ - A.maxZ, A.minZ - B.maxZ);
  const overlapX = Math.min(A.maxX, B.maxX) - Math.max(A.minX, B.minX);
  const overlapZ = Math.min(A.maxZ, B.maxZ) - Math.max(A.minZ, B.minZ);
  if (gapX <= 0.6 && gapZ <= 0.6) return { why: `"${f.id}" and "${t.id}" already touch; drop the bridge (a walk joins them)` };
  let rect: Rect;
  if (gapX > 0.6 && overlapZ >= w) {
    const [x0, x1] = A.maxX <= B.minX ? [A.maxX, B.minX] : [B.maxX, A.minX];
    const zc = clamp(a.z, Math.max(A.minZ, B.minZ) + w / 2, Math.min(A.maxZ, B.maxZ) - w / 2);
    rect = { minX: x0 - 0.25, maxX: x1 + 0.25, minZ: zc - w / 2, maxZ: zc + w / 2 };
  } else if (gapZ > 0.6 && overlapX >= w) {
    const [z0, z1] = A.maxZ <= B.minZ ? [A.maxZ, B.minZ] : [B.maxZ, A.minZ];
    const xc = clamp(a.x, Math.max(A.minX, B.minX) + w / 2, Math.min(A.maxX, B.maxX) - w / 2);
    rect = { minX: xc - w / 2, maxX: xc + w / 2, minZ: z0 - 0.25, maxZ: z1 + 0.25 };
  } else
    return {
      why: `they do not face each other: a straight ${r1(w)} m wide bridge needs them to overlap by at least that much across it (they overlap by ${r1(Math.max(0, overlapX))} m along x and ${r1(Math.max(0, overlapZ))} m along z); move one so they line up`,
    };
  const top = f.topY;
  return { area: { ...a, ...fromRect(rect), baseY: r2(top - 0.5), topY: top, climbs: 'none' } };
}

const SIDES = [
  // The side of the upper area the flight stands on, the way it climbs (toward that side's edge), and which axis the edge runs along.
  { side: 'north', climbs: 'south', along: 'x', out: -1 },
  { side: 'south', climbs: 'north', along: 'x', out: 1 },
  { side: 'west', climbs: 'east', along: 'z', out: -1 },
  { side: 'east', climbs: 'west', along: 'z', out: 1 },
] as const;

/**
 * Where a flight from one area up to another goes: against one side of the upper area, rising
 * toward its edge, with its foot on the lower area. Every side and a few positions along it are
 * tried; the one nearest the planner's x/z hint wins. The flight never leaves the room, never
 * lands its foot in a pit or acid, and never runs into another part.
 */
function placeStairs(bp: Blueprint, a: Area, placed: Area[]): { area: Area } | { why: string } {
  const end = (id: string) => {
    if (id === FLOOR) return bp.ground === 'floor' ? { id, top: 0, rect: room(bp), floor: true } : null;
    const t = placed.find((x) => x.id === id && LANDINGS.has(x.role));
    return t ? { id, top: t.topY, rect: rectOf(t), floor: false } : null;
  };
  if (!a.from || !a.to) return { why: 'give both from (where the flight starts) and to (where it arrives)' };
  const A = end(a.from);
  const B = end(a.to);
  if (!A || !B) {
    const bad = !A ? a.from : a.to;
    return { why: bad === FLOOR ? 'the level has no floor (ground is "void")' : `"${bad}" is not a ground, raised, floating or bridge area` };
  }
  const [low, high] = A.top <= B.top ? [A, B] : [B, A];
  const rise = r2(high.top - low.top);
  if (rise < 0.4) return { why: `"${a.from}" and "${a.to}" are at the same height (y=${r1(low.top)}); where they touch a player walks across, otherwise use a bridge` };
  if (high.floor) return { why: 'stairs go up from the floor, not down to it' };
  const run = a.depth >= rise && a.depth <= rise * 4 ? r1(a.depth) : Math.ceil(rise * 2.5) / 2;
  const want = a.width >= 1.5 ? Math.min(a.width, 8) : 3;
  const H = high.rect;
  const R = room(bp);
  const all = expand(bp, placed);
  const pits = all.filter((o) => o.role === 'pit').map(rectOf);
  const acid = all.filter(isAcid).map(rectOf);
  const blockers = all.filter((o) => o.id !== low.id && o.id !== high.id && ['raised', 'wall', 'floating', 'bridge', 'stairs'].includes(o.role) && o.topY > low.top + 0.05 && o.baseY < high.top + 2);
  let best: { rect: Rect; climbs: Area['climbs']; score: number } | null = null;
  const reasons: string[] = [];
  for (const s of SIDES) {
    const lo = s.along === 'x' ? H.minX : H.minZ;
    const hi = s.along === 'x' ? H.maxX : H.maxZ;
    const w = Math.min(want, hi - lo);
    if (w < 1.5) {
      reasons.push(`${s.side}: the side is only ${r1(hi - lo)} m long`);
      continue;
    }
    const edge = s.side === 'north' ? H.minZ : s.side === 'south' ? H.maxZ : s.side === 'west' ? H.minX : H.maxX;
    const far = edge + s.out * run;
    const hint = s.along === 'x' ? a.x : a.z;
    const centres = [...new Set([clamp(hint, lo + w / 2, hi - w / 2), (lo + hi) / 2, lo + w / 2, hi - w / 2].map(r2))];
    let why = '';
    let ok = false;
    for (const c of centres) {
      const rect: Rect =
        s.along === 'x'
          ? { minX: c - w / 2, maxX: c + w / 2, minZ: Math.min(edge, far), maxZ: Math.max(edge, far) }
          : { minX: Math.min(edge, far), maxX: Math.max(edge, far), minZ: c - w / 2, maxZ: c + w / 2 };
      const foot: [number, number] = s.along === 'x' ? [c, far - s.out * 0.3] : [far - s.out * 0.3, c];
      const hit = blockers.find((o) => overlapArea(rectOf(o), rect) > 0.05);
      if (!within(rect, R)) why ||= 'it would leave the room';
      else if (!low.floor && !within(rect, low.rect)) why ||= `its foot would not stand on "${low.id}" (${span(low.rect)})`;
      else if (low.floor && pits.some((p) => pointIn(foot[0], foot[1], p))) why ||= 'its foot would be over a pit';
      else if (acid.some((p) => pointIn(foot[0], foot[1], p))) why ||= 'its foot would be in acid';
      else if (hit) why ||= `it would run into "${hit.id}"`;
      else {
        ok = true;
        const over = low.floor ? pits.reduce((sum, p) => sum + overlapArea(p, rect), 0) * 5 : 0;
        const score = Math.hypot((rect.minX + rect.maxX) / 2 - a.x, (rect.minZ + rect.maxZ) / 2 - a.z) + over;
        if (!best || score < best.score) best = { rect, climbs: s.climbs, score };
      }
    }
    if (!ok) reasons.push(`${s.side}: ${why}`);
  }
  if (!best)
    return { why: `no side of "${high.id}" has room for a ${r1(want)} m wide, ${r1(run)} m long flight down onto "${low.id}" (${reasons.join('; ')}); move or resize the areas, or start the stairs from another area` };
  const placedRect: Rect = best.rect;
  return { area: { ...a, ...fromRect(placedRect), baseY: low.top, topY: high.top, climbs: best.climbs } };
}

/** Every area as built: the resolved ones, and for a symmetric combat level their half-turn copies (ids end in "~"). */
export function expandAreas(bp: Blueprint): Area[] {
  return expand(bp, resolveAreas(bp).areas);
}

// ------------------------------------------------------------------ the floor of a level with pits

interface FloorGrid {
  /** The floor's parts (the pits can cut it in pieces), each as rectangles. */
  parts: Rect[][];
  /** The floor as few rectangles as possible, for building. */
  slabs: Rect[];
}

/** The room floor minus the pits (null for a void level). One grid cell per band between pit edges. */
function floorGrid(bp: Blueprint, expanded: Area[]): FloorGrid | null {
  if (bp.ground !== 'floor') return null;
  const R = room(bp);
  const pits = expanded
    .filter((a) => a.role === 'pit')
    .map(rectOf)
    .map((p) => ({ minX: Math.max(p.minX, R.minX), maxX: Math.min(p.maxX, R.maxX), minZ: Math.max(p.minZ, R.minZ), maxZ: Math.min(p.maxZ, R.maxZ) }))
    .filter((p) => p.maxX - p.minX > 0.05 && p.maxZ - p.minZ > 0.05);
  const cuts = (lo: number, hi: number, more: number[]) => [...new Set([lo, hi, ...more.map(r2)])].filter((v) => v >= lo && v <= hi).sort((a, b) => a - b);
  const xs = cuts(R.minX, R.maxX, pits.flatMap((p) => [p.minX, p.maxX]));
  const zs = cuts(R.minZ, R.maxZ, pits.flatMap((p) => [p.minZ, p.maxZ]));
  const nx = xs.length - 1;
  const nz = zs.length - 1;
  const solid: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    solid.push([]);
    for (let j = 0; j < nz; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cz = (zs[j] + zs[j + 1]) / 2;
      solid[i].push(!pits.some((p) => pointIn(cx, cz, p)));
    }
  }
  const cell = (i: number, j: number): Rect => ({ minX: xs[i], maxX: xs[i + 1], minZ: zs[j], maxZ: zs[j + 1] });
  // Parts: cells joined by a shared edge.
  const seen = new Set<string>();
  const parts: Rect[][] = [];
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < nz; j++) {
      if (!solid[i][j] || seen.has(`${i},${j}`)) continue;
      const part: Rect[] = [];
      const queue: [number, number][] = [[i, j]];
      seen.add(`${i},${j}`);
      while (queue.length) {
        const [a, b] = queue.pop()!;
        part.push(cell(a, b));
        for (const [da, db] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const p = a + da;
          const q = b + db;
          if (p < 0 || q < 0 || p >= nx || q >= nz || !solid[p][q] || seen.has(`${p},${q}`)) continue;
          seen.add(`${p},${q}`);
          queue.push([p, q]);
        }
      }
      parts.push(part);
    }
  // Slabs: runs of floor along x in each band, then identical runs in neighbouring bands merged.
  const slabs: Rect[] = [];
  let open = new Map<string, Rect>();
  for (let j = 0; j < nz; j++) {
    const next = new Map<string, Rect>();
    let i = 0;
    while (i < nx) {
      if (!solid[i][j]) {
        i++;
        continue;
      }
      const start = i;
      while (i < nx && solid[i][j]) i++;
      const key = `${xs[start]},${xs[i]}`;
      const prev = open.get(key);
      next.set(key, prev ? { ...prev, maxZ: zs[j + 1] } : { minX: xs[start], maxX: xs[i], minZ: zs[j], maxZ: zs[j + 1] });
      open.delete(key);
    }
    slabs.push(...open.values());
    open = next;
  }
  slabs.push(...open.values());
  return { parts, slabs };
}

const hasPits = (bp: Blueprint, expanded: Area[]): boolean => bp.ground === 'floor' && expanded.some((a) => a.role === 'pit');

// ------------------------------------------------------------------ getting around: surfaces and moves

/** A piece of surface: flat at `level`, or a flight of stairs (its height runs from base to top along `climbs`). */
interface Patch {
  rect: Rect;
  level: number;
  ramp?: { climbs: Area['climbs']; base: number; top: number };
}

interface Surface {
  id: string;
  patches: Patch[];
  portals: boolean;
}

/** The line across a flight of stairs where its steps are at height `level` (the nearest end when it is beyond them). */
function rampLine(p: Patch, level: number): Patch {
  const { climbs, base, top } = p.ramp!;
  const l = clamp(level, base, top);
  const t = top > base ? (l - base) / (top - base) : 0;
  const r = p.rect;
  const line: Rect =
    climbs === 'north' ? { ...r, minZ: r.maxZ - t * (r.maxZ - r.minZ), maxZ: r.maxZ - t * (r.maxZ - r.minZ) }
    : climbs === 'south' ? { ...r, minZ: r.minZ + t * (r.maxZ - r.minZ), maxZ: r.minZ + t * (r.maxZ - r.minZ) }
    : climbs === 'east' ? { ...r, minX: r.minX + t * (r.maxX - r.minX), maxX: r.minX + t * (r.maxX - r.minX) }
    : { ...r, minX: r.maxX - t * (r.maxX - r.minX), maxX: r.maxX - t * (r.maxX - r.minX) };
  return { rect: line, level: l };
}

/** How far apart two patches are, and how much higher b is than a where they come closest. */
function contact(a: Patch, b: Patch): { gap: number; dy: number } {
  if (a.ramp && b.ramp) {
    const ends = [rampLine(a, a.ramp.base), rampLine(a, a.ramp.top)].map((e) => contact(e, b));
    return ends.sort((p, q) => p.gap + Math.abs(p.dy) - (q.gap + Math.abs(q.dy)))[0];
  }
  if (b.ramp) {
    const line = rampLine(b, a.level);
    return { gap: rectGap(a.rect, line.rect), dy: line.level - a.level };
  }
  if (a.ramp) {
    const line = rampLine(a, b.level);
    return { gap: rectGap(line.rect, b.rect), dy: b.level - line.level };
  }
  return { gap: rectGap(a.rect, b.rect), dy: b.level - a.level };
}

const canWalk = (c: { gap: number; dy: number }) => c.gap <= 0.6 && Math.abs(c.dy) <= 0.4;
const canJump = (rise: number, gap: number) => (rise <= 0.4 ? gap <= 5 && -rise <= 10 : rise <= 1.8 && gap <= 3.5);
const canDrop = (c: { gap: number; dy: number }) => c.dy <= -0.5 && c.dy >= -12 && c.gap <= 6;

/** Can a player get from `a` to `b` (ab) and back (ba) the way `how` says? `why` explains a no, in numbers. */
function movement(a: Surface, b: Surface, how: Link['how']): { ab: boolean; ba: boolean; why: string } {
  const pairs: { gap: number; dy: number }[] = [];
  for (const pa of a.patches) for (const pb of b.patches) pairs.push(contact(pa, pb));
  const closest = pairs.sort((p, q) => p.gap + Math.abs(p.dy) - (q.gap + Math.abs(q.dy)))[0] ?? { gap: Infinity, dy: 0 };
  const gap = r1(closest.gap);
  switch (how) {
    case 'walk': {
      const ok = pairs.some(canWalk);
      return {
        ab: ok,
        ba: ok,
        why: `walking needs the areas to touch (gap at most 0.5 m) at nearly the same height (within 0.3 m; stairs touch at the end, or the stretch of their side, that is at that height), but they are ${gap} m apart with a ${r1(Math.abs(closest.dy))} m height difference where they come closest; use stairs, a jump or a portal`,
      };
    }
    case 'jump':
      return {
        ab: pairs.some((c) => canJump(c.dy, c.gap)),
        ba: pairs.some((c) => canJump(-c.dy, c.gap)),
        why: `a jump climbs at most 1.8 m and crosses at most 3.5 m (5 m on the level, up to 10 m down), but these are ${gap} m apart with a ${r1(closest.dy)} m height change`,
      };
    case 'drop':
      return { ab: pairs.some(canDrop), ba: false, why: `a drop goes from a higher area down 0.5 to 12 m onto a lower one at most 6 m away; the height change from "from" to "to" is ${r1(closest.dy)} m and the gap ${gap} m` };
    case 'portal':
      return { ab: a.portals && b.portals, ba: a.portals && b.portals, why: 'a portal link needs portals=true on both areas' };
  }
}

const patchOf = (a: Area): Patch => (a.role === 'stairs' ? { rect: rectOf(a), level: a.baseY, ramp: { climbs: a.climbs === 'none' ? 'north' : a.climbs, base: a.baseY, top: a.topY } } : { rect: rectOf(a), level: a.topY });

/** The level as places a player can be: every walkable area (mirrored copies included) and each part of the floor. */
interface World {
  resolved: Area[];
  expanded: Area[];
  problems: string[];
  surfaces: Map<string, Surface>;
  /** Surface ids of the floor's parts: [FLOOR] for a whole floor, FLOOR#1.. when pits cut it, [] for a void level. */
  floor: string[];
  grid: FloorGrid | null;
}

function world(bp: Blueprint): World {
  const r = resolveAreas(bp);
  const expanded = expand(bp, r.areas);
  const surfaces = new Map<string, Surface>();
  for (const a of expanded) if (isWalkable(a)) surfaces.set(a.id, { id: a.id, patches: [patchOf(a)], portals: a.portals });
  const grid = floorGrid(bp, expanded);
  const floor: string[] = [];
  if (grid) {
    grid.parts.forEach((part, k) => {
      const id = grid.parts.length === 1 ? FLOOR : `${FLOOR}#${k + 1}`;
      floor.push(id);
      surfaces.set(id, { id, patches: part.map((rect) => ({ rect, level: 0 })), portals: true });
    });
  }
  return { resolved: r.areas, expanded, problems: r.problems, surfaces, floor, grid };
}

/** The floor's part under (x, z), or null over a pit (or with no floor). */
const floorAt = (w: World, x: number, z: number): string | null => w.floor.find((id) => w.surfaces.get(id)!.patches.some((p) => pointIn(x, z, p.rect, 1e-6))) ?? null;

/** The surface ids a name in a link stands for: FLOOR is every part of the floor. */
const surfacesFor = (w: World, id: string): string[] => (id === FLOOR ? w.floor : w.surfaces.has(id) ? [id] : []);

/** One surface made of several (for a message about "the floor" when pits cut it in parts). */
const merged = (w: World, ids: string[]): Surface => ({ id: ids.join('+'), patches: ids.flatMap((id) => w.surfaces.get(id)!.patches), portals: ids.some((id) => w.surfaces.get(id)!.portals) });

// ------------------------------------------------------------------ problems with the plan itself

interface Analysis {
  problems: string[];
  /** Walkable areas no spawn can reach (written ids). */
  unreachable: string[];
  /** Every surface (area id, mirrored copy, floor part) a player can get to from a spawn. */
  reached: Set<string>;
  world: World;
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
  const w = world(bp);
  if (out.length) return { problems: out, unreachable, reached, world: w }; // everything below is measured against the room

  out.push(...w.problems);
  if (bp.areas.length > MAX_AREAS) add(`There are ${bp.areas.length} areas; use at most ${MAX_AREAS} (merge small ones).`);
  const ids = new Set<string>();
  const label = (a: Area) => `area "${a.id}" (${a.what})`;
  const bounds = room(bp);
  const resolvedOf = (id: string) => w.resolved.find((x) => x.id === id);
  for (const a of bp.areas) {
    if (!a.id.trim() || a.id === FLOOR || a.id.endsWith('~') || a.id.includes('.') || a.id.includes('#')) add(`${label(a)}: the id must be a short label that is not "${FLOOR}" and has no "~", "." or "#".`);
    if (ids.has(a.id)) add(`The id "${a.id}" is used by two areas; ids must be unique.`);
    ids.add(a.id);
    if (!isRelational(a)) {
      if (a.width <= 0 || a.depth <= 0) add(`${label(a)} has no size (width ${a.width}, depth ${a.depth}).`);
      const r = rectOf(a);
      if (r.minX < bounds.minX - 0.05 || r.maxX > bounds.maxX + 0.05 || r.minZ < bounds.minZ - 0.05 || r.maxZ > bounds.maxZ + 0.05)
        add(`${label(a)} spans ${span(r)}, which sticks out of the room (${span(bounds)}).`);
      if (a.topY <= a.baseY + 0.05 && ['ground', 'raised', 'floating', 'stairs', 'wall'].includes(a.role)) add(`${label(a)}: topY ${a.topY} must be above baseY ${a.baseY}.`);
    }
    if (['ground', 'raised', 'floating'].includes(a.role) && (a.width < 1.5 || a.depth < 1.5)) add(`${label(a)} is only ${r1(a.width)} x ${r1(a.depth)} m; walkable areas are at least 1.5 m in both directions.`);
    const built = resolvedOf(a.id);
    if (built && isWalkable(built) && built.topY + HEADROOM > H) add(`${label(a)} has its surface at y=${built.topY}, too close to the ${H} m ceiling (a player needs ${HEADROOM} m above it); lower it or raise roomHeight.`);
    if (a.role === 'stairs' && !isConnector(a)) {
      if (a.climbs === 'none') add(`${label(a)} is stairs but has neither from/to nor a climbs direction; give from and to (code places the flight).`);
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
  } else if (w.floor.length === 0) add('The pits leave no floor at all; make them smaller, or set ground to "void" and list islands.');

  // Links, then what can be reached.
  const known = (id: string) => (id === FLOOR ? w.floor.length > 0 : bp.areas.some((a) => a.id === id));
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
      add(`Link ${l.from} -> ${l.to} names "${bad}", which ${bad === FLOOR ? 'does not exist because ground is "void"' : 'is not an area id'} (ids: ${[...ids].join(', ')}${w.floor.length ? `, ${FLOOR}` : ''}).`);
      continue;
    }
    const fs = surfacesFor(w, l.from);
    const ts = surfacesFor(w, l.to);
    if (!fs.length || !ts.length) {
      add(`Link ${l.from} -> ${l.to}: links join walkable areas (ground, raised, floating, stairs, bridge), not walls, pits, pools or hazard zones.`);
      continue;
    }
    let works = false;
    for (const copy of mirrorsOf(bp) ? [false, true] : [false]) {
      for (const f of copy ? surfacesFor(w, mirror(l.from)) : fs)
        for (const t of copy ? surfacesFor(w, mirror(l.to)) : ts) {
          const m = movement(w.surfaces.get(f)!, w.surfaces.get(t)!, l.how);
          if (m.ab) link(f, t);
          if (m.ba) link(t, f);
          if (!copy && (m.ab || m.ba)) works = true;
        }
    }
    if (!works) add(`Link ${l.from} -> ${l.to} (${l.how}) does not work: ${movement(merged(w, fs), merged(w, ts), l.how).why}.`);
  }
  // What needs no link: surfaces that touch at one height (a flight of stairs and the areas at its ends,
  // a bridge and its banks), anything up to a standing jump above the floor, and floor parts a jump apart.
  const all = [...w.surfaces.values()];
  for (let i = 0; i < all.length; i++)
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const b = all[j];
      if (movement(a, b, 'walk').ab) {
        link(a.id, b.id);
        link(b.id, a.id);
      }
    }
  for (const f of w.floor)
    for (const s of all) {
      if (s.id === f) continue;
      const area = w.expanded.find((x) => x.id === s.id);
      if (area && (area.role === 'stairs' || area.topY > 1.5)) continue;
      const m = movement(w.surfaces.get(f)!, s, 'jump');
      if (m.ab) link(f, s.id);
      if (m.ba) link(s.id, f);
    }

  // Spawns and the goal.
  const starts: string[] = [];
  let spawnCount = 0;
  const spawnSpots: { x: number; z: number; level: number }[] = [];
  const rectFor = (id: string): Rect | null => {
    if (id === FLOOR) return w.floor.length ? bounds : null;
    const a = resolvedOf(id);
    return a && isWalkable(a) ? rectOf(a) : null;
  };
  const levelFor = (id: string) => (id === FLOOR ? 0 : (resolvedOf(id)?.topY ?? 0));
  for (const s of bp.spawns) {
    const r = rectFor(s.area);
    const area = bp.areas.find((a) => a.id === s.area);
    if (!known(s.area) || !r) {
      add(`A spawn at (${s.x}, ${s.z}) is on "${s.area}", which is not a walkable area${w.floor.length ? ` (or ${FLOOR})` : ''}.`);
      continue;
    }
    if (area?.role === 'stairs') add(`A spawn at (${s.x}, ${s.z}) is on stairs "${s.area}"; put spawns on flat areas.`);
    if (s.x < r.minX - 0.3 || s.x > r.maxX + 0.3 || s.z < r.minZ - 0.3 || s.z > r.maxZ + 0.3) add(`A spawn at (${s.x}, ${s.z}) is not inside "${s.area}" (${span(r)}).`);
    const doubled = mirrorsOf(bp) && area && !area.center;
    if (s.area === FLOOR) {
      const part = floorAt(w, s.x, s.z);
      if (part) starts.push(part);
      else add(`A spawn at (${s.x}, ${s.z}) on ${FLOOR} is over a pit; move it onto the floor.`);
    } else {
      starts.push(s.area);
      if (doubled) starts.push(`${s.area}~`);
    }
    spawnCount += doubled ? 2 : 1;
    spawnSpots.push({ x: s.x, z: s.z, level: levelFor(s.area) });
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
    const r = rectFor(g.area);
    if (!g.area || !known(g.area) || !r) add(`A puzzle needs a goal on a walkable area (goal.area "${g.area}" is not one).`);
    else {
      if (g.x < r.minX - 0.3 || g.x > r.maxX + 0.3 || g.z < r.minZ - 0.3 || g.z > r.maxZ + 0.3) add(`The goal at (${g.x}, ${g.z}) is not inside "${g.area}".`);
      if (g.area === FLOOR && !floorAt(w, g.x, g.z)) add(`The goal at (${g.x}, ${g.z}) is over a pit; move it onto the floor.`);
      if (bp.areas.find((a) => a.id === g.area)?.role === 'stairs') add('The goal is on stairs; put it on a flat area.');
    }
  }

  // Nobody starts or finishes in acid or on spikes (a ledge standing above the pool is fine).
  const harmful = w.expanded.filter((a) => isAcid(a) || (a.role === 'hazard-zone' && a.hazards.includes('spikes')));
  const inZone = (x: number, z: number, level: number, m: number) => harmful.find((a) => level <= a.topY + 0.3 && pointIn(x, z, rectOf(a), m));
  for (const s of bp.spawns) {
    const zone = inZone(s.x, s.z, levelFor(s.area), 0.5);
    if (zone) add(`The spawn at (${s.x}, ${s.z}) is inside hazard zone "${zone.id}" (${zone.what}); move the spawn or shrink the zone.`);
  }
  if (bp.goal.area) {
    const zone = inZone(bp.goal.x, bp.goal.z, levelFor(bp.goal.area), 0.5);
    if (zone) add(`The goal at (${bp.goal.x}, ${bp.goal.z}) is inside hazard zone "${zone.id}" (${zone.what}); move the goal or shrink the zone.`);
  }

  // Everything walkable must be reachable from a spawn.
  if (starts.length) {
    for (const st of starts) reached.add(st);
    const queue = [...starts];
    while (queue.length) {
      const here = queue.pop()!;
      for (const next of edges.get(here) ?? []) if (!reached.has(next)) (reached.add(next), queue.push(next));
    }
    for (const a of bp.areas) {
      if (!isWalkable(a) || reached.has(a.id) || !w.surfaces.has(a.id)) continue;
      unreachable.push(a.id);
      add(`${label(a)} at y=${resolvedOf(a.id)?.topY ?? a.topY} cannot be reached from any spawn. Add a way in from an area a player can already reach: stairs (from/to), a bridge, a jump of at most 1.8 m up, or a portal between two areas with portals=true.`);
    }
  }
  return { problems: out, unreachable, reached, world: w };
}

// ------------------------------------------------------------------ mechanical repairs of a plan

const half = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/**
 * Settles the plan's arithmetic without a model call: the planner reasons well about what a
 * level should contain and badly about metres, and these slips are all unambiguous. Heights
 * are rounded to 0.1 m, islands sit at y=0, areas are pulled inside the room, stairs given by
 * coordinates get the run their rise needs, links that cannot work are retyped to one that can
 * (or dropped), spawns are pulled inside their area and off pits, and an area nothing reaches
 * is joined to the nearest reachable one (by the cheapest way that works, a portal pair if
 * nothing else does). Stairs and bridges written with from/to need none of this: code places them.
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
      a !== b && !a.center && !b.center && !isRelational(a) && !isRelational(b) && a.role === b.role && Math.hypot(a.x + b.x, a.z + b.z) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.depth - b.depth) <= 1 && Math.abs(a.topY - b.topY) <= 0.5;
    if (bp.areas.some((a) => bp.areas.some((b) => twin(a, b)))) {
      bp.symmetric = false;
      note('the plan lists both halves of the level, so it is not mirrored again');
    }
  }

  for (const a of bp.areas) {
    a.from ??= '';
    a.to ??= '';
    a.around ??= '';
    if (a.role !== 'stairs' && a.role !== 'bridge') a.from = a.to = '';
    if (a.role !== 'moat') a.around = '';
    if (isRelational(a)) {
      // Only hints and widths here; code works out where it goes.
      a.width = half(Math.max(0, a.width));
      a.depth = half(Math.max(0, a.depth));
      if (a.role !== 'moat') a.climbs = 'none';
      continue;
    }
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
    if (['ground', 'raised', 'floating', 'stairs', 'wall'].includes(a.role) && a.topY <= a.baseY) a.baseY = a.role === 'ground' ? -1 : a.topY - 0.5;
    if (a.role === 'hazard-zone' && a.topY < a.baseY) a.topY = a.baseY;
    if (a.role === 'pool' && a.topY < a.baseY + 0.2) a.topY = half(a.baseY + 0.3);
    if (a.role === 'pit') a.baseY = a.topY = 0;
    if (a.role !== 'stairs') a.climbs = 'none';
    if (before !== JSON.stringify([a.x, a.z, a.width, a.depth, a.baseY, a.topY])) note(`area "${a.id}": numbers tidied to 0.1 m and put inside the room`);
  }
  // A wall stands on the ground it is built on; a base a little off it buries the bottom of the
  // portal opening or leaves a step nobody can climb into it.
  const placedNow = resolveAreas(bp).areas;
  for (const a of bp.areas) {
    if (a.role !== 'wall') continue;
    const rect = rectOf(a);
    const under = placedNow
      .filter((g) => g.id !== a.id && isWalkable(g) && g.role !== 'stairs' && g.topY <= a.topY - 1 && rectGap(rectOf(g), rect) <= 0.6)
      .sort((p, q) => (rectGap(rectOf(p), rect) === rectGap(rectOf(q), rect) ? Math.abs(p.topY - a.baseY) - Math.abs(q.topY - a.baseY) : rectGap(rectOf(p), rect) - rectGap(rectOf(q), rect)))[0];
    const level = under ? under.topY : bp.ground === 'floor' && Math.abs(a.baseY) <= 1.5 ? 0 : null;
    if (level !== null && Math.abs(level - a.baseY) > 0.02 && Math.abs(level - a.baseY) <= 1.5) {
      note(`wall "${a.id}" stands level with the ground beside it: base y=${r1(a.baseY)} -> y=${r1(level)}`);
      a.baseY = level;
    }
  }
  for (const a of bp.areas) {
    if (a.role !== 'stairs' || isConnector(a) || a.climbs === 'none') continue;
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
  let w = world(bp);
  const kept: Link[] = [];
  for (const l of bp.links) {
    const fs = surfacesFor(w, l.from);
    const ts = surfacesFor(w, l.to);
    if (!fs.length || !ts.length) {
      note(`link ${l.from} -> ${l.to} dropped: it joins something that is not a walkable area`);
      continue;
    }
    const ok = (how: Link['how']) => fs.some((f) => ts.some((t) => {
      const m = movement(w.surfaces.get(f)!, w.surfaces.get(t)!, how);
      return m.ab || m.ba;
    }));
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
    note(`link ${l.from} -> ${l.to} (${l.how}) dropped: ${movement(merged(w, fs), merged(w, ts), l.how).why}`);
  }
  bp.links = kept;

  // Spawns and the goal stand inside their area.
  const rectFor = (id: string): Rect | null => {
    if (id === FLOOR) return w.floor.length ? room(bp) : null;
    const a = w.resolved.find((x) => x.id === id);
    return a && isWalkable(a) ? rectOf(a) : null;
  };
  const inset = (id: string, p: { x: number; z: number }, what: string) => {
    const r = rectFor(id);
    if (!r) return;
    const x = clamp(half(p.x), r.minX + 0.5, r.maxX - 0.5);
    const z = clamp(half(p.z), r.minZ + 0.5, r.maxZ - 0.5);
    if (x !== p.x || z !== p.z) note(`${what} moved to (${x}, ${z}) so it is inside "${id}"`);
    p.x = x;
    p.z = z;
  };
  for (const s of bp.spawns) inset(s.area, s, 'a spawn');
  if (bp.goal.area) inset(bp.goal.area, bp.goal, 'the goal');

  // Nobody starts or finishes inside a hazard zone or over a pit: move them to the nearest safe spot of their area.
  const zones = w.expanded.filter((a) => isAcid(a) || (a.role === 'hazard-zone' && a.hazards.includes('spikes')));
  const pits = w.expanded.filter((a) => a.role === 'pit').map(rectOf);
  const unsafe = (areaId: string, x: number, z: number, level: number, m: number) =>
    zones.some((a) => level <= a.topY + 0.3 && pointIn(x, z, rectOf(a), m)) || (areaId === FLOOR && pits.some((p) => pointIn(x, z, p, m)));
  const dodge = (areaId: string, p: { x: number; z: number }, what: string, others: { x: number; z: number }[]) => {
    const r = rectFor(areaId);
    if (!r) return;
    const level = areaId === FLOOR ? 0 : (w.resolved.find((a) => a.id === areaId)?.topY ?? 0);
    if (!unsafe(areaId, p.x, p.z, level, 0.5)) return;
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (let x = Math.ceil(r.minX + 1); x <= r.maxX - 1; x += 1)
      for (let z = Math.ceil(r.minZ + 1); z <= r.maxZ - 1; z += 1) {
        if (unsafe(areaId, x, z, level, 1.5) || others.some((o) => Math.hypot(o.x - x, o.z - z) < 3.5)) continue;
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
    w = an.world;
    if (an.reached.size === 0) break;
    const next = an.unreachable.find((id) => !joined.has(id));
    if (next === undefined) break;
    joined.add(next);
    const target = bp.areas.find((a) => a.id === next)!;
    const ts = w.surfaces.get(target.id)!;
    const candidates: { id: string; surf: Surface }[] = [];
    for (const a of bp.areas) if (a.id !== target.id && isWalkable(a) && an.reached.has(a.id) && w.surfaces.has(a.id)) candidates.push({ id: a.id, surf: w.surfaces.get(a.id)! });
    const floorReached = w.floor.filter((f) => an.reached.has(f));
    if (floorReached.length) candidates.push({ id: FLOOR, surf: merged(w, floorReached) });
    if (candidates.length === 0) break;
    const dist = (c: { surf: Surface }) => Math.min(...c.surf.patches.flatMap((p) => ts.patches.map((q) => {
      const k = contact(p, q);
      return k.gap + Math.abs(k.dy) * 0.25;
    })));
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
const placeWord = (p: Feature['where']) => (p === 'anywhere' ? '' : p === 'center' ? ' at the centre' : ` on the ${p} side`);

/** A feature in words, for the prompts and for showing the user what was understood. */
export function describeFeature(f: Feature): string {
  const n = Math.max(1, Math.round(f.count));
  const size = f.size === 'any' ? '' : `${f.size} `;
  switch (f.what) {
    case 'hole': return `a ${size}bottomless hole in the floor${placeWord(f.where)}`;
    case 'pool': return `a ${size}acid pool${placeWord(f.where)}`;
    case 'moat': return `a ${f.hazard === 'acid' ? 'acid moat' : 'moat (a ring of hole or acid)'} all the way around ${f.where === 'anywhere' || f.where === 'center' ? 'the centre' : `the ${f.where} side`}`;
    case 'bridge': return `${n > 1 ? `${n} bridges` : 'a bridge'} over a gap or between raised parts${placeWord(f.where)}`;
    case 'platforms': return `at least ${n} platform${n === 1 ? '' : 's'} (raised or floating surfaces)`;
    case 'levels': return `at least ${Math.max(2, n)} distinct height levels`;
    case 'tower': return `${n > 1 ? `${n} towers` : 'a tower'}${placeWord(f.where)}${f.metres > 0 ? `, at least ${f.metres} m tall` : ''}`;
    case 'height-spread': return `at least ${f.metres > 0 ? f.metres : 6} m between the lowest and the highest ground`;
    case 'stairs': return `at least ${n} flight${n === 1 ? '' : 's'} of stairs`;
    case 'hazard': return `${n > 1 ? `${n} ` : ''}${f.hazard}${n > 1 && f.hazard !== 'acid' && f.hazard !== 'spikes' ? 's' : ''}`;
    case 'hazard-on-each-platform': return 'a hazard on every floating platform';
    case 'portal-walls': return `at least ${n} portal surface${n === 1 ? '' : 's'}`;
    case 'void': return 'a void to fall into (no floor under everything)';
  }
}

/** One line per part of the plan, for the prompts and for showing the user. */
export function blueprintLines(bp: Blueprint): string[] {
  const lines: string[] = [];
  for (const f of bp.features ?? []) lines.push(`wants ${describeFeature(f)}${f.words ? ` ("${f.words}")` : ''}`);
  const built = resolveAreas(bp).areas;
  for (const a of bp.areas) {
    const b = built.find((x) => x.id === a.id) ?? a;
    const where = `x=${r1(b.x)} z=${r1(b.z)}, ${r1(b.width)} x ${r1(b.depth)} m`;
    let detail: string;
    if (a.role === 'moat') detail = `around "${a.around}", ${r1(a.width > 0 ? a.width : 4)} m wide, ${a.hazards.includes('acid') ? 'acid' : 'bottomless'}`;
    else if (a.role === 'stairs' && isConnector(a)) detail = `from ${a.from} up to ${a.to}; placed by code at ${where}, rises y=${r1(b.baseY)} to y=${r1(b.topY)}${dirWord(b.climbs)}`;
    else if (a.role === 'bridge') detail = `from ${a.from} to ${a.to}; placed by code at ${where}, top y=${r1(b.topY)}`;
    else if (a.role === 'stairs') detail = `${where}; rises y=${r1(a.baseY)} to y=${r1(a.topY)}${dirWord(a.climbs)}`;
    else if (a.role === 'wall') detail = `${where}; y=${r1(a.baseY)} to y=${r1(a.topY)}`;
    else if (a.role === 'pit') detail = `${where}; no floor here: a bottomless hole`;
    else if (a.role === 'pool') detail = `${where}; acid surface at y=${r1(a.topY)}`;
    else if (a.role === 'hazard-zone') detail = `${where}; at y=${r1(a.topY)}`;
    else detail = `${where}; top y=${r1(a.topY)}${a.baseY !== 0 ? `, underside y=${r1(a.baseY)}` : ''}`;
    const flags = [a.portals ? 'takes portals' : '', a.center ? 'on the centre line' : '', a.hazards.length && a.role !== 'pool' ? `hazards: ${a.hazards.join(', ')}` : ''].filter(Boolean).join('; ');
    lines.push(`${a.id}: ${a.role} - ${a.what} (${detail}${flags ? `; ${flags}` : ''})`);
  }
  for (const l of bp.links) lines.push(`${l.from} -> ${l.to}: ${l.how}${l.note ? ` - ${l.note}` : ''}`);
  for (const s of bp.spawns) lines.push(`spawn on ${s.area} at (${r1(s.x)}, ${r1(s.z)})`);
  if (bp.goal.area) lines.push(`goal on ${bp.goal.area} at (${r1(bp.goal.x)}, ${r1(bp.goal.z)})`);
  return lines;
}

/** The plan as the model reads it in the drawing and repair prompts. */
export function blueprintText(bp: Blueprint): string {
  const pits = hasPits(bp, expandAreas(bp));
  const head = [
    `Level "${bp.name}": ${bp.concept}`,
    `Kind: ${bp.kind}. Room: ${bp.roomWidth} x ${bp.roomHeight} x ${bp.roomDepth} m (x, y, z), centred on x=0, z=0, floor at y=0.`,
    bp.ground === 'floor'
      ? pits
        ? `Ground: a floor at y=0 everywhere except over the pits, which are bottomless holes. The room piece skips its floor and the floor is built as blocks around the pits; ${FLOOR} is that floor. Never cover a pit.`
        : `Ground: the room has its own floor at y=0 (a room piece without "skip"); ${FLOOR} is that floor.`
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
    case 'floating':
    case 'bridge': {
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
    default:
      return null; // pits are an absence, pools and hazard zones are added with the hazards
  }
}

/** The map's structure, exactly as planned: room, the floor around any pits, every area, acid pools and spike patches, spawns and goal. Moving hazards, wiring and detail are the model's to add. */
export function scaffold(bp: Blueprint): MapData {
  const resolved = resolveAreas(bp).areas;
  const expanded = expand(bp, resolved);
  const pits = hasPits(bp, expanded);
  const pieces: Piece[] = [
    { type: 'room', at: [0, 0, 0], size: [bp.roomWidth, bp.roomHeight, bp.roomDepth], center: true, portal: ['walls'], ...(bp.ground === 'void' || pits ? { skip: ['floor'] } : {}) },
    // Written out here so the tidy-up that adds lights to a map without any does not shift every piece after it by one.
    { type: 'lights', at: [0, bp.roomHeight, 0], size: [bp.roomWidth, 0, bp.roomDepth], center: true },
  ];
  // The floor around the pits, from the mirrored plan, so it is already whole and is not mirrored again.
  if (pits) for (const s of floorGrid(bp, expanded)!.slabs) pieces.push({ type: 'block', at: [r2((s.minX + s.maxX) / 2), -1, r2((s.minZ + s.maxZ) / 2)], size: [r2(s.maxX - s.minX), 1, r2(s.maxZ - s.minZ)], center: true });
  for (const a of resolved) {
    const p = pieceOfArea(a);
    if (p) pieces.push(p);
  }
  // The hazards that are just a patch of the area: an acid pool fills its zone, spikes take a
  // patch of an area nobody spawns on. Anything with moving parts or wiring is the model's.
  const occupied = new Set([...bp.spawns.map((s) => s.area), bp.goal.area]);
  for (const a of resolved) {
    const centre = a.center ? { center: true as const } : {};
    if (isAcid(a)) pieces.push({ type: 'acid', at: [a.x, a.topY, a.z], size: [a.width, 0, a.depth], ...centre });
    if (a.role === 'hazard-zone' && a.hazards.includes('spikes')) pieces.push({ type: 'spikes', at: [a.x, a.topY, a.z], size: [a.width, 0, a.depth], ...centre });
    if (isWalkable(a) && a.role !== 'stairs' && a.hazards.includes('spikes') && !occupied.has(a.id))
      pieces.push({ type: 'spikes', at: [a.x, a.topY, a.z], size: [r1(Math.min(6, a.width * 0.5)), 0, r1(Math.min(6, a.depth * 0.5))], ...centre });
  }
  const topOf = (id: string): number => (id === FLOOR ? 0 : (resolved.find((a) => a.id === id)?.topY ?? 0));
  const centreOf = (id: string): boolean => id === FLOOR || !!resolved.find((a) => a.id === id)?.center;
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

/** Makes the room piece agree with the plan's ground: a whole floor stays, a void level or a floor with pits has none (the floor is built around the pits). */
export function applyGround(bp: Blueprint, input: MapData): { map: MapData; fixes: string[] } {
  const map = structuredClone(input);
  const fixes: string[] = [];
  const roomPiece = map.pieces.find((p) => p.type === 'room');
  if (!roomPiece) return { map, fixes };
  const skip = Array.isArray(roomPiece.skip) ? (roomPiece.skip as string[]) : [];
  const skipsFloor = skip.includes('floor');
  const pits = hasPits(bp, expandAreas(bp));
  const wantSkip = bp.ground === 'void' || pits;
  if (!wantSkip && skipsFloor) {
    const rest = skip.filter((s) => s !== 'floor');
    if (rest.length) roomPiece.skip = rest;
    else delete roomPiece.skip;
    fixes.push('kept the room floor (the plan has a floor; the map had left it out)');
  } else if (wantSkip && !skipsFloor) {
    roomPiece.skip = [...skip, 'floor'];
    fixes.push(pits ? 'left out the room floor (the plan has pits; the floor is built around them)' : 'left out the room floor (the plan is islands over a void)');
  }
  return { map, fixes };
}

// ------------------------------------------------------------------ does the built map match the plan?

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;
const turn = (rot: number | undefined) => ((Math.round(rot ?? 0) % 360) + 360) % 360;

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
  const expanded = expandAreas(bp);
  const spots = (a: Area): [number, number][] => {
    const dx = a.width * 0.3;
    const dz = a.depth * 0.3;
    return a.width < 3 || a.depth < 3 ? [[a.x, a.z]] : [[a.x, a.z], [a.x - dx, a.z - dz], [a.x + dx, a.z - dz], [a.x - dx, a.z + dz], [a.x + dx, a.z + dz]];
  };
  const walkableRects = expanded.filter((a) => isWalkable(a)).map(rectOf);
  for (const a of expanded) {
    const where = `${a.id.endsWith('~') ? `the mirrored copy of "${a.id.slice(0, -1)}"` : `area "${a.id}"`} (${a.what}) at x=${r1(a.x)}, z=${r1(a.z)}, ${r1(a.width)} x ${r1(a.depth)} m`;
    if (a.role === 'ground' || a.role === 'raised' || a.role === 'floating' || a.role === 'bridge') {
      const pts = spots(a);
      const hits = pts.filter(([x, z]) => solids.some((s) => s.type !== 'stairs' && inside(s, x, z) && near(s.top, a.topY, 0.35))).length;
      if (hits < Math.ceil(pts.length * 0.6)) {
        const there = solids.filter((s) => inside(s, a.x, a.z)).map((s) => s.top);
        const kind = a.role === 'floating' ? 'floating platform' : a.role === 'ground' ? 'floor island' : a.role === 'bridge' ? 'bridge' : 'raised block';
        out.push(`${where} is missing: the plan has a ${kind} with its top at y=${r1(a.topY)} covering ${span(rectOf(a))}, but the map has ${there.length ? `surfaces at y=${[...new Set(there.map(r1))].join(', ')} there` : 'nothing there'}. Add a block (at.y = ${r1(a.topY)} minus its height) with that top.`);
      }
    } else if (a.role === 'stairs') {
      const want = a.climbs === 'none' ? null : ROT_OF[a.climbs];
      const flights = placed.filter((p) => (p.type === 'stairs' || p.type === 'slope') && Array.isArray(p.size)).map((p) => ({ p, s: footprint(p) }));
      const here = flights.filter(({ s }) => a.x >= s.min.x - 1e-6 && a.x <= s.max.x + 1e-6 && a.z >= s.min.z - 1e-6 && a.z <= s.max.z + 1e-6 && near(s.max.y, a.topY, 0.6));
      if (!here.length) out.push(`${where} is missing: the plan has stairs rising from y=${r1(a.baseY)} to y=${r1(a.topY)}${dirWord(a.climbs)} there, but no stairs piece covers that spot.`);
      else if (want !== null && !here.some(({ p }) => turn(p.rot) === want))
        out.push(`${where} climbs the wrong way: the plan has it rising${dirWord(a.climbs)} (rot ${want}), but the stairs there have rot ${turn(here[0].p.rot)}. Set its rot to ${want}.`);
    } else if (a.role === 'wall') {
      const ok = solids.some((s) => s.type !== 'room floor' && inside(s, a.x, a.z) && s.top >= a.topY - 0.6);
      if (!ok) out.push(`${where} is missing: the plan has a wall up to y=${r1(a.topY)} there.`);
    } else if (a.role === 'pit' && bp.ground === 'floor') {
      // A pit stays open, except where the plan itself puts a bridge, platform or stairs over it.
      const filled = spots(a).filter(([x, z]) => !walkableRects.some((r) => pointIn(x, z, r))).map(([x, z]) => ({ x, z, s: solids.find((s) => inside(s, x, z) && s.bottom <= 0.5 && s.top > -3) })).find((h) => h.s);
      if (filled) out.push(`${where} is covered: the plan has a bottomless hole there, but the map has a ${filled.s!.type} at y=${r1(filled.s!.top)} over (${r1(filled.x)}, ${r1(filled.z)}). Remove it; the room skips its floor and the floor is built around the pit.`);
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
      if (!found) out.push(`${where} should have ${h === 'acid' || h === 'spikes' ? h : `a ${h}`} (the plan lists it as a hazard there), but the map has no ${h} piece within 1 m of ${span(r)}.`);
    }
  }
  // The floor around the pits is still there (a few points of each part).
  if (hasPits(bp, expanded)) {
    const grid = floorGrid(bp, expanded)!;
    const gone: string[] = [];
    for (const part of grid.parts) {
      const step = Math.max(1, Math.floor(part.length / 6));
      for (let i = 0; i < part.length; i += step) {
        const c = part[i];
        const x = (c.minX + c.maxX) / 2;
        const z = (c.minZ + c.maxZ) / 2;
        if (!solids.some((s) => inside(s, x, z) && near(s.top, 0, 0.35)) && !solids.some((s) => inside(s, x, z) && s.bottom <= 0.05 && s.top > 0.35)) gone.push(`(${r1(x)}, ${r1(z)})`);
      }
    }
    if (gone.length) out.push(`The floor around the pits is missing at ${gone.slice(0, 4).join(', ')}: the plan has floor at y=0 there. Keep the floor blocks (top at y=0) that surround the pits.`);
  }
  const wanted = bp.spawns.length;
  const have = placed.filter((p) => p.type === 'spawn').length;
  if (have < wanted) out.push(`The plan has ${wanted} spawn point${wanted === 1 ? '' : 's'} but the map has ${have}.`);
  return out;
}
