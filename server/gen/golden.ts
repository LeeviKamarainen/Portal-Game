import { expandPieces, mapKind, withDefaults, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';
import { solidsOf } from './check';

/**
 * The golden prompts for `npm run gen:eval`: what real users are likely to type, spread over
 * combat and puzzle maps, sizes and hazard types. "ok" from the generator only says the map
 * builds and passes the lints; `expect` adds what the request itself asked for, in terms code
 * can measure, so the report can tell "builds" from "builds and looks like what was asked".
 */

export interface Expect {
  kind?: 'combat' | 'puzzle';
  minSpawns?: number;
  /** At least this many pieces of each type. */
  has?: Record<string, number>;
  /** Highest walkable surface minus the lowest, in metres. */
  heightSpread?: number;
  /** Surfaces clear of the floor (floating platforms and islands). */
  floating?: number;
  /** Every floating platform carries or touches a hazard. */
  hazardOnEachPlatform?: boolean;
  /** At least this many portal-capable pieces. */
  portalPieces?: number;
  /** The room has no floor: falling off is possible. */
  voidFloor?: boolean;
}

export interface GoldenPrompt {
  id: string;
  prompt: string;
  kind: 'auto' | 'combat' | 'puzzle';
  size: 'auto' | 'small' | 'medium' | 'large';
  expect: Expect;
}

const g = (id: string, prompt: string, expect: Expect, kind: GoldenPrompt['kind'] = 'auto', size: GoldenPrompt['size'] = 'auto'): GoldenPrompt => ({ id, prompt, kind, size, expect });

export const GOLDEN: GoldenPrompt[] = [
  // Combat
  g('pvp-heights', 'Pvp map with big height differences, floating platforms with hazards on each platform', { kind: 'combat', minSpawns: 2, heightSpread: 8, floating: 3, hazardOnEachPlatform: true }),
  g('flat-cover', 'Wide open flat arena with a few cover blocks and portal walls on two sides', { kind: 'combat', minSpawns: 2, portalPieces: 2 }, 'combat'),
  g('central-pillar', 'Small symmetric arena with a tall central pillar and portal walls on every side, no hazards', { kind: 'combat', minSpawns: 2, portalPieces: 2 }, 'combat', 'small'),
  g('acid-moat', 'A fortress in the middle surrounded by an acid moat, with ramps up to a high platform', { kind: 'combat', minSpawns: 2, has: { acid: 1 }, heightSpread: 4 }, 'combat'),
  g('twin-towers', 'Two tall towers on opposite sides connected by a thin bridge, portal walls on the tower sides', { kind: 'combat', minSpawns: 2, heightSpread: 6, portalPieces: 2 }, 'combat'),
  g('trap-corridor', 'A corridor map with crushers and spike traps guarding the way between the two spawn areas', { kind: 'combat', minSpawns: 2 }, 'combat'),
  g('void-islands', 'Islands floating over a bottomless void where you can fall off, with portals as the only way across the biggest gaps', { kind: 'combat', minSpawns: 2, voidFloor: true, has: { block: 3 }, portalPieces: 2 }, 'combat'),
  g('moving-acid', 'Moving platforms carrying players across an acid lake', { kind: 'combat', minSpawns: 2, has: { platform: 1, acid: 1 } }, 'combat'),
  g('shaft', 'Vertical shaft map with spawns at the top and the bottom, ledges and stairs zig-zagging between them', { kind: 'combat', minSpawns: 2, heightSpread: 8 }, 'combat'),
  g('trapdoors', 'Arena whose floor is trapdoors over a spike pit', { kind: 'combat', minSpawns: 2, has: { trapdoor: 1, spikes: 1 } }, 'combat'),
  g('king-hill', 'King of the hill: a high central platform with rams on the sides that knock players off', { kind: 'combat', minSpawns: 2, has: { ram: 1 }, heightSpread: 3 }, 'combat'),
  g('three-storey', 'A three-storey building with stairs between the floors and portal walls on every floor', { kind: 'combat', minSpawns: 2, heightSpread: 8, portalPieces: 3 }, 'combat', 'large'),

  // Puzzle
  g('portal1-stage1', 'Copy puzzle map from Portal 1 stage 1', { kind: 'puzzle', has: { goal: 1 } }),
  g('acid-gap', 'Puzzle: cross an acid pit by placing portals on two walls to reach the exit', { kind: 'puzzle', has: { goal: 1, acid: 1 }, portalPieces: 2 }, 'puzzle'),
  // A switch only sets off hazards, and a door only opens for a laser receiver: "a switch that opens a
  // door" arrives with milestone 5a (plate + multi-input door). Until then the door is the measured part.
  g('switch-door', 'Puzzle with a switch you have to shoot to open the door to the exit', { kind: 'puzzle', has: { goal: 1, door: 1 } }, 'puzzle'),
  g('laser-relay', 'Puzzle where a laser has to be sent through a portal into a receiver to open the exit door', { kind: 'puzzle', has: { goal: 1, laser: 1, receiver: 1, door: 1 } }, 'puzzle'),
  g('high-ledge', 'Puzzle: the exit is on a high ledge you cannot jump to, so you fling yourself up with portals', { kind: 'puzzle', has: { goal: 1 }, heightSpread: 5, portalPieces: 2 }, 'puzzle'),
  g('timed-hazards', 'Puzzle corridor with spikes and a crusher to time, then portal over a wall to the exit', { kind: 'puzzle', has: { goal: 1 }, portalPieces: 1 }, 'puzzle'),
  // Targets are painted rings and nothing reacts to a crate landing on one until 5a/5b (plate, cube).
  g('dropper-target', 'Puzzle where a dropper drops crates and one has to land on a target to open the exit door', { kind: 'puzzle', has: { goal: 1, dropper: 1 } }, 'puzzle'),
  g('two-chambers', 'Two chambers: the first has a door opened by a switch, the second an acid pit to cross with portals, exit at the end', { kind: 'puzzle', has: { goal: 1, door: 1, acid: 1 }, portalPieces: 2 }, 'puzzle', 'large'),
];

export interface MapStats {
  kind: 'combat' | 'puzzle';
  pieces: number;
  spawns: number;
  byType: Record<string, number>;
  /** Highest minus lowest standable surface; 0 when there is none. */
  heightSpread: number;
  floating: number;
  floatingBare: number;
  portalPieces: number;
  /** The room's floor is skipped. */
  voidFloor: boolean;
}

const HAZARDS = ['acid', 'spikes', 'trapdoor', 'crusher', 'ram', 'laser', 'platform', 'dropper'];

/** What a finished map contains, in the terms the `Expect` fields use. */
export function measure(map: MapData): MapStats {
  const placed: Piece[] = expandPieces(map).map(withDefaults);
  const byType: Record<string, number> = {};
  for (const p of map.pieces) byType[p.type] = (byType[p.type] ?? 0) + 1;
  const solids = solidsOf(map, placed).filter((s) => s.top - s.bottom >= 0.01);
  const room = placed.find((p) => p.type === 'room');
  const floorY = Array.isArray(room?.at) ? (room!.at as Vec3)[1] : 0;
  const tops = solids.filter((s) => s.type !== 'wall' && s.type !== 'portal-wall').map((s) => s.top);
  const heightSpread = tops.length ? Math.max(...tops) - Math.min(...tops) : 0;
  // A floating surface sits clear of the floor with air below it (a tall block rising from the floor is not floating).
  const floatingSolids = solids.filter((s) => ['block', 'floor'].includes(s.type) && s.bottom >= floorY + 1);
  const hazards = placed.filter((p) => HAZARDS.includes(p.type) && Array.isArray(p.at));
  const bare = floatingSolids.filter(
    (s) => !hazards.some((h) => (h.at as Vec3)[0] >= s.minX - 1 && (h.at as Vec3)[0] <= s.maxX + 1 && (h.at as Vec3)[2] >= s.minZ - 1 && (h.at as Vec3)[2] <= s.maxZ + 1 && (h.at as Vec3)[1] >= s.top - 1 && (h.at as Vec3)[1] <= s.top + 6),
  );
  return {
    kind: mapKind(map),
    pieces: map.pieces.length,
    spawns: placed.filter((p) => p.type === 'spawn').length,
    byType,
    heightSpread: Math.round(heightSpread * 10) / 10,
    floating: floatingSolids.length,
    floatingBare: bare.length,
    portalPieces: placed.filter((p) => Array.isArray(p.portal) && p.portal.length > 0).length,
    voidFloor: Array.isArray(room?.skip) && (room!.skip as string[]).includes('floor'),
  };
}

export interface FitResult {
  checked: number;
  passed: number;
  misses: string[];
}

/** Compares a finished map with what its prompt was measured to need. */
export function fit(map: MapData, expect: Expect): FitResult {
  const s = measure(map);
  const misses: string[] = [];
  let checked = 0;
  const need = (ok: boolean, miss: string) => {
    checked++;
    if (!ok) misses.push(miss);
  };
  if (expect.kind) need(s.kind === expect.kind, `kind is ${s.kind}, wanted ${expect.kind}`);
  if (expect.minSpawns !== undefined) need(s.spawns >= expect.minSpawns, `${s.spawns} spawns, wanted ${expect.minSpawns}`);
  for (const [type, n] of Object.entries(expect.has ?? {})) need((s.byType[type] ?? 0) >= n, `${s.byType[type] ?? 0} ${type}, wanted ${n}`);
  if (expect.heightSpread !== undefined) need(s.heightSpread >= expect.heightSpread, `height spread ${s.heightSpread} m, wanted ${expect.heightSpread}`);
  if (expect.floating !== undefined) need(s.floating >= expect.floating, `${s.floating} floating platforms, wanted ${expect.floating}`);
  if (expect.hazardOnEachPlatform) need(s.floatingBare === 0 && s.floating > 0, `${s.floatingBare} of ${s.floating} floating platforms have no hazard`);
  if (expect.voidFloor !== undefined) need(s.voidFloor === expect.voidFloor, expect.voidFloor ? 'the room has a floor, wanted a void' : 'the room has no floor');
  if (expect.portalPieces !== undefined) need(s.portalPieces >= expect.portalPieces, `${s.portalPieces} portal surfaces, wanted ${expect.portalPieces}`);
  return { checked, passed: checked - misses.length, misses };
}
