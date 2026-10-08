import * as THREE from 'three';
import { simEnv } from '../../sim/env';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { type Hazard, type HazardContext, type Triggerable } from './Hazard';

export type SwitchEffect = 'portals' | 'trigger' | 'gravity';

export interface SwitchOptions {
  /** Centre of the wall face the switch is mounted on. */
  mount: THREE.Vector3;
  /** Out of the wall: the side with the target. */
  facing: THREE.Vector3;
  effect: SwitchEffect;
  /** Seconds before it can be used again. */
  cooldown?: number;
  /** gravity: multiplier and how long it lasts. */
  factor?: number;
  duration?: number;
}

export const EFFECT_COLORS: Record<SwitchEffect, number> = {
  portals: 0xc070ff,
  trigger: 0xffa020,
  gravity: 0x5d7bff,
};

const HOUSING = new THREE.Vector3(1.2, 1.2, 0.35);

/**
 * A shootable switch. Hitting its target with either portal colour sets it off instead of
 * opening a portal: it can close every portal in the arena, set off the hazards it is
 * wired to, or make gravity heavier for a while. Its colour and icon say which, and the
 * glowing ring goes dark while it recharges.
 */
export class Switch implements Hazard {
  readonly effect: SwitchEffect;
  private readonly mount: THREE.Vector3;
  private readonly cooldown: number;
  private readonly factor: number;
  private readonly duration: number;
  private readonly ring: THREE.MeshBasicMaterial;
  private readonly color: THREE.Color;
  private targets: Triggerable[] = [];
  private ready = 0;
  private time = 0;
  private flash = 0;

  constructor(level: Level, o: SwitchOptions) {
    this.effect = o.effect;
    this.mount = o.mount.clone();
    this.cooldown = o.cooldown ?? 10;
    this.factor = o.factor ?? 1.8;
    this.duration = o.duration ?? 8;
    this.color = new THREE.Color(EFFECT_COLORS[o.effect]);

    const facing = o.facing.clone().normalize();
    const group = new THREE.Group();
    group.position.copy(o.mount);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing);
    const housing = new THREE.Mesh(level.own(new THREE.BoxGeometry(HOUSING.x, HOUSING.y, HOUSING.z)), materials().trim);
    housing.position.z = HOUSING.z / 2;
    housing.castShadow = true;
    const face = new THREE.Mesh(
      level.own(new THREE.CircleGeometry(0.42, 40)),
      level.own(
        simEnv.headless
          ? new THREE.MeshStandardMaterial()
          : new THREE.MeshStandardMaterial({ map: iconTexture(o.effect), roughness: 0.5, emissive: 0xffffff, emissiveIntensity: 0.35, emissiveMap: iconTexture(o.effect) }),
      ),
    );
    face.position.z = HOUSING.z + 0.006;
    this.ring = level.own(glowMaterial(EFFECT_COLORS[o.effect], 1.4));
    const ring = new THREE.Mesh(level.own(new THREE.RingGeometry(0.44, 0.52, 40)), this.ring);
    ring.position.z = HOUSING.z + 0.008;
    group.add(housing, face, ring);
    level.scene.add(group);
    level.addInteractable(housing, this);
    level.addInteractable(face, this);
  }

  /** Wires up the hazards a `trigger` switch sets off (they may be built after it). */
  setTargets(targets: Triggerable[]): void {
    this.targets = targets;
  }

  get isReady(): boolean {
    return this.time >= this.ready;
  }

  /** A shot hit it. Returns whether it went off. */
  shoot(ctx: HazardContext): boolean {
    if (!this.isReady) {
      ctx.sound('fizzle', 0.5);
      return false;
    }
    this.ready = this.time + this.cooldown;
    this.flash = 1;
    ctx.sound('click', 0.9);
    ctx.sound('door', 0.8, this.mount, 40);
    switch (this.effect) {
      case 'portals':
        ctx.effects.clearPortals();
        break;
      case 'trigger':
        for (const t of this.targets) t.trigger();
        break;
      case 'gravity':
        ctx.effects.setGravity(this.factor, this.duration);
        break;
    }
    return true;
  }

  update(dt: number): void {
    this.time += dt;
    this.flash = Math.max(0, this.flash - dt * 3);
    if (this.isReady) {
      // Ready: a slow breathing glow in the effect's colour.
      const k = 1.1 + Math.sin(this.time * 3) * 0.35 + this.flash * 2;
      this.ring.color.copy(this.color).multiplyScalar(k);
    } else {
      // Recharging: dark red, brightening back toward ready.
      const left = (this.ready - this.time) / this.cooldown;
      this.ring.color.setRGB(0.5, 0.04, 0.03).lerp(this.color.clone().multiplyScalar(0.5), 1 - left).multiplyScalar(1 + this.flash * 3);
    }
  }

  reset(): void {
    this.ready = this.time;
  }
}

const icons = new Map<SwitchEffect, THREE.CanvasTexture>();

/** The icon on a switch's face (shared, cached; also used by the map editor). */
export function iconTexture(effect: SwitchEffect): THREE.CanvasTexture {
  const cached = icons.get(effect);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121419';
  g.fillRect(0, 0, 128, 128);
  const col = `#${EFFECT_COLORS[effect].toString(16).padStart(6, '0')}`;
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  if (effect === 'portals') {
    // Two portals, struck through.
    g.strokeStyle = '#ff7a1a';
    g.beginPath();
    g.ellipse(46, 64, 16, 30, 0, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = '#2ab8ff';
    g.beginPath();
    g.ellipse(82, 64, 16, 30, 0, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = col;
    g.lineWidth = 11;
    g.beginPath();
    g.moveTo(28, 100);
    g.lineTo(100, 28);
    g.stroke();
  } else if (effect === 'trigger') {
    // A lightning bolt.
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(72, 16);
    g.lineTo(38, 70);
    g.lineTo(62, 70);
    g.lineTo(52, 112);
    g.lineTo(92, 52);
    g.lineTo(67, 52);
    g.closePath();
    g.fill();
  } else {
    // Weight pressing down: two heavy chevrons over a bar.
    g.strokeStyle = col;
    g.lineWidth = 12;
    for (const y of [30, 58]) {
      g.beginPath();
      g.moveTo(32, y);
      g.lineTo(64, y + 26);
      g.lineTo(96, y);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(30, 104);
    g.lineTo(98, 104);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  icons.set(effect, tex);
  return tex;
}
