import { expandPieces, footprint, withDefaults, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';
import { inside, solidsOf, type Solid } from './check';
import { describeFeature, expandAreas, type Blueprint, type Feature } from './blueprint';

/**
 * Whether a map has what its request asked for. The planner reads the request into features
 * (a hole at the centre, three platforms, an acid moat...); each kind has a measurement here on
 * the built geometry, so "a giant hole in the middle" is checked as an opening in the floor at
 * the centre, not as a word in a summary. The same measurement judges
 *
 *   - the plan, through the structure code builds from it (`scaffold`), with the hazards taken
 *     from the plan's lists because the model only adds most of them later,
 *   - the finished map, and
 *   - the eval's golden prompts.
 *
 * Messages say what was asked, what is there, and how to fix it in the plan's or the map's terms.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
/** The side of a hole, pool or moat as a share of the room's smaller side. */
const FRACTION: Record<Feature['size'], number> = { any: 0.15, small: 0.15, medium: 0.25, large: 0.4 };
const HAZARDS = ['acid', 'spikes', 'trapdoor', 'crusher', 'ram', 'laser', 'platform', 'dropper'];

interface Group {
  top: number;
  area: number;
  solids: Solid[];
}

interface Scene {
  W: number;
  D: number;
  H: number;
  cx: number;
  cz: number;
  floorY: number;
  killY: number;
  placed: Piece[];
  solids: Solid[];
  acid: { min: { x: number; z: number }; max: { x: number; z: number } }[];
  /** Walkable surfaces, with touching ones at one height merged (a platform and its bridge are one). */
  groups: Group[];
  /** Most of the room has ground at floor level, so "platforms" are what rises above it. */
  floorBased: boolean;
  skipsFloor: boolean;
}

/** A long, narrow slab: a bridge or walkway, not a platform of its own. */
function bridgeLike(s: Solid): boolean {
  const w = s.maxX - s.minX;
  const d = s.maxZ - s.minZ;
  return s.type !== 'room floor' && Math.max(w, d) >= 2.5 && Math.max(w, d) >= 1.5 * Math.min(w, d) && Math.min(w, d) <= 3;
}

const gap = (a: Solid, b: Solid) => Math.hypot(Math.max(0, a.minX - b.maxX, b.minX - a.maxX), Math.max(0, a.minZ - b.maxZ, b.minZ - a.maxZ));

function sceneOf(map: MapData): Scene | null {
  let placed: Piece[];
  try {
    placed = expandPieces(map).map(withDefaults);
  } catch {
    return null;
  }
  const room = placed.find((p) => p.type === 'room' && Array.isArray(p.size));
  if (!room) return null;
  const [W, H, D] = room.size as Vec3;
  const solids = solidsOf(map, placed);
  const acid = placed.filter((p) => p.type === 'acid' && Array.isArray(p.size) && (p.rot ?? 0) % 90 === 0).map((p) => footprint(p));
  const floorY = room.at[1];
  // Merge touching surfaces at one height; a bridge joins platforms without making them one.
  const flat = solids.filter((s) => ['block', 'floor', 'room floor'].includes(s.type) && s.top - s.bottom >= 0.01 && !bridgeLike(s));
  const parent = flat.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < flat.length; i++)
    for (let j = i + 1; j < flat.length; j++) if (Math.abs(flat[i].top - flat[j].top) <= 0.15 && gap(flat[i], flat[j]) <= 0.15) parent[find(i)] = find(j);
  const byRoot = new Map<number, Group>();
  flat.forEach((s, i) => {
    const g = byRoot.get(find(i)) ?? { top: s.top, area: 0, solids: [] };
    g.area += (s.maxX - s.minX) * (s.maxZ - s.minZ);
    g.solids.push(s);
    byRoot.set(find(i), g);
  });
  const groups = [...byRoot.values()];
  const floorArea = groups.filter((g) => Math.abs(g.top - floorY) <= 0.3).reduce((sum, g) => sum + g.area, 0);
  return {
    W,
    D,
    H,
    cx: room.at[0],
    cz: room.at[2],
    floorY,
    killY: typeof map.killY === 'number' ? map.killY : -6,
    placed,
    solids,
    acid,
    groups,
    floorBased: floorArea >= 0.5 * W * D,
    skipsFloor: Array.isArray(room.skip) && (room.skip as string[]).includes('floor'),
  };
}

// ------------------------------------------------------------------ the floor plan as 1 m cells

interface Region {
  x: number;
  z: number;
  r: number;
  words: string;
}

