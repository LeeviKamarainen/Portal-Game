import type * as THREE from 'three';

/**
 * Two cameras draw this scene: the player's camera and the portal renderer's virtual one.
 * The player's own body has to be split between them - the main camera sits inside the
 * avatar's head, so the body may only appear in portal views. (The first-person gun needs
 * no layer: ViewModel draws it from a scene of its own.)
 */
export const LAYER_WORLD = 0;
/** The player's body and the gun in its hand: portal views only. */
export const LAYER_AVATAR = 1;

export function setLayerRecursive(root: THREE.Object3D, layer: number): void {
  root.traverse((child) => child.layers.set(layer));
}
