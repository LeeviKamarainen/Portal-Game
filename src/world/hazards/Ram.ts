import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET, PLAYER_RADIUS } from '../../player/PlayerController';
import { BOX_HALF } from './PropBox';
import { distanceGain, type Hazard, type HazardContext, type Triggerable } from './Hazard';

export type RamPhase = 'rest' | 'warn' | 'strike' | 'hold' | 'retract';

export const RAM_WARN_TIME = 0.85;
const STRIKE_TIME = 0.18;
const HOLD_TIME = 0.45;
const RETRACT_TIME = 1.0;
/** What a hit does to the player: shoved along the ram and popped off the ground. */
const PUSH_SPEED = 8;
const PUSH_LIFT = 4.5;
const HOUSING_DEPTH = 0.7;

const _local = new THREE.Vector3();
const _probe = new THREE.Vector3();

export interface RamOptions {
  /** Centre of the wall face the ram sits in (the head's back when retracted). */
  mount: THREE.Vector3;
  /** Push direction; horizontal. */
  facing: THREE.Vector3;
  /** Head width, height and thickness. */
  size: THREE.Vector3;
  /** How far the head travels out. */
  reach: number;
  /** Seconds retracted each cycle; `offset` staggers neighbours. */
  rest: number;
  offset?: number;
  /** Surface under the ram's reach, for the warning stripe (omit for none). */
  floorY?: number;
  /** How far out the stripe runs (default: the head's full travel). */
  stripe?: number;
  /** False: never fires on its own, only when a switch triggers it. */
  auto?: boolean;
}

/**
 * A wall-mounted pneumatic ram that punches straight out on a fixed cycle and throws
 * whatever it hits - meant for high walkways, where the real damage is the fall. Its tell:
 * chevrons on the floor covering its reach and pointing the way it pushes, and amber
 * lamps that strobe faster and faster with a rising beep while the head draws back.
 *
 * Works with portals the way anything moving does: a player or crate thrown into a portal
 * keeps the speed on the way out.
 */
export class Ram implements Hazard, Triggerable {
  private readonly body: RAPIER.RigidBody;
  private readonly group = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly rod: THREE.Mesh;
  private readonly lamp: THREE.MeshBasicMaterial;
  private readonly mount: THREE.Vector3;
  private readonly facing: THREE.Vector3;
  private readonly quat = new THREE.Quaternion();
  private readonly inverse = new THREE.Quaternion();
  private readonly half: THREE.Vector3;
  private readonly reach: number;
  private readonly restTime: number;
  private readonly offset: number;
  private readonly auto: boolean;
  private phase: RamPhase = 'rest';
  private t: number;
  /** How far the head's back face is out from the mount. */
  private ext = 0;
  private lastBeep = -1;
  private struck = false;

  constructor(level: Level, o: RamOptions) {
    const { mount, facing, size, reach, floorY } = o;
    this.mount = mount.clone();
    this.facing = new THREE.Vector3(facing.x, 0, facing.z).normalize();
    this.quat.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.facing);
    this.inverse.copy(this.quat).invert();
    this.half = size.clone().multiplyScalar(0.5);
    this.reach = reach;
    this.restTime = o.rest;
    this.offset = o.offset ?? 0;
    this.auto = o.auto ?? true;
    this.t = -this.offset;
    const stripeLength = o.stripe;

