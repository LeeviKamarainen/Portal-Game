import { ArenaSim } from '../../src/sim/ArenaSim';
import { checkMap, mapProblem } from '../../src/room/mapCheck';
import { FACE_NAMES, PIECES, ROOM_SIDES, expandPieces, faces, footprint, isSymmetric, mapKind, mapToArena, withDefaults, type FieldSpec, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';
import { slug } from './wire';

/**
 * Everything about a generated map that needs no model: tidy what is plainly sloppy
 * (`autofix`), find what is wrong with a reason a model can act on (`lint`, whose messages
 * carry coordinates), and prove the map builds the way the game will build it (`buildCheck`).
 * `checkGenerated` runs the three in order. The messages are written to be pasted into a
 * repair prompt.
 */

const NAME_MAX = 40;
const HINT_MAX = 500;
const BLURB_MAX = 100;
const LIMIT = 500; // no coordinate or size beyond this is sane
const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_FOG = { color: '#0b0e14', near: 30, far: 150 };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const r2 = (n: number) => Math.round(n * 100) / 100;
const fmt = (v: ArrayLike<number>) => `[${Array.from(v).map(r2).join(', ')}]`;
/** Text that ends up on other players' screens: no markup, no control characters. */
const clean = (s: unknown, max: number) => String(s ?? '').replace(/[<>\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const KEPT_KEYS = new Set(['type', 'at', 'size', 'rot', 'center']);
/** The hazards a switch can set off (the ones that take an id). */
const TARGETABLE = ['spikes', 'trapdoor', 'crusher', 'ram'];

export interface AutofixResult {
  map: MapData;
  fixes: string[];
}

/** Tidies a map without guessing: rounding, clamping to legal values, dropping what the game ignores. */
export function autofix(input: MapData): AutofixResult {
  const map = structuredClone(input);
  const fixes: string[] = [];
  const note = (s: string) => fixes.push(s);

  const name = clean(map.name, NAME_MAX) || 'Untitled map';
  if (name !== map.name) note('tidied the name');
  map.name = name;
  const hint = clean(map.hint, HINT_MAX);
  if (hint !== map.hint) note('tidied the hint');
  map.hint = hint;
  if (map.blurb !== undefined) {
    const blurb = clean(map.blurb, BLURB_MAX);
    if (blurb !== map.blurb) note('tidied the blurb');
    if (blurb) map.blurb = blurb;
    else delete map.blurb;
  }
  if (typeof map.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(map.id)) {
    map.id = `${slug(map.name)}-${Math.random().toString(36).slice(2, 6)}`;
    note('made a valid map id');
  }
  if (map.kind !== 'combat' && map.kind !== 'puzzle') {
    map.kind = 'combat';
    note('kind was not combat or puzzle; set combat');
  }
  if (map.kind === 'puzzle' && map.symmetry && map.symmetry !== 'none') {
    map.symmetry = 'none';
    note('puzzles are not mirrored; set symmetry none');
  }
  if (!isNum(map.killY)) {
    map.killY = -6;
    note('killY was not a number; set -6');
  }
  const fog = map.fog;
  if (!fog || typeof fog.color !== 'string' || !COLOR.test(fog.color) || !isNum(fog.near) || !isNum(fog.far) || fog.near < 0 || fog.far <= fog.near) {
    map.fog = { ...DEFAULT_FOG };
    note('fog was not valid; used the default fog');
  }

  if (!Array.isArray(map.pieces)) return { map, fixes };
  map.pieces = map.pieces.filter((p) => p && typeof p === 'object');
  let hiddenFaces = 0;
  map.pieces.forEach((p, i) => {
    const spec = PIECES[p.type];
    const where = `piece #${i} (${p.type})`;
    if (!spec) return; // lint reports it
    for (const key of Object.keys(p)) {
      if (KEPT_KEYS.has(key) || (spec.fields ?? []).some((f) => f.key === key)) continue;
      delete p[key];
      note(`${where}: dropped unknown parameter "${key}"`);
    }
    for (const key of ['at', 'size'] as const) {
      const v = p[key];
      if (Array.isArray(v) && v.every(isNum) && v.some((n) => n !== r2(n))) p[key] = v.map(r2) as Vec3;
    }
    if (isNum(p.rot)) {
      let rot = r2(((p.rot % 360) + 360) % 360);
      if (spec.turn === 'quarter') {
        const snapped = (Math.round(rot / 90) * 90) % 360;
        if (snapped !== rot) note(`${where}: rot ${rot} snapped to ${snapped} (it turns in 90 degree steps)`);
        rot = snapped;
      } else if (spec.turn === 'none' && rot !== 0) {
        note(`${where}: rot ignored for this piece; set 0`);
        rot = 0;
      }
      if (rot === 0) delete p.rot;
      else p.rot = rot;
    }
    if (p.center === false) delete p.center;
    // "Hidden faces" is for hand-built maps. Generated ones used it on the undersides of floating
    // blocks, which then show nothing from below, so every face is drawn.
    if (p.hide !== undefined) {
      delete p.hide;
      hiddenFaces++;
    }
    if (p.type === 'dropper' && isVec3(p.at) && isNum(p.ceiling) && p.ceiling <= p.at[1]) {
      note(`${where}: ceiling ${p.ceiling} was not above the drop point; set ${r2(p.at[1] + 1)}`);
      p.ceiling = r2(p.at[1] + 1);
    }
  });

  if (hiddenFaces) note(`showed the hidden faces of ${hiddenFaces} piece${hiddenFaces === 1 ? '' : 's'} (platform undersides must be drawn)`);

  // A switch can only set off hazards that exist; drop the ids that point at nothing, and a
  // trigger switch left with no target does nothing at all, so it goes too.
  const targetable = new Set(map.pieces.filter((p) => TARGETABLE.includes(p.type) && typeof p.id === 'string' && p.id).map((p) => p.id as string));
  const reachable = (id: string) => targetable.has(id) || targetable.has(id.replace(/~+$/, ''));
  const dropped = new Set<number>();
  map.pieces.forEach((p, i) => {
    if (p.type !== 'switch' || !Array.isArray(p.targets)) return;
    const kept = (p.targets as unknown[]).filter((t): t is string => typeof t === 'string' && reachable(t));
    if (kept.length === (p.targets as unknown[]).length) return;
    note(`piece #${i} (switch): removed target${(p.targets as unknown[]).length - kept.length === 1 ? '' : 's'} that no spikes, trapdoor, crusher or ram has as id`);
    if (kept.length === 0 && (p.effect ?? 'trigger') === 'trigger') {
      dropped.add(i);
      note(`piece #${i} (switch): removed, it had nothing left to set off`);
    } else p.targets = kept;
  });
  if (dropped.size) map.pieces = map.pieces.filter((_, i) => !dropped.has(i));

  const room = map.pieces.find((p) => p.type === 'room');
  if (room && isVec3(room.at) && !map.pieces.some((p) => p.type === 'lights')) {
    const [w, h, d] = withDefaults(room).size as Vec3;
    map.pieces.splice(1, 0, { type: 'lights', at: [room.at[0], room.at[1] + h, room.at[2]], size: [w, 0, d], center: true });
    note('added ceiling lights (the map had none)');
  }
  return { map, fixes };
}

/** A box a player can stand on or run into, from the placed pieces. */
export interface Solid {
  type: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  bottom: number;
  top: number;
  stairs: boolean;
}

export const inside = (s: Solid, x: number, z: number) => x >= s.minX - 1e-6 && x <= s.maxX + 1e-6 && z >= s.minZ - 1e-6 && z <= s.maxZ + 1e-6;

function fieldProblem(f: FieldSpec, v: unknown): string | null {
  switch (f.kind) {
    case 'number': return isNum(v) ? null : 'must be a number';
    case 'bool': return typeof v === 'boolean' ? null : 'must be true or false';
    case 'text': return typeof v === 'string' ? null : 'must be text';
    case 'color': return typeof v === 'string' && COLOR.test(v) ? null : 'must be a colour "#rrggbb"';
    case 'select': return typeof v === 'string' && (f.options ?? []).includes(v) ? null : `must be one of ${(f.options ?? []).map((o) => o || '(empty)').join(', ')}`;
    case 'vec3': return isVec3(v) ? null : 'must be three numbers [x, y, z]';
    case 'ids': return Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'must be a list of ids';
    case 'faces': {
      const ok = [...FACE_NAMES, 'sides', 'all'] as string[];
      return Array.isArray(v) && v.every((x) => ok.includes(x)) ? null : `must be a list of ${ok.join(', ')}`;
    }
    case 'sides': {
      const ok = [...ROOM_SIDES, 'walls'] as string[];
      return Array.isArray(v) && v.every((x) => ok.includes(x)) ? null : `must be a list of ${ok.join(', ')}`;
    }
  }
}

/** The floors and blocks a player can stand on or run into, from the placed (symmetry-expanded) pieces. */
export function solidsOf(map: MapData, placed: Piece[]): Solid[] {
  const solids: Solid[] = [];
  const roomPiece = map.pieces.find((p) => p.type === 'room');
  if (roomPiece && isVec3(roomPiece.at)) {
    const r = withDefaults(roomPiece);
    if (isVec3(r.size) && !(r.skip as string[] | undefined)?.includes('floor'))
      solids.push({ type: 'room floor', minX: r.at[0] - r.size[0] / 2, maxX: r.at[0] + r.size[0] / 2, minZ: r.at[2] - r.size[2] / 2, maxZ: r.at[2] + r.size[2] / 2, bottom: r.at[1] - 1, top: r.at[1], stairs: false });
  }
  for (const p of placed) {
    if (!['block', 'portal-wall', 'wall', 'floor', 'stairs'].includes(p.type) || !isVec3(p.size) || (p.rot ?? 0) % 90 !== 0) continue;
    const { min, max } = footprint(p);
    solids.push({ type: p.type, minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, bottom: min.y, top: max.y, stairs: p.type === 'stairs' });
  }
  return solids;
}


/** A portal wall whose base is off the ground beside it by more than this (and at most MAX_WALL_SNAP) is a mistake. */
const WALL_FLUSH = 0.02;
const MAX_WALL_SNAP = 1.5;

interface WallLevels {
  base: number;
  top: number;
  /** The ground beside each of the two faces (null: none, or far below), in `sides` order. */
  floors: (number | null)[];
  sides: [string, string];
  /** The world face of each side, in the same order (nx/px for walls along z, nz/pz for walls along x). */
  keys: [string, string];
}

/**
 * The ground level on each side of a free-standing wall, measured just beside its faces at a
 * few points along it. Only surfaces below the wall's top count, so a tall block next to it
 * is not mistaken for ground.
 */
function wallLevels(p: Piece, solids: Solid[]): WallLevels {
  const { min, max } = footprint(p);
  const alongX = max.x - min.x >= max.z - min.z;
  const len = alongX ? max.x - min.x : max.z - min.z;
  const cx = (min.x + max.x) / 2;
  const cz = (min.z + max.z) / 2;
  const same = (s: Solid) =>
    Math.abs(s.minX - min.x) < 1e-6 && Math.abs(s.maxX - max.x) < 1e-6 && Math.abs(s.minZ - min.z) < 1e-6 && Math.abs(s.maxZ - max.z) < 1e-6 && Math.abs(s.bottom - min.y) < 1e-6;
  const fractions = len < 3 ? [0] : [-0.35, 0, 0.35];
  const floors: (number | null)[] = [];
  for (const sign of [-1, 1]) {
    let best: number | null = null;
    for (const f of fractions)
      for (const out of [0.4, 1.0]) {
        const x = alongX ? cx + f * len : (sign < 0 ? min.x : max.x) + sign * out;
        const z = alongX ? (sign < 0 ? min.z : max.z) + sign * out : cz + f * len;
        for (const s of solids) if (!s.stairs && !same(s) && inside(s, x, z) && s.top <= max.y - 0.5) best = Math.max(best ?? -Infinity, s.top);
      }
    floors.push(best);
  }
  return { base: min.y, top: max.y, floors, sides: alongX ? ['north', 'south'] : ['west', 'east'], keys: alongX ? ['nz', 'pz'] : ['nx', 'px'] };
}

/** `faces`, but a malformed list (reported elsewhere by lint) is an empty one instead of a throw. */
function safeFaces(list: unknown, rot: number): string[] {
  try {
    return faces(list, rot);
  } catch {
    return [];
  }
}

/** The wall's own name ("front", "back", ...) for the face that looks out on a world face, given its turn. */
function relativeFace(worldKey: string, rot: number): 'front' | 'back' | 'left' | 'right' | null {
  for (const name of ['front', 'back', 'left', 'right'] as const) if (safeFaces([name], rot)[0] === worldKey) return name;
  return null;
}

const MAX_DROP = 30;
/** Space a standing player needs above a spawn or goal (the capsule is 2 m tall). */
const HEADROOM = 2.2;

/** Half the side of the dry square left under a spawn or goal that stood in a pool. */
const PAD = 3;

/**
 * Cuts a dry square out of every written acid pool that covers (x, z) at height y, replacing
 * the pool by the rectangles around it. A mirrored copy of a pool is the half-turn image of the
 * written one, so a point inside the copy cuts the written pool at the mirrored point. Returns
 * a description, or null when nothing was cut.
 */
function carvePad(map: MapData, x: number, y: number, z: number, mirrored: boolean): string | null {
  let cut = 0;
  for (let i = 0; i < map.pieces.length; i++) {
    const p = map.pieces[i];
    if (p.type !== 'acid') continue;
    const w = withDefaults(p);
    if (!isVec3(w.size) || !isVec3(w.at) || (w.rot ?? 0) % 90 !== 0) continue;
    if (!(y <= w.at[1] + 0.5 && y >= w.at[1] - 6)) continue;
    const spots: [number, number][] = [[x, z]];
    if (mirrored && !w.center) spots.push([-x, -z]);
    const { min, max } = footprint(w);
    for (const [px, pz] of spots) {
      if (px < min.x || px > max.x || pz < min.z || pz > max.z) continue;
      const hx0 = px - PAD;
      const hx1 = px + PAD;
      const hz0 = pz - PAD;
      const hz1 = pz + PAD;
      const rects: [number, number, number, number][] = [
        [min.x, max.x, min.z, hz0], // beyond the pad on the low z side, full width
        [min.x, max.x, hz1, max.z],
        [min.x, hx0, Math.max(min.z, hz0), Math.min(max.z, hz1)],
        [hx1, max.x, Math.max(min.z, hz0), Math.min(max.z, hz1)],
      ];
      const pieces: Piece[] = [];
      for (const [x0, x1, z0, z1] of rects) {
        if (x1 - x0 < 0.5 || z1 - z0 < 0.5) continue;
        const copy: Piece = { ...p, at: [(x0 + x1) / 2, w.at[1], (z0 + z1) / 2], size: [r2(x1 - x0), w.size[1], r2(z1 - z0)] };
        delete copy.rot;
        // The id belongs to one piece only.
        if (pieces.length > 0) delete copy.id;
        pieces.push(copy);
      }
      // Replace in place, so the order of the pieces (and what points at them) stays put.
      map.pieces.splice(i, 1, ...pieces);
      i += pieces.length - 1;
      cut++;
      break;
    }
  }
  return cut ? `cut a ${PAD * 2} x ${PAD * 2} m dry pad out of the acid pool under it` : null;
}

/**
 * Puts spawns and goals on the surface they plainly belong to: one buried in a block is lifted
 * to the top of it (and again if that lands inside the next block up), one hanging in the air
 * drops onto the highest surface below it. Models get this wrong constantly and the answer is
 * unambiguous, so it is fixed here instead of costing a repair call. Only the written pieces
 * move; a mirrored copy follows its original, and one that is still wrong is left to `lint`.
 */
export function fixSupport(input: MapData): AutofixResult {
  const map = structuredClone(input);
  const fixes: string[] = [];
  if (!Array.isArray(map.pieces) || map.pieces.some((p) => !PIECES[p.type] || !isVec3(p.at))) return { map, fixes };
  let placed: Piece[];
  try {
    placed = expandPieces(map);
  } catch {
    return { map, fixes };
  }
  const solids = solidsOf(map, placed);
  map.pieces.forEach((p, i) => {
    if (p.type !== 'spawn' && p.type !== 'goal') return;
    const [x, y0, z] = p.at;
    let y = y0;
    for (let n = 0; n < 8; n++) {
      const under = solids.filter((s) => inside(s, x, z));
      const buried = under.filter((s) => !s.stairs && s.bottom < y + 1.8 && s.top > y + 0.15);
      if (buried.length) {
        y = Math.max(...buried.map((s) => s.top));
        continue;
      }
      if (under.some((s) => (s.stairs ? y >= s.bottom - 0.15 && y <= s.top + 0.15 : Math.abs(s.top - y) <= 0.15))) break;
      const below = under.filter((s) => !s.stairs && s.top <= y + 0.15 && y - s.top <= MAX_DROP).sort((a, b) => b.top - a.top)[0];
      if (!below) break;
      y = below.top;
    }
    if (r2(y) !== r2(y0)) {
      p.at = [x, r2(y), z];
      fixes.push(`piece #${i} (${p.type}) at x=${r2(x)}, z=${r2(z)} moved from y=${r2(y0)} to y=${r2(y)} so it stands on a surface`);
    }
  });
  // Nobody starts or finishes in acid. Models draw a pool over the middle of the floor and the
  // spawns that stood there with it; the nearest dry spot on the same surface is unambiguous.
  const pools = placed.filter((p) => p.type === 'acid' && isVec3(p.size) && isVec3(p.at) && (p.rot ?? 0) % 90 === 0).map((p) => ({ ...footprint(p), y: p.at[1] }));
  const inPool = (x: number, z: number, y: number, m: number) => pools.some((q) => x >= q.min.x - m && x <= q.max.x + m && z >= q.min.z - m && z <= q.max.z + m && y <= q.y + 0.5 && y >= q.y - 6);
  const standingOn = (x: number, z: number, y: number) => solids.some((sd) => inside(sd, x, z) && (sd.stairs ? false : Math.abs(sd.top - y) <= 0.15));
  const roomBox = placed.find((p) => p.type === 'room' && isVec3(p.size));
  const others = placed.filter((p) => p.type === 'spawn' || p.type === 'goal');
  const carves: { i: number; type: string; x: number; y: number; z: number }[] = [];
  map.pieces.forEach((p, i) => {
    if ((p.type !== 'spawn' && p.type !== 'goal') || !isVec3(p.at)) return;
    const [x, y, z] = p.at;
    if (!inPool(x, z, y, 0)) return;
    const half = roomBox && isVec3(roomBox.size) ? [roomBox.size[0] / 2 - 1, roomBox.size[2] / 2 - 1] : [40, 40];
    const cx = roomBox ? roomBox.at[0] : 0;
    const cz = roomBox ? roomBox.at[2] : 0;
    let best: [number, number] | null = null;
    let bestD = Infinity;
    for (let gx = Math.round(cx - half[0]); gx <= cx + half[0]; gx += 1)
      for (let gz = Math.round(cz - half[1]); gz <= cz + half[1]; gz += 1) {
        const d = Math.hypot(gx - x, gz - z);
        if (d >= bestD || inPool(gx, gz, y, 1.5) || !standingOn(gx, gz, y)) continue;
        if (others.some((o) => o !== p && Math.abs(o.at[1] - y) < 2 && Math.hypot(o.at[0] - gx, o.at[2] - gz) < 3)) continue;
        best = [gx, gz];
        bestD = d;
      }
    if (!best) {
      // No dry spot anywhere on this surface (the pool covers it all): a dry pad is cut out below.
      carves.push({ i, type: p.type, x, y, z });
      return;
    }
    p.at = [best[0], y, best[1]];
    fixes.push(`piece #${i} (${p.type}) moved from x=${r2(x)}, z=${r2(z)} to x=${best[0]}, z=${best[1]}, out of the acid pool`);
  });
  // Cut after the walk above: it replaces pieces, which would shift the indices it is iterating over.
  for (const c of carves) {
    const note = carvePad(map, c.x, c.y, c.z, isSymmetric(map));
    if (note) fixes.push(`piece #${c.i} (${c.type}) at x=${r2(c.x)}, z=${r2(c.z)}: ${note}`);
  }
  // A portal wall stands level with the ground beside it. One a little too low is buried (a portal
  // there opens into the ground); one a little too high leaves a step nobody can climb into the opening.
  map.pieces.forEach((p, i) => {
    if (p.type !== 'portal-wall') return;
    const w = withDefaults(p);
    if (!isVec3(w.size) || !isVec3(w.at) || (w.rot ?? 0) % 90 !== 0) return;
    const lv = wallLevels(w, solids);
    const found = lv.floors.filter((f): f is number => f !== null);
    if (lv.floors[0] !== null && lv.floors[1] !== null && Math.abs(lv.floors[0] - lv.floors[1]) > 0.05 && Math.abs(lv.floors[0] - lv.floors[1]) <= MAX_WALL_SNAP) {
      // Ground at two levels (a wall on the edge of a shore or a ledge) cannot be level with both
      // sides. Stand it on the lower one, with portals on that face only: the other face is partly
      // buried, and a portal there would open into the ground.
      const lowSide = lv.floors[0] < lv.floors[1] ? 0 : 1;
      const low = lv.floors[lowSide]!;
      const face = relativeFace(lv.keys[lowSide], w.rot ?? 0);
      if (face && lv.top - low >= 1) {
        const rest = Array.isArray(w.portal) ? (w.portal as string[]).filter((f) => !['front', 'back', 'left', 'right', 'sides', 'all'].includes(f)) : [];
        const portal = [face, ...rest];
        const changed = Math.abs(low - lv.base) > WALL_FLUSH || JSON.stringify([...(Array.isArray(w.portal) ? (w.portal as string[]) : [])].sort()) !== JSON.stringify([...portal].sort());
        if (changed) {
          p.at = [w.at[0], r2(low), w.at[2]];
          p.size = [w.size[0], r2(lv.top - low), w.size[2]];
          p.portal = portal;
          fixes.push(
            `piece #${i} (portal-wall) at x=${r2(w.at[0])}, z=${r2(w.at[2])} stands between ground at y=${r2(lv.floors[lowSide]!)} (${lv.sides[lowSide]} side) and y=${r2(lv.floors[1 - lowSide]!)} (${lv.sides[1 - lowSide]} side): set to stand on the lower one (base y=${r2(low)}, top stays at y=${r2(lv.top)}) with portals on the ${face} face only`,
          );
        }
      }
      return;
    }
    if (found.length === 0 || found.some((f) => Math.abs(f - found[0]) > 0.05)) return;
    const d = found[0] - lv.base;
    if (Math.abs(d) <= WALL_FLUSH || Math.abs(d) > MAX_WALL_SNAP || lv.top - found[0] < 1) return;
    p.at = [w.at[0], r2(found[0]), w.at[2]];
    p.size = [w.size[0], r2(lv.top - found[0]), w.size[2]];
    fixes.push(`piece #${i} (portal-wall) at x=${r2(w.at[0])}, z=${r2(w.at[2])} moved from y=${r2(lv.base)} to y=${r2(found[0])} to stand level with the ground beside it (its top stays at y=${r2(lv.top)})`);
  });
  return { map, fixes };
}

/** What is wrong with `map`, in words a model can act on. Empty means it passed. No building: see `buildCheck`. */
export function lint(map: MapData): string[] {
  const problems: string[] = [];
  const add = (s: string) => problems.push(s);
  if (!Array.isArray(map.pieces) || map.pieces.length === 0) return ['The map has no pieces.'];
  const kind = mapKind(map);

  // 1. Each piece on its own.
  let structural = false;
  map.pieces.forEach((raw, i) => {
    const where = `piece #${i} (${raw.type})`;
    const spec = PIECES[raw.type];
    if (!spec) {
      structural = true;
      return add(`${where}: unknown piece type (known: ${Object.keys(PIECES).join(', ')})`);
    }
    if (!isVec3(raw.at)) {
      structural = true;
      return add(`${where}: "at" must be three numbers [x, y, z]`);
    }
    if (raw.at.some((n) => Math.abs(n) > LIMIT)) add(`${where}: at ${fmt(raw.at)} is beyond ${LIMIT} m from the origin`);
    const p = withDefaults(raw);
    if (spec.sizeLabels) {
      if (!isVec3(p.size)) add(`${where}: "size" must be three numbers (${spec.sizeLabels.join(', ')})`);
      else
        p.size.forEach((n, k) => {
          const label = spec.sizeLabels![k];
          if (n < 0 || (label !== '-' && n === 0) || n > LIMIT) add(`${where}: size ${fmt(p.size!)} has a bad ${label === '-' ? `component ${k}` : label} (${n})`);
        });
    }
    if (p.rot !== undefined && !isNum(p.rot)) add(`${where}: "rot" must be a number`);
    else if (spec.turn === 'quarter' && (p.rot ?? 0) % 90 !== 0) add(`${where}: rot ${p.rot} must be a multiple of 90`);
    for (const f of spec.fields ?? []) {
      if (p[f.key] === undefined) continue;
      const why = fieldProblem(f, p[f.key]);
      if (why) add(`${where}: parameter "${f.key}" ${why} (got ${JSON.stringify(p[f.key])})`);
    }
  });
  if (structural) return problems; // cross-piece checks need well-formed pieces

  // 2. The room and what sits in it.
  const rooms = map.pieces.map((p, i) => ({ p, i })).filter((x) => x.p.type === 'room');
  if (rooms.length === 0) add('The map has no room piece. Start with a room shell that encloses everything.');
  if (rooms.length > 1) add(`The map has ${rooms.length} room pieces; use exactly one.`);
  const roomPiece = rooms[0]?.p;
  const room = roomPiece && isVec3(withDefaults(roomPiece).size) ? { piece: withDefaults(roomPiece), size: withDefaults(roomPiece).size as Vec3 } : null;
  const bounds = room
    ? { minX: room.piece.at[0] - room.size[0] / 2, maxX: room.piece.at[0] + room.size[0] / 2, minZ: room.piece.at[2] - room.size[2] / 2, maxZ: room.piece.at[2] + room.size[2] / 2, minY: room.piece.at[1], maxY: room.piece.at[1] + room.size[1] }
    : null;
  if (room && isSymmetric(map) && (Math.abs(room.piece.at[0]) > 0.01 || Math.abs(room.piece.at[2]) > 0.01))
    add(`Symmetric maps mirror about x=0, z=0, but the room is centred at ${fmt(room.piece.at)}; centre it on x=0, z=0.`);
  if (bounds) {
    map.pieces.forEach((raw, i) => {
      if (raw.type === 'room') return;
      const p = withDefaults(raw);
      const where = `piece #${i} (${p.type}) at ${fmt(p.at)}`;
      const [x, y, z] = p.at;
      if (x < bounds.minX - 0.05 || x > bounds.maxX + 0.05 || z < bounds.minZ - 0.05 || z > bounds.maxZ + 0.05)
        add(`${where} is outside the room (room x ${r2(bounds.minX)}..${r2(bounds.maxX)}, z ${r2(bounds.minZ)}..${r2(bounds.maxZ)}).`);
      else if (y > bounds.maxY + 0.05) add(`${where} is above the room ceiling (y ${r2(bounds.maxY)}).`);
      else if (y < bounds.minY - 40) add(`${where} is more than 40 m below the room floor.`);
      if (isVec3(p.size) && PIECES[p.type].turn === 'quarter' && (p.rot ?? 0) % 90 === 0 && PIECES[p.type].group === 'Structure') {
        const { min, max } = footprint(p);
        const over = Math.max(bounds.minX - min.x, max.x - bounds.maxX, bounds.minZ - min.z, max.z - bounds.maxZ);
        if (over > 1) add(`${where} sticks out of the room by ${r2(over)} m (size ${fmt(p.size)}).`);
      }
      if (p.type === 'platform' && isVec3(p.to) && (p.to[0] < bounds.minX || p.to[0] > bounds.maxX || p.to[2] < bounds.minZ || p.to[2] > bounds.maxZ))
        add(`${where}: its "to" ${fmt(p.to)} is outside the room.`);
    });
  }

  // 3. Hazards and wiring that can be checked from the numbers.
  const seen = new Set<string>();
  map.pieces.forEach((raw, i) => {
    const p = withDefaults(raw);
    if (typeof p.id === 'string' && p.id) {
      if (seen.has(p.id)) add(`piece #${i} (${p.type}): the id "${p.id}" is used twice; ids must be unique.`);
      seen.add(p.id);
    }
    if (p.type === 'dropper' && isNum(p.ceiling) && p.ceiling <= p.at[1]) add(`piece #${i} (dropper) at ${fmt(p.at)}: ceiling ${p.ceiling} must be above the drop point (y ${p.at[1]}).`);
  });
  // A door opens while its receiver is lit, so a receiver with that id has to exist.
  const receivers = new Set(map.pieces.filter((p) => p.type === 'receiver').map((p) => String(withDefaults(p).id ?? '')));
  map.pieces.forEach((raw, i) => {
    if (raw.type !== 'door') return;
    const id = String(withDefaults(raw).receiver ?? '');
    if (!receivers.has(id) && !receivers.has(id.replace(/~+$/, '')))
      add(`piece #${i} (door) at ${fmt(raw.at)}: no receiver piece has the id "${id}"${receivers.size ? ` (receivers: ${[...receivers].join(', ')})` : '; add a receiver piece lit by a laser'}.`);
  });

  // 4. Spawns and goals against the floor under them. `placed` includes the mirrored copies of a
  // symmetric map, so they count as solids too.
  const placed = expandPieces(map);
  const solids = solidsOf(map, placed);
  const spawns = placed.filter((p) => p.type === 'spawn');
  const goals = placed.filter((p) => p.type === 'goal');
  const standing = (p: Piece, label: string) => {
    const [x, y, z] = p.at;
    const under = solids.filter((s) => inside(s, x, z));
    const supported = under.some((s) => (s.stairs ? y >= s.bottom - 0.15 && y <= s.top + 0.15 : Math.abs(s.top - y) <= 0.15));
    const buried = under.find((s) => !s.stairs && s.bottom < y + 1.8 && s.top > y + 0.15);
    if (bounds && y + HEADROOM > bounds.maxY + 1e-6)
      add(`${label} at ${fmt(p.at)} has no headroom: the room ceiling is at y=${r2(bounds.maxY)} and a player needs ${HEADROOM} m; lower what it stands on or raise the room.`);
    if (buried) add(`${label} at ${fmt(p.at)} is inside a ${buried.type} that rises to y=${r2(buried.top)}; raise it to y=${r2(buried.top)} or move it.`);
    else if (!supported) {
      const below = under.filter((s) => s.top <= y + 0.15).sort((a, b) => b.top - a.top)[0];
      add(`${label} at ${fmt(p.at)} has no floor under it (${below ? `the nearest surface below is a ${below.type} at y=${r2(below.top)}` : 'nothing below it'}); put it on a surface top.`);
    }
  };
  spawns.forEach((p) => standing(p, 'spawn'));
  goals.forEach((p) => standing(p, 'goal'));
  for (const pool of placed.filter((p) => p.type === 'acid' && isVec3(p.size) && (p.rot ?? 0) % 90 === 0)) {
    const { min, max } = footprint(pool);
    for (const p of [...spawns, ...goals])
      if (p.at[0] >= min.x && p.at[0] <= max.x && p.at[2] >= min.z && p.at[2] <= max.z && p.at[1] <= pool.at[1] + 0.5 && p.at[1] >= pool.at[1] - 6)
        add(`${p.type} at ${fmt(p.at)} is in an acid pool (surface at y=${r2(pool.at[1])}); move it onto dry ground.`);
  }
  for (const p of placed.filter((x) => x.type === 'portal-wall' && isVec3(x.size) && (x.rot ?? 0) % 90 === 0)) {
    const lv = wallLevels(p, solids);
    const takesPortals = new Set<string>(Array.isArray(p.portal) ? safeFaces(p.portal, p.rot ?? 0) : []);
    lv.floors.forEach((f, k) => {
      if (f === null || Math.abs(f - lv.base) <= WALL_FLUSH || Math.abs(f - lv.base) > MAX_WALL_SNAP || !takesPortals.has(lv.keys[k])) return;
      add(
        `portal wall at ${fmt(p.at)} has its base at y=${r2(lv.base)}, but the ground beside its ${lv.sides[k]} face is at y=${r2(f)}: a portal there opens into the ground or above a step too high to climb. Make the ground on both sides y=${r2(lv.base)}, or set the wall's at.y to ${r2(f)} (height ${r2(lv.top - f)}), or turn portals off on that face (a wall between two ground levels should stand on the lower one and take portals on that face only).`,
      );
    });
  }
  for (let a = 0; a < spawns.length; a++)
    for (let b = a + 1; b < spawns.length; b++) {
      const [ax, ay, az] = spawns[a].at;
      const [bx, by, bz] = spawns[b].at;
      if (Math.hypot(ax - bx, az - bz) < 2.5 && Math.abs(ay - by) < 2) add(`spawns at ${fmt(spawns[a].at)} and ${fmt(spawns[b].at)} are less than 2.5 m apart; spread them out.`);
    }

  // 5. What the kind needs.
  if (kind === 'combat' && spawns.length < 2) add(`A combat map needs at least 2 spawn points (it has ${spawns.length}); with symmetry a spawn that is not marked center counts twice.`);
  if (kind === 'puzzle') {
    if (spawns.length < 1) add('A puzzle map needs a spawn point.');
    if (goals.length !== 1) add(`A puzzle map needs exactly one goal piece (it has ${goals.length}).`);
  }
  return problems;
}

export interface BuildResult {
  error: string | null;
  spawns: number;
  ms: number;
}

/** Builds the map headless the way the game will. Combat goes through `checkMap`, the gate online rooms use. */
export async function buildCheck(map: MapData): Promise<BuildResult> {
  const t0 = performance.now();
  const done = (error: string | null, spawns: number): BuildResult => ({ error, spawns, ms: Math.round(performance.now() - t0) });
  if (mapKind(map) === 'combat') {
    const r = await checkMap({ kind: 'custom', data: map });
    return typeof r === 'string' ? done(r, 0) : done(null, r.slots);
  }
  try {
    const sim = await ArenaSim.load(mapToArena(map), null);
    const spawns = sim.arena.spawns.length;
    sim.dispose();
    return done(null, spawns);
  } catch (e) {
    return done(`The map didn't build: ${(e as Error).message}`, 0);
  }
}

export interface CheckResult {
  ok: boolean;
  /** The map after autofix; this is what to save when `ok`. */
  map: MapData;
  fixes: string[];
  problems: string[];
  buildMs?: number;
}

/** Autofix, then lint, then (only when lint is clean) build. `ok` means it can be saved and played. */
export async function checkGenerated(raw: MapData): Promise<CheckResult> {
  const tidy = autofix(raw);
  const support = fixSupport(tidy.map);
  const map = support.map;
  const fixes = [...tidy.fixes, ...support.fixes];
  const size = mapProblem(map);
  if (size) return { ok: false, map, fixes, problems: [size] };
  const problems = [...new Set(lint(map))];
  if (problems.length) return { ok: false, map, fixes, problems };
  const built = await buildCheck(map);
  if (built.error) return { ok: false, map, fixes, problems: [built.error], buildMs: built.ms };
  return { ok: true, map, fixes, problems: [], buildMs: built.ms };
}
