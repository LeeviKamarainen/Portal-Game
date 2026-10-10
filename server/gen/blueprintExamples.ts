import type { Area, Blueprint } from './blueprint';

/**
 * Two worked blueprints: shown to the planner as examples, and used by the tests as plans
 * that are known to be sound. The first describes the shipped Highwire map's structure (a
 * symmetric void level), so the tests can prove the map conforms to it.
 */

const area = (a: Partial<Area> & Pick<Area, 'id' | 'role' | 'what' | 'x' | 'z' | 'width' | 'depth' | 'baseY' | 'topY'>): Area => ({
  climbs: 'none',
  portals: false,
  center: false,
  hazards: [],
  ...a,
});

/** A symmetric combat level over a void: a landing, a spawn terrace with stairs up to a catwalk. */
export function combatExample(): Blueprint {
  return {
    kind: 'combat',
    size: 'large',
    symmetric: true,
    name: 'Highwire',
    hint: 'Hold the high ground, shoot portals across the gap, and do not fall.',
    concept: 'Two mirrored sides over a void: a ground landing, a high spawn terrace, and a catwalk reached by stairs.',
    roomWidth: 52,
    roomHeight: 26,
    roomDepth: 76,
    ground: 'void',
    areas: [
      area({ id: 'G1', role: 'ground', what: 'south landing, the only ground', x: 0, z: 23, width: 52, depth: 30, baseY: -3, topY: 0, portals: true }),
      area({ id: 'T1', role: 'raised', what: 'spawn terrace at the south wall', x: 0, z: 33, width: 52, depth: 10, baseY: 0, topY: 8, portals: true }),
      area({ id: 'S1', role: 'stairs', what: 'west stairs from the landing up to the terrace', x: -24, z: 18, width: 4, depth: 20, baseY: 0, topY: 8, climbs: 'south' }),
      area({ id: 'F2', role: 'floating', what: 'catwalk beside the terrace', x: 20, z: 23, width: 4, depth: 10, baseY: 7.5, topY: 8 }),
      area({ id: 'S2', role: 'stairs', what: 'east stairs up from the catwalk to the high bridge', x: 24, z: 19, width: 4, depth: 18, baseY: 8, topY: 16, climbs: 'north' }),
    ],
    links: [
      { from: 'G1', to: 'S1', how: 'walk', note: 'the stairs start on the landing' },
      { from: 'S1', to: 'T1', how: 'walk', note: 'the stairs top out on the terrace' },
      { from: 'T1', to: 'F2', how: 'walk', note: 'the catwalk continues the terrace edge' },
      { from: 'F2', to: 'S2', how: 'walk', note: 'stairs rise from the end of the catwalk' },
    ],
    spawns: [
      { area: 'T1', x: 0, z: 34 },
      { area: 'T1', x: -16, z: 34 },
    ],
    goal: { area: '', x: 0, z: 0 },
    notes: [],
    requirements: [],
  };
}

/** A solo puzzle on a floor: a raised ledge with the exit behind a hazard. */
export function puzzleExample(): Blueprint {
  return {
    kind: 'puzzle',
    size: 'medium',
    symmetric: false,
    name: 'Ledge and acid',
    hint: 'Put portals on the pale walls to get across the acid to the exit.',
    concept: 'A start platform, an acid pool with a portal wall beside it, and a high exit ledge.',
    roomWidth: 20,
    roomHeight: 8,
    roomDepth: 28,
    ground: 'floor',
    areas: [
      area({ id: 'P1', role: 'hazard-zone', what: 'acid pool between the start and the exit side', x: 0, z: 0, width: 20, depth: 8, baseY: 0, topY: 0.4, hazards: ['acid'] }),
      area({ id: 'W1', role: 'wall', what: 'portal wall beside the pool', x: -4, z: -2, width: 6, depth: 0.6, baseY: 0, topY: 4, portals: true }),
      area({ id: 'L1', role: 'raised', what: 'exit ledge at the far end', x: 0, z: -11, width: 12, depth: 6, baseY: 0, topY: 3, portals: true }),
    ],
    links: [{ from: 'FLOOR', to: 'L1', how: 'portal', note: 'a portal on the wall W1 and one on the ledge side' }],
    spawns: [{ area: 'FLOOR', x: 0, z: 11 }],
    goal: { area: 'L1', x: 0, z: -11 },
    notes: [],
    requirements: [],
  };
}
