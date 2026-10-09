import * as THREE from 'three';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PropBox } from './PropBox';
import { type Hazard, type HazardContext } from './Hazard';

const SETTLE_SPEED = 0.05;
const SETTLE_DELAY = 2;
/** Warning time before each drop: the hatch light flashes and the box hangs in view. */
const WARN_TIME = 1.4;

/**
 * A ceiling hatch that keeps dropping a heavy crate. The crate is a real physics prop -
 * it hurts on impact, and it can be knocked into or fall through portals.
 */
export class Dropper implements Hazard {
  readonly box: PropBox;
  private readonly dropPoint: THREE.Vector3;
  private readonly lamp: THREE.MeshBasicMaterial;
  private readonly killY: number;
  private settleTimer = 0;
  private warnTimer = 0;
  private waiting = false;

  constructor(level: Level, dropPoint: THREE.Vector3, ceilingY: number, killY: number) {
    this.dropPoint = dropPoint.clone();
    this.killY = killY;
    this.box = new PropBox(level.scene, level.physics, dropPoint);

    const hatch = new THREE.Mesh(level.own(new THREE.CylinderGeometry(0.9, 1.1, 0.25, 20)), materials().hazard);
    hatch.position.set(dropPoint.x, ceilingY - 0.12, dropPoint.z);
    this.lamp = level.own(glowMaterial(0xff3020, 3));
    const lampRing = new THREE.Mesh(level.own(new THREE.TorusGeometry(0.7, 0.05, 8, 32)), this.lamp);
    lampRing.rotation.x = Math.PI / 2;
    lampRing.position.set(dropPoint.x, ceilingY - 0.26, dropPoint.z);
    level.scene.add(hatch, lampRing);
    level.addBlocker(hatch);
    this.startWarning();
  }

  get props(): PropBox[] {
    return [this.box];
  }

  private startWarning(): void {
    this.waiting = true;
    this.warnTimer = 0;
    this.box.respawnAt(this.dropPoint);
    this.box.setVisible(true);
    this.box.setFrozen(true);
  }

  netState(): number[] {
    return [this.waiting ? 1 : 0, this.warnTimer, this.settleTimer];
  }

  setNetState(s: readonly number[]): void {
    this.waiting = s[0] === 1;
    [, this.warnTimer, this.settleTimer] = s;
  }

  update(dt: number, ctx: HazardContext): void {
    // Online, on a player's screen, the crate is where the game server says: only the lamp runs here.
    if (ctx.netClient) {
      const blink = this.waiting ? (Math.sin((this.warnTimer += dt) * 18) > 0 ? 1 : 0.15) : 0.2;
      this.lamp.color.setRGB(3 * blink, 0.2 * blink, 0.1 * blink);
      return;
    }
    if (this.waiting) {
      this.warnTimer += dt;
      const blink = Math.sin(this.warnTimer * 18) > 0 ? 1 : 0.15;
      this.lamp.color.setRGB(3 * blink, 0.2 * blink, 0.1 * blink);
      if (this.warnTimer >= WARN_TIME) {
        this.waiting = false;
        this.box.setFrozen(false);
        this.lamp.color.setRGB(0.6, 0.05, 0.02);
        ctx.sound('warn', 1, this.dropPoint, 30);
      }
      return;
    }

    const p = this.box.getPosition();
    if (p.y < this.killY) {
      this.startWarning();
      return;
    }
    this.settleTimer = this.box.speed() < SETTLE_SPEED ? this.settleTimer + dt : 0;
    if (this.settleTimer >= SETTLE_DELAY) {
      this.settleTimer = 0;
      this.startWarning();
    }
  }

  reset(): void {
    this.settleTimer = 0;
    this.startWarning();
  }
}
