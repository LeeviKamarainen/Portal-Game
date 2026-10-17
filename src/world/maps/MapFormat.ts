import * as THREE from 'three';
import type { ArenaBuilder, ArenaDef } from '../ArenaBuilder';
import type { FaceKey, RoomSide } from '../Level';
import type { MaterialName } from '../Materials';
import { addLightStrip } from '../Markers';
import type { PowerSource, Triggerable } from '../hazards/Hazard';
import { PLAYER_FEET_OFFSET } from '../../player/PlayerController';

/**
 * Maps as data: a list of pieces from a fixed catalogue, each placed with a position, a
 * size and a rotation. The same file can be written by hand, generated, or saved by the
 * map editor, and `mapToArena` turns it into an arena the game plays.
 *
 * Conventions (all lengths in metres, y up):
 *  - `at` is the bottom centre of a piece unless the catalogue says otherwise.
 *  - `size` is [width, height, depth] in the piece's own frame: width across, depth along
 *    its front. `rot` turns the piece about y, in degrees, counter-clockwise seen from
 *    above. At rot 0 a piece's front faces -z (north); 90 faces -x (west).
 *  - Blocks, floors, stairs and pools turn in 90 degree steps; hazards turn freely.
 *  - Faces are named from the piece's own point of view (top, bottom, front, back, left,
 *    right; `sides` = the four upright ones, `all` = six), so a rotated piece keeps its
 *    portal surface on the same side of itself.
 *  - `symmetry: "rotate180"` copies every piece not marked `center` with a half turn
 *    about the map's centre, swapping team colours - fair two-team maps for half the work.
 *  - Hazards can carry an `id`; switches list the ids they set off in `targets`, doors
 *    name their `receiver` (a laser receiver's or a floor button's id). In a symmetric map the copy of a piece gets its id with "~"
 *    added and its references flipped the same way, so each half's switch drives its own
 *    half (and a reference to "x~" from one half reaches the other half's "x").
 */

export type Vec3 = [number, number, number];
export type RelFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right' | 'sides' | 'all';
export type Team = 'orange' | 'blue';

export interface Piece {
  type: string;
  at: Vec3;
  size?: Vec3;
  rot?: number;
  /** On the symmetry centre: placed once, not copied. */
  center?: boolean;
  [param: string]: unknown;
}

/**
 * What the level is for. `combat`: a scored match against others, won on points (orbs and
 * hazard kills); the exit goal is ignored. `puzzle`: one player alone, hazards and portals
 * to get past, and the level ends when they reach the exit goal. A map without a `kind`
 * is a combat map. `speedrun`: one player against the clock, through the checkpoint gates in
 * the order they are listed to the finish gate; falls go back to the last checkpoint.
 */
export type MapKind = 'combat' | 'puzzle' | 'speedrun';

export const MAP_KINDS: { id: MapKind; label: string; help: string }[] = [
  { id: 'combat', label: 'Combat', help: 'Scored match against bots: orbs, hazard kills, first to the target score. Needs spawn points; the exit goal is ignored.' },
  { id: 'puzzle', label: 'Puzzle', help: 'Solo: reach the exit goal to finish the level. Needs one exit goal; symmetry and teams are ignored.' },
  {
    id: 'speedrun',
    label: 'Speedrun',
    help: 'Solo, against the clock: from the spawn through every checkpoint in order to the finish gate. No fall damage; a fall brings you back to the last checkpoint. Fizzlers close your portals, so no one portal can carry the whole run.',
  },
];

export interface MapData {
  id: string;
  name: string;
  hint: string;
  blurb?: string;
  kind?: MapKind;
  symmetry?: 'none' | 'rotate180';
  fog?: { color: string; near: number; far: number };
  /** Anything falling below this dies. */
  killY?: number;
  /** How far a portal shot reaches, in metres (default 200): a tall course can keep far-off surfaces out of use. */
  portalRange?: number;
  pieces: Piece[];
}

export type FieldKind = 'number' | 'text' | 'select' | 'faces' | 'sides' | 'bool' | 'color' | 'vec3' | 'ids';

/** One editable parameter of a piece, for the editor's inspector. */
export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  step?: number;
  hint?: string;
}

export type PieceGroup = 'Structure' | 'Hazards' | 'Interactive' | 'Markers';

export interface PieceSpec {
  /** For the editor's palette, and for error messages. */
  label: string;
  group: PieceGroup;
  /** One line on what it is and where `at` sits. */
  help: string;
  /** How it may turn: in quarter steps, freely, or not at all. */
  turn: 'quarter' | 'free' | 'none';
  /** Names of the three size components, if it has a size. */
  sizeLabels?: [string, string, string];
  defaults?: Partial<Piece>;
  fields?: FieldSpec[];
  build(b: ArenaBuilder, p: Piece, ctx: BuildContext): void;
}

interface BuildContext {
  kind: MapKind;
  /** Everything a door can name: laser receivers and floor buttons, by id. */
  receivers: Map<string, PowerSource>;
  triggerables: Map<string, Triggerable>;
  spawns: { feet: THREE.Vector3; yaw: number; team: Team | null }[];
  extent: THREE.Box3;
  /** Wiring that waits until every piece exists (doors, switches). */
  later: (() => void)[];
}

export const TEAM_COLORS: Record<Team, number> = { orange: 0xff8a3a, blue: 0x3ab0ff };

/** The steepest slope piece that can be walked: rise over run (about 40 degrees). */
export const MAX_SLOPE = 0.8;

/**
 * The gentlest a surf ramp's face may be, in degrees: steeper than anything the player can
 * stand on (the controller climbs up to 50), so the face is always slid on, never walked.
 */
export const MIN_SURF_ANGLE = 52;

/** How far a ramp fin reaches on down into its ramp (out of sight), at most. */
const FIN_BURY = 1.4;

