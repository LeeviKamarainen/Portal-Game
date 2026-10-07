import * as THREE from 'three';
import { Level, type BoxOptions } from './Level';
import { Goal, addLightStrip, addSpawnPad } from './Markers';
import type { Hazard } from './hazards/Hazard';
import { PropBox } from './hazards/PropBox';
import { AcidPool } from './hazards/AcidPool';
import { Crusher } from './hazards/Crusher';
import { LaserEmitter, LaserReceiver } from './hazards/Laser';
import { Door } from './hazards/Door';
import { MovingPlatform } from './hazards/MovingPlatform';
import { Dropper } from './hazards/Dropper';
import { Ram, type RamOptions } from './hazards/Ram';
import { Spikes, type SpikeOptions } from './hazards/Spikes';
import { Trapdoor, type TrapdoorOptions } from './hazards/Trapdoor';
import { Switch, type SwitchOptions } from './hazards/Switch';
import { glowMaterial } from './Materials';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

export interface SpawnPoint {
  /** Where the player's centre goes. */
  position: THREE.Vector3;
  yaw: number;
  team: string | null;
}

export interface FogSettings {
  color: number;
  near: number;
  far: number;
}

/** Collects everything an arena definition creates. */
export class ArenaBuilder {
  readonly level: Level;
  readonly hazards: Hazard[] = [];
  readonly props: PropBox[] = [];
  readonly lasers: LaserEmitter[] = [];
  spawn = V(0, 1.02, 0);
  spawnYaw = 0;
  /** Every spawn point, the main one first; player slot i starts on spawns[i % length]. */
  readonly spawns: SpawnPoint[] = [];
  goal: Goal | null = null;
  killY = -6;
  fog: FogSettings = { color: 0x0b0e14, near: 30, far: 150 };
  /** Shadow-casting key light covers this box. */
  bounds = new THREE.Box3(V(-20, 0, -20), V(20, 10, 20));

  constructor(level: Level) {
    this.level = level;
  }

  box(min: THREE.Vector3, max: THREE.Vector3, opts?: BoxOptions) {
    return this.level.box(min, max, opts);
  }

  /** The main spawn (the local player's); `p` is the player's centre. */
  setSpawn(p: THREE.Vector3, yaw: number, team: string | null = null): void {
    this.spawn = p.clone();
    this.spawnYaw = yaw;
    this.spawns.unshift({ position: p.clone(), yaw, team });
    addSpawnPad(this.level, new THREE.Vector3(p.x, p.y - 1.02, p.z), yaw);
  }

  /** Another spawn point (opponents, teams); `p` is the player's centre. */
  addSpawn(p: THREE.Vector3, yaw: number, team: string | null = null): void {
    this.spawns.push({ position: p.clone(), yaw, team });
    addSpawnPad(this.level, new THREE.Vector3(p.x, p.y - 1.02, p.z), yaw);
  }

  setGoal(p: THREE.Vector3): void {
    this.goal = new Goal(this.level, p);
  }

  /**
   * A solid staircase of stacked boxes climbing `rise` over `run` from `base` along an
   * axis-aligned `dir`. Steps stay under the character controller's autostep height.
   */
  stairs(base: THREE.Vector3, dir: THREE.Vector3, rise: number, run: number, width: number): void {
    const steps = Math.max(1, Math.ceil(rise / 0.25));
    const stepRise = rise / steps;
    const stepRun = run / steps;
    const alongX = Math.abs(dir.x) > 0.5;
    for (let i = 0; i < steps; i++) {
      const a = base.clone().addScaledVector(dir, i * stepRun);
      const b = base.clone().addScaledVector(dir, (i + 1) * stepRun + 0.02);
      const h = base.y + (i + 1) * stepRise;
      const min = V(Math.min(a.x, b.x), base.y, Math.min(a.z, b.z));
      const max = V(Math.max(a.x, b.x), h, Math.max(a.z, b.z));
      if (alongX) {
        min.z = base.z - width / 2;
        max.z = base.z + width / 2;
      } else {
        min.x = base.x - width / 2;
        max.x = base.x + width / 2;
      }
      this.level.box(min, max, { material: 'metal', faces: ['py', 'px', 'nx', 'pz', 'nz'] });
    }
  }

