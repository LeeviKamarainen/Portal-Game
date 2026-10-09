import { z } from 'zod';
import { BUILT_IN_MAPS, blankPuzzle } from '../../src/editor/templates';
import { PIECES, mapKind, withDefaults, type MapData, type MapKind, type Vec3 } from '../../src/world/maps/MapFormat';
import { buildCatalogue, renderExample } from './catalogue';

/**
 * Every prompt the graph sends, and the small structured answers of the planning and review
 * steps. The big static prompt (`draftSystem`) is identical for the draft and every repair so
 * its cache is shared between them.
 */

export type RoomSize = 'small' | 'medium' | 'large';

export interface GenRequest {
  prompt: string;
  kind: 'auto' | MapKind;
  size: 'auto' | RoomSize;
}

export const BriefSchema = z.object({
  kind: z.enum(['combat', 'puzzle']),
  size: z.enum(['small', 'medium', 'large']),
  symmetric: z.boolean(),
  concept: z.string(),
  tiers: z.array(z.object({ name: z.string(), floorY: z.number(), purpose: z.string() })),
  hazards: z.array(z.string()),
  portalPlan: z.string(),
  /** What to tell the user: approximations, mechanics the game lacks, anything the map does differently from the request. */
  notes: z.array(z.string()),
  /** Explicit, countable things the request asks for, which the review step checks the finished map against. */
  requirements: z.array(z.string()),
});
export type Brief = z.infer<typeof BriefSchema>;

export const CritiqueSchema = z.object({
  satisfies: z.boolean(),
  /** Concrete changes to make, only when something explicit in the request is missing. */
  issues: z.array(z.string()),
});
export type Critique = z.infer<typeof CritiqueSchema>;

const ROOMS: Record<MapKind, Record<RoomSize, Vec3>> = {
  combat: { small: [32, 16, 32], medium: [48, 20, 48], large: [64, 28, 64] },
  puzzle: { small: [16, 6, 20], medium: [20, 8, 28], large: [28, 10, 40] },
};
export const roomSizeFor = (kind: MapKind, size: RoomSize): Vec3 => ROOMS[kind][size];

let cachedSystem: string | undefined;
/** The static prompt of the draft and the repair: catalogue, rules, worked examples. Built once. */
export function draftSystem(): string {
  if (cachedSystem) return cachedSystem;
  const highwire = BUILT_IN_MAPS.find((m) => m.label.startsWith('Highwire'))!.data();
  cachedSystem =
    buildCatalogue() +
    '\n# Worked examples\nThese are complete, valid maps. Study how heights line up and where spawns stand.\n\n' +
    renderExample('Highwire, a symmetric combat map with three tiers', highwire) +
    '\n' +
    renderExample('A minimal puzzle map', blankPuzzle());
  return cachedSystem;
}

/** Game limits the planning step has to know about. Update when milestone 5 adds mechanics. */
const MISSING_MECHANICS =
  'The game does not have turrets, pressure plates, weighted cubes, fizzlers, light bridges, funnels or gel yet. When the request asks for these (or for a copy of a level that uses them), approximate with what exists - shootable switches, laser + receiver + door, crates, hazards, portal surfaces - and say what was substituted in notes. You cannot reproduce another game\'s level exactly; recreate its idea and rough layout from memory as new geometry and say it is approximate in notes.';

export function briefSystem(): string {
  const pieces = Object.entries(PIECES)
    .map(([t, s]) => `- ${t}: ${s.help}`)
    .join('\n');
  return `You plan levels for a first-person portal-gun game, before anyone places a single piece. Reply only in the requested structure.

Pieces the level can use:
${pieces}

${MISSING_MECHANICS}

Planning rules:
- kind "combat" is a scored match for 2-4 players (needs spawns, symmetric layouts are fair); kind "puzzle" is solo, ends at an exit goal. Pick what the request implies; when it does not say, pick combat.
- size: small, medium or large room. Big height differences need a tall room.
- tiers: the walkable levels from the floor up, each with a floorY in metres and what it is for. Adjacent tiers need a way up (stairs, or portals, or a platform within a 2 m jump). Keep floorY values on a 0.5 m grid.
- hazards: which hazards go where, as short sentences. Hazards on platforms stand on the platform top.
- portalPlan: where portal surfaces go so portals are useful (one sentence).
- notes: things the player of this map should be told. Empty when the map does exactly what was asked.
- requirements: at most 4 explicit things the request asks for that can be checked from numbers - a count, a height difference, hazards placed on every platform, a kind of piece. Write each as a short checkable statement. Leave it empty when the request only names a style, a mood, or another game's level ("copy level X"): resemblance cannot be checked.`;
}

export function briefUser(req: GenRequest): string {
  const hints = [req.kind !== 'auto' ? `It must be a ${req.kind} map.` : '', req.size !== 'auto' ? `Use a ${req.size} room.` : ''].filter(Boolean).join(' ');
  return `Plan this map: ${req.prompt}${hints ? `\n${hints}` : ''}`;
}

function planText(req: GenRequest, brief: Brief): string {
  const [w, h, d] = roomSizeFor(brief.kind, req.size === 'auto' ? brief.size : req.size);
  return [
    `Kind: ${brief.kind}. Symmetric: ${brief.symmetric ? 'yes, symmetry rotate180 (author one half, mark centre pieces center=true)' : 'no, symmetry none'}.`,
    `Room: about ${w} x ${h} x ${d} m (width x height x depth), centred on x=0, z=0, floor at y=0.`,
    `Concept: ${brief.concept}`,
    `Tiers (floor height - purpose): ${brief.tiers.map((t) => `${t.floorY} m - ${t.name}: ${t.purpose}`).join('; ') || 'one level'}.`,
    `Hazards: ${brief.hazards.join('; ') || 'none planned'}.`,
    `Portal surfaces: ${brief.portalPlan}`,
  ].join('\n');
}