const V = (v: Vec3) => new THREE.Vector3(v[0], v[1], v[2]);
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Turns a vector by `rot` degrees about y (three.js convention: counter-clockwise from above). */
export function turn(v: THREE.Vector3, rot: number): THREE.Vector3 {
  const a = rad(rot);
  const c = Math.cos(a);
  const s = Math.sin(a);
  return new THREE.Vector3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

export const front = (rot: number) => turn(new THREE.Vector3(0, 0, -1), rot);

function axisFace(v: THREE.Vector3): FaceKey {
  const ax = Math.abs(v.x);
  const ay = Math.abs(v.y);
  const az = Math.abs(v.z);
  if (ay >= ax && ay >= az) return v.y > 0 ? 'py' : 'ny';
  if (ax >= az) return v.x > 0 ? 'px' : 'nx';
  return v.z > 0 ? 'pz' : 'nz';
}

const LOCAL_FACES: Record<Exclude<RelFace, 'sides' | 'all'>, THREE.Vector3> = {
  top: new THREE.Vector3(0, 1, 0),
  bottom: new THREE.Vector3(0, -1, 0),
  front: new THREE.Vector3(0, 0, -1),
  back: new THREE.Vector3(0, 0, 1),
  left: new THREE.Vector3(-1, 0, 0),
  right: new THREE.Vector3(1, 0, 0),
};

export const FACE_NAMES = Object.keys(LOCAL_FACES) as (keyof typeof LOCAL_FACES)[];
export const ROOM_SIDES: RoomSide[] = ['floor', 'ceiling', 'north', 'south', 'east', 'west'];

/** A piece's face names (relative to it) as world box faces. */
export function faces(list: unknown, rot: number): FaceKey[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`faces must be a list, got ${JSON.stringify(list)}`);
  const out = new Set<FaceKey>();
  for (const f of list as RelFace[]) {
    const names = f === 'all' ? FACE_NAMES : f === 'sides' ? ['front', 'back', 'left', 'right'] : [f];
    for (const n of names) {
      const local = LOCAL_FACES[n as keyof typeof LOCAL_FACES];
      if (!local) throw new Error(`unknown face "${n}" (use top, bottom, front, back, left, right, sides, all)`);
      out.add(axisFace(turn(local, rot)));
    }
  }
  return [...out];
}

function num(p: Piece, key: string, fallback?: number): number {
  const v = p[key] ?? fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`);
  return v;
}

function optNum(p: Piece, key: string): number | undefined {
  const v = p[key];
  return v === undefined || v === null || v === '' ? undefined : num(p, key);
}

function str<T extends string>(p: Piece, key: string, fallback?: T): T {
  const v = p[key] ?? fallback;
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`);
  return v as T;
}

function oneOf<T extends string>(p: Piece, key: string, options: readonly T[], fallback: T): T {
  const v = (p[key] ?? fallback) as T;
  if (!options.includes(v)) throw new Error(`"${key}" must be one of ${options.join(', ')}`);
  return v;
}

