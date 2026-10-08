import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET, PLAYER_RADIUS } from '../../player/PlayerController';
import { BOX_HALF } from './PropBox';
import { type Hazard, type HazardContext, type Triggerable } from './Hazard';

export type Phase = 'up' | 'warn' | 'slam' | 'down' | 'rise';

export const WARN_TIME = 0.9;
const SLAM_TIME = 0.16;
const DOWN_TIME = 0.45;
const RISE_TIME = 1.1;

/**
 * A heavy piston that slams to the floor on a fixed cycle. Its tell is unmissable: the
 * footprint is painted with hazard stripes, and before each slam the warning lamps strobe
 * red and beep while the block shudders.
 */
export class Crusher implements Hazard, Triggerable {
  private readonly body: RAPIER.RigidBody;
  private readonly mesh: THREE.Group;
  private readonly lamp: THREE.MeshBasicMaterial;
  private readonly half: THREE.Vector3;
  private readonly x: number;
  private readonly z: number;
  private readonly topY: number;
  private readonly bottomY: number;
  private readonly upTime: number;
  private readonly offset: number;
  private readonly auto: boolean;
  private phase: Phase = 'up';
  private t = 0;
  private y: number;
  private lastBeep = 0;

  /**
   * @param footprint x/z size of the block
   * @param floorY    surface it slams onto
   * @param topY      height of the block's underside when raised
   * @param upTime    seconds it rests raised each cycle; `offset` staggers neighbours
   * @param auto      false: only slams when a switch triggers it
   */
  constructor(level: Level, x: number, z: number, footprint: THREE.Vector2, floorY: number, topY: number, upTime: number, offset = 0, auto = true) {
    const height = 1.6;
    this.half = new THREE.Vector3(footprint.x / 2, height / 2, footprint.y / 2);
    this.x = x;
    this.z = z;
    this.bottomY = floorY;
    this.topY = topY;
    this.upTime = upTime;
    this.offset = offset;
    this.auto = auto;
    this.y = topY;
    this.t = -offset;

    this.mesh = new THREE.Group();
    const block = new THREE.Mesh(level.own(new THREE.BoxGeometry(footprint.x, height, footprint.y)), materials().metal);
    block.castShadow = true;
    const band = new THREE.Mesh(level.own(new THREE.BoxGeometry(footprint.x + 0.04, 0.35, footprint.y + 0.04)), materials().hazard);
    band.position.y = -height / 2 + 0.2;
    this.lamp = level.own(glowMaterial(0xff2010, 0.4));
    const lampGeo = level.own(new THREE.BoxGeometry(footprint.x + 0.08, 0.08, footprint.y + 0.08));
    const lamp = new THREE.Mesh(lampGeo, this.lamp);
    lamp.position.y = -height / 2 + 0.42;
    // The shaft it hangs from, up into the ceiling.
    const shaft = new THREE.Mesh(level.own(new THREE.CylinderGeometry(0.25, 0.25, 12, 10)), materials().trim);
    shaft.position.y = height / 2 + 6;
    this.mesh.add(block, band, lamp, shaft);
    level.scene.add(this.mesh);
    level.addBlocker(block);

    const decal = new THREE.Mesh(level.own(new THREE.PlaneGeometry(footprint.x + 0.6, footprint.y + 0.6)), materials().hazard);
    decal.rotation.x = -Math.PI / 2;
    decal.position.set(x, floorY + 0.006, z);
    decal.receiveShadow = true;
    level.scene.add(decal);

    this.body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(x, topY + this.half.y, z),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(this.half.x, this.half.y, this.half.z), this.body);
    level.physics.registerOwner(c.handle, { type: 'hazard', ref: this });
    this.place();
  }

  private place(shake = 0): void {
    const cy = this.y + this.half.y;
    this.body.setNextKinematicTranslation({ x: this.x, y: cy, z: this.z });
    this.mesh.position.set(this.x + shake, cy, this.z);
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    this.t += dt;
    let shake = 0;
    const pos = new THREE.Vector3(this.x, this.bottomY, this.z);
    switch (this.phase) {
      case 'up':
        this.lamp.color.setRGB(0.4, 0.04, 0.02);
        if (this.auto && this.t >= this.upTime) this.enter('warn');
        break;
      case 'warn': {
        const on = Math.sin(this.t * 30) > 0;
        this.lamp.color.setRGB(on ? 4 : 0.3, on ? 0.3 : 0.02, on ? 0.1 : 0.01);
        shake = Math.sin(this.t * 90) * 0.03;
        if (this.t - this.lastBeep > 0.22) {
          this.lastBeep = this.t;
          ctx.sound('warn', 0.7, pos, 22);
        }
        if (this.t >= WARN_TIME) this.enter('slam');
        break;
      }
      case 'slam': {
        const k = Math.min(1, this.t / SLAM_TIME);
        this.y = THREE.MathUtils.lerp(this.topY, this.bottomY, k * k);
        if (k >= 1) {
          ctx.sound('slam', 1, pos, 35);
          this.enter('down');
        }
        break;
      }
      case 'down':
        this.lamp.color.setRGB(4, 0.3, 0.1);
        if (this.t >= DOWN_TIME) this.enter('rise');
        break;
      case 'rise': {
        const k = Math.min(1, this.t / RISE_TIME);
        this.y = THREE.MathUtils.lerp(this.bottomY, this.topY, k * (2 - k));
        this.lamp.color.setRGB(0.6, 0.06, 0.02);
        if (k >= 1) this.enter('up');
        break;
      }
    }
    this.place(shake);
  }

  /** Slams now (after its usual warning) if it is raised and waiting. */
  trigger(): void {
    if (this.phase === 'up') this.enter('warn');
  }

  private enter(phase: Phase): void {
    this.phase = phase;
    this.t = 0;
    this.lastBeep = -1;
  }

  /** Height of the block's underside right now (what a player watches to time a run). */
  get underside(): number {
    return this.y;
  }

  get phaseName(): Phase {
    return this.phase;
  }

  get timeInPhase(): number {
    return this.t;
  }

  /** True while the block is coming down or resting on the floor. */
  get dangerous(): boolean {
    return this.phase === 'slam' || this.phase === 'down';
  }

  /** The floor under the block (and a body's width around it). */
  covers(p: THREE.Vector3): boolean {
    return (
      Math.abs(p.x - this.x) < this.half.x + 0.5 &&
      Math.abs(p.z - this.z) < this.half.z + 0.5 &&
      p.y > this.bottomY - 0.5 &&
      p.y < this.bottomY + 1
    );
  }

  /** Anything but resting fully raised: its warning, the slam, and until it is back up. */
  dangerNow(): boolean {
    return this.phase !== 'up';
  }

  update(_dt: number, ctx: HazardContext): void {
    if (!this.dangerous) return;
    const bottom = this.y;
    const top = bottom + 2 * this.half.y;
    for (const player of ctx.players) {
      const p = player.getPosition();
      const under =
        Math.abs(p.x - this.x) < this.half.x + PLAYER_RADIUS * 0.6 &&
        Math.abs(p.z - this.z) < this.half.z + PLAYER_RADIUS * 0.6;
      // Caught if the block's underside has come down past the head while the player is not
      // standing on top of it.
      if (under && bottom < p.y + PLAYER_FEET_OFFSET - 0.1 && top > p.y - PLAYER_FEET_OFFSET + 0.1) ctx.kill(player, 'crushed');
    }

    for (const box of ctx.props) {
      const b = box.getPosition();
      if (
        box.visible &&
        Math.abs(b.x - this.x) < this.half.x + BOX_HALF &&
        Math.abs(b.z - this.z) < this.half.z + BOX_HALF &&
        b.y + BOX_HALF > bottom &&
        b.y - BOX_HALF < bottom + 2 * this.half.y
      ) {
        box.setVisible(false);
      }
    }
  }

  reset(): void {
    this.phase = 'up';
    this.t = -this.offset;
    this.y = this.topY;
    this.place();
  }
}
