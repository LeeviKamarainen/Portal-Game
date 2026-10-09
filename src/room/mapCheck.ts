import { ArenaSim } from '../sim/ArenaSim';
import { mapKind, mapToArena, type MapData } from '../world/maps/MapFormat';
import { BUILT_IN_ONLINE_MAPS, MAP_JSON_MAX, MAP_PIECES_MAX, MAX_SLOTS, type MapChoice } from '../net/protocol';

/** A map a room can play: proven to build, with the number of players it has spawn pads for. */
export interface CheckedMap {
  data: MapData;
  /** Built-in id, or null for a host's own map. */
  builtin: string | null;
  name: string;
  slots: number;
}

const builtins = new Map<string, Promise<CheckedMap | string>>();

/**
 * Whether a room can play `choice`, or why not (in words for the host). A custom map has to
 * be a combat map of sane size, and is built once headless - exactly as the match will build
 * it - so a map that would fail to load never gets as far as anyone's screen.
 */
export function checkMap(choice: MapChoice): Promise<CheckedMap | string> {
  if (choice.kind === 'builtin') {
    const found = BUILT_IN_ONLINE_MAPS.find((m) => m.id === choice.id);
    if (!found) return Promise.resolve(`There is no built-in map "${String(choice.id).slice(0, 40)}".`);
    let checked = builtins.get(found.id);
    if (!checked) {
      checked = build(found.data, found.id);
      builtins.set(found.id, checked);
    }
    return checked;
  }
  return checkCustom(choice.data);
}

/**
 * Why `raw` can't even be stored or sent as a map (not a map file, no name, too big), or null.
 * Cheap: nothing is built. Whether it is playable is `checkMap`'s question.
 */
export function mapProblem(raw: unknown): string | null {
  const data = raw as MapData;
  if (!data || typeof data !== 'object' || !Array.isArray(data.pieces)) return "That isn't a map file.";
  if (typeof data.id !== 'string' || typeof data.name !== 'string') return 'The map has no id or name.';
  if (JSON.stringify(data).length > MAP_JSON_MAX) return `The map is too big to send (over ${MAP_JSON_MAX / 1024} KB).`;
  if (data.pieces.length > MAP_PIECES_MAX) return `The map has too many pieces (over ${MAP_PIECES_MAX}).`;
  return null;
}

async function checkCustom(raw: unknown): Promise<CheckedMap | string> {
  const problem = mapProblem(raw);
  if (problem) return problem;
  const data = raw as MapData;
  if (mapKind(data) === 'puzzle') return 'Puzzle maps are single-player; online rooms play combat maps.';
  return build(data, null);
}

async function build(data: MapData, builtin: string | null): Promise<CheckedMap | string> {
  let sim: ArenaSim;
  try {
    sim = await ArenaSim.load(mapToArena(data), {});
  } catch (e) {
    return `The map didn't build: ${(e as Error).message}`;
  }
  const spawns = sim.arena.spawns.length;
  sim.dispose();
  if (spawns < 2) return `The map has ${spawns} spawn point${spawns === 1 ? '' : 's'}; a match needs at least 2.`;
  return { data, builtin, name: data.name.slice(0, 40) || 'Untitled map', slots: Math.min(MAX_SLOTS, spawns) };
}
