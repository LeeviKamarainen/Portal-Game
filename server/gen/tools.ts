import { PIECES, expandPieces, footprint, isSymmetric, mapKind, withDefaults, type FieldSpec, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';
import { MAP_PIECES_MAX } from '../../src/net/protocol';
import { fieldProblem, fmt, inside, lint, r2, solidsOf, type CheckResult } from './check';
import type { PlayReport, PlayStep } from './playtest';
import { describeRoutes, type RouteReport } from './routes';
import { slug } from './wire';
import type { ToolSpec } from './llm';

/**
 * The model's hands and eyes: it edits the map through these tools and checks its own work
 * with them, instead of being fenced in by a plan written in advance. Every edit comes back
 * with what is wrong with the pieces it touched, and the heavier checks (the full build,
 * "can the exit be reached", "what is at this spot") are tools it calls when it wants to know.
 *
 * Piece numbers are the map's own order. Within one `edit_map` call every number means the
 * map as it was before the call; new pieces are appended and removals happen last, and the
 * result says what the numbers are afterwards.
 */

export interface ToolEnv {
  /** The full check (tidy, lint, headless build); the server runs it on a worker thread. */
  check(map: MapData): Promise<CheckResult>;
  /** Route analysis: can the exit be reached, with how many portal hops. */
  routes(map: MapData): Promise<RouteReport>;
  /** A scripted playtest in the real simulation. */
  playtest(map: MapData, steps: PlayStep[]): Promise<PlayReport>;
}

export interface ToolOutcome {
  /** What the model reads. */
  text: string;
  isError: boolean;
  /** One line for the chat: what the call did. */
  summary: string;
  /** Problems to show under the summary, if any. */
  problems?: string[];
  /** The map changed (the editor should redraw). */
  mapChanged: boolean;
  /** check_routes only: the level can be finished as far as the analysis can tell. */
  routesOk?: boolean;
  /** playtest only: the exit was reached. */
  reachedExit?: boolean;
}

const NAME_MAX = 40;
const MAX_PROBLEMS_SHOWN = 12;
const KINDS = ['combat', 'puzzle'];
const SYMMETRIES = ['none', 'rotate180'];
const BASE_KEYS = new Set(['type', 'at', 'size', 'rot', 'center']);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The size, extents and parameters of a piece on one line, for the model to refer to by number. */
export function pieceLine(raw: Piece, index: number): string {
  const spec = PIECES[raw.type];
  const p = withDefaults(raw);
  const parts = [`#${index} ${raw.type} at ${fmt(p.at)}`];
  if (Array.isArray(raw.size)) parts.push(`size ${fmt(raw.size)}`);
  if (raw.rot) parts.push(`rot ${raw.rot}`);
  if (raw.center) parts.push('center');
  for (const f of spec?.fields ?? []) {
    const v = raw[f.key];
    if (v === undefined || v === null) continue;
    parts.push(`${f.key}=${Array.isArray(v) ? v.join(',') : String(v)}`);
  }
  let extent = '';
  if (spec?.sizeLabels && Array.isArray(p.size) && p.size.length === 3 && p.size.every(isNum) && ((p.rot ?? 0) % 90 === 0 || spec.turn !== 'quarter')) {
    try {
      if (raw.type === 'platform') {
        const [w, h, d] = p.size as Vec3;
        extent = `x ${r2(p.at[0] - w / 2)}..${r2(p.at[0] + w / 2)}, y ${r2(p.at[1] - h / 2)}..${r2(p.at[1] + h / 2)}, z ${r2(p.at[2] - d / 2)}..${r2(p.at[2] + d / 2)}`;
      } else if (['room', 'block', 'portal-wall', 'wall', 'floor', 'glass', 'door', 'stairs', 'slope'].includes(raw.type)) {
        const { min, max } = footprint({ ...p, size: p.size as Vec3 });
        extent = `x ${r2(min.x)}..${r2(max.x)}, y ${r2(min.y)}..${r2(max.y)}, z ${r2(min.z)}..${r2(max.z)}`;
      }
    } catch {
      /* a malformed size is reported by lint */
    }
  }
  return extent ? `${parts.join(' ')}  [${extent}]` : parts.join(' ');
}

/** The whole map as the model reads it: header, then one line per piece. */
export function mapListing(map: MapData, only?: string[]): string {
  const room = map.pieces.map(withDefaults).find((p) => p.type === 'room');
  const lines = [
    `Map "${map.name}" (id ${map.id}): kind ${mapKind(map)}, symmetry ${map.symmetry ?? 'none'}, killY ${map.killY ?? -6}, ${map.pieces.length} piece${map.pieces.length === 1 ? '' : 's'}.`,
    `Hint: ${map.hint || '(none)'}`,
  ];
  if (room && Array.isArray(room.size)) lines.push(`Room: x ${r2(room.at[0] - room.size[0] / 2)}..${r2(room.at[0] + room.size[0] / 2)}, y ${r2(room.at[1])}..${r2(room.at[1] + room.size[1])}, z ${r2(room.at[2] - room.size[2] / 2)}..${r2(room.at[2] + room.size[2] / 2)}.`);
  if (isSymmetric(map)) lines.push('Symmetric: every piece not marked center is copied with a half turn about x=0, z=0 (only the written half is listed).');
  map.pieces.forEach((p, i) => {
    if (!only || only.includes(p.type)) lines.push(pieceLine(p, i));
  });
  return lines.join('\n');
}

/** A value from the model in the form a field's kind wants (it may send "3.5" for 3.5, or "top,sides" for a list). */
function coerce(f: FieldSpec, v: unknown): unknown {
  if (typeof v === 'string') {
    switch (f.kind) {
      case 'number':
        return v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
      case 'bool':
        return v === 'true' ? true : v === 'false' ? false : v;
      case 'faces':
      case 'sides':
      case 'ids':
        return v.split(',').map((x) => x.trim()).filter(Boolean);
      case 'vec3': {
        const parts = v.split(',').map(Number);
        return parts.length === 3 && parts.every(Number.isFinite) ? parts : v;
      }
    }
  }
  return v;
}

/** Three finite numbers (a list, or "x,y,z" text) rounded to 0.01, or null. */
const vec3 = (v: unknown): Vec3 | null => {
  const a: unknown = typeof v === 'string' ? v.split(',').map((x) => (x.trim() === '' ? NaN : Number(x))) : v;
  if (!Array.isArray(a) || a.length !== 3) return null;
  const n = a.map((x) => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN));
  return n.every(Number.isFinite) ? (n.map(r2) as Vec3) : null;
};

