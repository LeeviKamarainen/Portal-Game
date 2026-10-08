import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { type Hazard, type HazardContext, type Triggerable } from './Hazard';

type TrapPhase = 'closed' | 'warn' | 'open' | 'closing';

export const TRAP_WARN_TIME = 0.75;
const SWING_TIME = 0.18;
const CLOSE_TIME = 0.6;

export interface TrapdoorOptions {
  /** Centre of the trapdoor's top surface. */
  center: THREE.Vector3;
  /** Width (x), thickness (y) and depth (z). */
  size: THREE.Vector3;
  /** cycle: opens on a timer. trigger: only when a switch fires it. */
  mode: 'cycle' | 'trigger';
  /** Seconds it stays open. */
  open?: number;
  /** cycle mode: seconds shut each cycle; `offset` staggers neighbours. */
  rest?: number;
  offset?: number;
}

/**
 * A section of floor that drops away: two leaves hinged at the outer edges swing down and
 * whatever stood on it falls. The tell: hazard stripes along the seam and hinges, and a
 * strobing lamp line down the middle with a rattle before it opens.
 */
export class Trapdoor implements Hazard, Triggerable {
  private readonly center: THREE.Vector3;
  private readonly half: THREE.Vector3;
  private readonly mode: 'cycle' | 'trigger';
  private readonly openTime: number;
  private readonly rest: number;
  private readonly offset: number;
  private readonly colliders: RAPIER.Collider[] = [];
  private readonly leaves: THREE.Group[] = [];
  private readonly lamp: THREE.MeshBasicMaterial;
  private readonly lampMesh: THREE.Mesh;
  private phase: TrapPhase = 'closed';
  private t: number;
  /** 0 = shut, 1 = hanging open. */
  private swing = 0;
  private lastBeep = -1;

  constructor(level: Level, o: TrapdoorOptions) {
    this.center = o.center.clone();
    this.half = o.size.clone().multiplyScalar(0.5);
    this.mode = o.mode;
    this.openTime = o.open ?? 2.5;
    this.rest = o.rest ?? 4;
    this.offset = o.offset ?? 0;
    this.t = -this.offset;

    const m = materials();
    const leafW = o.size.x / 2;
    for (const side of [-1, 1]) {
      // Each leaf hangs from a hinge at its outer edge.
      const hinge = new THREE.Group();
      hinge.position.set(this.center.x + side * leafW, this.center.y, this.center.z);
      const leaf = new THREE.Mesh(level.own(new THREE.BoxGeometry(leafW - 0.02, o.size.y, o.size.z)), m.metal);
      leaf.position.set(-side * leafW / 2, -o.size.y / 2, 0);
      leaf.castShadow = true;
      leaf.receiveShadow = true;
      const stripe = new THREE.Mesh(level.own(new THREE.PlaneGeometry(0.3, o.size.z)), m.hazard);
      stripe.rotation.x = -Math.PI / 2;
      stripe.position.set(-side * (leafW - 0.17), 0.003, 0);
      hinge.add(leaf, stripe);
      level.scene.add(hinge);
      level.addBlocker(leaf);
      this.leaves.push(hinge);
    }
    this.lamp = level.own(glowMaterial(0xffa020, 0.3));
    const lamp = new THREE.Mesh(level.own(new THREE.PlaneGeometry(0.08, o.size.z)), this.lamp);
    lamp.rotation.x = -Math.PI / 2;
    lamp.position.copy(this.center).setY(this.center.y + 0.004);
    level.scene.add(lamp);
    this.lampMesh = lamp;

    const body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(this.center.x, this.center.y - o.size.y / 2, this.center.z),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(o.size.x / 2, o.size.y / 2, o.size.z / 2), body);
    level.physics.registerOwner(c.handle, { type: 'hazard', ref: this });
    this.colliders.push(c);
  }

  get isOpen(): boolean {
    return this.phase === 'open';
  }

  /** Its own floor. */
  covers(p: THREE.Vector3): boolean {
    return Math.abs(p.x - this.center.x) < this.half.x + 0.3 && Math.abs(p.z - this.center.z) < this.half.z + 0.3 && Math.abs(p.y - this.center.y) < 0.6;
  }

  /** Anything but shut: its warning, open, and closing again. */
  dangerNow(): boolean {
    return this.phase !== 'closed';
  }

  get phaseName(): TrapPhase {
    return this.phase;
  }

  private setSwing(k: number, shake = 0): void {
    this.swing = k;
    this.leaves.forEach((hinge, i) => {
      const side = i === 0 ? -1 : 1;
      hinge.rotation.z = side * (k * Math.PI * 0.5 + shake);
    });
    this.lampMesh.visible = k < 0.05;
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    this.t += dt;
    let shake = 0;
    switch (this.phase) {
      case 'closed':
        this.lamp.color.setRGB(0.3, 0.15, 0.02);
        if (this.mode === 'cycle' && this.t >= this.rest) this.enter('warn');
        break;
      case 'warn': {
        const on = Math.sin(this.t * 30) > 0;
        this.lamp.color.setRGB(on ? 3.2 : 0.3, on ? 1.6 : 0.15, on ? 0.1 : 0.02);
        shake = Math.sin(this.t * 95) * 0.015;
        if (this.t - this.lastBeep > 0.22) {
          this.lastBeep = this.t;
          ctx.sound('warn', 0.5, this.center, 22);
        }
        if (this.t >= TRAP_WARN_TIME) {
          this.enter('open');
          for (const c of this.colliders) c.setEnabled(false);
          ctx.sound('door', 1, this.center, 30);
        }
        break;
      }
      case 'open':
        this.setSwing(Math.min(1, this.swing + dt / SWING_TIME));
        if (this.t >= this.openTime) this.enter('closing');
        return;
      case 'closing':
        this.setSwing(Math.max(0, 1 - this.t / CLOSE_TIME));
        if (this.swing <= 0) {
          for (const c of this.colliders) c.setEnabled(true);
          this.enter('closed');
        }
        return;
    }
    this.setSwing(0, shake);
  }

  update(): void {}

  /** Drops open now (after its warning) if it is shut. */
  trigger(): void {
    if (this.phase === 'closed') this.enter('warn');
  }

  private enter(phase: TrapPhase): void {
    this.phase = phase;
    this.t = 0;
    this.lastBeep = -1;
  }

  reset(): void {
    this.phase = 'closed';
    this.t = -this.offset;
    for (const c of this.colliders) c.setEnabled(true);
    this.setSwing(0);
  }
}