  acid(min: THREE.Vector2, max: THREE.Vector2, surfaceY: number): AcidPool {
    const a = new AcidPool(this.level, min, max, surfaceY);
    this.hazards.push(a);
    return a;
  }

  crusher(x: number, z: number, footprint: THREE.Vector2, floorY: number, topY: number, upTime: number, offset = 0, auto = true): Crusher {
    const c = new Crusher(this.level, x, z, footprint, floorY, topY, upTime, offset, auto);
    this.hazards.push(c);
    return c;
  }

  laser(origin: THREE.Vector3, dir: THREE.Vector3, sweep?: { axis: THREE.Vector3; angle: number; period: number }): LaserEmitter {
    const l = new LaserEmitter(this.level, origin, dir, sweep);
    this.hazards.push(l);
    this.lasers.push(l);
    return l;
  }

  receiver(position: THREE.Vector3, facing: THREE.Vector3): LaserReceiver {
    const r = new LaserReceiver(this.level, position, facing);
    this.hazards.push(r);
    return r;
  }

  door(min: THREE.Vector3, max: THREE.Vector3, receiver: LaserReceiver): Door {
    const d = new Door(this.level, min, max, receiver);
    this.hazards.push(d);
    return d;
  }

  platform(size: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, speed?: number, pause?: number): MovingPlatform {
    const p = new MovingPlatform(this.level, size, a, b, speed, pause);
    this.hazards.push(p);
    return p;
  }

  /** A wall-mounted ram punching along `facing`; see RamOptions. */
  ram(o: RamOptions): Ram {
    const r = new Ram(this.level, o);
    this.hazards.push(r);
    return r;
  }

  spikes(o: SpikeOptions): Spikes {
    const s = new Spikes(this.level, o);
    this.hazards.push(s);
    return s;
  }

  trapdoor(o: TrapdoorOptions): Trapdoor {
    const t = new Trapdoor(this.level, o);
    this.hazards.push(t);
    return t;
  }

  /** A shootable switch; wire `trigger` switches up with setTargets. */
  switch(o: SwitchOptions): Switch {
    const s = new Switch(this.level, o);
    this.hazards.push(s);
    return s;
  }

  /** A free crate that returns to `home` whenever it is destroyed. */
  prop(home: THREE.Vector3): PropBox {
    const p = new PropBox(this.level.scene, this.level.physics, home, 0xc8a040);
    this.props.push(p);
    return p;
  }

  dropper(point: THREE.Vector3, ceilingY: number): Dropper {
    const d = new Dropper(this.level, point, ceilingY, this.killY);
    this.hazards.push(d);
    this.props.push(d.box);
    return d;
  }

  /** Rows of ceiling light strips over a rectangle. */
  ceilingLights(min: THREE.Vector2, max: THREE.Vector2, y: number, spacing = 6, color?: number): void {
    for (let x = min.x + spacing / 2; x < max.x; x += spacing) {
      addLightStrip(this.level, V(x, y - 0.04, min.y + 1), V(x, y - 0.04, max.y - 1), color);
    }
  }

  /** A painted outline showing where a laser should be relayed to. */
  target(center: THREE.Vector3, normal: THREE.Vector3, size = 1.3): void {
    const mat = this.level.own(glowMaterial(0x30ff70, 1.2, { transparent: true, opacity: 0.85 }));
    const ring = new THREE.Mesh(this.level.own(new THREE.RingGeometry(size * 0.42, size * 0.5, 32)), mat);
    ring.position.copy(center).addScaledVector(normal, 0.01);
    ring.lookAt(center.clone().add(normal));
    const dot = new THREE.Mesh(this.level.own(new THREE.CircleGeometry(size * 0.08, 16)), mat);
    dot.position.copy(ring.position);
    dot.quaternion.copy(ring.quaternion);
    this.level.scene.add(ring, dot);
  }
}

export interface ArenaDef {
  id: string;
  name: string;
  hint: string;
  /** One line for the stage list in the menu. */
  blurb?: string;
  build(b: ArenaBuilder): void;
}
