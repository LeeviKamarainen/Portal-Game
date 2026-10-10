import { z } from 'zod';
import { BUILT_IN_MAPS, blankPuzzle } from '../../src/editor/templates';
import { PIECES, mapKind, withDefaults, type MapData, type MapKind, type Vec3 } from '../../src/world/maps/MapFormat';
import { buildCatalogue, renderExample } from './catalogue';
import { HAZARD_TYPES, blueprintText, roomSizeFor, type Blueprint, type RoomSize } from './blueprint';
import { combatExample, puzzleExample } from './blueprintExamples';

/**
 * Every prompt the graph sends, and the small structured answer of the review step. The big
 * static prompt (`draftSystem`) is identical for the draft and every repair so its cache is
 * shared between them; the planner has its own static prompt (`planSystem`).
 */

export type { RoomSize };
export { roomSizeFor };

export interface GenRequest {
  prompt: string;
  kind: 'auto' | MapKind;
  size: 'auto' | RoomSize;
  /** A refinement: change this map as the prompt says instead of designing a new one (already cleaned, see base.ts). */
  baseMap?: MapData;
}

export const CritiqueSchema = z.object({
  satisfies: z.boolean(),
  /** Concrete changes to make, only when something explicit in the request is missing. */
  issues: z.array(z.string()),
});
export type Critique = z.infer<typeof CritiqueSchema>;