export function color(v: unknown, fallback: number): number {
  if (v === undefined || v === '') return fallback;
  if (typeof v !== 'string' || !/^#[0-9a-f]{6}$/i.test(v)) throw new Error(`colours are "#rrggbb", got ${JSON.stringify(v)}`);
  return parseInt(v.slice(1), 16);
}

function quarterTurns(p: Piece): number {
  const rot = p.rot ?? 0;
  if (rot % 90 !== 0) throw new Error(`turns in 90 degree steps only (rot ${rot})`);
  return (((rot / 90) % 4) + 4) % 4;
}

/** World-space box of a piece standing on `at` with `size`, turned in quarter steps. */
export function footprint(p: Piece): { min: THREE.Vector3; max: THREE.Vector3 } {
  const [w, h, d] = p.size!;
  const swap = quarterTurns(p) % 2 === 1;
  const hx = (swap ? d : w) / 2;
  const hz = (swap ? w : d) / 2;
  return {
    min: new THREE.Vector3(p.at[0] - hx, p.at[1], p.at[2] - hz),
    max: new THREE.Vector3(p.at[0] + hx, p.at[1] + h, p.at[2] + hz),
  };
}

function solid(b: ArenaBuilder, p: Piece, ctx: BuildContext): void {
  const { min, max } = footprint(p);
  const rot = p.rot ?? 0;
  const hidden = new Set(faces(p.hide, rot));
  const all: FaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  b.box(min, max, {
    material: str<MaterialName>(p, 'material', 'metal'),
    portalable: faces(p.portal, rot),
    faces: all.filter((f) => !hidden.has(f)),
  });
  ctx.extent.expandByPoint(min).expandByPoint(max);
}

export type Poly = { points: THREE.Vector3[]; portalable?: boolean; up?: THREE.Vector3 };

/** One fin on a surf ramp (see the surf-ramp piece's `fins`). */
interface FinSpec {
  /** Metres from the ramp's back end. */
  along: number;
  /** Which sloping face it stands on (a one-sided ramp's own face by default). */
  side?: 'left' | 'right';
  /** How far it stands out of the face (a portal needs about 4.2). */
  height?: number;
  /** The stretch of the face it covers, as fractions from its foot (0) to its top (1). */
  from?: number;
  to?: number;
  thick?: number;
  /** Both broad faces take portals (default yes). */
  portal?: boolean;
}

/**
 * A surf ramp: a triangular ridge (or a one-sided wedge) `length` long, lying along its
 * front-back axis, the front end `drop` metres lower than the back; `at` is the middle of
 * its base. Fins are short walls standing straight out of a sloping face across the way
 * down it: hit one and you stop, but their broad faces take portals.
 */
export function surfRamp(p: Piece): { ramp: Poly[]; fins: Poly[][]; ridge: [THREE.Vector3, THREE.Vector3] } {
  const [width, height, length] = p.size!;
  if (!(width > 0 && height > 0 && length > 0)) throw new Error('a surf ramp needs a positive width, height and length');
  const sides = oneOf(p, 'sides', ['both', 'left', 'right'] as const, 'both');
  const drop = num(p, 'drop', 0);
  const run = sides === 'both' ? width / 2 : width;
  const angle = (Math.atan2(height, run) * 180) / Math.PI;
  if (angle < MIN_SURF_ANGLE) {
    throw new Error(`a surf ramp's face must be at least ${MIN_SURF_ANGLE} degrees steep or it is just a floor: this one is ${angle.toFixed(0)} (make it taller or narrower)`);
  }
  const hw = width / 2;
  // The cross-section, in (across, up): left base, then round.
  const section: [number, number][] =
    sides === 'both' ? [[-hw, 0], [0, height], [hw, 0]] : sides === 'left' ? [[-hw, 0], [hw, height], [hw, 0]] : [[-hw, 0], [-hw, height], [hw, 0]];
  const rot = p.rot ?? 0;
  const base = V(p.at);
  /** Ramp-local (across, up, z with +z the back end) to world, the drop sloping it along its length. */
  const local = (x: number, y: number, z: number) => turn(new THREE.Vector3(x, y + (drop * z) / length, z), rot).add(base);
  const at = ([x, y]: [number, number], back: boolean) => local(x, y, back ? length / 2 : -length / 2);
  const portal = new Set((p.portal as string[] | undefined) ?? []);
  const ramp: Poly[] = [];
  /** Each sloping face: its foot, its top and the section's third corner. */
  const slopes: Partial<Record<'left' | 'right', [[number, number], [number, number], [number, number]]>> = {};
  for (let i = 0; i < 3; i++) {
    const a = section[i];
    const b = section[(i + 1) % 3];
    const slanted = a[0] !== b[0] && a[1] !== b[1];
    const name = !slanted ? '' : sides === 'both' ? (i === 0 ? 'left' : 'right') : sides;
    if (name) slopes[name] = [...(a[1] < b[1] ? [a, b] : [b, a]), section[(i + 2) % 3]] as [[number, number], [number, number], [number, number]];
    ramp.push({ points: [at(a, true), at(b, true), at(b, false), at(a, false)], portalable: name !== '' && portal.has(name) });
  }
  ramp.push({ points: section.map((c) => at(c, true)) });
  ramp.push({ points: section.map((c) => at(c, false)) });

  const fins: Poly[][] = [];
  const specs = (p.fins as FinSpec[] | undefined) ?? [];
  if (!Array.isArray(specs)) throw new Error('fins must be a list of { along, side, height, from, to }');
  specs.forEach((f, i) => {
    const side = f.side ?? (sides === 'both' ? 'left' : sides);
    const slope = slopes[side];
    if (!slope) throw new Error(`fin #${i}: this ramp has no ${side} face`);
    if (typeof f.along !== 'number' || f.along < 0 || f.along > length) throw new Error(`fin #${i}: "along" must be 0..${length} (metres from the back end)`);
    const [foot, top, other] = slope;
    const from = f.from ?? 0.1;
    const to = f.to ?? 0.9;
    if (!(from >= 0 && to <= 1 && to - from > 0.05)) throw new Error(`fin #${i}: "from" and "to" must be fractions up the face, from < to`);
    const rise = f.height ?? 4.5;
    const half = (f.thick ?? 0.4) / 2;
    // Up the face, and out of it (pointing away from the ramp's middle).
    const ux = top[0] - foot[0];
    const uy = top[1] - foot[1];
    const ul = Math.hypot(ux, uy);
    let nx = -uy / ul;
    let ny = ux / ul;
    if (ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    const z0 = length / 2 - f.along;
    // The fin goes on down into the ramp, out of sight, as deep as the ramp is thick there:
    // a portal on it may then reach below the face, round a body riding the ramp.
    const angle = (v: [number, number], a: [number, number], b: [number, number]) => {
      const p = [a[0] - v[0], a[1] - v[1]];
      const q = [b[0] - v[0], b[1] - v[1]];
      return Math.acos((p[0] * q[0] + p[1] * q[1]) / (Math.hypot(p[0], p[1]) * Math.hypot(q[0], q[1])));
    };
    const reach = (s: number, phi: number) => (phi >= Math.PI / 2 - 1e-3 ? Infinity : s * Math.tan(phi));
    const phiFoot = angle(foot, top, other);
    const phiTop = angle(top, foot, other);
    const bury = (t: number) => Math.max(0.05, Math.min(FIN_BURY, reach(t * ul, phiFoot) - 0.05, reach((1 - t) * ul, phiTop) - 0.05));
    const corner = (t: number, out: number, dz: number) => {
      const k = out === 0 ? -bury(t) : rise;
      return local(foot[0] + ux * t + nx * k, foot[1] + uy * t + ny * k, z0 + dz);
    };
    const c = (t: number, out: number, dz: number) => corner(t ? to : from, out, dz);
    // The broad faces' own up: straight out of the ramp, so the opening fits them exactly.
    const up = turn(new THREE.Vector3(nx, ny, 0), rot);
    const takes = f.portal !== false;
    fins.push([
      { points: [c(0, 0, half), c(1, 0, half), c(1, 1, half), c(0, 1, half)], portalable: takes, up },
      { points: [c(0, 0, -half), c(1, 0, -half), c(1, 1, -half), c(0, 1, -half)], portalable: takes, up },
      { points: [c(0, 1, half), c(1, 1, half), c(1, 1, -half), c(0, 1, -half)] },
      { points: [c(0, 0, half), c(1, 0, half), c(1, 0, -half), c(0, 0, -half)] },
      { points: [c(0, 0, half), c(0, 1, half), c(0, 1, -half), c(0, 0, -half)] },
      { points: [c(1, 0, half), c(1, 1, half), c(1, 1, -half), c(1, 0, -half)] },
    ]);
  });
  // The top edge: the ridge, or a one-sided ramp's crest.
  const crest = section.reduce((a, c) => (c[1] > a[1] ? c : a));
  return { ramp, fins, ridge: [at(crest, true).setY(at(crest, true).y + 0.04), at(crest, false).setY(at(crest, false).y + 0.04)] };
}

function register(ctx: BuildContext, p: Piece, t: Triggerable): void {
  if (typeof p.id === 'string' && p.id) ctx.triggerables.set(p.id, t);
}

/** A reference to `id`; a symmetric copy's "~" reference falls back to an unmirrored centre piece. */
function lookup<T>(map: Map<string, T>, id: string): T | undefined {
  return map.get(id) ?? (id.endsWith('~') ? map.get(id.replace(/~+$/, '')) : undefined);
}

const MATERIALS = ['metal', 'panel', 'floor', 'trim', 'hazard', 'surf'];
const SOLID_FIELDS: FieldSpec[] = [
  { key: 'material', label: 'Material', kind: 'select', options: MATERIALS },
  { key: 'portal', label: 'Takes portals', kind: 'faces' },
  { key: 'hide', label: 'Hidden faces', kind: 'faces', hint: 'Faces nobody can see (still solid).' },
];
const FLAT_FIELD: FieldSpec = { key: 'flat', label: 'Lies flat', kind: 'bool', hint: 'across a shaft, flown up through: size = width, thickness, depth' };
const ID_FIELD: FieldSpec = { key: 'id', label: 'Id', kind: 'text', hint: 'Lets a switch set it off.' };
const AUTO_FIELD: FieldSpec = { key: 'auto', label: 'Runs on its own', kind: 'bool', hint: 'Off: only a switch fires it.' };
const MODE_OPTIONS = ['static', 'cycle', 'trigger'] as const;
const EFFECTS = ['trigger', 'portals', 'gravity'] as const;

/** The catalogue. Keys are the `type` names used in map files. */
export const PIECES: Record<string, PieceSpec> = {
  room: {
    label: 'Room shell',
    group: 'Structure',
    help: 'Outer walls, floor and ceiling. at = floor centre.',
    turn: 'none',
    sizeLabels: ['Width (x)', 'Height', 'Depth (z)'],
    defaults: { size: [40, 16, 40], portal: ['walls'] },
    fields: [
      { key: 'portal', label: 'Takes portals', kind: 'sides' },
      { key: 'skip', label: 'Leave out', kind: 'sides', hint: 'Sides you build yourself (e.g. a floor with a pit).' },
    ],
    build(b, p, ctx) {
      const [w, h, d] = p.size!;
      const min = new THREE.Vector3(p.at[0] - w / 2, p.at[1], p.at[2] - d / 2);
      const max = new THREE.Vector3(p.at[0] + w / 2, p.at[1] + h, p.at[2] + d / 2);
      const portalable: Partial<Record<RoomSide, boolean>> = {};
      for (const s of (p.portal as string[] | undefined) ?? []) {
        if (s === 'walls') for (const k of ['north', 'south', 'east', 'west'] as const) portalable[k] = true;
        else portalable[s as RoomSide] = true;
      }
      b.level.room(min, max, { portalable, skip: (p.skip as RoomSide[] | undefined) ?? [] });
      ctx.extent.expandByPoint(min).expandByPoint(max);
    },
  },
  block: {
    label: 'Block',
    group: 'Structure',
    help: 'A solid box. Pick which faces take portals.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Depth'],
    defaults: { size: [2, 2, 2] },
    fields: SOLID_FIELDS,
    build: solid,
  },
  'portal-wall': {
    label: 'Portal wall',
    group: 'Structure',
    help: 'A free-standing wall that takes portals on both faces.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [4, 4, 0.6], portal: ['front', 'back'] },
    fields: SOLID_FIELDS,
    build: solid,
  },
  wall: {
    label: 'Low wall',
    group: 'Structure',
    help: 'Waist-high cover.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [4, 1.2, 0.4] },
    fields: SOLID_FIELDS,
    build: solid,
  },
  glass: {
    label: 'Glass wall',
    group: 'Structure',
    help: 'A see-through pane: solid, but portal shots and beams stop at it, so nothing sticks to it. Keep it thin. at = bottom centre.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [6, 3, 0.15] },
    fields: [{ key: 'tint', label: 'Tint', kind: 'color' }],
    build(b, p, ctx) {
      quarterTurns(p);
      const { min, max } = footprint(p);
      b.glass(min, max, color(p.tint, 0x9fd4ff));
      ctx.extent.expandByPoint(min).expandByPoint(max);
    },
  },
  floor: {
    label: 'Floor slab',
    group: 'Structure',
    help: 'A walkable slab that takes portals on top.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Thickness', 'Depth'],
    defaults: { size: [8, 0.4, 8], portal: ['top'] },
    fields: SOLID_FIELDS,
    build: solid,
  },
  'ceiling-slot': {
    label: 'Ceiling portal slot',
    group: 'Structure',
    help: 'A pale panel hung under a dark ceiling that takes portals. at = on the ceiling.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Thickness', 'Depth'],
    defaults: { size: [4, 0.3, 4] },
    build(b, p, ctx) {
      const t = p.size![1];
      solid(b, { ...p, at: [p.at[0], p.at[1] - t, p.at[2]], portal: ['bottom'], material: 'trim', hide: ['top'] }, ctx);
    },
  },
  stairs: {
    label: 'Stairs',
    group: 'Structure',
    help: 'Climbs toward its front. at = bottom centre of the whole flight.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Rise', 'Run'],
    defaults: { size: [3, 3, 6] },
    build(b, p, ctx) {
      quarterTurns(p);
      const [width, rise, run] = p.size!;
      const dir = front(p.rot ?? 0);
      const base = V(p.at).addScaledVector(dir, -run / 2);
      b.stairs(base, dir, rise, run, width);
      const { min, max } = footprint({ ...p, size: [width, rise, run] });
      ctx.extent.expandByPoint(min).expandByPoint(max);
    },
  },
  slope: {
    label: 'Slope',
    group: 'Structure',
    help: 'A smooth ramp climbing toward its front; the sloping top can take portals. at = bottom centre of the whole ramp. Rise at most 0.8 x run (about 40 degrees) so it can be walked.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Rise', 'Run'],
    defaults: { size: [4, 3, 8], portal: ['top'] },
    fields: [
      { key: 'material', label: 'Material', kind: 'select', options: MATERIALS },
      { key: 'portal', label: 'Takes portals', kind: 'faces', hint: 'Only the slope itself can: list "top".' },
    ],
    build(b, p, ctx) {
      quarterTurns(p);
      const [width, rise, run] = p.size!;
      if (!(width > 0 && rise > 0 && run > 0)) throw new Error('a slope needs a positive width, rise and run');
      if (rise > run * MAX_SLOPE) throw new Error(`a slope may rise at most ${MAX_SLOPE} x its run (about 40 degrees) or it cannot be walked: rise ${rise}, run ${run}`);
      const dir = front(p.rot ?? 0);
      const base = V(p.at).addScaledVector(dir, -run / 2);
      const portalable = faces(p.portal, 0).includes('py');
      b.slope(base, dir, rise, run, width, { portalable, material: str<MaterialName>(p, 'material', 'metal') });
      const { min, max } = footprint({ ...p, size: [width, rise, run] });
      ctx.extent.expandByPoint(min).expandByPoint(max);
    },
  },
  'surf-ramp': {
    label: 'Surf ramp',
    group: 'Structure',
    help: `A steep ridge to slide along: too steep to stand on (at least ${MIN_SURF_ANGLE} degrees), so you surf it - strafe into the face to stay on and gravity keeps you fast. Lies along its front-back axis; the front end can sit lower (drop). at = middle of its base. Turns freely. Fins (a list of { along: metres from the back end, side, height, from, to }) are short walls standing out of a face across the way: they stop you dead, but their faces take portals - shoot one as you slide at it and fly on out of your other portal.`,
    turn: 'free',
    sizeLabels: ['Width', 'Height', 'Length'],
    defaults: { size: [8, 6, 30], sides: 'both', drop: 0, material: 'surf' },
    fields: [
      { key: 'sides', label: 'Sloping sides', kind: 'select', options: ['both', 'left', 'right'], hint: 'left / right: one face, a sheer wall behind it' },
      { key: 'drop', label: 'Front end lower by', kind: 'number', step: 0.5 },
      { key: 'material', label: 'Material', kind: 'select', options: MATERIALS },
      { key: 'portal', label: 'Takes portals', kind: 'faces', hint: 'the sloping faces: "left" and/or "right"' },
    ],
    build(b, p, ctx) {
      const { ramp, fins, ridge } = surfRamp(p);
      const bed = b.level.polyhedron(ramp, { material: str<MaterialName>(p, 'material', 'surf'), slick: true });
      bed.slideAxis = ridge[1].clone().sub(ridge[0]).normalize();
      // A glowing line along the top, so a ramp reads from far off and at speed.
      addLightStrip(b.level, ridge[0], ridge[1], 0x6fd8ff, 1.4);
      ctx.extent.expandByPoint(bed.min).expandByPoint(bed.max);
      for (const polys of fins) {
        // Fins are slick too (nothing on a ramp is somewhere to stand), and a portal on one
        // may reach into the ramp under it.
        const fin = b.level.polyhedron(polys, { material: 'metal', slick: true });
        fin.clearOf = [bed.collider.handle];
      }
    },
  },
  acid: {
    label: 'Acid pool',
    group: 'Hazards',
    help: 'Deadly liquid. at = centre of the surface.',
    turn: 'quarter',
    sizeLabels: ['Width', '-', 'Depth'],
    defaults: { size: [6, 0, 6] },
    build(b, p) {
      const { min, max } = footprint(p);
      b.acid(new THREE.Vector2(min.x, min.z), new THREE.Vector2(max.x, max.z), p.at[1]);
    },
  },
  spikes: {
    label: 'Spikes',
    group: 'Hazards',
    help: 'A spike bed set into the floor. at = floor surface centre.',
    turn: 'quarter',
    sizeLabels: ['Width', '-', 'Depth'],
    defaults: { size: [4, 0, 4], mode: 'cycle', rest: 3 },
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: [...MODE_OPTIONS] },
      { key: 'rest', label: 'Down for (s)', kind: 'number', step: 0.1 },
      { key: 'offset', label: 'Offset (s)', kind: 'number', step: 0.1 },
      ID_FIELD,
    ],
    build(b, p, ctx) {
      const { min, max } = footprint(p);
      const s = b.spikes({
        center: V(p.at),
        size: new THREE.Vector2(max.x - min.x, max.z - min.z),
        mode: oneOf(p, 'mode', MODE_OPTIONS, 'cycle'),
        rest: num(p, 'rest', 3),
        offset: num(p, 'offset', 0),
      });
      register(ctx, p, s);
    },
  },
  trapdoor: {
    label: 'Trapdoor',
    group: 'Hazards',
    help: 'Floor that drops open. Leave a hole under it. at = top surface centre.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Thickness', 'Depth'],
    defaults: { size: [4, 0.4, 4], mode: 'trigger', open: 2.5 },
    fields: [
      { key: 'mode', label: 'Mode', kind: 'select', options: ['cycle', 'trigger'] },
      { key: 'open', label: 'Open for (s)', kind: 'number', step: 0.1 },
      { key: 'rest', label: 'Shut for (s)', kind: 'number', step: 0.1, hint: 'cycle mode' },
      { key: 'offset', label: 'Offset (s)', kind: 'number', step: 0.1 },
      ID_FIELD,
    ],
    build(b, p, ctx) {
      const { min, max } = footprint(p);
      const t = b.trapdoor({
        center: V(p.at),
        size: new THREE.Vector3(max.x - min.x, p.size![1], max.z - min.z),
        mode: oneOf(p, 'mode', ['cycle', 'trigger'] as const, 'trigger'),
        open: num(p, 'open', 2.5),
        rest: num(p, 'rest', 4),
        offset: num(p, 'offset', 0),
      });
      register(ctx, p, t);
    },
  },
  crusher: {
    label: 'Crusher',
    group: 'Hazards',
    help: 'Slams down onto the floor. at = floor centre; height = how high it rests.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Drop height', 'Depth'],
    defaults: { size: [3, 5, 3] },
    fields: [
      { key: 'upTime', label: 'Up for (s)', kind: 'number', step: 0.1 },
      { key: 'offset', label: 'Offset (s)', kind: 'number', step: 0.1 },
      AUTO_FIELD,
      ID_FIELD,
    ],
    build(b, p, ctx) {
      const { min, max } = footprint(p);
      const c = b.crusher(
        p.at[0],
        p.at[2],
        new THREE.Vector2(max.x - min.x, max.z - min.z),
        p.at[1],
        p.at[1] + p.size![1],
        num(p, 'upTime', 1.8),
        num(p, 'offset', 0),
        p.auto !== false,
      );
      register(ctx, p, c);
    },
  },
  ram: {
    label: 'Ram',
    group: 'Hazards',
    help: 'Wall-mounted; punches toward its front and throws players. at = wall mount centre.',
    turn: 'free',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [2.4, 1.6, 0.5], reach: 3, rest: 3 },
    fields: [
      { key: 'reach', label: 'Reach', kind: 'number', step: 0.1 },
      { key: 'rest', label: 'Rest (s)', kind: 'number', step: 0.1 },
      { key: 'offset', label: 'Offset (s)', kind: 'number', step: 0.1 },
      { key: 'floor', label: 'Floor height', kind: 'number', step: 0.1, hint: 'For the warning chevrons; empty = none.' },
      { key: 'stripe', label: 'Chevron length', kind: 'number', step: 0.1 },
      AUTO_FIELD,
      ID_FIELD,
    ],
    build(b, p, ctx) {
      const r = b.ram({
        mount: V(p.at),
        facing: front(p.rot ?? 0),
        size: V(p.size!),
        reach: num(p, 'reach', 3),
        rest: num(p, 'rest', 3),
        offset: num(p, 'offset', 0),
        floorY: optNum(p, 'floor'),
        stripe: optNum(p, 'stripe'),
        auto: p.auto !== false,
      });
      register(ctx, p, r);
    },
  },
  laser: {
    label: 'Laser',
    group: 'Hazards',
    help: 'Burns; bends through portals. Fires toward its front.',
    turn: 'free',
    fields: [
      { key: 'pitch', label: 'Pitch (deg)', kind: 'number', step: 1 },
      { key: 'sweep', label: 'Sweep (deg)', kind: 'number', step: 1, hint: '0 = fixed' },
      { key: 'period', label: 'Sweep period (s)', kind: 'number', step: 0.1 },
    ],
    build(b, p) {
      const pitch = rad(num(p, 'pitch', 0));
      const dir = front(p.rot ?? 0).multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
      const sweep = num(p, 'sweep', 0);
      b.laser(V(p.at), dir, sweep ? { axis: new THREE.Vector3(0, 1, 0), angle: rad(sweep), period: num(p, 'period', 6) } : undefined);
    },
  },
  platform: {
    label: 'Moving platform',
    group: 'Hazards',
    help: 'Shuttles between at and to (centres).',
    turn: 'quarter',
    sizeLabels: ['Width', 'Thickness', 'Depth'],
    defaults: { size: [3, 0.4, 3] },
    fields: [
      { key: 'to', label: 'Moves to', kind: 'vec3' },
      { key: 'speed', label: 'Speed', kind: 'number', step: 0.1 },
      { key: 'pause', label: 'Pause (s)', kind: 'number', step: 0.1 },
    ],
    build(b, p) {
      const to = (p.to as Vec3 | undefined) ?? [p.at[0], p.at[1], p.at[2] - 8];
      const { min, max } = footprint(p);
      b.platform(max.clone().sub(min), V(p.at), V(to), num(p, 'speed', 2.6), num(p, 'pause', 1.6));
    },
  },
  dropper: {
    label: 'Crate dropper',
    group: 'Hazards',
    help: 'Drops a crate after a warning blink. Switched off auto, it holds its crate until a switch sets it off (a cube dispenser). at = drop point.',
    turn: 'none',
    fields: [{ key: 'ceiling', label: 'Ceiling height', kind: 'number', step: 0.1 }, AUTO_FIELD, ID_FIELD],
    build(b, p, ctx) {
      register(ctx, p, b.dropper(V(p.at), num(p, 'ceiling', p.at[1] + 1), p.auto !== false));
    },
  },
  switch: {
    label: 'Switch',
    group: 'Interactive',
    help: 'Shoot it to set it off. at = centre of the wall it hangs on; faces its front.',
    turn: 'free',
    defaults: { effect: 'trigger', cooldown: 10 },
    fields: [
      { key: 'effect', label: 'Effect', kind: 'select', options: [...EFFECTS] },
      { key: 'targets', label: 'Sets off (ids)', kind: 'ids', hint: 'trigger: comma-separated hazard ids' },
      { key: 'cooldown', label: 'Cooldown (s)', kind: 'number', step: 0.5 },
      { key: 'factor', label: 'Gravity ×', kind: 'number', step: 0.1, hint: 'gravity' },
      { key: 'duration', label: 'Lasts (s)', kind: 'number', step: 0.5, hint: 'gravity' },
    ],
    build(b, p, ctx) {
      const sw = b.switch({
        mount: V(p.at),
        facing: front(p.rot ?? 0),
        effect: oneOf(p, 'effect', EFFECTS, 'trigger'),
        cooldown: num(p, 'cooldown', 10),
        factor: num(p, 'factor', 1.8),
        duration: num(p, 'duration', 8),
      });
      const ids = (p.targets as string[] | undefined) ?? [];
      ctx.later.push(() => {
        sw.setTargets(
          ids.map((id) => {
            const t = lookup(ctx.triggerables, id);
            if (!t) throw new Error(`switch at [${p.at.join(', ')}]: nothing with id "${id}"`);
            return t;
          }),
        );
      });
    },
  },
  receiver: {
    label: 'Laser receiver',
    group: 'Interactive',
    help: 'Lit by a laser, it opens doors. Faces its front.',
    turn: 'free',
    defaults: { id: 'receiver' },
    fields: [{ key: 'id', label: 'Id', kind: 'text' }],
    build(b, p, ctx) {
      ctx.receivers.set(str(p, 'id'), b.receiver(V(p.at), front(p.rot ?? 0)));
    },
  },
  button: {
    label: 'Floor button',
    group: 'Interactive',
    help: 'A pressure pad set into the floor, held down by a crate (or a player). Opens the doors that name its id. at = floor surface centre.',
    turn: 'quarter',
    sizeLabels: ['Width', '-', 'Depth'],
    defaults: { size: [2.4, 0, 2.4], id: 'button', needs: 'any' },
    fields: [
      { key: 'id', label: 'Id', kind: 'text', hint: 'a door names this as its receiver' },
      { key: 'needs', label: 'Held down by', kind: 'select', options: ['any', 'crate'], hint: 'any: crate or player; crate: only a crate' },
      { key: 'hold', label: 'Stays on (s)', kind: 'number', step: 0.5, hint: 'after being let go; 0 = not at all' },
    ],
    build(b, p, ctx) {
      quarterTurns(p);
      const { min, max } = footprint(p);
      const button = b.button({
        center: V(p.at),
        size: new THREE.Vector2(max.x - min.x, max.z - min.z),
        needs: oneOf(p, 'needs', ['any', 'crate'] as const, 'any'),
        hold: num(p, 'hold', 0),
      });
      ctx.receivers.set(str(p, 'id'), button);
      ctx.extent.expandByPoint(min).expandByPoint(max);
    },
  },
  'jump-pad': {
    label: 'Jump pad',
    group: 'Interactive',
    help: 'A plate in the floor that throws whoever steps on it, and any crate that lands on it, along an arc to the "to" point (a floor spot). at = floor surface centre.',
    turn: 'quarter',
    sizeLabels: ['Width', '-', 'Depth'],
    defaults: { size: [2.4, 0, 2.4], apex: 3 },
    fields: [
      { key: 'to', label: 'Lands at', kind: 'vec3', hint: 'the floor point the throw comes down on' },
      { key: 'apex', label: 'Arc height', kind: 'number', step: 0.5, hint: 'metres above the higher end of the throw' },
    ],
    build(b, p, ctx) {
      quarterTurns(p);
      const { min, max } = footprint(p);
      const to = (p.to as Vec3 | undefined) ?? [p.at[0], p.at[1], p.at[2] - 12];
      b.jumpPad({ center: V(p.at), size: new THREE.Vector2(max.x - min.x, max.z - min.z), target: V(to), apex: num(p, 'apex', 3) });
      ctx.extent.expandByPoint(min).expandByPoint(max).expandByPoint(V(to));
    },
  },
  door: {
    label: 'Door',
    group: 'Interactive',
    help: 'Open while its receiver is lit or its floor button is held down.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [4, 3.6, 0.6], receiver: 'receiver' },
    fields: [{ key: 'receiver', label: 'Receiver / button id', kind: 'text', hint: 'the id of a laser receiver or a floor button' }],
    build(b, p, ctx) {
      const id = str(p, 'receiver');
      const { min, max } = footprint(p);
      ctx.later.push(() => {
        const r = lookup(ctx.receivers, id);
        if (!r) throw new Error(`door at [${p.at.join(', ')}]: no receiver or button with id "${id}"`);
        b.door(min, max, r);
      });
    },
  },
  target: {
    label: 'Laser target mark',
    group: 'Interactive',
    help: 'A painted ring on a wall, facing its front.',
    turn: 'free',
    fields: [{ key: 'radius', label: 'Size', kind: 'number', step: 0.1 }],
    build(b, p) {
      b.target(V(p.at), front(p.rot ?? 0), num(p, 'radius', 1.3));
    },
  },
  crate: {
    label: 'Crate',
    group: 'Interactive',
    help: 'A loose crate. at = its centre.',
    turn: 'none',
    build(b, p) {
      b.prop(V(p.at));
    },
  },
  spawn: {
    label: 'Spawn point',
    group: 'Markers',
    help: 'at = floor under the feet; faces its front.',
    turn: 'free',
    defaults: { team: 'orange' },
    fields: [{ key: 'team', label: 'Team', kind: 'select', options: ['orange', 'blue'] }],
    build(_b, p, ctx) {
      ctx.spawns.push({ feet: V(p.at), yaw: rad(p.rot ?? 0), team: (p.team as Team | undefined) ?? null });
    },
  },
  checkpoint: {
    label: 'Checkpoint gate',
    group: 'Markers',
    help: 'Speedrun maps: a gate to pass through, in the order checkpoints are listed. Records a split, and a fall brings you back here. at = bottom centre of the opening; faces its front (the way the run goes).',
    turn: 'free',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [8, 5, 1] },
    fields: [{ key: 'respawn', label: 'Respawn at', kind: 'vec3', hint: 'floor point to come back on; empty = the gate itself' }, FLAT_FIELD],
    build(b, p, ctx) {
      if (ctx.kind !== 'speedrun') return;
      const yaw = rad(p.rot ?? 0);
      const feet = Array.isArray(p.respawn) ? V(p.respawn as Vec3) : V(p.at);
      b.gate('checkpoint', V(p.at), V(p.size!), yaw, { feet, yaw }, p.flat === true);
      ctx.extent.expandByPoint(V(p.at));
    },
  },
  finish: {
    label: 'Finish gate',
    group: 'Markers',
    help: 'Speedrun maps: flying through it (after every checkpoint) stops the clock. One per map. at = bottom centre of the opening.',
    turn: 'free',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [8, 6, 1] },
    fields: [FLAT_FIELD],
    build(b, p, ctx) {
      if (ctx.kind !== 'speedrun') return;
      b.gate('finish', V(p.at), V(p.size!), rad(p.rot ?? 0), undefined, p.flat === true);
      ctx.extent.expandByPoint(V(p.at));
    },
  },
  fizzler: {
    label: 'Fizzler',
    group: 'Interactive',
    help: 'An emancipation field: walk through it freely, but portal shots stop at it and your portals close as you pass. Span a whole corridor with it so each section needs portals of its own. at = bottom centre.',
    turn: 'free',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [8, 5, 0.4] },
    fields: [FLAT_FIELD],
    build(b, p, ctx) {
      b.gate('fizzler', V(p.at), V(p.size!), rad(p.rot ?? 0), undefined, p.flat === true);
      ctx.extent.expandByPoint(V(p.at));
    },
  },
  goal: {
    label: 'Exit goal',
    group: 'Markers',
    help: 'Puzzle maps: stepping on it ends the level (one per map). Ignored in combat maps. at = floor centre.',
    turn: 'none',
    build(b, p, ctx) {
      if (ctx.kind !== 'puzzle') return;
      if (b.goal) throw new Error('a puzzle map has one exit goal; remove the extra one');
      b.setGoal(V(p.at));
      ctx.extent.expandByPoint(V(p.at)).expandByPoint(V(p.at).setY(p.at[1] + 4));
    },
  },
  lights: {
    label: 'Ceiling lights',
    group: 'Markers',
    help: 'Rows of light strips over an area. at = centre, on the ceiling.',
    turn: 'none',
    sizeLabels: ['Width', '-', 'Depth'],
    defaults: { size: [20, 0, 20], spacing: 6 },
    fields: [
      { key: 'spacing', label: 'Row spacing', kind: 'number', step: 0.5 },
      { key: 'color', label: 'Colour', kind: 'color' },
    ],
    build(b, p) {
      const { min, max } = footprint(p);
      b.ceilingLights(new THREE.Vector2(min.x, min.z), new THREE.Vector2(max.x, max.z), p.at[1], num(p, 'spacing', 6), color(p.color, 0xdfe8ff));
    },
  },
  strip: {
    label: 'Light strip',
    group: 'Markers',
    help: 'A glowing line. at = its centre; runs across the piece.',
    turn: 'free',
    sizeLabels: ['Length', '-', '-'],
    defaults: { size: [6, 0, 0] },
    fields: [
      { key: 'team', label: 'Team colour', kind: 'select', options: ['', 'orange', 'blue'] },
      { key: 'color', label: 'Colour', kind: 'color' },
    ],
    build(b, p) {
      const half = turn(new THREE.Vector3(1, 0, 0), p.rot ?? 0).multiplyScalar(p.size![0] / 2);
      const team = p.team as Team | undefined;
      const c = team ? TEAM_COLORS[team] : color(p.color, 0xdfe8ff);
      addLightStrip(b.level, V(p.at).sub(half), V(p.at).add(half), c);
    },
  },
};

