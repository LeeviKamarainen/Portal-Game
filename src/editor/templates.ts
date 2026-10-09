import type { MapData } from '../world/maps/MapFormat';
import highwire from '../world/maps/highwire.json';
import catwalk from '../world/maps/catwalk.json';
import shaft from '../world/maps/shaft.json';
import courtyard from '../world/maps/courtyard.json';

/**
 * What "New map" starts from: a symmetric two-team room with portal walls, a dark ceiling
 * with pale portal slots in it, lights, and a spawn for each team - playable as it is.
 */
export function blankMap(): MapData {
  return {
    id: 'pvp-new-map',
    name: 'New map',
    hint: 'A custom arena.',
    blurb: '',
    kind: 'combat',
    symmetry: 'rotate180',
    fog: { color: '#0c1018', near: 40, far: 160 },
    killY: -6,
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [48, 20, 48], portal: ['walls', 'floor'], center: true },
      { type: 'lights', at: [0, 20, 0], size: [48, 0, 48], spacing: 8, center: true },
      { type: 'ceiling-slot', at: [0, 20, 0], size: [5, 0.3, 5], center: true },
      { type: 'ceiling-slot', at: [12, 20, 12], size: [4, 0.3, 4] },
      { type: 'ceiling-slot', at: [-12, 20, 12], size: [4, 0.3, 4] },
      { type: 'spawn', at: [0, 0, 20], rot: 0, team: 'orange' },
    ],
  };
}

/**
 * A puzzle to build on: one room with a low divider, a spawn at one end and the exit at the
 * other - reach it by portalling over the divider. No symmetry, no teams.
 */
export function blankPuzzle(): MapData {
  return {
    id: 'puzzle-new-level',
    name: 'New puzzle',
    hint: 'Pale panels take portals. Get to the exit.',
    blurb: '',
    kind: 'puzzle',
    symmetry: 'none',
    fog: { color: '#0e121a', near: 30, far: 110 },
    killY: -6,
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [20, 8, 28], portal: ['walls', 'floor'] },
      { type: 'lights', at: [0, 8, 0], size: [20, 0, 28], spacing: 5 },
      { type: 'block', at: [0, 0, 0], size: [20, 3.2, 1], portal: ['front', 'back'] },
      { type: 'spawn', at: [0, 0, 10], rot: 0, team: 'orange' },
      { type: 'goal', at: [0, 0, -10] },
    ],
  };
}

/** Maps that ship with the game, to open as a starting point. */
export const BUILT_IN_MAPS: { label: string; data: () => MapData }[] = [
  { label: 'Highwire (PvP)', data: () => structuredClone(highwire as MapData) },
  { label: 'Catwalk (PvP)', data: () => structuredClone(catwalk as MapData) },
  { label: 'Shaft (PvP)', data: () => structuredClone(shaft as MapData) },
  { label: 'Courtyard (PvP)', data: () => structuredClone(courtyard as MapData) },
  { label: 'Blank combat template', data: blankMap },
  { label: 'Blank puzzle template', data: blankPuzzle },
];
