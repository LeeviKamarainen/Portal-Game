import type { MapData } from '../world/maps/MapFormat';
import highwire from '../world/maps/highwire.json';

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

/** Maps that ship with the game, to open as a starting point. */
export const BUILT_IN_MAPS: { label: string; data: () => MapData }[] = [
  { label: 'Highwire (PvP)', data: () => structuredClone(highwire as MapData) },
  { label: 'Blank template', data: blankMap },
];
