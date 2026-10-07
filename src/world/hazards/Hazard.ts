import type * as THREE from 'three';
import type { PhysicsWorld } from '../../physics/PhysicsWorld';
import type { PlayerController } from '../../player/PlayerController';
import type { PortalSystem } from '../../portals/PortalSystem';
import type { Audio } from '../../core/Audio';
import type { PropBox } from './PropBox';

export interface HazardContext {
  time: number;
  physics: PhysicsWorld;
  /** Every player in the arena who is alive and in play. */
  players: readonly PlayerController[];
  props: PropBox[];
  portals: PortalSystem;
  audio: Audio;
  /** Where sounds are heard from (the camera). */
  listener: THREE.Vector3;
  kill(player: PlayerController, cause: string): void;
  /**
   * Damage from an object (a beam): `credit` is the owner of the last portal it came out
   * of, if any, for kill credit.
   */
  hurtPlayer(player: PlayerController, amount: number, credit: string | null): void;
  /** Arena-wide effects a switch can set off. */
  effects: ArenaEffects;
}

export interface ArenaEffects {
  /** Closes every open portal. */
  clearPortals(): void;
  /** Multiplies gravity for everyone and everything for a while. */
  setGravity(factor: number, seconds: number): void;
}

/** A hazard a switch can set off (see Switch); `auto: false` hazards only act when triggered. */
export interface Triggerable {
  trigger(): void;
}

export interface Hazard {
  /** Before the physics step - kinematic movers set their next pose here. */
  prePhysics?(dt: number, ctx: HazardContext): void;
  /** After the physics step and portal travel. */
  update(dt: number, ctx: HazardContext): void;
  /** Back to the initial state (on player respawn). */
  reset?(): void;
  /** Whether it makes the floor at `p` deadly, so nothing should be put there (point orbs). */
  covers?(p: THREE.Vector3): boolean;
  /**
   * For bots: whether the floor it covers is deadly right now or about to be - true from
   * the moment its warning shows. Without this method, it is always deadly (acid).
   */
  dangerNow?(): boolean;
  /** For bots: deadly whatever its phase (static spikes) - left off the navigation map, like acid. */
  readonly alwaysDeadly?: boolean;
}

/** Volume falloff for positional one-shot sounds. */
export function distanceGain(listener: THREE.Vector3, at: THREE.Vector3, radius = 25): number {
  const d = listener.distanceTo(at);
  return Math.max(0, 1 - d / radius);
}
