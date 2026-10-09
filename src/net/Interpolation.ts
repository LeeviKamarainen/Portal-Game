import * as THREE from 'three';
import type { NetPlayer, NetProp } from './snapshot';

/** Everyone else is drawn this many steps (100 ms) behind the newest snapshot, so there is always one to come. */
const DELAY = 6;
/** Further than this from where it should be, the drawing clock jumps instead of drifting there. */
const SNAP = 30;
/** How hard the drawing clock is pulled toward its place each step. */
const PULL = 0.03;

interface Frame {
  tick: number;
  players: Map<number, NetPlayer>;
  props: readonly NetProp[];
}

/** A crate further than this from one snapshot to the next jumped (it came back home): no sliding. */
const PROP_JUMP = 3;

/** Where a player was drawn at one moment: between two snapshots, or the nearest one. */
export interface Pose {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  dead: boolean;
  grounded: boolean;
}

/** Where a crate is drawn now. */
export interface PropPose {
  visible: boolean;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  passing: number;
}

/**
 * Other players and the crates as the snapshots saw them, played back a little in the
 * past: each is drawn between the two snapshots either side of the drawing clock, which
 * runs at the game's step rate and keeps itself DELAY steps behind the newest snapshot.
 */
export class Interpolation {
  private readonly frames: Frame[] = [];
  /** The server step being drawn (fractional), or -1 before the first snapshot. */
  renderTick = -1;

  push(tick: number, players: readonly NetPlayer[], props: readonly NetProp[] = []): void {
    const last = this.frames[this.frames.length - 1];
    if (last && tick <= last.tick) return;
    this.frames.push({ tick, players: new Map(players.map((p) => [p.slot, p])), props });
  }

  /** One game step went by. */
  advance(): void {
    const newest = this.frames[this.frames.length - 1];
    if (!newest) return;
    const target = newest.tick - DELAY;
    if (this.renderTick < 0 || Math.abs(this.renderTick - target) > SNAP) this.renderTick = target;
    else this.renderTick += 1 + (target - this.renderTick) * PULL;
    this.renderTick = Math.min(this.renderTick, newest.tick);
    // Keep one snapshot from before the drawing clock.
    while (this.frames.length > 2 && this.frames[1].tick <= this.renderTick) this.frames.shift();
  }

  /** The snapshots either side of the drawing clock, and how far between them it is. */
  private bracket(): { a: Frame; b: Frame | undefined; k: number } | null {
    const t = this.renderTick;
    for (let i = 0; i < this.frames.length; i++) {
      const f = this.frames[i];
      const next = this.frames[i + 1];
      if (!next || next.tick > t) {
        return { a: f, b: next, k: next ? THREE.MathUtils.clamp((t - f.tick) / (next.tick - f.tick), 0, 1) : 0 };
      }
    }
    return null;
  }

  /** Where player `slot` is drawn now; false if no snapshot has them. */
  sample(slot: number, out: Pose): boolean {
    const at = this.bracket();
    if (!at) return false;
    const a = at.a.players.get(slot);
    const b = at.b?.players.get(slot);
    const k = at.k;
    if (!a && !b) return false;
    // Through a portal or back to a spawn pad: no sliding across the gap.
    if (!a || !b || a.warp !== b.warp) {
      const p = (a && (!b || k < 0.5) ? a : b)!;
      return this.copy(p, out);
    }
    out.position.lerpVectors(a.position, b.position, k);
    out.velocity.lerpVectors(a.velocity, b.velocity, k);
    let dyaw = (b.yaw - a.yaw) % (Math.PI * 2);
    if (dyaw > Math.PI) dyaw -= Math.PI * 2;
    if (dyaw < -Math.PI) dyaw += Math.PI * 2;
    out.yaw = a.yaw + dyaw * k;
    out.pitch = a.pitch + (b.pitch - a.pitch) * k;
    const near = k < 0.5 ? a : b;
    out.dead = near.dead;
    out.grounded = near.grounded;
    return true;
  }

  /** Where crate `index` is drawn now; false if no snapshot has it. */
  sampleProp(index: number, out: PropPose): boolean {
    const at = this.bracket();
    const a = at?.a.props[index];
    if (!at || !a) return false;
    const b = at.b?.props[index];
    const k = at.k;
    const slide = b && a.warp === b.warp && a.visible === b.visible && a.position.distanceTo(b.position) < PROP_JUMP;
    const near = !b || k < 0.5 ? a : b;
    if (slide) {
      out.position.lerpVectors(a.position, b.position, k);
      out.rotation.slerpQuaternions(a.rotation, b.rotation, k);
    } else {
      out.position.copy(near.position);
      out.rotation.copy(near.rotation);
    }
    out.visible = near.visible;
    out.passing = near.passing;
    return true;
  }

  private copy(p: NetPlayer, out: Pose): boolean {
    out.position.copy(p.position);
    out.velocity.copy(p.velocity);
    out.yaw = p.yaw;
    out.pitch = p.pitch;
    out.dead = p.dead;
    out.grounded = p.grounded;
    return true;
  }
}