interface Normalized {
  piece: Piece;
  notes: string[];
}

/**
 * A piece as the model wrote it, as a map-file piece: numbers rounded, a quarter-turn piece's
 * rotation snapped, parameter values in the kind each wants. Throws a message for what cannot
 * be understood (the call is then refused whole and nothing is applied).
 */
function normalize(input: Record<string, unknown>, type: string, where: string): Normalized {
  const spec = PIECES[type];
  if (!spec) throw new Error(`${where}: unknown piece type "${type}". Known types: ${Object.keys(PIECES).join(', ')}.`);
  const notes: string[] = [];
  const piece: Piece = { type, at: [0, 0, 0] };
  const at = vec3(input.at);
  if (!at) throw new Error(`${where}: "at" must be three numbers [x, y, z].`);
  piece.at = at;
  if (input.size !== undefined && input.size !== null) {
    if (!spec.sizeLabels) {
      notes.push(`${where}: a ${type} has no size; ignored`);
    } else {
      const size = vec3(input.size);
      if (!size) throw new Error(`${where}: "size" must be three numbers (${spec.sizeLabels.join(', ')}).`);
      piece.size = size;
    }
  }
  if (input.rot !== undefined && input.rot !== null) {
    let rot = Number(input.rot);
    if (!Number.isFinite(rot)) throw new Error(`${where}: "rot" must be a number of degrees.`);
    rot = ((r2(rot) % 360) + 360) % 360;
    if (spec.turn === 'quarter') {
      const snapped = (Math.round(rot / 90) * 90) % 360;
      if (snapped !== rot) notes.push(`${where}: rot ${rot} snapped to ${snapped} (a ${type} turns in 90 degree steps)`);
      rot = snapped;
    } else if (spec.turn === 'none' && rot !== 0) {
      notes.push(`${where}: a ${type} cannot be turned; rot ignored`);
      rot = 0;
    }
    if (rot) piece.rot = rot;
  }
  if (input.center === true) piece.center = true;
  for (const [key, raw] of Object.entries(input)) {
    if (BASE_KEYS.has(key)) continue;
    const f = spec.fields?.find((x) => x.key === key);
    if (!f || key === 'hide') {
      throw new Error(`${where}: a ${type} has no parameter "${key}". Its parameters: ${(spec.fields ?? []).filter((x) => x.key !== 'hide').map((x) => x.key).join(', ') || 'none'}.`);
    }
    const value = coerce(f, raw);
    const why = fieldProblem(f, value);
    if (why) throw new Error(`${where}: parameter "${key}" ${why} (got ${JSON.stringify(raw)}).`);
    piece[key] = value;
  }
  return { piece, notes };
}

