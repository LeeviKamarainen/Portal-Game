import { z } from 'zod';
import { PIECES, type FieldSpec, type MapData, type Piece, type Vec3 } from '../../src/world/maps/MapFormat';

/**
 * The shape the model writes a map in.
 *
 * Anthropic's structured outputs allow at most 24 optional fields and 16 union types in one
 * schema, and the catalogue has far more piece parameters than that. So every field here is
 * required and a piece's own parameters travel as `{key, value}` string pairs, which
 * `fromWire` turns back into typed values using the catalogue's `FieldSpec` kinds. That keeps
 * the output grammar-valid JSON without a schema per piece type, and it follows the
 * catalogue automatically when a piece is added.
 *
 * Values by field kind: number "3.5"; text/select/color as is; faces, sides and ids as
 * comma-separated lists "top,sides"; bool "true"/"false"; vec3 "x,y,z".
 */

const pieceTypes = Object.keys(PIECES) as [string, ...string[]];

export const WirePieceSchema = z.object({
  type: z.enum(pieceTypes),
  at: z.array(z.number()),
  /** Empty for pieces without a size (spawn, switch, laser...). */
  size: z.array(z.number()),
  rot: z.number(),
  center: z.boolean(),
  params: z.array(z.object({ key: z.string(), value: z.string() })),
});

export const WireMapSchema = z.object({
  name: z.string(),
  hint: z.string(),
  blurb: z.string(),
  kind: z.enum(['combat', 'puzzle']),
  symmetry: z.enum(['none', 'rotate180']),
  fogColor: z.string(),
  fogNear: z.number(),
  fogFar: z.number(),
  killY: z.number(),
  pieces: z.array(WirePieceSchema),
});

export type WirePiece = z.infer<typeof WirePieceSchema>;
export type WireMap = z.infer<typeof WireMapSchema>;

const fieldOf = (type: string, key: string): FieldSpec | undefined => PIECES[type]?.fields?.find((f) => f.key === key);

const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/** One parameter value as the typed value the map file holds, or an error in words. */
function parseValue(f: FieldSpec, raw: string): { value: unknown } | { error: string } {
  const v = raw.trim();
  switch (f.kind) {
    case 'number': {
      const n = Number(v);
      return v !== '' && Number.isFinite(n) ? { value: n } : { error: `"${raw}" is not a number` };
    }
    case 'bool':
      return v === 'true' || v === 'false' ? { value: v === 'true' } : { error: `"${raw}" must be true or false` };
    case 'faces':
    case 'sides':
    case 'ids':
      return { value: list(v) };
    case 'vec3': {
      const parts = list(v).map(Number);
      return parts.length === 3 && parts.every(Number.isFinite) ? { value: parts as Vec3 } : { error: `"${raw}" must be three numbers "x,y,z"` };
    }
    default:
      return { value: v };
  }
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(',');
  return String(value);
}

export interface FromWire {
  map: MapData;
  /** Things in the wire map that could not be turned into map data; each is a problem to fix. */
  problems: string[];
  /** What was dropped without a repair: parameters the piece does not have (they would do nothing). */
  fixes: string[];
}

export interface WireOptions {
  /** Map id; default is a slug of the name plus a short random suffix. */
  id?: string;
}

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'map';

/** One wire piece as a map-file piece; `index` is only for the wording of problems. */
export function pieceFromWire(w: WirePiece, index: number): { piece: Piece; problems: string[]; fixes: string[] } {
  const problems: string[] = [];
  const fixes: string[] = [];
  const p: Piece = { type: w.type, at: w.at as Vec3 };
  if (w.size.length) p.size = w.size as Vec3;
  if (w.rot) p.rot = w.rot;
  if (w.center) p.center = true;
  const where = `piece #${index} (${w.type})`;
  for (const { key, value } of w.params) {
    const f = fieldOf(w.type, key);
    if (!f) {
      // A parameter the piece does not have changes nothing, so it is dropped rather than sent back to the model.
      fixes.push(`${where}: dropped unknown parameter "${key}"`);
      continue;
    }
    const r = parseValue(f, value);
    if ('error' in r) problems.push(`${where}: parameter "${key}": ${r.error}`);
    else p[key] = r.value;
  }
  return { piece: p, problems, fixes };
}

export function fromWire(wire: WireMap, opts: WireOptions = {}): FromWire {
  const problems: string[] = [];
  const fixes: string[] = [];
  const pieces: Piece[] = wire.pieces.map((w, i) => {
    const r = pieceFromWire(w, i);
    problems.push(...r.problems);
    fixes.push(...r.fixes);
    return r.piece;
  });
  const map: MapData = {
    id: opts.id ?? `${slug(wire.name)}-${Math.random().toString(36).slice(2, 6)}`,
    name: wire.name,
    hint: wire.hint,
    kind: wire.kind,
    symmetry: wire.symmetry,
    fog: { color: wire.fogColor, near: wire.fogNear, far: wire.fogFar },
    killY: wire.killY,
    pieces,
  };
  if (wire.blurb) map.blurb = wire.blurb;
  return { map, problems, fixes };
}

/** A map file in the model's shape (for few-shot examples, and for tests of the round trip). */
export function toWire(map: MapData): WireMap {
  return {
    name: map.name,
    hint: map.hint,
    blurb: map.blurb ?? '',
    kind: map.kind ?? 'combat',
    symmetry: map.symmetry ?? 'none',
    fogColor: map.fog?.color ?? '#0b0e14',
    fogNear: map.fog?.near ?? 30,
    fogFar: map.fog?.far ?? 150,
    killY: map.killY ?? -6,
    pieces: map.pieces.map((p) => ({
      type: p.type,
      at: [...p.at],
      size: p.size ? [...p.size] : [],
      rot: p.rot ?? 0,
      center: p.center === true,
      params: (PIECES[p.type]?.fields ?? [])
        .filter((f) => p[f.key] !== undefined && p[f.key] !== null)
        .map((f) => ({ key: f.key, value: formatValue(p[f.key]) })),
    })),
  };
}
