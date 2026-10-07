import * as THREE from 'three';
import type { Portal } from './Portal';

const FLIP_Y = new THREE.Matrix4().makeRotationY(Math.PI);

/**
 * The transform that carries anything at `source` to the equivalent place at `dest`,
 * turned half around so that going *into* source means coming *out of* dest.
 */
export function computePortalRelativeMatrix(source: Portal, dest: Portal, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.copy(dest.root.matrixWorld).multiply(FLIP_Y).multiply(source.matrixInverse);
}

export function relativeRotation(relativeMatrix: THREE.Matrix4, out = new THREE.Quaternion()): THREE.Quaternion {
  return out.setFromRotationMatrix(relativeMatrix);
}