function regionOf(s: Scene, where: Feature['where']): Region | null {
  const m = Math.min(s.W, s.D);
  switch (where) {
    case 'anywhere': return null;
    case 'center': return { x: s.cx, z: s.cz, r: 0.2 * m, words: 'the centre' };
    case 'north': return { x: s.cx, z: s.cz - s.D / 4, r: 0.3 * m, words: 'the north side' };
    case 'south': return { x: s.cx, z: s.cz + s.D / 4, r: 0.3 * m, words: 'the south side' };
    case 'east': return { x: s.cx + s.W / 4, z: s.cz, r: 0.3 * m, words: 'the east side' };
    case 'west': return { x: s.cx - s.W / 4, z: s.cz, r: 0.3 * m, words: 'the west side' };
  }
}

interface Blob {
  cells: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  touches: boolean;
}

/** Cells (1 m) where `pred` holds, joined into blobs; `touches` says a blob reaches into the region. */
function blobs(s: Scene, pred: (x: number, z: number) => boolean, region: Region | null): Blob[] {
  const nx = Math.max(1, Math.ceil(s.W));
  const nz = Math.max(1, Math.ceil(s.D));
  const x0 = s.cx - s.W / 2;
  const z0 = s.cz - s.D / 2;
  const at = (i: number, j: number): [number, number] => [x0 + ((i + 0.5) * s.W) / nx, z0 + ((j + 0.5) * s.D) / nz];
  const on: boolean[] = new Array(nx * nz);
  for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) on[i * nz + j] = pred(...at(i, j));
  const seen = new Uint8Array(nx * nz);
  const out: Blob[] = [];
  for (let k = 0; k < nx * nz; k++) {
    if (!on[k] || seen[k]) continue;
    const b: Blob = { cells: 0, minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, touches: false };
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const i = Math.floor(c / nz);
      const j = c % nz;
      const [x, z] = at(i, j);
      b.cells++;
      b.minX = Math.min(b.minX, x - 0.5);
      b.maxX = Math.max(b.maxX, x + 0.5);
      b.minZ = Math.min(b.minZ, z - 0.5);
      b.maxZ = Math.max(b.maxZ, z + 0.5);
      if (region && Math.hypot(x - region.x, z - region.z) <= region.r) b.touches = true;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const p = i + di;
        const q = j + dj;
        if (p < 0 || q < 0 || p >= nx || q >= nz) continue;
        const n = p * nz + q;
        if (on[n] && !seen[n]) (seen[n] = 1), stack.push(n);
      }
    }
    out.push(b);
  }
  return out;
}

/** Nothing reaches down to the floor level here: a player at ground level falls. */
const openAt = (s: Scene) => (x: number, z: number) => !s.solids.some((sd) => inside(sd, x, z) && sd.bottom <= s.floorY + 0.5 && sd.top > s.killY);
const acidAt = (s: Scene) => (x: number, z: number) => s.acid.some((a) => x >= a.min.x && x <= a.max.x && z >= a.min.z && z <= a.max.z);

// ------------------------------------------------------------------ the measurements

type Stage = 'plan' | 'map';

interface Verdict {
  /** What is there, when it falls short. */
  found: string;
  /** What to change, in the stage's terms. */
  fix: string;
}

/** An opening (or acid) of the feature's size in the right place. */
function patchCheck(s: Scene, f: Feature, stage: Stage, kind: 'hole' | 'pool'): Verdict | null {
  const region = regionOf(s, f.where);
  const side = Math.max(3, FRACTION[f.size] * Math.min(s.W, s.D));
  const pred = kind === 'hole' ? openAt(s) : acidAt(s);
  const found = blobs(s, pred, region).filter((b) => !region || b.touches).sort((a, b) => b.cells - a.cells)[0];
  // Big enough by area, and wide enough to be a real gap (a long chasm 4 m across counts; a slit does not).
  const ok = found && found.cells >= 0.7 * side * side && Math.min(found.maxX - found.minX, found.maxZ - found.minZ) >= Math.min(0.7 * side, 4);
  if (ok) return null;
  const at = region ? ` at x=${r1(region.x)}, z=${r1(region.z)}` : '';
  const what = kind === 'hole' ? 'opening in the floor' : 'acid';
  return {
    found: found ? `the largest ${what}${region ? ` at ${region.words}` : ''} is only about ${r1(found.maxX - found.minX)} x ${r1(found.maxZ - found.minZ)} m` : `there is no ${what}${region ? ` at ${region.words}` : ''}${kind === 'hole' ? ' (the ground there is solid)' : ''}`,
    fix:
      stage === 'plan'
        ? kind === 'hole'
          ? `Add a pit area (role "pit", a bottomless hole, not acid) of at least ${Math.ceil(side)} x ${Math.ceil(side)} m${at}, and keep raised and ground areas out of it`
          : `Add a pool area (role "pool") of at least ${Math.ceil(side)} x ${Math.ceil(side)} m${at}`
        : kind === 'hole'
          ? `Leave the floor out${at} over at least ${Math.ceil(side)} x ${Math.ceil(side)} m: the room piece skips its floor and floor blocks go only around the hole; remove whatever fills it`
          : `Add an acid piece of at least ${Math.ceil(side)} x ${Math.ceil(side)} m${at}`,
  };
}

