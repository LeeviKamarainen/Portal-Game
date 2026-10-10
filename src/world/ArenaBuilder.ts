import * as THREE from 'three';
import { Level, type BoxOptions } from './Level';
import { Goal, addLightStrip, addSpawnPad } from './Markers';
import type { Hazard, PowerSource } from './hazards/Hazard';
import { PropBox } from './hazards/PropBox';
import { AcidPool } from './hazards/AcidPool';
import { Crusher } from './hazards/Crusher';
import { LaserEmitter, LaserReceiver } from './hazards/Laser';
import { Door } from './hazards/Door';
import { FloorButton, type FloorButtonOptions } from './hazards/FloorButton';
import { FaithPlate, type FaithPlateOptions } from './hazards/FaithPlate';
import { MovingPlatform } from './hazards/MovingPlatform';
import { Dropper } from './hazards/Dropper';
import { Ram, type RamOptions } from './hazards/Ram';
import { Spikes, type SpikeOptions } from './hazards/Spikes';
import { Trapdoor, type TrapdoorOptions } from './hazards/Trapdoor';
import { Switch, type SwitchOptions } from './hazards/Switch';
import { glowMaterial, materials } from './Materials';

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

  door(min: THREE.Vector3, max: THREE.Vector3, receiver: PowerSource): Door {
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

  /** A pressure pad in the floor; name it as a door's power source. */
  button(o: FloorButtonOptions): FloorButton {
    const b = new FloorButton(this.level, o);
    this.hazards.push(b);
    return b;
  }

  /** A jump pad that throws whoever steps on it (or whatever lands on it) to `o.target`. */
  jumpPad(o: FaithPlateOptions): FaithPlate {
    const p = new FaithPlate(this.level, o);
    this.hazards.push(p);
    return p;
  }

  /**
   * A pane of glass: solid, see-through, and nothing sticks to it - portal shots and
   * beams stop at it. `min`/`max` are the pane's corners; `tint` is its colour.
   */
  glass(min: THREE.Vector3, max: THREE.Vector3, tint = 0x9fd4ff): void {
    const solid = this.level.box(min, max, { faces: [] });
    this.level.physics.registerOwner(solid.collider.handle, { type: 'glass', ref: solid });
    const size = max.clone().sub(min);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const pane = new THREE.Mesh(
      this.level.own(new THREE.BoxGeometry(size.x, size.y, size.z)),
      this.level.own(
        new THREE.MeshStandardMaterial({ color: tint, transparent: true, opacity: 0.2, roughness: 0.05, metalness: 0.1, depthWrite: false, envMapIntensity: 1.2 }),
      ),
    );
    pane.position.copy(center);
    pane.renderOrder = 2;
    this.level.scene.add(pane);
    this.level.addBlocker(pane);
    // A thin steel frame round the edge, so a clear pane still reads as a wall.
    const bar = 0.1;
    const lengthX = size.x >= size.z;
    const length = lengthX ? size.x : size.z;
    const thick = (lengthX ? size.z : size.x) + 0.06;
    const strut = (along: number, y: number, l: number, h: number) => {
      const g = lengthX ? new THREE.BoxGeometry(l, h, thick) : new THREE.BoxGeometry(thick, h, l);
      const m = new THREE.Mesh(this.level.own(g), materials().trim);
      m.position.set(center.x + (lengthX ? along : 0), y, center.z + (lengthX ? 0 : along));
      m.castShadow = true;
      this.level.scene.add(m);
    };
    strut(0, max.y - bar / 2, length, bar);
    strut(0, min.y + bar / 2, length, bar);
    strut(-(length - bar) / 2, center.y, bar, size.y);
    strut((length - bar) / 2, center.y, bar, size.y);
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

  dropper(point: THREE.Vector3, ceilingY: number, auto = true): Dropper {
    const d = new Dropper(this.level, point, ceilingY, this.killY, auto);
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
  /** `combat`: a scored match; `puzzle` (the default): solo, ended by the exit goal. */
  kind?: 'combat' | 'puzzle';
  build(b: ArenaBuilder): void;
}
