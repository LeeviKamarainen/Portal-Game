import * as THREE from 'three';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET, PLAYER_RADIUS } from '../../player/PlayerController';
import { BOX_HALF } from './PropBox';
import { type Hazard, type HazardContext, type Triggerable } from './Hazard';

export type SpikeMode = 'static' | 'cycle' | 'trigger';
type SpikePhase = 'down' | 'warn' | 'up' | 'retract';

export const SPIKE_WARN_TIME = 0.8;
const RISE_TIME = 0.08;
const UP_TIME = 1.3;
const RETRACT_TIME = 0.5;
const SPIKE_HEIGHT = 0.7;
const SPACING = 0.4;

export interface SpikeOptions {
  /** Centre of the floor surface the bed is set into. */
  center: THREE.Vector3;
  /** Width (x) and depth (z) of the bed. */
  size: THREE.Vector2;
  /** static: always out. cycle: on a timer. trigger: only when a switch fires it. */
  mode: SpikeMode;
  /** Seconds retracted each cycle; `offset` staggers neighbours. */
  rest?: number;
  offset?: number;
}

/**
 * A bed of steel spikes in the floor. Out, they kill anything standing on or landing in
 * them. Static beds line pits; cycling and triggered beds hide in walkways. The tell: the
 * bed is ringed in hazard stripes and the tips always show a little above the floor;
 * before they shoot up the ring strobes red with a fast rattle.
 */
export class Spikes implements Hazard, Triggerable {
  private readonly center: THREE.Vector3;
  private readonly half: THREE.Vector2;
  private readonly mode: SpikeMode;
  private readonly rest: number;
  private readonly offset: number;
  private readonly spikes: THREE.InstancedMesh;
  private readonly lamp: THREE.MeshBasicMaterial;
  private phase: SpikePhase;
  private t: number;
  /** 0 = retracted (tips showing), 1 = fully out. */
  private ext: number;
  private lastBeep = -1;