const flipRef = (id: string) => (id.endsWith('~') ? id.slice(0, -1) : `${id}~`);

/** The half-turn copy of a piece for `symmetry: "rotate180"`. */
export function rotated(p: Piece): Piece {
  const q: Piece = { ...p, at: [-p.at[0], p.at[1], -p.at[2]], rot: ((p.rot ?? 0) + 180) % 360 };
  if (Array.isArray(p.to)) q.to = [-p.to[0], p.to[1], -p.to[2]];
  if (p.team === 'orange') q.team = 'blue';
  else if (p.team === 'blue') q.team = 'orange';
  if (typeof p.id === 'string' && p.id) q.id = `${p.id}~`;
  if (typeof p.receiver === 'string') q.receiver = flipRef(p.receiver);
  if (Array.isArray(p.targets)) q.targets = (p.targets as string[]).map(flipRef);
  return q;
}

/** A piece with the catalogue's defaults filled in. */
export function withDefaults(raw: Piece): Piece {
  return { ...PIECES[raw.type]?.defaults, ...raw };
}

export const mapKind = (data: MapData): MapKind => data.kind ?? 'combat';

/** Why a puzzle or speedrun map can't be played in an online room. */
export const soloMapMessage = (data: MapData): string =>
  `${mapKind(data) === 'speedrun' ? 'Speedrun' : 'Puzzle'} maps are single-player; online rooms play combat maps.`;

