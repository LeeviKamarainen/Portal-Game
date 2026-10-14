import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { type Hazard, type HazardContext, type PowerSource } from './Hazard';

const OPEN_SPEED = 1.6;

/**
 * A sliding blast door held open by a power source: a lit laser receiver or a pressed
 * floor button. Its status strip is red while shut and green while open, matching the
 * source's lens.
 */
export class Door implements Hazard {
  private readonly body: RAPIER.RigidBody;
  private readonly group: THREE.Group;
  private readonly status: THREE.MeshBasicMaterial;
  private readonly closed: THREE.Vector3;
  private readonly travel: number;
  private readonly receiver: PowerSource;
  private open = 0;
  private wasOpening = false;

  constructor(level: Level, min: THREE.Vector3, max: THREE.Vector3, receiver: PowerSource) {
    this.receiver = receiver;
    const size = max.clone().sub(min);
    this.closed = min.clone().add(max).multiplyScalar(0.5);
    this.travel = size.y - 0.15;

    this.group = new THREE.Group();
    const slab = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x, size.y, size.z)), materials().metal);
    slab.castShadow = true;
    const stripes = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.02, 0.4, size.z + 0.02)), materials().hazard);
    stripes.position.y = -size.y / 2 + 0.3;
    this.status = level.own(glowMaterial(0xff2020, 2.5));
    const strip = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.04, 0.1, size.z + 0.04)), this.status);
    strip.position.y = size.y / 2 - 0.4;
    this.group.add(slab, stripes, strip);
    this.group.position.copy(this.closed);
    level.scene.add(this.group);
    level.addBlocker(slab);

    this.body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(this.closed.x, this.closed.y, this.closed.z),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2), this.body);
    level.physics.registerOwner(c.handle, { type: 'door', ref: this });
  }

  get isOpen(): boolean {
    return this.open > 0.95;
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    const opening = this.receiver.powered;
    if (opening !== this.wasOpening) ctx.sound('door', 1, this.closed, 30);
    this.wasOpening = opening;
    this.open = THREE.MathUtils.clamp(this.open + (opening ? dt : -dt) * OPEN_SPEED, 0, 1);
    const e = this.open * this.open * (3 - 2 * this.open);
    const y = this.closed.y + e * this.travel;
    this.body.setNextKinematicTranslation({ x: this.closed.x, y, z: this.closed.z });
    this.group.position.y = y;
    if (opening) this.status.color.setRGB(0.2 * 2.5, 1 * 2.5, 0.3 * 2.5);
    else this.status.color.setRGB(2.5, 0.2, 0.2);
  }

  update(): void {}

  reset(): void {
    this.open = 0;
    this.wasOpening = false;
    this.body.setTranslation(this.closed, true);
    this.group.position.copy(this.closed);
  }
}