  constructor(level: Level, o: SpikeOptions) {
    this.center = o.center.clone();
    this.half = o.size.clone().multiplyScalar(0.5);
    this.mode = o.mode;
    this.rest = o.rest ?? 3;
    this.offset = o.offset ?? 0;
    this.phase = o.mode === 'static' ? 'up' : 'down';
    this.ext = o.mode === 'static' ? 1 : 0;
    this.t = -this.offset;

    const nx = Math.max(1, Math.floor(o.size.x / SPACING));
    const nz = Math.max(1, Math.floor(o.size.y / SPACING));
    const cone = level.own(new THREE.ConeGeometry(0.11, SPIKE_HEIGHT, 6));
    cone.translate(0, SPIKE_HEIGHT / 2, 0);
    const steel = level.own(new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 0.85, roughness: 0.28 }));
    this.spikes = new THREE.InstancedMesh(cone, steel, nx * nz);
    const m = new THREE.Matrix4();
    let i = 0;
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = (ix + 0.5) * (o.size.x / nx) - this.half.x;
        const z = (iz + 0.5) * (o.size.y / nz) - this.half.y;
        // A little jitter so the bed doesn't read as a printed pattern.
        m.makeRotationY((ix * 7 + iz * 13) % 6);
        m.setPosition(x + (((ix * 31 + iz * 17) % 7) - 3) * 0.008, 0, z + (((ix * 11 + iz * 29) % 7) - 3) * 0.008);
        this.spikes.setMatrixAt(i++, m);
      }
    }
    this.spikes.castShadow = true;
    this.spikes.position.copy(this.center);

    // Dark bed, hazard-stripe border, and a lamp strip round the edge that strobes as a warning.
    const bed = new THREE.Mesh(level.own(new THREE.PlaneGeometry(o.size.x, o.size.y)), level.own(new THREE.MeshStandardMaterial({ color: 0x15171b, roughness: 0.9 })));
    bed.rotation.x = -Math.PI / 2;
    bed.position.copy(this.center).setY(this.center.y + 0.004);
    bed.receiveShadow = true;
    const border = new THREE.Mesh(level.own(ringGeometry(o.size.x + 0.5, o.size.y + 0.5, o.size.x, o.size.y)), materials().hazard);
    border.position.copy(this.center).setY(this.center.y + 0.005);
    this.lamp = level.own(glowMaterial(0xff2a14, 0.3));
    const lamp = new THREE.Mesh(level.own(ringGeometry(o.size.x + 0.08, o.size.y + 0.08, o.size.x, o.size.y)), this.lamp);
    lamp.position.copy(this.center).setY(this.center.y + 0.006);
    level.scene.add(bed, border, lamp, this.spikes);
    this.place();
  }

  private place(shake = 0): void {
    // Retracted, the tips still show 6 cm above the floor.
    this.spikes.position.y = this.center.y - SPIKE_HEIGHT + 0.06 + (SPIKE_HEIGHT - 0.06) * this.ext + shake;
  }

  get extended(): number {
    return this.ext;
  }

  get phaseName(): SpikePhase {
    return this.phase;
  }

  covers(p: THREE.Vector3): boolean {
    return (
      Math.abs(p.x - this.center.x) < this.half.x + 0.6 &&
      Math.abs(p.z - this.center.z) < this.half.y + 0.6 &&
      Math.abs(p.y - this.center.y) < SPIKE_HEIGHT + 0.3
    );
  }

  /** Static spikes are never safe to cross. */
  get alwaysDeadly(): boolean {
    return this.mode === 'static';
  }

  /** Out, or about to be (warning), or still going back in. */
  dangerNow(): boolean {
    return this.mode === 'static' || this.phase !== 'down';
  }

  prePhysics(dt: number, ctx: HazardContext): void {
    if (this.mode === 'static') return;
    this.t += dt;
    let shake = 0;
    switch (this.phase) {
      case 'down':
        this.lamp.color.setRGB(0.3, 0.03, 0.02);
        if (this.mode === 'cycle' && this.t >= this.rest) this.enter('warn');
        break;
      case 'warn': {
        const on = Math.sin(this.t * 34) > 0;
        this.lamp.color.setRGB(on ? 4 : 0.3, on ? 0.35 : 0.03, on ? 0.15 : 0.02);
        shake = Math.sin(this.t * 120) * 0.012;
        if (this.t - this.lastBeep > 0.2) {
          this.lastBeep = this.t;
          ctx.sound('warn', 0.5, this.center, 20);
        }
        if (this.t >= SPIKE_WARN_TIME) this.enter('up');
        break;
      }
      case 'up':
        this.ext = Math.min(1, this.ext + dt / RISE_TIME);
        this.lamp.color.setRGB(4, 0.35, 0.15);
        if (this.t >= UP_TIME) this.enter('retract');
        break;
      case 'retract':
        this.ext = Math.max(0, 1 - this.t / RETRACT_TIME);
        this.lamp.color.setRGB(0.6, 0.06, 0.03);
        if (this.ext <= 0) this.enter('down');
        break;
    }
    if (this.phase === 'up' && this.t < dt * 1.5) ctx.sound('slam', 0.45, this.center, 25);
    this.place(shake);
  }

  update(_dt: number, ctx: HazardContext): void {
    if (this.ext < 0.35) return;
    const top = this.center.y + SPIKE_HEIGHT * this.ext;
    for (const player of ctx.players) {
      const p = player.getPosition();
      const feet = p.y - PLAYER_FEET_OFFSET;
      const inside =
        Math.abs(p.x - this.center.x) < this.half.x + PLAYER_RADIUS * 0.5 &&
        Math.abs(p.z - this.center.z) < this.half.y + PLAYER_RADIUS * 0.5;
      if (inside && feet < top - 0.05 && feet > this.center.y - 0.5) ctx.kill(player, 'spiked');
    }
    for (const box of ctx.props) {
      const b = box.getPosition();
      if (
        box.visible &&
        Math.abs(b.x - this.center.x) < this.half.x + BOX_HALF &&
        Math.abs(b.z - this.center.z) < this.half.y + BOX_HALF &&
        b.y - BOX_HALF < top
      ) {
        box.setVisible(false);
      }
    }
  }

  /** Shoots up now (after its warning) if it is down. */
  trigger(): void {
    if (this.mode !== 'static' && this.phase === 'down') this.enter('warn');
  }

  private enter(phase: SpikePhase): void {
    this.phase = phase;
    this.t = 0;
    this.lastBeep = -1;
  }

  reset(): void {
    if (this.mode === 'static') return;
    this.phase = 'down';
    this.t = -this.offset;
    this.ext = 0;
    this.place();
  }
}

/** A flat rectangular frame lying on the floor: outer w x d with an inner iw x id hole. */
function ringGeometry(w: number, d: number, iw: number, id: number): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, -d / 2).lineTo(w / 2, -d / 2).lineTo(w / 2, d / 2).lineTo(-w / 2, d / 2).closePath();
  const hole = new THREE.Path();
  hole.moveTo(-iw / 2, -id / 2).lineTo(-iw / 2, id / 2).lineTo(iw / 2, id / 2).lineTo(iw / 2, -id / 2).closePath();
  shape.holes.push(hole);
  const g = new THREE.ShapeGeometry(shape);
  g.rotateX(-Math.PI / 2);
  return g;
}