/** What the model may pass to `edit_map` as one operation. */
interface Op {
  op?: string;
  index?: number;
  piece?: Record<string, unknown>;
  set?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

const PIECE_SCHEMA = {
  type: 'object',
  description:
    'A piece as in the map file: {"type": "block", "at": [x, y, z], "size": [w, h, d], "rot": 0, ...its own parameters (portal, id, receiver, targets, ...)}. Parameter values are JSON: numbers, true/false, lists like ["top","front"].',
  properties: { type: { type: 'string' }, at: { type: 'array', items: { type: 'number' } }, size: { type: 'array', items: { type: 'number' } }, rot: { type: 'number' }, center: { type: 'boolean' } },
  required: ['type', 'at'],
  additionalProperties: true,
};

export const TOOLS: ToolSpec[] = [
  {
    name: 'view_map',
    description:
      'List the pieces of the map as it is now, one line each with its number, position, size and the extents it covers (x, y, z ranges; a piece\'s top is its y max). Use it to refresh your picture after edits or removals, which renumber pieces. Optionally only some piece types.',
    input_schema: { type: 'object', properties: { types: { type: 'array', items: { type: 'string' }, description: 'Only these piece types, e.g. ["spawn","goal"].' } } },
  },
  {
    name: 'edit_map',
    description:
      'Change the map: add, update or remove pieces and change the map\'s name, hint or kind. Several operations per call are fine and cheaper than many calls. Piece numbers in `index` refer to the map as it was before this call; added pieces are appended; removals happen last. The reply lists what is wrong with the pieces you touched, and the extents of what you added so you can stack things exactly. Nothing is applied if any operation is invalid.\n' +
      'Operations: {"op":"add","piece":{...}}; {"op":"update","index":5,"set":{"at":[0,2,0],"portal":null}} (null removes a parameter; only the keys given change); {"op":"remove","index":5}; {"op":"meta","meta":{"name":"...","hint":"...","blurb":"...","kind":"puzzle","symmetry":"none","killY":-6}}; {"op":"clear"} removes every piece (keep the room: add a new one).',
    input_schema: {
      type: 'object',
      properties: {
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['add', 'update', 'remove', 'meta', 'clear'] },
              index: { type: 'integer', description: 'update/remove: the piece number.' },
              piece: PIECE_SCHEMA,
              set: { type: 'object', description: 'update: keys to set (any of at, size, rot, center or the piece\'s own parameters); null deletes a parameter.', additionalProperties: true },
              meta: { type: 'object', description: 'meta: name, hint, blurb, kind, symmetry, killY.', additionalProperties: true },
            },
            required: ['op'],
          },
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'validate_map',
    description:
      'Check the whole map the way the game will: tidy it, find every problem (spawns buried or floating, pieces outside the room, doors with no receiver, ...), and build it headless. Tidying is kept: pieces may be rounded, moved onto the surface they belong to, or removed (so numbers can shift: view_map again). Call it when you think you are done with a stage, and fix every problem it lists.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_routes',
    description:
      'Can the level be finished? Works out, with the real colliders and the same movement rules bots use, whether a player can get from the spawn to the exit goal (puzzle) or between the spawns (combat) by walking, jumping, dropping, jump pads and portal hops (an exit portal shot where you can see it, an entrance beside you, step in). Reports the route in words, the fewest portal hops, floor that nothing reaches, and for each door what opens it. Use it on every puzzle before you say it is done: a puzzle that cannot be solved, or that can be walked straight through, is a failure. It cannot see momentum flings or beams bent through portals.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'playtest',
    description:
      'Play the level in the real game simulation, as a person would, and see what happens. This is how you check the parts check_routes cannot see: a beam bent through portals that must light a receiver, a crate dropped through a portal onto a button, a jump pad, a door that must open. Steps run in order starting at the spawn: {"do":"stand","at":[x,y,z]} puts the player standing there (y is the floor height; use it to skip ahead to a place check_routes says can be reached); {"do":"shoot","color":"blue"|"orange","at":[x,y,z]} aims at that point from where the player stands and fires (a switch, a portal surface...); {"do":"walk","to":[x,z],"seconds":8} walks in a straight line toward the point, jumping when something is in the way, and goes through any portal in the way; {"do":"wait","seconds":3}. The reply says, per step, what was placed or hit and where the player ended up, and at the end whether the exit was reached and which receivers are lit, buttons down and doors open. Up to 30 steps and 90 s of game time per call.',
    input_schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              do: { type: 'string', enum: ['stand', 'shoot', 'walk', 'wait'] },
              at: { type: 'array', items: { type: 'number' }, description: 'stand/shoot: the point [x, y, z].' },
              color: { type: 'string', enum: ['blue', 'orange'] },
              to: { type: 'array', items: { type: 'number' }, description: 'walk: [x, z].' },
              seconds: { type: 'number' },
            },
            required: ['do'],
          },
        },
      },
      required: ['steps'],
    },
  },
  {
    name: 'surface_at',
    description:
      'What is at a spot: for each (x, z) every solid you could stand on or hit (piece number, type, y range), acid or pits, and the room ceiling. Use it to find the exact height of the floor under a place before putting a spawn, goal or hazard there.',
    input_schema: {
      type: 'object',
      properties: { points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }, description: 'Up to 8 points [x, z].' } },
      required: ['points'],
    },
  },
];