let cachedSystem: string | undefined;
/** The static prompt of the draft and the repair: catalogue, rules, worked examples. Built once. */
export function draftSystem(): string {
  if (cachedSystem) return cachedSystem;
  const highwire = BUILT_IN_MAPS.find((m) => m.label.startsWith('Highwire'))!.data();
  // The shipped maps hide faces nobody sees; a model that copies that leaves floating platforms open underneath.
  for (const p of highwire.pieces) delete p.hide;
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
  "The game does not have turrets, pressure plates, weighted cubes, fizzlers, light bridges, funnels or gel yet. When the request asks for these (or for a copy of a level that uses them), approximate with what exists - shootable switches, laser + receiver + door, crates, hazards, portal surfaces - and say what was substituted in notes. You cannot reproduce another game's level exactly; recreate its idea and rough layout from memory as new geometry and say it is approximate in notes.";

let cachedPlan: string | undefined;
/** The static prompt of the planner (and of its corrections). */
export function planSystem(): string {
  if (cachedPlan) return cachedPlan;
  const hazards = HAZARD_TYPES.map((t) => `- ${t}: ${PIECES[t]?.help ?? ''}`).join('\n');
  const example = (bp: Blueprint) => JSON.stringify(bp);
  cachedPlan = `You are the level architect for a first-person portal-gun game. Before anything is built you write a blueprint: every part of the level as a rectangle seen from above with its heights, what it is for, how players get from each part to the next, and where they start. Code checks the blueprint and builds the structure directly from it, so the numbers must be exact and every part must connect. Reply only in the requested structure.

## Space
- Metres, y up. x runs east-west and z north-south: north is -z, south is +z, east is +x, west is -x. The room is centred on x=0, z=0, its floor is at y=0 and its ceiling at roomHeight. You choose roomWidth (x), roomHeight and roomDepth (z): combat 24-90 m wide and deep and 10-40 m tall; puzzle 10-40 m wide, 5-14 m tall and 10-50 m deep. Taller rooms for bigger height differences.
- An area is a rectangle: centre (x, z), width along x, depth along z. It must lie entirely inside the room.
- A player is 2 m tall, jumps about 1.8 m up and about 3.5 m across (5 m across on the level), and needs 2.5 m of free height above any surface they stand on. Keep heights on a 0.5 m grid.

## Ground
- ground "floor": the room has its own floor at y=0 under everything. Use this unless the level is about a void. A level on a floor needs no ground areas; every area you list stands on the floor or floats above it.
- ground "void": there is no floor and players fall to their death below the islands. Then you must list the islands as role "ground" areas with topY 0 (together they cover at least 12% of the room's footprint), and every spawn stands on an area.

## Area roles
- ground: a flat island of floor at y=0 (void levels).
- raised: a solid mass from baseY (normally 0) up to topY: a ledge, tower or terrace. Players stand on its top.
- floating: a thin slab hanging in the air with its top surface at topY and its underside at baseY (about 0.5 m lower).
- stairs: a staircase. baseY is its low end, topY its high end, climbs says which way it goes up. Its run (depth for north/south, width for east/west) must be at least as long as its rise.
- wall: a standing wall or portal wall; topY is its top edge. The smaller of width and depth is its thickness.
- hazard-zone: a patch where a hazard is the point (an acid pool, a spike field); list the hazard in hazards. Not walkable.
Set portals=true on areas whose top (for raised areas also their sides, for walls both faces) should take portals; give every tier and important wall some.
Use hazards to say which hazard types belong on or in an area, so "hazards on each platform" means every floating area lists at least one:
${hazards}

## Links: how players move between walkable areas
Every ground, raised, floating and stairs area must be reachable from a spawn through links (FLOOR names the room floor in floor levels; areas whose top is at most 1.5 m above the floor join it automatically).
- walk: the areas touch (gap at most 0.5 m) and their surfaces differ by at most 0.3 m (stairs touch at their low and high ends).
- jump: up at most 1.8 m with a gap of at most 3.5 m, or level with a gap of at most 5 m; down at most 10 m.
- portal: both areas have portals=true; the player shoots portals to cross.
- drop: one way, from a higher area onto a lower one (0.5-12 m down, gap at most 6 m).
Say the reason in note ("the stairs start on the landing").

## Spawns and goal
- spawns: x, z and the area they stand on (inside its rectangle, on flat ground, not on stairs). Combat needs at least 2 in total (a spawn on a mirrored area counts twice), at least 3 m apart.
- goal: puzzles have exactly one exit, on a flat walkable area. Combat levels set goal.area to "".

## Symmetry
For fair combat levels set symmetric=true: write only one half of the level; every area is copied with x -> -x, z -> -z (ids get a "~") unless its center flag is true, which you set for areas that lie across the centre point and are their own mirror image. Puzzles are never symmetric.

## A good plan
- A handful of clear parts (6-14), each with a purpose: spawn, fight space, high ground, hazard crossing, portal wall.
- Different heights, connected: no ledge without a way up, no island without a way across.
- Put hazards and portal surfaces where the request wants them, not everywhere.
- name is at most 40 characters; hint is one or two sentences telling the player how to play.
- notes: things the player should be told (approximations, missing mechanics); empty when the level is exactly what was asked.
- requirements: at most 4 explicit things the request asks for that can be checked from numbers (a count, a height difference, hazards on every platform). Empty when the request only names a style, a mood or another game's level.

${MISSING_MECHANICS}

## Example blueprints (they pass every check)
Combat, symmetric, over a void:
${example(combatExample())}

Puzzle, on a floor:
${example(puzzleExample())}`;
  return cachedPlan;
}

export function briefUser(req: GenRequest): string {
  const hints: string[] = [];
  if (req.kind !== 'auto') hints.push(`It must be a ${req.kind} map.`);
  if (req.size !== 'auto') {
    const [w, h, d] = roomSizeFor(req.kind === 'puzzle' ? 'puzzle' : 'combat', req.size);
    hints.push(`Use a ${req.size} room, about ${w} x ${h} x ${d} m.`);
  }
  return `Write the blueprint for this map: ${req.prompt}${hints.length ? `\n${hints.join(' ')}` : ''}`;
}

export function replanUser(req: GenRequest, plan: Blueprint, problems: string[]): string {
  return `Request: ${req.prompt}\n\nYour blueprint:\n${JSON.stringify(plan)}\n\nThe checker found these problems with it. Fix every one:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nReturn the complete corrected blueprint. Change only what is needed.`;
}

/** The drawing step: the structure is already built from the plan; the model adds what the plan lists and the request asks for. */
export function fillUser(req: GenRequest, plan: Blueprint, scaffoldJson: string): string {
  return `Design request: ${req.prompt}

The blueprint of the level:
${blueprintText(plan)}

The structure has already been built from the blueprint. This is the map so far (pieces are numbered from 0 in this order):
${scaffoldJson}

Finish the map and return the complete map. It must contain every piece above, unchanged in position and size and still in the same order, and in addition:
- the hazards each area lists, placed on or in that area (a hazard on a platform stands on its top surface; spikes and acid pools take the footprint they cover),
- the portal walls, cover, switches and other detail that the request and the concept call for; lights are added for you,
- a better name or hint if the concept calls for it.
Do not move, resize or remove the built pieces, do not add another room, and do not put hazards on spawns or the goal.`;
}

/** A refinement: the existing map, as the model writes maps, and what to change in it. */
export function refineUser(req: GenRequest, mapJson: string): string {
  return `Change this existing map as asked. Keep its name (unless the change is about it), its layout and every piece that the request does not mention.\n\nRequested change: ${req.prompt}\n\nThe existing map (pieces are numbered from 0 in this order):\n${mapJson}\n\nReply with the complete changed map.`;
}

export function repairUser(req: GenRequest, plan: Blueprint | null, previousJson: string, problems: string[]): string {
  const intro = plan ? `Design request: ${req.prompt}\n\nThe blueprint:\n${blueprintText(plan)}` : `Requested change to an existing map: ${req.prompt}`;
  return `${intro}\n\nHere is the map you produced, after automatic tidying (pieces are numbered from 0 in this order):\n${previousJson}\n\nThese problems were found. Fix every one of them:\n${problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}\n\nReturn the complete corrected map. Keep everything that works; change only what is needed to fix the problems.`;
}

export function critiqueSystem(): string {
  return `You check a finished level against a short list of requirements taken from the request that made it. You see the requirements and a summary of the map, not the pieces. Judge only the listed requirements, each strictly by the numbers in the summary (for example "hazards on each platform" fails if the summary lists a floating surface with "no hazard"; "big height differences" fails if the surface heights are all within a few metres). A requirement the summary does not show either way (it lists counts, heights and hazards, not layout, direction or looks) is not a failure: count it as met. Report an issue only when the summary positively shows a requirement broken: a count below what was asked, a platform listed with "no hazard", surface heights too close together. Say satisfies=true when no requirement is shown broken. Never add requirements of your own: not taste, not balance, not resemblance to another game's level. When satisfies is false, give at most 3 issues, each naming the failing requirement and one concrete change a level designer could make. Reply only in the requested structure.`;
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
