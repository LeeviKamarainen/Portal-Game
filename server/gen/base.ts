import { PIECES, type MapData, type Piece } from '../../src/world/maps/MapFormat';
import { autofix } from './check';

/**
 * The map a "refine" request starts from. It comes from the page, so it is checked as
 * untrusted input before it is put in a prompt: it must be a map file whose pieces are known
 * types with finite positions, and small enough to be written out again in one answer.
 */

/** Refining rewrites the whole map, so it has to fit in one model answer with room to spare. */
export const REFINE_PIECES_MAX = 150;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): boolean => Array.isArray(v) && v.length === 3 && v.every(isNum);

/** The tidied map, or the reason it cannot be refined. */
export function cleanBaseMap(raw: unknown): { map: MapData } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'baseMap must be a map file.' };
  const m = raw as Record<string, unknown>;
  if (!Array.isArray(m.pieces)) return { error: 'baseMap has no pieces.' };
  if (m.pieces.length === 0) return { error: 'baseMap has no pieces to refine.' };
  if (m.pieces.length > REFINE_PIECES_MAX) return { error: `A map can be refined up to ${REFINE_PIECES_MAX} pieces; this one has ${m.pieces.length}.` };
  for (const [i, p] of m.pieces.entries()) {
    const piece = p as Partial<Piece> | null;
    if (typeof piece !== 'object' || piece === null) return { error: `baseMap piece ${i} is not an object.` };
    if (typeof piece.type !== 'string' || !Object.hasOwn(PIECES, piece.type)) return { error: `baseMap piece ${i} has an unknown type.` };
    if (!isVec3(piece.at)) return { error: `baseMap piece ${i} has no valid position.` };
    if (piece.size !== undefined && !isVec3(piece.size)) return { error: `baseMap piece ${i} has no valid size.` };
  }
  const copy = { ...m, name: typeof m.name === 'string' ? m.name : '', hint: typeof m.hint === 'string' ? m.hint : '' } as unknown as MapData;
  return { map: autofix(copy).map };
}