export class Workspace {
  /** The map as edited so far. */
  map: MapData;
  /** The map as the chat began, to tell whether anything changed. */
  readonly original: MapData;
  /** JSON of the map as of the last passing `validate_map`; null before one. */
  private validated: string | null = null;
  private readonly env: ToolEnv;

  constructor(map: MapData, env: ToolEnv) {
    this.map = structuredClone(map);
    this.original = structuredClone(map);
    this.env = env;
  }

  get changed(): boolean {
    return JSON.stringify(this.map) !== JSON.stringify(this.original);
  }

  /** The map is exactly as it was when a validation last passed. */
  get isValidated(): boolean {
    return this.validated !== null && this.validated === JSON.stringify(this.map);
  }

  async run(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      switch (name) {
        case 'view_map':
          return this.view(input);
        case 'edit_map':
          return this.edit(input);
        case 'validate_map':
          return await this.validate();
        case 'check_routes':
          return await this.routes();
        case 'playtest':
          return await this.play(input);
        case 'surface_at':
          return this.surface(input);
        default:
          return { text: `There is no tool "${name}". Tools: ${TOOLS.map((t) => t.name).join(', ')}.`, isError: true, summary: `unknown tool ${name}`, mapChanged: false };
      }
    } catch (e) {
      const message = (e as Error).message;
      return { text: message, isError: true, summary: message.split('\n')[0].slice(0, 160), mapChanged: false };
    }
  }

  // ---------------------------------------------------------------- tools

  private view(input: Record<string, unknown>): ToolOutcome {
    const only = Array.isArray(input.types) ? input.types.filter((t): t is string => typeof t === 'string') : undefined;
    return { text: mapListing(this.map, only), isError: false, summary: `looked at the map (${this.map.pieces.length} pieces)`, mapChanged: false };
  }

  private edit(input: Record<string, unknown>): ToolOutcome {
    const ops = input.ops;
    if (!Array.isArray(ops) || ops.length === 0) throw new Error('edit_map needs "ops": a list of operations.');
    const base = this.map.pieces;
    const next: (Piece | null)[] = base.map((p) => p);
    const added: Piece[] = [];
    const notes: string[] = [];
    const touched = new Set<number>();
    const removed = new Set<number>();
    const metaDone: string[] = [];
    const meta = { ...this.map };
    let cleared = false;

    const indexOf = (op: Op, i: number): number => {
      const idx = op.index;
      if (!Number.isInteger(idx) || idx! < 0 || idx! >= base.length) throw new Error(`operation ${i + 1}: there is no piece #${String(idx)} (the map has ${base.length} piece${base.length === 1 ? '' : 's'}, numbered 0..${base.length - 1}).`);
      return idx!;
    };

    ops.forEach((raw, i) => {
      const op = raw as Op;
      const where = `operation ${i + 1}`;
      switch (op.op) {
        case 'add': {
          if (!op.piece || typeof op.piece !== 'object') throw new Error(`${where}: "add" needs "piece".`);
          const type = String(op.piece.type ?? '');
          const n = normalize(op.piece, type, `${where} (add ${type})`);
          if (type === 'room' && (base.some((p) => p.type === 'room') || added.some((p) => p.type === 'room')) && !cleared)
            throw new Error(`${where}: the map already has a room; update it (set "size") or clear the map first.`);
          added.push(n.piece);
          notes.push(...n.notes);
          break;
        }
        case 'update': {
          const idx = indexOf(op, i);
          if (removed.has(idx)) throw new Error(`${where}: piece #${idx} is removed in this call.`);
          if (!op.set || typeof op.set !== 'object') throw new Error(`${where}: "update" needs "set".`);
          const current = next[idx]!;
          const merged: Record<string, unknown> = { ...current };
          for (const [k, v] of Object.entries(op.set)) {
            if (k === 'type') throw new Error(`${where}: a piece's type cannot change; remove it and add the new one.`);
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          const n = normalize(merged, current.type, `${where} (#${idx} ${current.type})`);
          next[idx] = n.piece;
          notes.push(...n.notes);
          touched.add(idx);
          break;
        }
        case 'remove': {
          const idx = indexOf(op, i);
          removed.add(idx);
          break;
        }
        case 'clear':
          cleared = true;
          break;
        case 'meta': {
          const m = op.meta ?? {};
          for (const [k, v] of Object.entries(m)) {
            if (k === 'name' || k === 'hint' || k === 'blurb') {
              if (typeof v !== 'string') throw new Error(`${where}: meta.${k} must be text.`);
              if (k === 'name') meta.name = v.slice(0, NAME_MAX);
              else if (k === 'hint') meta.hint = v;
              else meta.blurb = v;
            } else if (k === 'kind') {
              if (!KINDS.includes(String(v))) throw new Error(`${where}: meta.kind must be combat or puzzle.`);
              meta.kind = v as MapData['kind'];
            } else if (k === 'symmetry') {
              if (!SYMMETRIES.includes(String(v))) throw new Error(`${where}: meta.symmetry must be none or rotate180.`);
              meta.symmetry = v as MapData['symmetry'];
            } else if (k === 'killY') {
              if (!isNum(v)) throw new Error(`${where}: meta.killY must be a number.`);
              meta.killY = v;
            } else throw new Error(`${where}: meta has no "${k}". Use name, hint, blurb, kind, symmetry or killY.`);
            metaDone.push(k);
          }
          break;
        }
        default:
          throw new Error(`${where}: "op" must be add, update, remove, meta or clear (got ${JSON.stringify(op.op)}).`);
      }
    });

    // Apply: updates are already in `next`; removals (or a clear) last, then the new pieces.
    const survivors: { piece: Piece; old: number }[] = [];
    next.forEach((p, i) => {
      if (cleared || removed.has(i)) return;
      survivors.push({ piece: p!, old: i });
    });
    const pieces = [...survivors.map((s) => s.piece), ...added];
    if (pieces.length > MAP_PIECES_MAX) throw new Error(`The map would have ${pieces.length} pieces; the limit is ${MAP_PIECES_MAX}.`);
    const renumber = new Map(survivors.map((s, k) => [s.old, k] as const));
    // A map that was cleared and given a name is a new map: it gets an id of its own (a saved one stays linked to the old).
    if (cleared && metaDone.includes('name')) meta.id = `${slug(meta.name)}-${Math.random().toString(36).slice(2, 6)}`;
    this.map = { ...meta, pieces };

    const firstNew = survivors.length;
    const nowTouched = new Set<number>([...[...touched].map((i) => renumber.get(i)).filter((x): x is number => x !== undefined), ...added.map((_, k) => firstNew + k)]);
    const parts: string[] = [];
    if (cleared) parts.push('cleared the map');
    if (added.length) parts.push(`added ${added.length} piece${added.length === 1 ? '' : 's'} (#${firstNew}${added.length > 1 ? `-#${firstNew + added.length - 1}` : ''})`);
    if (touched.size) parts.push(`changed ${touched.size}`);
    if (removed.size && !cleared) parts.push(`removed ${removed.size}`);
    if (metaDone.length) parts.push(`set ${[...new Set(metaDone)].join(', ')}`);
    const applied = parts.join(', ') || 'nothing changed';

    const lines = [`Applied: ${applied}. The map now has ${pieces.length} piece${pieces.length === 1 ? '' : 's'}.`];
    if (removed.size && !cleared) {
      // Everything after the first removal was renumbered: say what the numbers are now, so the next call cannot hit the wrong piece.
      const first = Math.min(...[...removed]);
      const tail = this.map.pieces.slice(first).slice(0, 60);
      if (tail.length) {
        lines.push(`Numbers after the removal (the pieces from #${first} on were renumbered):`);
        tail.forEach((p, k) => lines.push('  ' + pieceLine(p, first + k)));
      }
    }
    for (const n of notes) lines.push(`Note: ${n}.`);
    if (nowTouched.size) {
      lines.push('Touched pieces now:');
      for (const i of [...nowTouched].sort((a, b) => a - b).slice(0, 16)) lines.push('  ' + pieceLine(this.map.pieces[i], i));
    }
    const problems = this.problemsFor(nowTouched);
    if (problems.mine.length) {
      lines.push(`Problems with what you touched (${problems.mine.length}):`);
      for (const p of problems.mine.slice(0, MAX_PROBLEMS_SHOWN)) lines.push('  - ' + p);
    }
    if (problems.other > 0) lines.push(`${problems.other} other problem${problems.other === 1 ? '' : 's'} elsewhere in the map (validate_map lists them; some are only because the map is unfinished).`);
    return { text: lines.join('\n'), isError: false, summary: applied, problems: problems.mine.slice(0, 4), mapChanged: true };
  }

  /** Lint problems that name one of the touched pieces (by number or by where it is), and how many there are besides. */
  private problemsFor(touched: Set<number>): { mine: string[]; other: number } {
    let all: string[];
    try {
      all = [...new Set(lint(this.map))];
    } catch (e) {
      return { mine: [`the map cannot be read: ${(e as Error).message}`], other: 0 };
    }
    const spots = [...touched].map((i) => this.map.pieces[i]).filter(Boolean).map((p) => fmt(withDefaults(p).at));
    const mine = all.filter((line) => [...touched].some((i) => line.startsWith(`piece #${i} `) || line.includes(`#${i} (`)) || spots.some((s) => line.includes(s)));
    return { mine, other: all.length - mine.length };
  }

  private async validate(): Promise<ToolOutcome> {
    const before = this.map.pieces.length;
    const r = await this.env.check(this.map);
    const changedMap = JSON.stringify(r.map) !== JSON.stringify(this.map);
    this.map = r.map;
    if (r.ok) this.validated = JSON.stringify(this.map);
    const lines: string[] = [];
    if (r.ok) lines.push(`The map is valid: it passes every check and builds${r.buildMs !== undefined ? ` (${r.buildMs} ms)` : ''}.`);
    else {
      lines.push(`The map has ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}:`);
      r.problems.slice(0, 20).forEach((p, i) => lines.push(`${i + 1}. ${p}`));
      if (r.problems.length > 20) lines.push(`...and ${r.problems.length - 20} more.`);
    }
    if (r.fixes.length) {
      lines.push('Tidied automatically (kept):');
      for (const f of r.fixes.slice(0, 10)) lines.push('  - ' + f);
    }
    if (this.map.pieces.length !== before) lines.push(`The piece count changed from ${before} to ${this.map.pieces.length}: numbers shifted, view_map for the new ones.`);
    return {
      text: lines.join('\n'),
      isError: false,
      summary: r.ok ? 'checked the map: valid' : `checked the map: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'}`,
      problems: r.ok ? undefined : r.problems.slice(0, 4),
      mapChanged: changedMap,
    };
  }

  private async routes(): Promise<ToolOutcome> {
    const report = await this.env.routes(this.map);
    const ok = report.connected && !report.blockedByDoor;
    let summary: string;
    if (report.kind === 'puzzle') {
      if (!report.connected) summary = 'checked the exit: NOT reachable';
      else if (report.blockedByDoor) summary = `checked the exit: reachable, but door #${report.blockedByDoor.piece} on the way never opens`;
      else summary = `checked the exit: reachable with ${report.hops} portal hop${report.hops === 1 ? '' : 's'}`;
    } else summary = ok ? 'checked the spawns: all connected' : 'checked the spawns: some cannot be reached';
    return { text: describeRoutes(report), isError: false, summary, mapChanged: false, routesOk: ok };
  }

  private async play(input: Record<string, unknown>): Promise<ToolOutcome> {
    const steps = input.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('playtest needs "steps": a list of what the player does.');
    const report = await this.env.playtest(this.map, steps as PlayStep[]);
    return {
      text: report.text,
      isError: false,
      summary: report.died ? `playtested: the player died (${report.died})` : report.goal ? 'playtested: the exit was reached' : `playtested ${steps.length} step${steps.length === 1 ? '' : 's'}`,
      mapChanged: false,
      reachedExit: report.goal,
    };
  }

  private surface(input: Record<string, unknown>): ToolOutcome {
    const pts = Array.isArray(input.points) ? input.points.slice(0, 8) : [];
    if (pts.length === 0) throw new Error('surface_at needs "points": a list of [x, z].');
    let placed: Piece[];
    try {
      placed = expandPieces(this.map);
    } catch (e) {
      throw new Error(`The map cannot be read yet: ${(e as Error).message}`);
    }
    const solids = solidsOf(this.map, placed);
    const room = placed.find((p) => p.type === 'room');
    const ceiling = room && Array.isArray(room.size) ? r2(room.at[1] + room.size[1]) : null;
    const skipFloor = room && Array.isArray((room as Piece).skip) && ((room as Piece).skip as string[]).includes('floor');
    const lines: string[] = [];
    for (const raw of pts) {
      const x = Number((raw as unknown[])[0]);
      const z = Number((raw as unknown[])[1]);
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('each point must be [x, z] numbers.');
      const here = solids.filter((s) => inside(s, x, z)).sort((a, b) => b.top - a.top);
      const bits = here.map((s) => `${s.type === 'room floor' ? 'room floor' : s.type}${s.stairs ? ' (stairs/slope: its top climbs, see its y range)' : ''} y ${r2(s.bottom)}..${r2(s.top)}`);
      const acid = placed.filter((p) => p.type === 'acid' && Array.isArray(p.size) && (p.rot ?? 0) % 90 === 0).filter((p) => {
        const { min, max } = footprint(p);
        return x >= min.x && x <= max.x && z >= min.z && z <= max.z;
      });
      for (const a of acid) bits.push(`ACID surface at y=${r2(a.at[1])}`);
      const standOn = here.find((s) => !s.stairs);
      lines.push(`(${r2(x)}, ${r2(z)}): ${bits.length ? bits.join('; ') : skipFloor ? 'nothing: this is a hole (the room has no floor here)' : 'nothing solid'}${standOn ? `; the highest flat surface to stand on is y=${r2(standOn.top)}` : ''}${ceiling !== null ? `; ceiling y=${ceiling}` : ''}`);
    }
    return { text: lines.join('\n'), isError: false, summary: `looked at ${pts.length} spot${pts.length === 1 ? '' : 's'}`, mapChanged: false };
  }
}

