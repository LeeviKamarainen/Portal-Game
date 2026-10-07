import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PhysicsWorld } from '../../physics/PhysicsWorld';
import type { PortalTraversable } from '../../portals/PortalTraversable';
import type { Portal } from '../../portals/Portal';
import type { PortalTrip } from '../../game/Match';

export const BOX_HALF = 0.4;

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

/**
 * A dynamic crate that portals can carry. While it is halfway through a portal it is drawn
 * twice - clipped at the entry window, and as a copy emerging from the exit clipped at that
 * window - so it never pokes out of the back of the wall nor pops in on the far side.
 */
export class PropBox implements PortalTraversable {
  readonly kind = 'prop' as const;
  readonly colliderHandle: number;
  readonly mesh: THREE.Mesh;
  passing: Portal | null = null;
  lastTrip: PortalTrip | null = null;

  private readonly clone: THREE.Mesh;
  private readonly material: THREE.MeshStandardMaterial;
  private readonly cloneMaterial: THREE.MeshStandardMaterial;
  private readonly bandMaterial: THREE.MeshBasicMaterial;
  private readonly cloneBandMaterial: THREE.MeshBasicMaterial;
  private readonly body: RAPIER.RigidBody;
  private readonly physics: PhysicsWorld;
  private readonly home = new THREE.Vector3();
  private readonly enterPlane = new THREE.Plane();
  private readonly exitPlane = new THREE.Plane();

  constructor(scene: THREE.Scene, physics: PhysicsWorld, home: THREE.Vector3, color = 0xd94a2b) {
    this.physics = physics;
    this.home.copy(home);
    const geo = new RoundedBoxGeometry(BOX_HALF * 2, BOX_HALF * 2, BOX_HALF * 2, 3, 0.06);
    this.material = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.45,
      metalness: 0.3,
      emissive: color,
      emissiveIntensity: 0.12,
    });
    this.cloneMaterial = this.material.clone();
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Glowing edge bands: the box reads as a hazard from anywhere in the room.
    this.bandMaterial = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffc040).multiplyScalar(2.2) });
    this.cloneBandMaterial = this.bandMaterial.clone();
    const bandGeo = new THREE.BoxGeometry(BOX_HALF * 2.04, 0.06, BOX_HALF * 2.04);
    for (const axis of [0, 1]) {
      const band = new THREE.Mesh(bandGeo, this.bandMaterial);
      if (axis === 1) band.rotation.x = Math.PI / 2;
      this.mesh.add(band);
    }
    this.clone = this.mesh.clone();
    this.clone.material = this.cloneMaterial;
    this.clone.children.forEach((c) => ((c as THREE.Mesh).material = this.cloneBandMaterial));
    this.clone.visible = false;
    this.clone.matrixAutoUpdate = false;
    scene.add(this.mesh, this.clone);

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(home.x, home.y, home.z)
        .setLinearDamping(0.05)
        .setAngularDamping(0.2)
        .setCcdEnabled(true),
    );
    const collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(BOX_HALF, BOX_HALF, BOX_HALF)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
        .setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS)
        .setDensity(6)
        .setFriction(0.7),
      this.body,
    );
    physics.registerOwner(collider.handle, { type: 'prop', ref: this });
    this.colliderHandle = collider.handle;
  }

  /** Copies the physics pose to the meshes. */
  syncMesh(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    this.mesh.updateMatrixWorld();
  }

  /** Draws the far-side copy while passing (`transform` = entry-to-exit), or clears it. */
  setPassage(enter: Portal | null, transform: THREE.Matrix4 | null): void {
    if (!enter || !transform || !enter.linked || !this.mesh.visible) {
      if (this.clone.visible || this.material.clippingPlanes) {
        this.material.clippingPlanes = null;
        this.bandMaterial.clippingPlanes = null;
        this.material.needsUpdate = true;
        this.bandMaterial.needsUpdate = true;
      }
      this.clone.visible = false;
      return;
    }
    this.enterPlane.copy(enter.plane);
    this.exitPlane.copy(enter.linked.plane);
    if (!this.material.clippingPlanes) {
      this.material.clippingPlanes = [this.enterPlane];
      this.bandMaterial.clippingPlanes = [this.enterPlane];
      this.cloneMaterial.clippingPlanes = [this.exitPlane];
      this.cloneBandMaterial.clippingPlanes = [this.exitPlane];
    }
    this.clone.matrix.copy(transform).multiply(this.mesh.matrixWorld);
    this.clone.updateMatrixWorld(true);
    this.clone.visible = true;
  }

  get visible(): boolean {
    return this.mesh.visible;
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
    if (!v) this.clone.visible = false;
    this.body.setEnabled(v);
  }

  respawnAt(p: THREE.Vector3): void {
    this.body.setEnabled(true);
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.passing = null;
    this.lastTrip = null;
    this.mesh.visible = true;
    this.syncMesh();
  }

  resetHome(): void {
    this.respawnAt(this.home);
  }

  /** Held in place (kinematic) or released to physics. */
  setFrozen(frozen: boolean): void {
    this.body.setBodyType(frozen ? RAPIER.RigidBodyType.KinematicPositionBased : RAPIER.RigidBodyType.Dynamic, true);
  }

  speed(): number {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z);
  }

  // PortalTraversable
  getPosition(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  setPosition(p: THREE.Vector3): void {
    this.body.setTranslation({ x: p.x, y: p.y, z: p.z }, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
  }

  getVelocity(): THREE.Vector3 {
    const v = this.body.linvel();
    return new THREE.Vector3(v.x, v.y, v.z);
  }

  setVelocity(v: THREE.Vector3): void {
    this.body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
  }

  getCrossingPoint(): THREE.Vector3 {
    return this.getPosition();
  }

  extentAlong(dir: THREE.Vector3): number {
    const r = this.body.rotation();
    _q.set(r.x, r.y, r.z, r.w).invert();
    _v.copy(dir).normalize().applyQuaternion(_q);
    return BOX_HALF * (Math.abs(_v.x) + Math.abs(_v.y) + Math.abs(_v.z));
  }

  exitShape(rotation: THREE.Quaternion): { shape: RAPIER.Shape; rotation: THREE.Quaternion } {
    const r = this.body.rotation();
    const q = rotation.clone().multiply(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return { shape: new RAPIER.Cuboid(BOX_HALF - 0.01, BOX_HALF - 0.01, BOX_HALF - 0.01), rotation: q };
  }

  exitCenter(transform: THREE.Matrix4): THREE.Vector3 {
    return this.getPosition().applyMatrix4(transform);
  }

  completeTeleport(center: THREE.Vector3, rotation: THREE.Quaternion): void {
    const r = this.body.rotation();
    const q = rotation.clone().multiply(_q.set(r.x, r.y, r.z, r.w));
    const v = this.body.linvel();
    const w = this.body.angvel();
    const nv = new THREE.Vector3(v.x, v.y, v.z).applyQuaternion(rotation);
    const nw = new THREE.Vector3(w.x, w.y, w.z).applyQuaternion(rotation);
    this.body.setTranslation({ x: center.x, y: center.y, z: center.z }, true);
    this.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    this.body.setLinvel({ x: nv.x, y: nv.y, z: nv.z }, true);
    this.body.setAngvel({ x: nw.x, y: nw.y, z: nw.z }, true);
    this.syncMesh();
  }

  /** Nudge applied while passing (funnelling into the opening). */
  addVelocity(dv: THREE.Vector3): void {
    const v = this.body.linvel();
    this.body.setLinvel({ x: v.x + dv.x, y: v.y + dv.y, z: v.z + dv.z }, true);
  }
}
