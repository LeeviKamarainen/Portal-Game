import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Face, Level } from '../world/Level';
import { PORTAL_HALF_H, PORTAL_HALF_W, type Portal, type PortalColor } from './Portal';

/** Gap kept between the opening and the edge of its surface. */
const EDGE_MARGIN = 0.02;
/** Space in front of the opening that must be free of other geometry. */
const CLEARANCE_DEPTH = 0.5;
/** How far a blocked shot may be nudged to find room. */
const NUDGE_RINGS = [0.15, 0.3, 0.45, 0.6, 0.8, 1.0, 1.25, 1.5];
const NUDGE_DIRECTIONS = 16;

export interface ShotResult {
  placed: boolean;
  point: THREE.Vector3 | null;
  normal: THREE.Vector3 | null;
  /** What the shot hit instead of a surface, if it was something shootable (a switch). */
  interactable?: unknown;
  /** It fizzled because the only room was inside a no-portal zone (around a point orb). */
  noPortalZone?: boolean;
  /** It hit another player's portal, which is now the shooter's to take (see Session.steal). */
  stolen?: Portal;
}

/** Whether an opening at `center` (axes `right`/`up`) would cut into a no-portal zone. */
export type NoPortalZone = (center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3) => boolean;

interface Placement {
  face: Face;
  center: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
}

const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * Turns a shot into a portal placement. The ray hits the first surface of any kind - a
 * non-portalable surface or a hazard housing stops the shot - and on a portalable face
 * the opening is oriented (walls: upright; floors and ceilings: pointing along the shot),
 * fitted inside the face, and nudged clear of anything standing in front of it and of the
 * other portal. A spot with no room fizzles instead of placing a portal that would cut
 * into a ledge or a corner.
 */
export class PortalGun {
  private readonly raycaster = new THREE.Raycaster();
  private readonly level: Level;
  private readonly physics: PhysicsWorld;
  private readonly portals: Record<PortalColor, Portal>;
  /** Every portal in the arena (all players'), for overlap checks. */
  private readonly allPortals: () => readonly Portal[];
  private readonly effects: ShotEffects;
  /** Areas no portal may open in (point orbs), or null. */
  noPortalZone: NoPortalZone | null = null;
  private zoneRejected = false;

  constructor(
    level: Level,
    physics: PhysicsWorld,
    portals: Record<PortalColor, Portal>,
    allPortals: () => readonly Portal[] = () => [portals.orange, portals.blue],
  ) {
    this.level = level;
    this.physics = physics;
    this.portals = portals;
    this.allPortals = allPortals;
    this.effects = new ShotEffects(level.scene, (c) => this.portals[c].tint);
  }

  fire(color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3, muzzle?: THREE.Vector3): ShotResult {
    // Moving blockers (crushers, platforms, doors) have moved since the last frame drew.
    this.level.scene.updateMatrixWorld();
    this.raycaster.set(eye, dir.clone().normalize());
    this.raycaster.far = 200;
    const hits = this.raycaster.intersectObjects(this.level.raycastTargets, false);
    const hit = hits[0];
    const from = muzzle ?? eye;
    if (!hit) {
      this.effects.tracer(color, from, eye.clone().addScaledVector(dir, 60), false);
      return { placed: false, point: null, normal: null };
    }
    const face = hit.object.userData.face as Face | undefined;
    const normal = face ? face.normal.clone() : hit.face?.normal.clone().transformDirection(hit.object.matrixWorld) ?? null;
    const interactable = hit.object.userData.interactable;
    if (interactable) {
      this.effects.tracer(color, from, hit.point, true, normal);
      return { placed: false, point: hit.point.clone(), normal, interactable };
    }
    if (!face || !face.portalable || face.normal.dot(dir) >= 0) {
      this.effects.tracer(color, from, hit.point, false, normal);
      return { placed: false, point: hit.point.clone(), normal };
    }
    // Into someone else's portal: it doesn't move, it changes hands.
    const target = this.portalAt(face, hit.point);
    if (target && target.owner !== this.portals[color].owner) {
      this.effects.tracer(color, from, hit.point, true, face.normal);
      return { placed: false, point: hit.point.clone(), normal: face.normal.clone(), stolen: target };
    }

    this.zoneRejected = false;
    const placement = this.findPlacement(color, face, hit.point, dir);
    if (!placement) {
      this.effects.tracer(color, from, hit.point, false, normal);
      return { placed: false, point: hit.point.clone(), normal, noPortalZone: this.zoneRejected };
    }
    this.portals[color].place(this.physics, placement.face, placement.center, placement.right, placement.up);
    this.effects.tracer(color, from, placement.center, true, face.normal);
    return { placed: true, point: placement.center.clone(), normal: face.normal.clone() };
  }