export function draftUser(req: GenRequest, brief: Brief): string {
  return `Design this map: ${req.prompt}\n\nPlan to follow:\n${planText(req, brief)}\n\nUse enough pieces to make the level feel built, not a bare room. Reply with the complete map.`;
}

export function repairUser(req: GenRequest, brief: Brief, previousJson: string, problems: string[]): string {
  return `Design request: ${req.prompt}\n\nPlan:\n${planText(req, brief)}\n\nHere is the map you produced, after automatic tidying (pieces are numbered from 0 in this order):\n${previousJson}\n\nThese problems were found. Fix every one of them:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nReturn the complete corrected map. Keep everything that works; change only what is needed to fix the problems.`;
}

export function critiqueSystem(): string {
  return `You check a finished level against a short list of requirements taken from the request that made it. You see the requirements and a summary of the map, not the pieces. Judge only the listed requirements, each strictly by the numbers in the summary (for example "hazards on each platform" fails if the summary lists a floating surface with "no hazard"; "big height differences" fails if the surface heights are all within a few metres). Say satisfies=true when every requirement holds. Never add requirements of your own: not taste, not balance, not resemblance to another game's level. When satisfies is false, give at most 3 issues, each naming the failing requirement and one concrete change a level designer could make. Reply only in the requested structure.`;
}

export function critiqueUser(req: GenRequest, requirements: string[], summary: string): string {
  return `Request: ${req.prompt}\n\nRequirements to check:\n${requirements.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nMap summary:\n${summary}`;
}

/** A short factual description of a map, for the review step. */
export function summarizeMap(map: MapData): string {
  const pieces = map.pieces.map(withDefaults);
  const byType = new Map<string, number>();
  for (const p of pieces) byType.set(p.type, (byType.get(p.type) ?? 0) + 1);
  const room = pieces.find((p) => p.type === 'room');
  const tops = new Map<number, string[]>();
  for (const p of pieces) {
    if (!['floor', 'block', 'portal-wall', 'wall', 'stairs'].includes(p.type) || !Array.isArray(p.size)) continue;
    const y = Math.round((p.at[1] + p.size[1]) * 2) / 2;
    tops.set(y, [...(tops.get(y) ?? []), p.type]);
  }
  const levels = [...tops.entries()].sort((a, b) => a[0] - b[0]).map(([y, t]) => `y=${y} (${t.length} piece${t.length === 1 ? '' : 's'})`);
  const hazardTypes = ['acid', 'spikes', 'trapdoor', 'crusher', 'ram', 'laser', 'platform', 'dropper'];
  const hazards = pieces.filter((p) => hazardTypes.includes(p.type)).map((p) => `${p.type} at ${p.at.map((n) => Math.round(n * 10) / 10).join(',')}`);
  const portalPieces = pieces.filter((p) => Array.isArray(p.portal) && p.portal.length).length;

  // Floating surfaces (clear of the room floor) and what stands on each, so "hazards on every platform" can be judged.
  const floorY = Array.isArray(room?.at) ? room.at[1] : 0;
  const onSurface = ['spikes', 'crusher', 'ram', 'laser', 'dropper', 'trapdoor'];
  const floating = pieces
    .filter((p) => ['floor', 'block', 'platform'].includes(p.type) && Array.isArray(p.size))
    .map((p) => {
      const [w, h, d] = p.size as Vec3;
      const moving = p.type === 'platform';
      const bottom = moving ? p.at[1] - h / 2 : p.at[1];
      return { p, w, d, bottom, top: bottom + h };
    })
    .filter((s) => s.bottom >= floorY + 1);
  const surfaces = floating.slice(0, 12).map((s) => {
    const mine = pieces.filter(
      (h) => onSurface.includes(h.type) && Math.abs(h.at[0] - s.p.at[0]) <= s.w / 2 + 0.5 && Math.abs(h.at[2] - s.p.at[2]) <= s.d / 2 + 0.5 && h.at[1] >= s.top - 0.3 && h.at[1] <= s.top + 6,
    );
    return `  - ${s.p.type} at [${s.p.at.map((n) => Math.round(n * 10) / 10).join(', ')}], top y=${Math.round(s.top * 10) / 10}: ${mine.length ? mine.map((h) => h.type).join(', ') : 'no hazard'}`;
  });
  return [
    `Name: ${map.name}. Kind: ${mapKind(map)}. Symmetry: ${map.symmetry ?? 'none'}.`,
    `Room size: ${Array.isArray(room?.size) ? room.size.join(' x ') : 'unknown'} m.`,
    `Pieces (${pieces.length}): ${[...byType.entries()].map(([t, n]) => `${n} ${t}`).join(', ')}.`,
    `Distinct surface heights: ${levels.join(', ') || 'none'}.`,
    `Hazards (${hazards.length}): ${hazards.join('; ') || 'none'}.`,
    `Pieces with portal surfaces: ${portalPieces}.`,
    `Floating surfaces, clear of the floor (${floating.length}):${surfaces.length ? '\n' + surfaces.join('\n') : ' none'}`,
  ].join('\n');
}