    // Local frame: -z is the push direction, the mount at the origin.
    this.group.position.copy(mount);
    this.group.quaternion.copy(this.quat);
    const m = materials();
    const housing = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.3, size.y + 0.3, HOUSING_DEPTH)), m.trim);
    housing.position.z = HOUSING_DEPTH / 2;
    housing.castShadow = true;
    this.rod = new THREE.Mesh(level.own(new THREE.CylinderGeometry(0.16, 0.16, 1, 12)), m.trim);
    this.rod.rotation.x = Math.PI / 2;
    this.rod.visible = false;

    const block = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x, size.y, size.z)), m.metal);
    block.castShadow = true;
    const face = new THREE.Mesh(level.own(new THREE.PlaneGeometry(size.x * 0.92, size.y * 0.92)), m.hazard);
    face.position.z = -size.z / 2 - 0.005;
    face.rotation.y = Math.PI;
    this.lamp = level.own(glowMaterial(0xffa020, 0.35));
    const rim = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + 0.06, size.y + 0.06, 0.08)), this.lamp);
    rim.position.z = -size.z / 2 + 0.06;
    this.head.add(block, face, rim);
    this.head.position.z = -this.half.z;
    this.group.add(housing, this.rod, this.head);
    level.scene.add(this.group);
    level.addBlocker(block);
    level.addBlocker(housing);

    if (floorY !== undefined) {
      const len = stripeLength ?? reach + size.z;
      const stripe = new THREE.Mesh(level.own(new THREE.PlaneGeometry(size.x, len)), level.own(chevronMaterial(len / size.x)));
      stripe.rotation.x = -Math.PI / 2;
      // Turns the plane's +y (the way the chevrons point) onto the push direction.
      stripe.rotation.z = Math.atan2(-this.facing.x, -this.facing.z);
      stripe.position.copy(mount).addScaledVector(this.facing, len / 2);
      stripe.position.y = floorY + 0.006;
      stripe.receiveShadow = true;
      level.scene.add(stripe);
    }

    this.body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setRotation(this.quat),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(this.half.x, this.half.y, this.half.z), this.body);
    level.physics.registerOwner(c.handle, { type: 'hazard', ref: this });
    const housingBody = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(mount.x, mount.y, mount.z).setRotation(this.quat),
    );
    level.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid((size.x + 0.3) / 2, (size.y + 0.3) / 2, HOUSING_DEPTH / 2).setTranslation(0, 0, HOUSING_DEPTH / 2),
      housingBody,
    );
    this.place(0);
  }

  get phaseName(): RamPhase {
    return this.phase;
  }

  get timeInPhase(): number {
    return this.t;
  }

  /** Centre of the head's front face, in world space. */
  get front(): THREE.Vector3 {
    return this.mount.clone().addScaledVector(this.facing, this.ext + 2 * this.half.z);
  }

  get pushDirection(): THREE.Vector3 {
    return this.facing.clone();
  }

  /** Floor whose stander the fully extended head would hit (the chevrons, plus a body's width). */
  covers(p: THREE.Vector3): boolean {
    const l = this.toLocal(_probe.copy(p).setY(p.y + PLAYER_FEET_OFFSET));
    if (Math.abs(l.x) > this.half.x + PLAYER_RADIUS + 0.1) return false;
    if (l.y - PLAYER_FEET_OFFSET > this.half.y - 0.05 || l.y + PLAYER_FEET_OFFSET < -this.half.y) return false;
    return l.z >= -0.1 && l.z <= this.reach + 2 * this.half.z + PLAYER_RADIUS + 0.1;
  }

  /** From its warning until the head is back in. */
  dangerNow(): boolean {
    return this.phase !== 'rest';
  }

  private place(shake: number): void {
    const back = this.ext + shake;
    this.head.position.z = -(back + this.half.z);
    this.rod.visible = back > 0.02;
    this.rod.scale.y = Math.max(back, 0.001);
    this.rod.position.z = -back / 2;
    const c = this.mount.clone().addScaledVector(this.facing, back + this.half.z);
    this.body.setTranslation(c, true);
  }

  /** The point in the ram's frame: x across, y up, z = distance out along the push. */
  private toLocal(p: THREE.Vector3): THREE.Vector3 {
    _local.copy(p).sub(this.mount).applyQuaternion(this.inverse);
    _local.z = -_local.z;
    return _local;
  }

  /** How far into the head's swept slab a body reaching `radius` sideways and `halfHeight` up/down sits, or null if clear. */
  private overlap(p: THREE.Vector3, radius: number, halfHeight: number): THREE.Vector3 | null {
    const l = this.toLocal(p);
    if (Math.abs(l.x) > this.half.x + radius * 0.9) return null;
    // Standing on top of the head does not count.
    if (l.y - halfHeight > this.half.y - 0.05 || l.y + halfHeight < -this.half.y) return null;
    const frontFace = this.ext + 2 * this.half.z;
    if (l.z < -0.1 || l.z > frontFace + radius) return null;
    return l;
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    this.t += dt;
    let shake = 0;
    switch (this.phase) {
      case 'rest':
        this.lamp.color.setRGB(0.35, 0.18, 0.02);
        if (this.auto && this.t >= this.restTime) this.enter('warn');
        break;
      case 'warn': {
        const k = this.t / RAM_WARN_TIME;
        const on = Math.sin(this.t * (18 + 26 * k)) > 0;
        this.lamp.color.setRGB(on ? 3 : 0.3, on ? 1.5 : 0.15, on ? 0.1 : 0.01);
        // Draws back as it builds pressure.
        shake = -0.12 * k + Math.sin(this.t * 80) * 0.015;
        if (this.t - this.lastBeep > 0.26 - 0.14 * k) {
          this.lastBeep = this.t;
          ctx.audio.play('warn', distanceGain(ctx.listener, this.mount, 24) * 0.55);
        }
        if (this.t >= RAM_WARN_TIME) this.enter('strike');
        break;
      }
      case 'strike': {
        const k = Math.min(1, this.t / STRIKE_TIME);
        this.ext = this.reach * k * k;
        this.lamp.color.setRGB(3, 1.5, 0.1);
        this.push(ctx);
        if (k >= 1) {
          ctx.audio.play('slam', distanceGain(ctx.listener, this.mount, 30) * 0.6);
          this.enter('hold');
        }
        break;
      }
      case 'hold':
        if (this.t >= HOLD_TIME) this.enter('retract');
        break;
      case 'retract': {
        const k = Math.min(1, this.t / RETRACT_TIME);
        this.ext = this.reach * (1 - k * (2 - k));
        this.lamp.color.setRGB(0.6, 0.3, 0.03);
        if (k >= 1) {
          this.ext = 0;
          this.enter('rest');
        }
        break;
      }
    }
    this.place(shake);
    ctx.physics.world.propagateModifiedBodyPositionsToColliders();
  }

  /** Throws anything the head is sweeping through; runs while it strikes. */
  private push(ctx: HazardContext): void {
    const frontFace = this.ext + 2 * this.half.z;
    for (const player of ctx.players) {
      const l = this.overlap(player.getPosition(), PLAYER_RADIUS, PLAYER_FEET_OFFSET);
      if (!l) continue;
      // Out of the head's way this step, then thrown clear.
      const clear = frontFace + PLAYER_RADIUS + 0.03 - l.z;
      if (clear > 0) player.externalDelta.addScaledVector(this.facing, clear);
      player.knockback(this.facing.clone().multiplyScalar(PUSH_SPEED).setY(PUSH_LIFT));
      if (!this.struck) ctx.audio.play('hurt', distanceGain(ctx.listener, this.mount, 20) * 0.5);
      this.struck = true;
    }
    for (const box of ctx.props) {
      if (!box.visible) continue;
      if (!this.overlap(box.getPosition(), BOX_HALF, BOX_HALF)) continue;
      const v = box.getVelocity();
      const along = v.dot(this.facing);
      if (along < PUSH_SPEED) box.addVelocity(this.facing.clone().multiplyScalar(PUSH_SPEED - along).setY(PUSH_LIFT * 0.5));
    }
  }

  update(_dt: number, ctx: HazardContext): void {
    // Pinned: thrown into something solid that stopped it while the head is still coming.
    if (this.phase !== 'strike' && this.phase !== 'hold') return;
    for (const player of ctx.players) {
      const l = this.overlap(player.getPosition(), PLAYER_RADIUS, PLAYER_FEET_OFFSET);
      if (l && l.z < this.ext + 2 * this.half.z + PLAYER_RADIUS - 0.2) ctx.kill(player, 'crushed');
    }
  }

  /** Fires now (after its usual warning) if it is resting. */
  trigger(): void {
    if (this.phase === 'rest') this.enter('warn');
  }

  private enter(phase: RamPhase): void {
    this.phase = phase;
    this.t = 0;
    this.lastBeep = -1;
    if (phase === 'strike') this.struck = false;
  }

  reset(): void {
    this.phase = 'rest';
    this.t = -this.offset;
    this.ext = 0;
    this.place(0);
  }
}

let chevronCanvas: HTMLCanvasElement | null = null;

/** Yellow-on-black chevrons pointing up the texture (+v), repeated `repeat` times. */
function chevronMaterial(repeat: number): THREE.MeshStandardMaterial {
  if (!chevronCanvas) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    // Canvas y runs down while the texture's v runs up: drawn pointing to the top edge.
    const g = c.getContext('2d')!;
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = '#f2b81a';
    g.lineWidth = 14;
    g.lineJoin = 'miter';
    for (const y of [36, 92]) {
      g.beginPath();
      g.moveTo(24, y + 16);
      g.lineTo(64, y - 12);
      g.lineTo(104, y + 16);
      g.stroke();
    }
    chevronCanvas = c;
  }
  const map = new THREE.CanvasTexture(chevronCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, Math.max(1, Math.round(repeat)));
  return new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.2 });
}