  /** The placed portal (anyone's) whose opening `point` on `face` lies in, if any. */
  private portalAt(face: Face, point: THREE.Vector3): Portal | null {
    for (const p of this.allPortals()) {
      if (p.placed && p.face === face && p.inAperture(p.toLocal(point), 0)) return p;
    }
    return null;
  }

  private orientation(face: Face, dir: THREE.Vector3): { right: THREE.Vector3; up: THREE.Vector3 } {
    const n = face.normal;
    let up: THREE.Vector3;
    if (Math.abs(n.y) < 0.7) {
      up = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize();
    } else {
      // Floor/ceiling: the top of the opening points away from the shooter, so walking or
      // falling in comes out facing the same way relative to the exit.
      up = dir.clone().addScaledVector(n, -dir.dot(n));
      if (up.lengthSq() < 1e-6) up.copy(face.up);
      up.normalize();
    }
    const right = new THREE.Vector3().crossVectors(up, n).normalize();
    return { right, up };
  }

  private findPlacement(color: PortalColor, face: Face, point: THREE.Vector3, dir: THREE.Vector3): Placement | null {
    const { right, up } = this.orientation(face, dir);
    // Half-extent of the opening along the face's own axes.
    const ex = Math.abs(right.dot(face.right)) * PORTAL_HALF_W + Math.abs(up.dot(face.right)) * PORTAL_HALF_H;
    const ey = Math.abs(right.dot(face.up)) * PORTAL_HALF_W + Math.abs(up.dot(face.up)) * PORTAL_HALF_H;
    const limX = face.width / 2 - ex - EDGE_MARGIN;
    const limY = face.height / 2 - ey - EDGE_MARGIN;
    if (limX < 0 || limY < 0) return null;

    const local = face.toLocal(point);
    const clampTo = (x: number, y: number) =>
      new THREE.Vector2(THREE.MathUtils.clamp(x, -limX, limX), THREE.MathUtils.clamp(y, -limY, limY));

    const tried = new Set<string>();
    const tryAt = (p2: THREE.Vector2): Placement | null => {
      const key = `${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
      if (tried.has(key)) return null;
      tried.add(key);
      const center = face.toWorld(p2.x, p2.y);
      if (!this.isClear(color, face, center, right, up)) return null;
      return { face, center, right, up };
    };

    const first = tryAt(clampTo(local.x, local.y));
    if (first) return first;
    for (const r of NUDGE_RINGS) {
      for (let i = 0; i < NUDGE_DIRECTIONS; i++) {
        const a = (i / NUDGE_DIRECTIONS) * Math.PI * 2;
        const p = tryAt(clampTo(local.x + Math.cos(a) * r, local.y + Math.sin(a) * r));
        if (p) return p;
      }
    }
    return null;
  }

  /** No geometry in front of the opening, no overlap with another portal, outside no-portal zones. */
  private isClear(color: PortalColor, face: Face, center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): boolean {
    if (this.noPortalZone?.(center, right, up)) {
      this.zoneRejected = true;
      return false;
    }
    // The portal being moved doesn't count; every other one, whoever's, does.
    const moving = this.portals[color];
    for (const other of this.allPortals()) {
      if (other !== moving && other.placed && overlapsOpening(other, face, center, right, up)) return false;
    }

    _basis.makeBasis(right, up, face.normal);
    _q.setFromRotationMatrix(_basis);
    const probe = center.clone().addScaledVector(face.normal, 0.03 + CLEARANCE_DEPTH / 2);
    const blocked = this.physics.world.intersectionWithShape(
      probe,
      _q,
      new RAPIER.Cuboid(PORTAL_HALF_W - 0.02, PORTAL_HALF_H - 0.02, CLEARANCE_DEPTH / 2),
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => {
        const t = this.physics.getOwner(c.handle)?.type;
        // People and crates move out of the way; tunnel colliders are not real geometry.
        return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel' && c.handle !== face.solid.collider.handle;
      },
    );
    return blocked === null;
  }

  update(dt: number): void {
    this.effects.update(dt);
  }
}

/** Whether an opening at `center` on `face` would overlap `other` (same plane, with a little air between). */
function overlapsOpening(other: Portal, face: Face, center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): boolean {
  if (other.normal.dot(face.normal) <= 0.99) return false;
  if (Math.abs(center.clone().sub(other.surfaceCenter).dot(face.normal)) >= 0.05) return false;
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ].map(([sx, sy]) => center.clone().addScaledVector(right, sx * PORTAL_HALF_W).addScaledVector(up, sy * PORTAL_HALF_H));
  const otherAxes = [other.right, other.up];
  const half = [PORTAL_HALF_W + 0.08, PORTAL_HALF_H + 0.08];
  // Separating-axis test on the plane (both rectangles' axes).
  for (const axis of [right, up, other.right, other.up]) {
    const proj = corners.map((c) => c.dot(axis));
    const min = Math.min(...proj);
    const max = Math.max(...proj);
    const oc = other.surfaceCenter.dot(axis);
    const or = Math.abs(otherAxes[0].dot(axis)) * half[0] + Math.abs(otherAxes[1].dot(axis)) * half[1];
    if (max < oc - or || min > oc + or) return false;
  }
  return true;
}

interface Tracer {
  line: THREE.Mesh;
  burst: THREE.Points;
  life: number;
  velocities: Float32Array;
}

const beamMaterial = (color: THREE.Color) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending });

const burstMaterial = (color: THREE.Color) =>
  new THREE.PointsMaterial({ color, size: 0.09, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });

/** Shot tracers and the spark burst where a shot lands (or fizzles). */
class ShotEffects {
  private readonly scene: THREE.Scene;
  private readonly active: Tracer[] = [];
  private readonly beamGeo = new THREE.CylinderGeometry(0.02, 0.02, 1, 6, 1, true);
  private readonly tintOf: (color: PortalColor) => number;

  constructor(scene: THREE.Scene, tintOf: (color: PortalColor) => number) {
    this.scene = scene;
    this.tintOf = tintOf;
    // A hidden tracer and burst that never go away: they get their shaders compiled with the
    // rest of the arena at load, and keep them alive - once the last material using a shader
    // is disposed three.js drops it, and the next shot would compile it all over again.
    const keep = new THREE.Group();
    keep.visible = false;
    keep.add(new THREE.Mesh(this.beamGeo, beamMaterial(new THREE.Color())), new THREE.Points(new THREE.BufferGeometry(), burstMaterial(new THREE.Color())));
    scene.add(keep);
  }

  tracer(color: PortalColor, from: THREE.Vector3, to: THREE.Vector3, placed: boolean, normal?: THREE.Vector3 | null): void {
    const col = new THREE.Color(placed ? this.tintOf(color) : 0x9aa4b0);
    const mat = beamMaterial(col.clone().multiplyScalar(3));
    const line = new THREE.Mesh(this.beamGeo, mat);
    const d = to.clone().sub(from);
    const len = d.length();
    line.position.copy(from).addScaledVector(d, 0.5);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    line.scale.set(1, len, 1);

    const count = placed ? 40 : 24;
    const pos = new Float32Array(count * 3);
    const vel = new Float32Array(count * 3);
    const n = normal ?? new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < count; i++) {
      pos.set([to.x, to.y, to.z], i * 3);
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      if (v.dot(n) < 0) v.addScaledVector(n, -2 * v.dot(n));
      v.multiplyScalar(2 + Math.random() * (placed ? 5 : 3));
      vel.set([v.x, v.y, v.z], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const burst = new THREE.Points(g, burstMaterial(col.clone().multiplyScalar(placed ? 3 : 1.5)));
    burst.frustumCulled = false;
    this.scene.add(line, burst);
    this.active.push({ line, burst, life: 1, velocities: vel });
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const t = this.active[i];
      t.life -= dt * 2.2;
      (t.line.material as THREE.MeshBasicMaterial).opacity = Math.max(0, t.life * 3 - 2) * 0.9;
      const pm = t.burst.material as THREE.PointsMaterial;
      pm.opacity = Math.max(0, t.life);
      const pos = t.burst.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < pos.count; k++) {
        t.velocities[k * 3 + 1] -= 9 * dt;
        pos.setXYZ(
          k,
          pos.getX(k) + t.velocities[k * 3] * dt,
          pos.getY(k) + t.velocities[k * 3 + 1] * dt,
          pos.getZ(k) + t.velocities[k * 3 + 2] * dt,
        );
      }
      pos.needsUpdate = true;
      if (t.life <= 0) {
        this.scene.remove(t.line, t.burst);
        (t.line.material as THREE.Material).dispose();
        t.burst.geometry.dispose();
        pm.dispose();
        this.active.splice(i, 1);
      }
    }
  }
}
