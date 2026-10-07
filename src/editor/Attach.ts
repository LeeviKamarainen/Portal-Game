import * as THREE from 'three';
import { footprint, turn, withDefaults, type Piece, type Vec3 } from '../world/maps/MapFormat';
import type { FaceKey } from '../world/Level';

/**
 * Which pieces are attached to which, worked out from where they sit rather than stored:
 * a piece whose anchor (`at`) lies on one of another piece's surfaces - standing on its
 * top, hanging under it, mounted on a side, or inside a room against its ceiling, floor or
 * a wall - is attached to that surface and follows it when the piece moves, turns or is
 * resized. Raising a room's height lifts everything hung from its ceiling; moving a block
 * takes the switch on its side and the crate on its top along.
 */

const EPS = 0.06;

/** The box whose surfaces other pieces can sit on, or null for pieces with no surfaces. */
export function surfaceBox(raw: Piece): THREE.Box3 | null {
  const p = withDefaults(raw);
  if (!p.size) return null;
  try {
    switch (p.type) {
      case 'room':
      case 'block':
      case 'portal-wall':
      case 'wall':
      case 'floor':
      case 'door':
      case 'stairs': {
        const { min, max } = footprint(p);
        return new THREE.Box3(min, max);
      }
      case 'ceiling-slot':
      case 'trapdoor': {
        const { min, max } = footprint({ ...p, at: [p.at[0], p.at[1] - p.size[1], p.at[2]] });
        return new THREE.Box3(min, max);
      }
      case 'platform': {
        const { min, max } = footprint(p);
        const h = (max.y - min.y) / 2;
        return new THREE.Box3(min.setY(min.y - h), max.setY(max.y - h));
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

const within = (v: number, lo: number, hi: number) => v >= lo - EPS && v <= hi + EPS;

/** Which face of `box` the point lies on, if any. */
export function faceUnder(point: Vec3, box: THREE.Box3): FaceKey | null {
  const [x, y, z] = point;
  const { min, max } = box;
  const inX = within(x, min.x, max.x);
  const inY = within(y, min.y, max.y);
  const inZ = within(z, min.z, max.z);
  if (inX && inZ) {
    if (Math.abs(y - max.y) < EPS) return 'py';
    if (Math.abs(y - min.y) < EPS) return 'ny';
  }
  if (inY && inZ) {
    if (Math.abs(x - max.x) < EPS) return 'px';
    if (Math.abs(x - min.x) < EPS) return 'nx';
  }
  if (inX && inY) {
    if (Math.abs(z - max.z) < EPS) return 'pz';
    if (Math.abs(z - min.z) < EPS) return 'nz';
  }
  return null;
}

/** Pieces sitting directly on piece `i`, with the face each sits on. */
export function directlyAttached(pieces: Piece[], i: number): { index: number; face: FaceKey }[] {
  const box = surfaceBox(pieces[i]);
  if (!box) return [];
  const out: { index: number; face: FaceKey }[] = [];
  pieces.forEach((p, j) => {
    if (j === i) return;
    const face = faceUnder(p.at, box);
    if (face) out.push({ index: j, face });
  });
  return out;
}

/**
 * Everything that rides along with `roots`: attached to them, or to something attached to
 * them, and so on. The roots themselves are not included. A piece never carries something
 * bigger that it merely touches - a block on a room floor does not carry the room, because
 * only the room's own surfaces carry, and the room's anchor is not on the block.
 */
export function carried(pieces: Piece[], roots: Iterable<number>): number[] {
  const seen = new Set(roots);
  const queue = [...seen];
  const out: number[] = [];
  while (queue.length) {
    const i = queue.shift()!;
    for (const { index } of directlyAttached(pieces, i)) {
      // The room is the world, not something that rides on a slab inside it.
      if (seen.has(index) || pieces[index].type === 'room') continue;
      seen.add(index);
      out.push(index);
      queue.push(index);
    }
  }
  return out;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

export function shift(p: Piece, d: THREE.Vector3): void {
  p.at = [round(p.at[0] + d.x), round(p.at[1] + d.y), round(p.at[2] + d.z)];
  if (Array.isArray(p.to)) {
    const t = p.to as Vec3;
    p.to = [round(t[0] + d.x), round(t[1] + d.y), round(t[2] + d.z)];
  }
}

/** Turns a piece about a vertical axis through `pivot` (x, z) by `deg`. */
export function turnAbout(p: Piece, pivot: THREE.Vector3, deg: number, turnable: boolean): void {
  const rel = new THREE.Vector3(p.at[0] - pivot.x, 0, p.at[2] - pivot.z);
  const r = turn(rel, deg);
  p.at = [round(pivot.x + r.x), p.at[1], round(pivot.z + r.z)];
  if (Array.isArray(p.to)) {
    const t = p.to as Vec3;
    const rt = turn(new THREE.Vector3(t[0] - pivot.x, 0, t[2] - pivot.z), deg);
    p.to = [round(pivot.x + rt.x), t[1], round(pivot.z + rt.z)];
  }
  if (turnable) p.rot = ((((p.rot ?? 0) + deg) % 360) + 360) % 360;
}

/** How far each face of a box moved when it changed from `before` to `after`. */
export function faceMotion(face: FaceKey, before: THREE.Box3, after: THREE.Box3): THREE.Vector3 {
  switch (face) {
    case 'px':
      return new THREE.Vector3(after.max.x - before.max.x, 0, 0);
    case 'nx':
      return new THREE.Vector3(after.min.x - before.min.x, 0, 0);
    case 'py':
      return new THREE.Vector3(0, after.max.y - before.max.y, 0);
    case 'ny':
      return new THREE.Vector3(0, after.min.y - before.min.y, 0);
    case 'pz':
      return new THREE.Vector3(0, 0, after.max.z - before.max.z);
    case 'nz':
      return new THREE.Vector3(0, 0, after.min.z - before.min.z);
  }
}
