import type * as THREE from 'three';

/** Every sound the game can make (synthesized by core/Audio in the browser). */
export type SoundName =
  | 'shootOrange'
  | 'shootBlue'
  | 'portalOpen'
  | 'fizzle'
  | 'teleport'
  | 'hurt'
  | 'death'
  | 'respawn'
  | 'goal'
  | 'slam'
  | 'warn'
  | 'door'
  | 'sizzle'
  | 'orb'
  | 'steal'
  | 'land'
  | 'click';

/**
 * A sound the simulation made. `at` null: heard at full `volume` wherever you are (a click
 * on your own gun, an arena-wide effect); otherwise it fades out over `radius` metres from
 * `at` (see Hazard.distanceGain).
 */
export interface SimSound {
  name: SoundName;
  volume: number;
  at: THREE.Vector3 | null;
  radius: number;
}

export type SessionEvent =
  /** `by`: who gets the kill credit, if anyone (see Match). */
  | { type: 'death'; player: string; cause: string; by: string | null }
  | { type: 'goal' }
  | { type: 'score'; player: string; points: number; reason: 'orb' | 'kill'; victim?: string }
  | { type: 'win'; player: string }
  | { type: 'steal'; thief: string; victim: string };

/**
 * Something audible happening, for bots' hearing (see bots/Perception). `source` is the
 * player who made it, if any; `radius` is how far it carries.
 */
export interface Noise {
  kind: 'shot' | 'portal' | 'teleport' | 'land' | 'step' | 'steal';
  position: THREE.Vector3;
  radius: number;
  source: string | null;
}
