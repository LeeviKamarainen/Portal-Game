import * as THREE from 'three';
import type { BotSkill } from './BotSkill';

/** Same limit as the player controller's. */
const PITCH_LIMIT = Math.PI / 2 - 0.01;
/** Pitch turns a bit slower than yaw, as a mouse hand does. */
const PITCH_RATE = 0.7;

const _d = new THREE.Vector3();

function wrap(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Yaw/pitch that look from `eye` at `point` (the player controller's convention: yaw 0 looks down -z). */
export function anglesTo(eye: THREE.Vector3, point: THREE.Vector3): { yaw: number; pitch: number } {
  _d.copy(point).sub(eye);
  const len = _d.length() || 1;
  return { yaw: Math.atan2(-_d.x, -_d.z), pitch: Math.asin(THREE.MathUtils.clamp(_d.y / len, -1, 1)) };
}

/**
 * Turns a bot's head the way a person turns a mouse: never faster than the skill's turn
 * rate, speeding up and slowing down rather than snapping, starting only a reaction time
 * after something new catches its attention, and with an aim error that shrinks the longer
 * it keeps tracking the same thing (down to a small wobble that never goes away). Its
 * output is just the look change for this step's PlayerCommand.
 */
export class LookController {
  private readonly skill: BotSkill;
  private readonly random: () => number;
  private yawRate = 0;
  private pitchRate = 0;
  private key: string | null = null;
  private readonly point = new THREE.Vector3();
  private pendingKey: string | null = null;
  private readonly pendingPoint = new THREE.Vector3();
  private pendingAt = 0;
  /** When the current target was taken up, for the aim error's decay. */
  private trackingSince = 0;
  private errYaw = 0;
  private errPitch = 0;
  /** Phases of the residual wobble (a slow sway plus a faster tremor, per axis). */
  private readonly phase: number[];
  /** Largest turn rate it has produced, rad/s (for tests). */
  peakRate = 0;

  constructor(skill: BotSkill, random: () => number) {
    this.skill = skill;
    this.random = random;
    this.phase = [0, 1, 2, 3].map(() => random() * Math.PI * 2);
  }

  /** What it is looking at, if anything (null while idle or still reacting to the first target). */
  get target(): string | null {
    return this.key;
  }

  /**
   * Look at `point`, identified by `key` ("enemy:p1", "orb:3"...). Following the same key
   * just updates the point; a new key is taken up after the reaction time - straight away if
   * it's `planned` (somewhere it decided to look in advance, nothing to react to).
   */
  lookAt(key: string, point: THREE.Vector3, now: number, planned = false): void {
    if (key === this.key) {
      this.point.copy(point);
      this.pendingKey = null;
      return;
    }
    if (key !== this.pendingKey) {
      this.pendingKey = key;
      this.pendingAt = now + (planned ? 0 : this.skill.reaction);
    }
    this.pendingPoint.copy(point);
  }

  /** Stop following anything (the head eases to a stop). */
  release(): void {
    this.key = null;
    this.pendingKey = null;
  }

  /** This step's look change, given where the eye is and where it looks now. */
  update(dt: number, now: number, eye: THREE.Vector3, yaw: number, pitch: number): { yaw: number; pitch: number } {
    if (this.pendingKey && now >= this.pendingAt) {
      this.key = this.pendingKey;
      this.point.copy(this.pendingPoint);
      this.pendingKey = null;
      this.trackingSince = now;
      // A fresh error for a fresh target: up to the skill's, in a random direction.
      const a = this.random() * Math.PI * 2;
      const m = this.skill.aimError * (0.5 + 0.5 * this.random());
      this.errYaw = Math.cos(a) * m;
      this.errPitch = Math.sin(a) * m;
    }

    let wantYaw = 0;
    let wantPitch = 0;
    if (this.key) {
      const decay = Math.exp(-(now - this.trackingSince) / this.skill.aimSettle);
      const goal = anglesTo(eye, this.point);
      const [a, b, c, d] = this.phase;
      const w = this.skill.aimWobble;
      const wobYaw = w * (0.65 * Math.sin(now * 1.9 + a) + 0.35 * Math.sin(now * 5.3 + b));
      const wobPitch = w * (0.65 * Math.sin(now * 1.6 + c) + 0.35 * Math.sin(now * 4.7 + d));
      wantYaw = wrap(goal.yaw + this.errYaw * decay + wobYaw - yaw);
      const goalPitch = THREE.MathUtils.clamp(goal.pitch + this.errPitch * decay + wobPitch, -PITCH_LIMIT, PITCH_LIMIT);
      wantPitch = goalPitch - pitch;
    }
    const s = this.skill;
    this.yawRate = this.steer(this.yawRate, wantYaw, s.turnRate, s.turnAccel, dt);
    this.pitchRate = this.steer(this.pitchRate, wantPitch, s.turnRate * PITCH_RATE, s.turnAccel * PITCH_RATE, dt);
    this.peakRate = Math.max(this.peakRate, Math.abs(this.yawRate), Math.abs(this.pitchRate));
    return { yaw: this.yawRate * dt, pitch: this.pitchRate * dt };
  }

  /** How far the view is from the target right now, radians (Infinity with no target). */
  offTarget(eye: THREE.Vector3, yaw: number, pitch: number): number {
    if (!this.key) return Infinity;
    const goal = anglesTo(eye, this.point);
    return Math.hypot(wrap(goal.yaw - yaw) * Math.cos(pitch), goal.pitch - pitch);
  }

  /**
   * New angular speed: head for the speed that would just stop on target (braking at the
   * skill's acceleration - a little late, for the overshoot), never past the turn rate, and
   * changing by at most the acceleration per step.
   */
  private steer(rate: number, error: number, maxRate: number, accel: number, dt: number): number {
    const brake = Math.sqrt(2 * accel * Math.abs(error)) * this.skill.overshoot;
    const want = Math.sign(error) * Math.min(maxRate, brake, Math.abs(error) / dt);
    const next = rate + THREE.MathUtils.clamp(want - rate, -accel * dt, accel * dt);
    return THREE.MathUtils.clamp(next, -maxRate, maxRate);
  }
}
