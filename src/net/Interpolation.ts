import * as THREE from 'three';
import type { NetPlayer, NetProp } from './snapshot';

/**
 * Everyone else is drawn this many steps behind the newest snapshot to begin with (100 ms),
 * so there is always one to come. The delay then follows the connection: as short as
 * MIN_DELAY on a steady one, up to MAX_DELAY (150 ms) when snapshots come in bunches.
 */
const START_DELAY = 6;
const MIN_DELAY = 4;
const MAX_DELAY = 9;
/** Steps of snapshot the drawing clock should still have in hand when the next one arrives. */
const MARGIN = 1;
/** Snapshots (1 s) between looks at whether the delay can come down. */
const WINDOW = 30;
/** How far the delay comes down per WINDOW when the connection has been steadier than it needs. */
const EASE = 0.5;
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
 * runs at the game's step rate and keeps itself `delay` steps behind the newest snapshot.
 */
export class Interpolation {
  private readonly frames: Frame[] = [];
  /** The server step being drawn (fractional), or -1 before the first snapshot. */
  renderTick = -1;
  /** Steps behind the newest snapshot the drawing clock aims for (see START_DELAY). */
  delay = START_DELAY;
  /** Snapshots that came after the drawing clock had already caught up with the newest one (it stood still). */
  late = 0;
  /** The least snapshot in hand at an arrival during this window, in steps. */
  private lowest = Infinity;
  private arrivals = 0;
  /** Steps the drawing clock would have gone past the newest snapshot since it came (it waits there instead). */
  private overrun = 0;

  push(tick: number, players: readonly NetPlayer[], props: readonly NetProp[] = []): void {
    const last = this.frames[this.frames.length - 1];
    if (last && tick <= last.tick) return;
    if (last && this.renderTick >= 0) this.measure(last.tick - this.renderTick - this.overrun);
    this.overrun = 0;
    this.frames.push({ tick, players: new Map(players.map((p) => [p.slot, p])), props });
  }

  /**
   * `inHand`: how far ahead of the drawing clock the newest snapshot was when the next one
   * came - the low point, since it only grows on arrivals. Less than MARGIN and the delay
   * goes up at once by as much; a whole window with more to spare and it eases down.
   */
  private measure(inHand: number): void {
    if (inHand <= 0) this.late++;
    if (inHand < MARGIN) this.delay = Math.min(MAX_DELAY, this.delay + (MARGIN - inHand));
    this.lowest = Math.min(this.lowest, inHand);
    if (++this.arrivals < WINDOW) return;
    const spare = this.lowest - MARGIN;
    if (spare > EASE) this.delay = Math.max(MIN_DELAY, this.delay - Math.min(EASE, spare - EASE));
    this.lowest = Infinity;
    this.arrivals = 0;
  }

  /** One game step went by. */
  advance(): void {
    const newest = this.frames[this.frames.length - 1];
    if (!newest) return;
    const target = newest.tick - this.delay;
    if (this.renderTick < 0 || Math.abs(this.renderTick - target) > SNAP) this.renderTick = target;
    else this.renderTick += 1 + (target - this.renderTick) * PULL;
    if (this.renderTick > newest.tick) {
      this.overrun += this.renderTick - newest.tick;
      this.renderTick = newest.tick;
    }
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