function moatCheck(s: Scene, f: Feature, stage: Stage): Verdict | null {
  const region = regionOf(s, f.where === 'anywhere' ? 'center' : f.where)!;
  const acid = acidAt(s);
  const open = openAt(s);
  const ring = f.hazard === 'acid' ? acid : (x: number, z: number) => acid(x, z) || open(x, z);
  const missing: string[] = [];
  if (ring(region.x, region.z)) missing.push(`${region.words} itself is ${f.hazard === 'acid' ? 'acid' : 'open'}, so there is nothing for the moat to surround`);
  else
    for (const [name, dx, dz] of [['north', 0, -1], ['south', 0, 1], ['west', -1, 0], ['east', 1, 0]] as const) {
      let hit = false;
      for (let t = 1; t < Math.max(s.W, s.D); t += 0.5) {
        const x = region.x + dx * t;
        const z = region.z + dz * t;
        if (Math.abs(x - s.cx) > s.W / 2 || Math.abs(z - s.cz) > s.D / 2) break;
        if (ring(x, z)) {
          hit = true;
          break;
        }
      }
      if (!hit) missing.push(name);
    }
  if (!missing.length) return null;
  const material = f.hazard === 'acid' ? 'acid' : 'a hole or acid';
  return {
    found: missing.length === 1 && missing[0].includes('itself') ? missing[0] : `nothing ${f.hazard === 'acid' ? 'acid' : 'open'} lies on the ${missing.join(', ')} side${missing.length === 1 ? '' : 's'} of ${region.words}`,
    fix:
      stage === 'plan'
        ? `Add a moat area (role "moat") with around = the id of the area at ${region.words}${f.hazard === 'acid' ? ' and hazards ["acid"]' : ''}; code builds the ring`
        : `Close the ring: ${material} on all four sides of the area at ${region.words}`,
  };
}

/** Long, narrow slabs over a gap or a drop, with a surface at their own height at both ends. */
function bridges(s: Scene, region: Region | null): number {
  const acid = acidAt(s);
  let n = 0;
  for (const b of s.solids) {
    if (!['block', 'floor'].includes(b.type)) continue;
    const w = b.maxX - b.minX;
    const d = b.maxZ - b.minZ;
    const long = Math.max(w, d);
    const short = Math.min(w, d);
    if (long < 4 || long < 2 * short || short < 1) continue;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    if (region && Math.hypot(cx - region.x, cz - region.z) > region.r + long / 2) continue;
    const below = s.solids.filter((o) => o !== b && inside(o, cx, cz) && o.top <= b.bottom + 0.05).map((o) => o.top);
    const air = below.length ? b.bottom - Math.max(...below) : Infinity;
    if (air < 1 && !acid(cx, cz)) continue;
    const ends: [number, number][] = w >= d ? [[b.minX - 0.4, cz], [b.maxX + 0.4, cz]] : [[cx, b.minZ - 0.4], [cx, b.maxZ + 0.4]];
    const bank = ([x, z]: [number, number]) => s.solids.some((o) => o !== b && inside(o, x, z) && (o.stairs ? b.top >= o.bottom - 0.3 && b.top <= o.top + 0.3 : Math.abs(o.top - b.top) <= 0.6));
    if (ends.every(bank)) n++;
  }
  return n;
}

const platforms = (s: Scene): Group[] => s.groups.filter((g) => g.area >= 4 && (s.floorBased ? g.top >= s.floorY + 0.5 : true));

function levels(s: Scene): number[] {
  const tops = [...new Set(s.groups.filter((g) => g.area >= 6).map((g) => g.top))].sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of tops) if (!out.length || t - out[out.length - 1] >= 1) out.push(t);
  return out;
}