/** Whether the map mirrors its pieces with a half turn (puzzles and speedruns are one player's, never mirrored). */
export const isSymmetric = (data: MapData): boolean => data.symmetry === 'rotate180' && mapKind(data) === 'combat';

/** Every piece the map places, with catalogue defaults filled in and symmetry applied. */
export function expandPieces(data: MapData): Piece[] {
  const out: Piece[] = [];
  data.pieces.forEach((raw, i) => {
    const spec = PIECES[raw.type];
    const where = `map "${data.id}", piece #${i} (${raw.type})`;
    if (!spec) throw new Error(`${where}: unknown piece type (known: ${Object.keys(PIECES).join(', ')})`);
    if (!Array.isArray(raw.at) || raw.at.length !== 3) throw new Error(`${where}: "at" must be [x, y, z]`);
    const p = withDefaults(raw);
    out.push(p);
    if (isSymmetric(data) && !p.center) out.push(rotated(p));
  });
  return out;
}

export function mapToArena(data: MapData): ArenaDef {
  return {
    id: data.id,
    name: data.name,
    hint: data.hint,
    blurb: data.blurb,
    kind: mapKind(data),
    build(b) {
      const kind = mapKind(data);
      if (kind !== 'combat' && kind !== 'puzzle' && kind !== 'speedrun') throw new Error(`map "${data.id}": kind must be "combat", "puzzle" or "speedrun", got ${JSON.stringify(data.kind)}`);
      const ctx: BuildContext = { kind, receivers: new Map(), triggerables: new Map(), spawns: [], extent: new THREE.Box3(), later: [] };
      for (const p of expandPieces(data)) {
        try {
          PIECES[p.type].build(b, p, ctx);
        } catch (e) {
          throw new Error(`map "${data.id}", ${p.type} at [${p.at.join(', ')}]: ${(e as Error).message}`);
        }
      }
      for (const wire of ctx.later) wire();
      if (kind === 'puzzle' && !b.goal) throw new Error(`puzzle map "${data.id}" has no exit goal, so it can't be finished`);
      if (kind === 'speedrun' && !b.finish) throw new Error(`speedrun map "${data.id}" has no finish gate, so the clock never stops`);

      // The player starts on the first orange spawn (or the first spawn); the rest get pads.
      const main = ctx.spawns.find((s) => s.team === 'orange') ?? ctx.spawns[0];
      if (!main) throw new Error(`map "${data.id}" has no spawn point`);
      for (const s of ctx.spawns) {
        const centre = s.feet.clone().setY(s.feet.y + PLAYER_FEET_OFFSET + 0.02);
        if (s === main) b.setSpawn(centre, s.yaw, s.team);
        else b.addSpawn(centre, s.yaw, s.team);
      }
      if (data.fog) b.fog = { color: color(data.fog.color, 0x0b0e14), near: data.fog.near, far: data.fog.far };
      if (data.killY !== undefined) b.killY = data.killY;
      if (data.portalRange !== undefined) b.level.portalRange = data.portalRange;
      if (!ctx.extent.isEmpty()) b.bounds.copy(ctx.extent).expandByScalar(1);
    },
  };
}
