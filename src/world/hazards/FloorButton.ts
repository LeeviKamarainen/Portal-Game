import * as THREE from 'three';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET } from '../../player/PlayerController';
import { BOX_HALF } from './PropBox';
import { type Hazard, type HazardContext, type PowerSource } from './Hazard';

/**
 * Height of the pad above the floor it is set into. It is drawn, not solid: a crate is shoved
 * onto it as easily as across the floor, and a step would stop it.
 */
export const BUTTON_HEIGHT = 0.04;
/** How far inside the pad's edge a body's centre may be and still press it. */
const EDGE_REACH = 0.1;
/** A crate bouncing on the pad must be off it this long before the button lets go. */
const RELEASE_GRACE = 0.15;

const OFF_COLOR = new THREE.Color(0xff7a1a);
const ON_COLOR = new THREE.Color(0x30d8ff);

export type ButtonNeeds = 'any' | 'crate';

export interface FloorButtonOptions {
  /** Centre of the floor surface the pad sits on. */
  center: THREE.Vector3;
  /** Width (x) and depth (z). */
  size: THREE.Vector2;
  /** `any`: a player or a crate holds it down. `crate`: only a crate is heavy enough. */
  needs?: ButtonNeeds;
  /** Seconds it stays on after being let go (a timed door). */
  hold?: number;
}

/**
 * A pressure pad set into the floor. It is down - and its power on - while a crate (or,
 * for an `any` button, a player) stands on it, and then drives whatever door names it.
 * Orange ring while up, cyan while down.
 */
export class FloorButton implements Hazard, PowerSource {
  powered = false;
  private readonly center: THREE.Vector3;
  private readonly half: THREE.Vector2;
  private readonly needs: ButtonNeeds;
  private readonly hold: number;
  private readonly pad: THREE.Group;
  private readonly ring: THREE.MeshBasicMaterial;
  private left = 0;
  private sink = 0;

  constructor(level: Level, o: FloorButtonOptions) {
    this.center = o.center.clone();
    this.half = o.size.clone().multiplyScalar(0.5);
    this.needs = o.needs ?? 'any';
    this.hold = Math.max(0, o.hold ?? 0);

    const m = materials();
    const { x: w, y: d } = o.size;
    const group = new THREE.Group();
    group.position.copy(this.center);
    // Hazard-striped bezel (flush with the floor's feet) and the pad that sinks inside it.
    const bezel = new THREE.Mesh(level.own(new THREE.BoxGeometry(w + 0.36, 0.02, d + 0.36)), m.hazard);
    bezel.position.y = 0.01;
    this.pad = new THREE.Group();
    const slab = new THREE.Mesh(level.own(new THREE.BoxGeometry(w, BUTTON_HEIGHT, d)), m.trim);
    slab.position.y = BUTTON_HEIGHT / 2;
    slab.castShadow = true;
    slab.receiveShadow = true;
    this.ring = level.own(glowMaterial(0xff7a1a, 1.8));
    const inset = Math.min(0.28, Math.min(w, d) * 0.2);
    const light = new THREE.Mesh(level.own(new THREE.BoxGeometry(Math.max(0.1, w - inset * 2), 0.012, Math.max(0.1, d - inset * 2))), this.ring);
    light.position.y = BUTTON_HEIGHT + 0.004;
    this.pad.add(slab, light);
    group.add(bezel, this.pad);
    level.scene.add(group);
    // Not a surface: a shot aimed at it fizzles.
    level.addBlocker(slab);
    group.updateMatrixWorld(true);

    this.paint();
  }

  /** The surface a body presses on. */
  get surfaceY(): number {
    return this.center.y + BUTTON_HEIGHT;
  }

  private under(x: number, z: number): boolean {
    return Math.abs(x - this.center.x) <= this.half.x + EDGE_REACH && Math.abs(z - this.center.z) <= this.half.y + EDGE_REACH;
  }

  private pressedBy(ctx: HazardContext): boolean {
    const top = this.surfaceY;
    for (const box of ctx.props) {
      if (!box.visible || box.passing) continue;
      const p = box.getPosition();
      if (this.under(p.x, p.z) && p.y - BOX_HALF - top > -0.2 && p.y - BOX_HALF - top < 0.35) return true;
    }
    if (this.needs === 'any') {
      for (const player of ctx.players) {
        const p = player.getPosition();
        const feet = p.y - PLAYER_FEET_OFFSET - top;
        if (this.under(p.x, p.z) && feet > -0.2 && feet < 0.3) return true;
      }
    }
    return false;
  }

  update(dt: number, ctx: HazardContext): void {
    // Online, on a player's screen: the game server says whether it is down.
    if (!ctx.netClient) {
      const pressed = this.pressedBy(ctx);
      if (pressed) this.left = Math.max(this.hold, RELEASE_GRACE);
      else this.left = Math.max(0, this.left - dt);
      const on = pressed || this.left > 0;
      if (on !== this.powered) ctx.sound('click', 0.7, this.center, 25);
      this.powered = on;
    }
    this.paint(dt);
  }

  private paint(dt = 0): void {
    const target = this.powered ? 1 : 0;
    this.sink += Math.sign(target - this.sink) * Math.min(Math.abs(target - this.sink), dt * 12 || 1);
    this.pad.position.y = -BUTTON_HEIGHT * 0.8 * this.sink;
    this.ring.color.copy(OFF_COLOR).lerp(ON_COLOR, this.sink).multiplyScalar(1.8);
  }

  netState(): number[] {
    return [this.powered ? 1 : 0, this.left];
  }

  setNetState(s: readonly number[]): void {
    this.powered = s[0] === 1;
    this.left = s[1] ?? 0;
  }

  reset(): void {
    this.powered = false;
    this.left = 0;
    this.sink = 0;
    this.paint();
  }
}
