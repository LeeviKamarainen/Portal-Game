import type * as THREE from 'three';
import type { PhysicsWorld } from '../../physics/PhysicsWorld';
import type { PlayerController } from '../../player/PlayerController';
import type { PortalSystem } from '../../portals/PortalSystem';
import type { SoundName } from '../../sim/SimEvents';
import type { PropBox } from './PropBox';

export interface HazardContext {
  time: number;
  physics: PhysicsWorld;
  /** Every player in the arena who is alive and in play. */
  players: readonly PlayerController[];
  props: PropBox[];
  portals: PortalSystem;
  /**
   * Makes a sound: at full `volume` everywhere, or fading out over `radius` metres from `at`.
   * (The simulation has no speakers; whoever presents it decides who hears what.)
   */
  sound(name: SoundName, volume: number, at?: THREE.Vector3, radius?: number): void;
  kill(player: PlayerController, cause: string): void;
  /** Online, on a player's screen: the game server owns everything that isn't timing (crates, deaths). */
  netClient?: boolean;
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

/** Something that is on or off and can hold a door open: a lit laser receiver, a pressed floor button. */
export interface PowerSource {
  readonly powered: boolean;
}

export interface Hazard {
  /** Before the physics step - kinematic movers set their next pose here. */
  prePhysics?(dt: number, ctx: HazardContext): void;
  /** After the physics step and portal travel. */
  update(dt: number, ctx: HazardContext): void;
  /** Back to the initial state (on player respawn). */
  reset?(): void;
  /**
   * Online: whatever changes as it runs (phase, timers), as numbers - the game server sends
   * it in its snapshots and each player's copy of the arena takes it (see net/snapshot).
   * Hazards without it are the same on every screen (acid, beams traced every step).
   */
  netState?(): number[];
  setNetState?(state: readonly number[]): void;
  /** Whether it makes the floor at `p` deadly, so nothing should be put there (point orbs). */
  covers?(p: THREE.Vector3): boolean;
  /**
   * For bots: whether the floor it covers is deadly right now or about to be - true from
   * the moment its warning shows. Without this method, it is always deadly (acid).
   */
  dangerNow?(): boolean;
  /** For bots: deadly whatever its phase (static spikes) - left off the navigation map, like acid. */
  readonly alwaysDeadly?: boolean;
  /**
   * For bots: when whoever is on the floor it `covers` dies - seconds from now, `from` to
   * `to` (a body that lands inside that window is killed on the spot). Null: not in the
   * foreseeable future. Hazards that don't say are treated as not timeable and left out of
   * portal-trap planning (acid, which has no phases, is always deadly).
   */
  deadlyWindow?(): DeadlyWindow | null;
}

export interface DeadlyWindow {
  from: number;
  to: number;
}

/** Volume falloff for positional one-shot sounds. */
export function distanceGain(listener: THREE.Vector3, at: THREE.Vector3, radius = 25): number {
  const d = listener.distanceTo(at);
  return Math.max(0, 1 - d / radius);
}
