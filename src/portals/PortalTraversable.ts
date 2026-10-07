import type * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import type { Portal } from './Portal';
import type { PortalTrip } from '../game/Match';

/** Anything that can pass through a portal: the player and physics props. */
export interface PortalTraversable {
  readonly kind: 'player' | 'prop';
  readonly colliderHandle: number;
  /** The portal this entity is currently passing through, maintained by PortalSystem. */
  passing: Portal | null;
  /** The last portal it came out of that counts for kill credit (see Match), or null. */
  lastTrip: PortalTrip | null;

  /** Centre of the collision shape. */
  getPosition(): THREE.Vector3;
  getVelocity(): THREE.Vector3;
  /**
   * The point whose crossing of a portal's window plane completes the passage. For the
   * player this is the eye, so the camera is never on the far side of a portal plane; for
   * props it is the centre.
   */
  getCrossingPoint(): THREE.Vector3;
  /** Half-extent of the collision shape along a world direction. */
  extentAlong(dir: THREE.Vector3): number;
  /** Collision shape and its orientation after `rotation` is applied, for validating an exit pose. */
  exitShape(rotation: THREE.Quaternion): { shape: RAPIER.Shape; rotation: THREE.Quaternion };
  /** Where the centre should land coming out of `exit` (before collision checks). */
  exitCenter(transform: THREE.Matrix4, exit: Portal): THREE.Vector3;
  /** Moves the entity through: new centre, plus the rotation/transform of the passage. */
  completeTeleport(center: THREE.Vector3, rotation: THREE.Quaternion, transform: THREE.Matrix4): void;
}
