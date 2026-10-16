import * as THREE from 'three';
import type { ArenaBuilder, SpawnPoint } from '../world/ArenaBuilder';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';

/** A run time as m:ss.cc (or ss.cc under a minute). */
export function formatTime(seconds: number): string {
  // (A hair added so 42.7999... from summed steps shows as 42.80.)
  const cs = Math.max(0, Math.floor(seconds * 100 + 1e-6));
  const m = Math.floor(cs / 6000);
  const s = Math.floor(cs / 100) % 60;
  const c = cs % 100;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}` : `${s}.${String(c).padStart(2, '0')}`;
}

/** A difference against a best time: +1.23 / -0.45. */
export function formatDelta(seconds: number): string {
  return `${seconds >= 0 ? '+' : '-'}${formatTime(Math.abs(seconds))}`;
}

/** How far from the spawn pad the body may wander before the clock starts. */
const START_RADIUS = 1.6;

/**
 * One timed run of a speedrun map: the clock starts when the runner leaves the spawn pad,
 * each checkpoint must be passed in order (it records a split, and a fall brings the runner
 * back to it), and the finish gate stops the clock once every checkpoint is done.
 */
export class Speedrun {
  private readonly arena: ArenaBuilder;
  /** Run time in seconds; 0 until the clock starts. */
  time = 0;
  started = false;
  finished = false;
  /** Checkpoints passed so far: also the index of the next one. */
  next = 0;
  /** Run time at each checkpoint passed. */
  readonly splits: number[] = [];

  constructor(arena: ArenaBuilder) {
    this.arena = arena;
  }

  get checkpointCount(): number {
    return this.arena.checkpoints.length;
  }

  /** The clock runs from leaving the pad to crossing the finish. */
  advance(dt: number, position: THREE.Vector3): void {
    if (this.finished) return;
    if (!this.started) {
      const s = this.arena.spawn;
      if (Math.hypot(position.x - s.x, position.z - s.z) > START_RADIUS || Math.abs(position.y - s.y) > START_RADIUS) this.started = true;
      else return;
    }
    this.time += dt;
  }

  /**
   * The runner's body moved from `a` to `b` this step: what it passed. A gate passed out of
   * order does nothing; the finish only counts after every checkpoint.
   */
  cross(a: THREE.Vector3, b: THREE.Vector3): { checkpoint?: number; finish?: boolean } {
    if (this.finished) return {};
    const cp = this.arena.checkpoints[this.next];
    if (cp && cp.crossed(a, b)) {
      cp.setPassed(true);
      this.splits.push(this.time);
      return { checkpoint: this.next++ };
    }
    if (this.next >= this.arena.checkpoints.length && this.arena.finish?.crossed(a, b)) {
      this.finished = true;
      return { finish: true };
    }
    return {};
  }

  /** Where a fall brings the runner back: the last checkpoint passed, or null for the spawn. */
  respawnPoint(): SpawnPoint | null {
    const cp = this.arena.checkpoints[this.next - 1];
    if (!cp) return null;
    const feet = cp.respawn.feet;
    return { position: new THREE.Vector3(feet.x, feet.y + PLAYER_FEET_OFFSET + 0.02, feet.z), yaw: cp.respawn.yaw, team: null };
  }

  /** A fresh run (R): the clock and every checkpoint back to the start. */
  reset(): void {
    this.time = 0;
    this.started = false;
    this.finished = false;
    this.next = 0;
    this.splits.length = 0;
    for (const cp of this.arena.checkpoints) cp.setPassed(false);
  }
}
