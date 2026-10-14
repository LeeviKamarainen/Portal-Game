import type { Area, Blueprint, Feature } from './blueprint';

/**
 * Worked blueprints: shown to the planner as examples (Highwire, Crevasse, the puzzle), and used
 * by the tests as plans that are known to be sound. The first describes the shipped Highwire
 * map's structure (a symmetric void level), so the tests can prove the map conforms to it.
 * Sinkhole is a test plan only: it answers a golden prompt, so showing it would teach the eval.
 */

export const area = (a: Partial<Area> & Pick<Area, 'id' | 'role' | 'what' | 'x' | 'z' | 'width' | 'depth' | 'baseY' | 'topY'>): Area => ({
  climbs: 'none',
  portals: false,
  center: false,
  hazards: [],
  from: '',
  to: '',
  around: '',
  ...a,
});

export const feature = (f: Partial<Feature> & Pick<Feature, 'what' | 'words'>): Feature => ({ where: 'anywhere', size: 'any', count: 0, metres: 0, hazard: 'none', ...f });

/** A symmetric combat level over a void: a landing, a spawn terrace with stairs up to a catwalk. */
export function combatExample(): Blueprint {
  return {
    features: [feature({ what: 'void', words: 'over a void' }), feature({ what: 'height-spread', metres: 8, words: 'high ground' })],
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
      area({ id: 'S1', role: 'stairs', what: 'west stairs from the landing up to the terrace', x: -24, z: 18, width: 4, depth: 20, baseY: 0, topY: 8, from: 'G1', to: 'T1' }),
      area({ id: 'F2', role: 'floating', what: 'catwalk beside the terrace', x: 20, z: 23, width: 4, depth: 10, baseY: 7.5, topY: 8 }),
      area({ id: 'S2', role: 'stairs', what: 'east stairs up from the catwalk to the high bridge', x: 24, z: 19, width: 4, depth: 18, baseY: 8, topY: 16, climbs: 'north' }),
    ],
    links: [
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
    features: [feature({ what: 'pool', where: 'center', size: 'medium', words: 'an acid pool between start and exit' })],
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
      area({ id: 'P1', role: 'pool', what: 'acid pool between the start and the exit side', x: 0, z: 0, width: 20, depth: 8, baseY: 0, topY: 0.4 }),
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

/** A symmetric combat level on a floor with a bottomless hole in the middle: platforms, stairs and a bridge written as relations. */
export function sinkholeExample(): Blueprint {
  return {
    features: [
      feature({ what: 'hole', where: 'center', size: 'large', words: 'a giant hole in the middle' }),
      feature({ what: 'platforms', count: 3, words: 'three platforms' }),
      feature({ what: 'bridge', words: 'a bridge' }),
    ],
    kind: 'combat',
    size: 'medium',
    symmetric: true,
    name: 'Sinkhole',
    hint: 'Fight around the hole; the middle platform is reached only by portal.',
    concept: 'A floor with a bottomless hole in the middle, a raised platform on each side joined by a bridge to a ledge, and a floating platform over the hole.',
    roomWidth: 48,
    roomHeight: 20,
    roomDepth: 48,
    ground: 'floor',
    areas: [
      area({ id: 'H1', role: 'pit', what: 'the hole in the middle', x: 0, z: 0, width: 20, depth: 20, baseY: 0, topY: 0, center: true }),
      area({ id: 'C1', role: 'floating', what: 'platform floating over the hole', x: 0, z: 0, width: 6, depth: 6, baseY: 5.5, topY: 6, portals: true, center: true }),
      area({ id: 'P1', role: 'raised', what: 'north platform', x: 0, z: -18, width: 12, depth: 8, baseY: 0, topY: 4, portals: true }),
      area({ id: 'E1', role: 'raised', what: 'north-east ledge', x: 17, z: -18, width: 6, depth: 8, baseY: 0, topY: 4, portals: true }),
      area({ id: 'S1', role: 'stairs', what: 'stairs from the floor up to the north platform', x: -8.5, z: -18, width: 3, depth: 0, baseY: 0, topY: 0, from: 'FLOOR', to: 'P1' }),
      area({ id: 'B1', role: 'bridge', what: 'bridge from the platform to the ledge', x: 0, z: -18, width: 2, depth: 0, baseY: 0, topY: 0, from: 'P1', to: 'E1' }),
    ],
    links: [{ from: 'FLOOR', to: 'C1', how: 'portal', note: 'portals on the room walls and the platform top' }],
    spawns: [
      { area: 'P1', x: -3, z: -18 },
      { area: 'E1', x: 17, z: -18 },
    ],
    goal: { area: '', x: 0, z: 0 },
    notes: [],
    requirements: [],
  };
}

/** A symmetric combat level on a floor cut by crevasses: a terrace with a lookout, stairs and a bridge written as relations. */
export function crevasseExample(): Blueprint {
  return {
    features: [
      feature({ what: 'hole', where: 'north', size: 'medium', words: 'a crevasse along the north side' }),
      feature({ what: 'levels', count: 3, words: 'three heights' }),
      feature({ what: 'bridge', words: 'a bridge over the crevasse' }),
    ],
    kind: 'combat',
    size: 'medium',
    symmetric: true,
    name: 'Crevasse',
    hint: 'Cross the crevasse by the bridge or by portal, and hold the lookout.',
    concept: 'A floor cut by a bottomless crevasse near each end wall, a terrace with a lookout on top, and a bridge from the terrace over the crevasse to a ledge by the wall.',
    roomWidth: 48,
    roomHeight: 20,
    roomDepth: 48,
    ground: 'floor',
    areas: [
      area({ id: 'C1', role: 'pit', what: 'crevasse along the north side', x: 0, z: -16, width: 30, depth: 6, baseY: 0, topY: 0 }),
      area({ id: 'T1', role: 'raised', what: 'west terrace', x: -17, z: -5, width: 10, depth: 10, baseY: 0, topY: 3, portals: true }),
      area({ id: 'U1', role: 'raised', what: 'lookout on the terrace', x: -20, z: -7, width: 4, depth: 4, baseY: 3, topY: 6, portals: true }),
      area({ id: 'N1', role: 'raised', what: 'ledge by the north wall, beyond the crevasse', x: -14, z: -22, width: 12, depth: 4, baseY: 0, topY: 3, portals: true }),
      area({ id: 'S1', role: 'stairs', what: 'stairs from the floor up to the terrace', x: -17, z: 3, width: 3, depth: 0, baseY: 0, topY: 0, from: 'FLOOR', to: 'T1' }),
      area({ id: 'S2', role: 'stairs', what: 'stairs from the terrace up to the lookout', x: -16, z: -7, width: 3, depth: 0, baseY: 0, topY: 0, from: 'T1', to: 'U1' }),
      area({ id: 'B1', role: 'bridge', what: 'bridge over the crevasse to the wall ledge', x: -13, z: -15, width: 2, depth: 0, baseY: 0, topY: 0, from: 'T1', to: 'N1' }),
    ],
    links: [],
    spawns: [
      { area: 'T1', x: -15, z: -2 },
      { area: 'N1', x: -14, z: -22 },
    ],
    goal: { area: '', x: 0, z: 0 },
    notes: [],
    requirements: [],
  };
}
