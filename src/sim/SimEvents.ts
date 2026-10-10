import type * as THREE from 'three';
import type { PortalColor } from '../portals/Portal';

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
  | 'click'
  | 'launch';

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
  source: SoundSource;
}

/** Who made a sound: a player (by id), a hazard, or nobody in particular. */
export type SoundSource = string | 'hazard' | null;

/** What a portal shot did: opened a portal, fizzled, took someone's portal, or set off a switch. */
export type ShotOutcome = 'fizzle' | 'placed' | 'stolen' | 'switch';

/** A portal shot: from the muzzle (or eye) to where it hit. */
export interface SimShot {
  player: string;
  color: PortalColor;
  from: THREE.Vector3;
  to: THREE.Vector3;
  outcome: ShotOutcome;
  normal: THREE.Vector3 | null;
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
