import * as THREE from 'three';
import type { ArenaBuilder, ArenaDef } from '../ArenaBuilder';
import type { FaceKey, RoomSide } from '../Level';
import type { MaterialName } from '../Materials';
import { addLightStrip } from '../Markers';
import type { LaserReceiver } from '../hazards/Laser';
import type { Triggerable } from '../hazards/Hazard';
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
 *    name their `receiver`. In a symmetric map the copy of a piece gets its id with "~"
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

export interface MapData {
  id: string;
  name: string;
  hint: string;
  blurb?: string;
  symmetry?: 'none' | 'rotate180';
  fog?: { color: string; near: number; far: number };
  /** Anything falling below this dies. */
  killY?: number;
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
  receivers: Map<string, LaserReceiver>;
  triggerables: Map<string, Triggerable>;
  spawns: { feet: THREE.Vector3; yaw: number; team: Team | null }[];
  extent: THREE.Box3;
  /** Wiring that waits until every piece exists (doors, switches). */
  later: (() => void)[];
}

export const TEAM_COLORS: Record<Team, number> = { orange: 0xff8a3a, blue: 0x3ab0ff };

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

function register(ctx: BuildContext, p: Piece, t: Triggerable): void {
  if (typeof p.id === 'string' && p.id) ctx.triggerables.set(p.id, t);
}

/** A reference to `id`; a symmetric copy's "~" reference falls back to an unmirrored centre piece. */
function lookup<T>(map: Map<string, T>, id: string): T | undefined {
  return map.get(id) ?? (id.endsWith('~') ? map.get(id.replace(/~+$/, '')) : undefined);
}

const SOLID_FIELDS: FieldSpec[] = [
  { key: 'material', label: 'Material', kind: 'select', options: ['metal', 'panel', 'floor', 'trim', 'hazard'] },
  { key: 'portal', label: 'Takes portals', kind: 'faces' },
  { key: 'hide', label: 'Hidden faces', kind: 'faces', hint: 'Faces nobody can see (still solid).' },
];
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
    help: 'Drops a crate after a warning blink. at = drop point.',
    turn: 'none',
    fields: [{ key: 'ceiling', label: 'Ceiling height', kind: 'number', step: 0.1 }],
    build(b, p) {
      b.dropper(V(p.at), num(p, 'ceiling', p.at[1] + 1));
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
  door: {
    label: 'Door',
    group: 'Interactive',
    help: 'Open while its receiver is lit.',
    turn: 'quarter',
    sizeLabels: ['Width', 'Height', 'Thickness'],
    defaults: { size: [4, 3.6, 0.6], receiver: 'receiver' },
    fields: [{ key: 'receiver', label: 'Receiver id', kind: 'text' }],
    build(b, p, ctx) {
      const id = str(p, 'receiver');
      const { min, max } = footprint(p);
      ctx.later.push(() => {
        const r = lookup(ctx.receivers, id);
        if (!r) throw new Error(`door at [${p.at.join(', ')}]: no receiver with id "${id}"`);
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
  goal: {
    label: 'Exit goal',
    group: 'Markers',
    help: 'Tutorial-style exit. at = floor centre.',
    turn: 'none',
    build(b, p) {
      b.setGoal(V(p.at));
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
    if (data.symmetry === 'rotate180' && !p.center) out.push(rotated(p));
  });
  return out;
}

export function mapToArena(data: MapData): ArenaDef {
  return {
    id: data.id,
    name: data.name,
    hint: data.hint,
    blurb: data.blurb,
    build(b) {
      const ctx: BuildContext = { receivers: new Map(), triggerables: new Map(), spawns: [], extent: new THREE.Box3(), later: [] };
      for (const p of expandPieces(data)) {
        try {
          PIECES[p.type].build(b, p, ctx);
        } catch (e) {
          throw new Error(`map "${data.id}", ${p.type} at [${p.at.join(', ')}]: ${(e as Error).message}`);
        }
      }
      for (const wire of ctx.later) wire();

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
      if (!ctx.extent.isEmpty()) b.bounds.copy(ctx.extent).expandByScalar(1);
    },
  };
}
