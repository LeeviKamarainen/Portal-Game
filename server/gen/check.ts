import { ArenaSim } from '../../src/sim/ArenaSim';
import { checkMap, mapProblem } from '../../src/room/mapCheck';
import { FACE_NAMES, PIECES, ROOM_SIDES, expandPieces, footprint, isSymmetric, mapKind, mapToArena, withDefaults, type FieldSpec, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';
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
  });

  const room = map.pieces.find((p) => p.type === 'room');
  if (room && isVec3(room.at) && !map.pieces.some((p) => p.type === 'lights')) {
    const [w, h, d] = withDefaults(room).size as Vec3;
    map.pieces.splice(1, 0, { type: 'lights', at: [room.at[0], room.at[1] + h, room.at[2]], size: [w, 0, d], center: true });
    note('added ceiling lights (the map had none)');
  }
  return { map, fixes };
}

interface Solid {
  type: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  bottom: number;
  top: number;
  stairs: boolean;
}

const inside = (s: Solid, x: number, z: number) => x >= s.minX - 1e-6 && x <= s.maxX + 1e-6 && z >= s.minZ - 1e-6 && z <= s.maxZ + 1e-6;

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

  // 4. Spawns and goals against the floor under them.
  const solids: Solid[] = [];
  if (bounds && !(roomPiece!.skip as string[] | undefined)?.includes('floor'))
    solids.push({ type: 'room floor', minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ, bottom: bounds.minY - 1, top: bounds.minY, stairs: false });
  // `placed` includes the mirrored copies of a symmetric map, so they count as solids too.
  const placed = expandPieces(map);
  for (const p of placed) {
    if (!['block', 'portal-wall', 'wall', 'floor', 'stairs'].includes(p.type) || !isVec3(p.size) || (p.rot ?? 0) % 90 !== 0) continue;
    const { min, max } = footprint(p);
    solids.push({ type: p.type, minX: min.x, maxX: max.x, minZ: min.z, maxZ: max.z, bottom: min.y, top: max.y, stairs: p.type === 'stairs' });
  }
  const spawns = placed.filter((p) => p.type === 'spawn');
  const goals = placed.filter((p) => p.type === 'goal');
  const standing = (p: Piece, label: string) => {
    const [x, y, z] = p.at;
    const under = solids.filter((s) => inside(s, x, z));
    const supported = under.some((s) => (s.stairs ? y >= s.bottom - 0.15 && y <= s.top + 0.15 : Math.abs(s.top - y) <= 0.15));
    const buried = under.find((s) => !s.stairs && s.bottom < y + 1.8 && s.top > y + 0.15);
    if (buried) add(`${label} at ${fmt(p.at)} is inside a ${buried.type} that rises to y=${r2(buried.top)}; raise it to y=${r2(buried.top)} or move it.`);
    else if (!supported) {
      const below = under.filter((s) => s.top <= y + 0.15).sort((a, b) => b.top - a.top)[0];
      add(`${label} at ${fmt(p.at)} has no floor under it (${below ? `the nearest surface below is a ${below.type} at y=${r2(below.top)}` : 'nothing below it'}); put it on a surface top.`);
    }
  };
  spawns.forEach((p) => standing(p, 'spawn'));
  goals.forEach((p) => standing(p, 'goal'));
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
  const { map, fixes } = autofix(raw);
  const size = mapProblem(map);
  if (size) return { ok: false, map, fixes, problems: [size] };
  const problems = [...new Set(lint(map))];
  if (problems.length) return { ok: false, map, fixes, problems };
  const built = await buildCheck(map);
  if (built.error) return { ok: false, map, fixes, problems: [built.error], buildMs: built.ms };
  return { ok: true, map, fixes, problems: [], buildMs: built.ms };
}