function towers(s: Scene, f: Feature, region: Region | null): { need: number; found: number } {
  const need = f.metres > 0 ? f.metres : Math.max(5, 0.3 * s.H);
  const maxW = 0.5 * Math.min(s.W, s.D);
  // A tower is a solid mass rising from the ground, at least three quarters as tall as it is wide; walls and stairs are not towers.
  const tall = s.solids.filter((b) => (b.type === 'block' || b.type === 'floor') && b.bottom <= s.floorY + 0.5 && b.top - s.floorY >= need && Math.max(b.maxX - b.minX, b.maxZ - b.minZ) <= Math.min(maxW, (b.top - s.floorY) / 0.75));
  const centres: [number, number][] = [];
  for (const b of tall) {
    const c: [number, number] = [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
    if (region && Math.hypot(c[0] - region.x, c[1] - region.z) > region.r) continue;
    if (!centres.some(([x, z]) => Math.hypot(x - c[0], z - c[1]) < 2)) centres.push(c);
  }
  return { need, found: centres.length };
}

/** Floating surfaces (clear of what is below) with no hazard on or over them. */
function bareFloating(s: Scene): Solid[] {
  const floating = s.solids.filter((b) => ['block', 'floor'].includes(b.type) && b.bottom >= s.floorY + 1);
  const hazards = s.placed.filter((p) => HAZARDS.includes(p.type) && Array.isArray(p.at));
  return floating.filter((b) => !hazards.some((h) => h.at[0] >= b.minX - 1 && h.at[0] <= b.maxX + 1 && h.at[2] >= b.minZ - 1 && h.at[2] <= b.maxZ + 1 && h.at[1] >= b.top - 1 && h.at[1] <= b.top + 6));
}

function judge(s: Scene, f: Feature, stage: Stage, plan?: Blueprint): Verdict | null {
  const n = Math.max(1, Math.round(f.count));
  const region = regionOf(s, f.where);
  switch (f.what) {
    case 'hole':
      return patchCheck(s, f, stage, 'hole');
    case 'pool':
      return patchCheck(s, f, stage, 'pool');
    case 'moat':
      return moatCheck(s, f, stage);
    case 'bridge': {
      const found = bridges(s, region);
      if (found >= n) return null;
      return {
        found: `the ${stage} has ${found} bridge${found === 1 ? '' : 's'}${region ? ` near ${region.words}` : ''}`,
        fix:
          stage === 'plan'
            ? 'Add a bridge area (role "bridge") with from and to naming two areas at one height with a gap or drop between them; code places it'
            : 'Add a long, narrow slab (at least 4 m long and twice as long as wide) over a gap or drop, touching a surface at its own height at both ends',
      };
    }
    case 'platforms': {
      const found = platforms(s).length;
      if (found >= n) return null;
      return {
        found: `the ${stage} has ${found} (surfaces of at least 4 m2 ${s.floorBased ? 'above the floor' : 'to stand on'}; parts that touch at one height count as one)`,
        fix: stage === 'plan' ? 'Add raised or floating areas that stand apart from each other' : 'Add raised or floating blocks that stand apart from each other',
      };
    }
    case 'levels': {
      const want = Math.max(2, n);
      const found = levels(s);
      if (found.length >= want) return null;
      return {
        found: `the ${stage} has ground at ${found.length} height${found.length === 1 ? '' : 's'} (${found.map((y) => `y=${r1(y)}`).join(', ') || 'none'})`,
        fix: `Put ${stage === 'plan' ? 'raised and floating areas' : 'surfaces'} at ${want} different heights, at least 1 m apart, each at least 6 m2`,
      };
    }
    case 'tower': {
      const t = towers(s, f, region);
      if (t.found >= n) return null;
      return {
        found: `the ${stage} has ${t.found} block${t.found === 1 ? '' : 's'} at least ${r1(t.need)} m tall and no wider than ${r1(0.5 * Math.min(s.W, s.D))} m or 4/3 of its height${region ? ` at ${region.words}` : ''}`,
        fix: `${stage === 'plan' ? 'Add a raised area' : 'Add a block'} at least ${r1(t.need)} m tall${region ? ` at x=${r1(region.x)}, z=${r1(region.z)}` : ''} (and raise roomHeight if needed)`,
      };
    }
    case 'height-spread': {
      const want = f.metres > 0 ? f.metres : 6;
      const tops = s.groups.filter((g) => g.area >= 2).map((g) => g.top);
      const spread = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
      if (spread >= want - 0.05) return null;
      return { found: `its ground spans only ${r1(spread)} m`, fix: `Raise the highest ${stage === 'plan' ? 'area' : 'surface'} so the spread is at least ${want} m` };
    }
    case 'stairs': {
      const found = s.placed.filter((p) => p.type === 'stairs' || p.type === 'slope').length;
      if (found >= n) return null;
      return { found: `the ${stage} has ${found}`, fix: stage === 'plan' ? 'Add stairs areas with from and to (code places each flight)' : 'Add stairs pieces between the levels' };
    }
    case 'hazard': {
      if (f.hazard === 'none') return null;
      if (plan) {
        const listed = expandAreas(plan).filter((a) => (a.hazards as string[]).includes(f.hazard)).length;
        return listed > 0 ? null : { found: `no area lists ${f.hazard}`, fix: `List ${f.hazard} in the hazards of the area${n > 1 ? 's' : ''} it belongs to` };
      }
      const found = s.placed.filter((p) => p.type === f.hazard).length;
      if (found >= n) return null;
      return { found: `the map has ${found}`, fix: `Add ${n - found} more ${f.hazard} piece${n - found === 1 ? '' : 's'}` };
    }
    case 'hazard-on-each-platform': {
      if (plan) {
        const bare = expandAreas(plan).filter((a) => a.role === 'floating' && a.hazards.length === 0);
        return bare.length ? { found: `the floating area${bare.length === 1 ? '' : 's'} ${bare.map((a) => a.id).join(', ')} list${bare.length === 1 ? 's' : ''} no hazard`, fix: 'List a hazard on every floating area' } : null;
      }
      const bare = bareFloating(s);
      if (bare.length === 0) return null;
      return { found: `${bare.length} floating platform${bare.length === 1 ? ' has' : 's have'} no hazard (${bare.slice(0, 4).map((b) => `top y=${r1(b.top)} at x=${r1((b.minX + b.maxX) / 2)}, z=${r1((b.minZ + b.maxZ) / 2)}`).join('; ')})`, fix: 'Put a hazard on or over each of them' };
    }
    case 'portal-walls': {
      const found = s.placed.filter((p) => p.type !== 'room' && Array.isArray(p.portal) && p.portal.length > 0).length;
      if (found >= n) return null;
      return { found: `the ${stage} has ${found} piece${found === 1 ? '' : 's'} with portal surfaces`, fix: stage === 'plan' ? 'Set portals=true on more areas, or add walls that take portals' : 'Give more pieces portal faces, or add portal walls' };
    }
    case 'void': {
      const floorArea = s.groups.filter((g) => Math.abs(g.top - s.floorY) <= 0.3).reduce((sum, g) => sum + g.area, 0);
      if (plan ? plan.ground === 'void' || expandAreas(plan).some((a) => a.role === 'pit') : s.skipsFloor && floorArea < 0.95 * s.W * s.D) return null;
      return { found: 'there is a floor under everything', fix: stage === 'plan' ? 'Set ground to "void" and list the islands, or add pits' : 'Skip the room floor and leave places to fall' };
    }
  }
}

export interface FeatureOptions {
  /** Judge a plan: `map` is the structure built from it, and hazards come from the plan's lists. */
  plan?: Blueprint;
}

/** What the map (or the plan, through its scaffold) lacks of the requested features. Empty means all are there. */
export function featureProblems(features: Feature[], map: MapData, opts: FeatureOptions = {}): string[] {
  if (!features.length) return [];
  const s = sceneOf(map);
  if (!s) return [];
  const stage: Stage = opts.plan ? 'plan' : 'map';
  const out: string[] = [];
  for (const f of features) {
    const v = judge(s, f, stage, opts.plan);
    if (v) out.push(`The request asks for ${describeFeature(f)}${f.words ? ` ("${f.words}")` : ''}, but ${v.found}. ${v.fix}.`);
  }
  return out;
}

/** The features of a plan as the model and the player may write them, kept to sane numbers. */
export function tidyFeatures(features: (Feature | null)[]): Feature[] {
  const seen = new Set<string>();
  const out: Feature[] = [];
  for (const f of features) {
    if (!f || (f.what === 'hazard' && f.hazard === 'none')) continue;
    const tidy: Feature = { ...f, count: Math.min(20, Math.max(0, Math.round(f.count))), metres: Math.min(60, Math.max(0, Math.round(f.metres * 2) / 2)), words: f.words.slice(0, 80) };
    const key = JSON.stringify({ ...tidy, words: '' });
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tidy);
  }
  return out.slice(0, 8);
}
