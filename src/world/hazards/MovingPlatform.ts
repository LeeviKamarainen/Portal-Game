import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET, PLAYER_RADIUS } from '../../player/PlayerController';
import type { Hazard, HazardContext } from './Hazard';

/**
 * A kinematic platform that shuttles between two points, pausing at each end. It carries
 * a player standing on it (through `externalDelta`) and shoves the player aside rather
 * than overlapping them. Crates are not carried - it moves by position, not velocity. Edge lights pulse in its direction
 * of travel and go solid while it waits, so the timing can be read from across the room.
 */
export class MovingPlatform implements Hazard {
  readonly colliderHandle: number;
  /** Displacement over the current step. */
  readonly delta = new THREE.Vector3();
  private readonly body: RAPIER.RigidBody;
  private readonly group: THREE.Group;
  private readonly a: THREE.Vector3;
  private readonly b: THREE.Vector3;
  private readonly half: THREE.Vector3;
  private readonly travelTime: number;
  private readonly pause: number;
  private readonly lights: THREE.MeshBasicMaterial;
  private readonly pos = new THREE.Vector3();
  private t = 0;

  constructor(level: Level, size: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, speed = 3, pause = 1.2) {
    this.a = a.clone();
    this.b = b.clone();
    this.half = size.clone().multiplyScalar(0.5);
    this.travelTime = a.distanceTo(b) / speed;
    this.pause = pause;
    this.pos.copy(a);

    this.group = new THREE.Group();
    const slab = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x, size.y, size.z)), materials().metal);
    slab.castShadow = true;
    slab.receiveShadow = true;
    const trim = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.06, 0.12, size.z + 0.06)), materials().hazard);
    trim.position.y = -size.y / 2 + 0.06;
    this.lights = level.own(glowMaterial(0x40c0ff, 1));
    const edge = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.1, 0.04, size.z + 0.1)), this.lights);
    edge.position.y = size.y / 2 - 0.02;
    this.group.add(slab, trim, edge);
    this.group.position.copy(a);
    level.scene.add(this.group);
    level.addBlocker(slab);

    this.body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(a.x, a.y, a.z),
    );
    const c = level.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(this.half.x, this.half.y, this.half.z).setFriction(1.2),
      this.body,
    );
    level.physics.registerOwner(c.handle, { type: 'mover', ref: this });
    this.colliderHandle = c.handle;

    // A rail under the path so the route is visible before the platform arrives.
    const dir = b.clone().sub(a);
    const len = dir.length();
    const rail = new THREE.Mesh(level.own(new THREE.BoxGeometry(0.12, 0.06, len)), level.own(glowMaterial(0x40c0ff, 0.7)));
    rail.position.copy(a).add(b).multiplyScalar(0.5);
    rail.position.y -= size.y / 2 + 0.6;
    rail.lookAt(b.x, rail.position.y, b.z);
    level.scene.add(rail);
  }

  private cycle(): number {
    return 2 * (this.travelTime + this.pause);
  }

  /** Position along the shuttle at time t (eased travel, pauses at both ends). */
  private sample(t: number, out: THREE.Vector3): { moving: boolean } {
    const c = this.cycle();
    let u = ((t % c) + c) % c;
    const leg = this.travelTime + this.pause;
    const back = u >= leg;
    if (back) u -= leg;
    if (u < this.pause) {
      out.copy(back ? this.b : this.a);
      return { moving: false };
    }
    const k = (u - this.pause) / this.travelTime;
    const e = k * k * (3 - 2 * k);
    out.copy(back ? this.b : this.a).lerp(back ? this.a : this.b, e);
    return { moving: true };
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    this.t += dt;
    const next = new THREE.Vector3();
    const { moving } = this.sample(this.t, next);
    this.delta.copy(next).sub(this.pos);
    this.pos.copy(next);
    // Moved directly rather than by velocity: Rapier's character controller tries to
    // follow a moving kinematic body on its own, but drops that motion on some frames,
    // so riders are carried explicitly by exactly this step's displacement instead.
    this.body.setTranslation(next, true);
    ctx.physics.world.propagateModifiedBodyPositionsToColliders();
    this.group.position.copy(next);
    const pulse = moving ? 0.8 + Math.sin(this.t * 12) * 0.45 : 1.35;
    this.lights.color.setRGB(0.25 * pulse, 0.75 * pulse, 1.0 * pulse);

    // Ride along when standing on it; get shoved when it runs into the player.
    for (const player of ctx.players) {
      if (player.groundCollider === this.colliderHandle) {
        player.externalDelta.add(this.delta);
      } else if (this.delta.lengthSq() > 0) {
        const p = player.getPosition();
        const overlapX = Math.abs(p.x - next.x) < this.half.x + PLAYER_RADIUS + 0.02;
        const overlapZ = Math.abs(p.z - next.z) < this.half.z + PLAYER_RADIUS + 0.02;
        const overlapY = p.y - PLAYER_FEET_OFFSET < next.y + this.half.y - 0.05 && p.y + PLAYER_FEET_OFFSET > next.y - this.half.y;
        if (overlapX && overlapZ && overlapY) player.externalDelta.add(new THREE.Vector3(this.delta.x, 0, this.delta.z));
      }
    }
  }

  update(): void {}

  netState(): number[] {
    return [this.t];
  }

  setNetState(s: readonly number[]): void {
    this.t = s[0];
  }

  reset(): void {
    this.t = 0;
    this.pos.copy(this.a);
    this.body.setTranslation(this.a, true);
    this.group.position.copy(this.a);
  }
}
