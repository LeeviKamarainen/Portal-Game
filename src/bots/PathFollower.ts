import * as THREE from 'three';
import type { PlayerController } from '../player/PlayerController';
import { EYE_OFFSET, PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { PlayerCommand } from '../player/PlayerCommand';
import type { NavGraph, NavNode, NavPath } from './NavGraph';

/** A waypoint counts as reached this close (horizontally). */
const REACH = 0.45;
/** Steer at a point this far ahead along walk links (smooths the grid's corners). */
const LOOKAHEAD = 1.4;
/** It looks this far ahead along its heading while walking. */
const LOOK_AHEAD = 4;
/** Check this many nodes ahead for hazards about to go off. */
const DANGER_AHEAD = 3;
/** Give up waiting on a hazard and look for another way after this long. */
const WAIT_LIMIT = 4;
/** Must make this much progress every PROGRESS_WINDOW seconds, or it re-plans. */
const PROGRESS = 0.3;
const PROGRESS_WINDOW = 1.2;
const MAX_REPLANS = 3;

export type FollowStatus = 'idle' | 'moving' | 'waiting' | 'arrived' | 'stuck' | 'no-path';

const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _look = new THREE.Vector3();

/**
 * Walks a body along a navigation path by filling in the move part of its PlayerCommand -
 * forward/right keys relative to wherever it happens to be looking, and jump - exactly what
 * a person's keyboard would do. Waits for a hazard on the path ahead to finish (its warning
 * is showing), re-plans when knocked off the route or stuck.
 */
export class PathFollower {
  status: FollowStatus = 'idle';
  path: NavPath | null = null;
  /** Index of the node it is heading from; it heads for path.nodes[index + 1]. */
  private index = 0;
  private readonly goal = new THREE.Vector3();
  private readonly nav: NavGraph;
  private readonly body: PlayerController;
  private waitedFor = 0;
  private progressAt = new THREE.Vector3();
  private progressTimer = 0;
  private replans = 0;
  /** Where it means to go next, for the head to look at (eye height), or null. */
  readonly lookPoint = new THREE.Vector3();
  hasLookPoint = false;
  /** Floor to keep off (open floor portals): routes go round it where they can. */
  avoid: ((n: NavNode) => boolean) | null = null;
  private avoidReplanAt = 0;
  private clock = 0;

  constructor(nav: NavGraph, body: PlayerController) {
    this.nav = nav;
    this.body = body;
  }

  /** Head for `point` (a body-centre position). */
  goTo(point: THREE.Vector3): FollowStatus {
    this.goal.copy(point);
    this.replans = 0;
    this.plan();
    return this.status;
  }

  stop(): void {
    this.path = null;
    this.status = 'idle';
    this.hasLookPoint = false;
  }

  private plan(): void {
    this.path = this.nav.findPath(this.body.getPosition(), this.goal, this.avoid ?? undefined);
    this.index = 0;
    this.waitedFor = 0;
    this.progressTimer = 0;
    this.progressAt.copy(this.body.getPosition());
    this.status = this.path ? 'moving' : 'no-path';
  }

  /** Fills in cmd.forward / cmd.right / cmd.jump for this step. */
  update(dt: number, cmd: PlayerCommand, yaw: number): void {
    this.clock += dt;
    this.hasLookPoint = false;
    const path = this.path;
    if (!path || this.status === 'arrived' || this.status === 'stuck' || this.status === 'no-path') return;
    const pos = this.body.getPosition();
    const nodes = path.nodes;

    // Advance past waypoints reached (or already walked past).
    while (this.index < nodes.length - 1 && (this.reached(pos, nodes[this.index + 1]) || this.passed(pos, this.index + 1))) this.index++;
    const toGoal = Math.hypot(this.goal.x - pos.x, this.goal.z - pos.z);
    const landed = this.body.isGrounded;
    if (landed && this.index >= nodes.length - 2 && (toGoal < REACH || (this.index >= nodes.length - 1 && !this.endsAtGoal()))) {
      this.status = 'arrived';
      return;
    }

    // Knocked off the route (a ram, a portal, a fall): find the way again.
    const here = this.nav.nearest(pos, 1);
    if (this.body.isGrounded && this.offRoute(pos)) {
      this.replan();
      return;
    }

    const ahead = nodes.slice(this.index + 1, this.index + 1 + DANGER_AHEAD);
    // A floor portal opened on the route ahead: find a way round (it won't go away by waiting).
    if (this.avoid && this.clock >= this.avoidReplanAt && ahead.some((n) => this.avoid!(n))) {
      this.avoidReplanAt = this.clock + 1;
      this.plan();
      return;
    }

    // A hazard just ahead is about to go off (or is going): wait for it - unless standing in it.
    const standingInDanger = here ? this.nav.blocked(here) : false;
    if (!standingInDanger && ahead.some((n) => this.nav.blocked(n))) {
      this.status = 'waiting';
      this.waitedFor += dt;
      this.progressTimer = 0;
      this.progressAt.copy(pos);
      if (this.waitedFor > WAIT_LIMIT) {
        this.waitedFor = 0;
        this.replan();
      }
      return;
    }
    this.status = 'moving';
    this.waitedFor = 0;

    // Stuck: hardly moved for a while.
    this.progressTimer += dt;
    if (this.progressTimer >= PROGRESS_WINDOW) {
      const moved = pos.distanceTo(this.progressAt);
      this.progressTimer = 0;
      this.progressAt.copy(pos);
      if (moved >= PROGRESS) this.replans = 0;
      else if (!this.replan()) return;
    }

    const next = nodes[Math.min(this.index + 1, nodes.length - 1)];
    const link = path.links[Math.min(this.index, path.links.length - 1)];
    const target = this.steerPoint(pos, _p);

    _d.set(target.x - pos.x, 0, target.z - pos.z);
    const dist = _d.length();
    if (dist > 1e-3) _d.divideScalar(dist);
    // Ease off right at the end so it doesn't overrun the goal.
    const speed = this.index >= nodes.length - 2 ? THREE.MathUtils.clamp(toGoal / 0.8, 0.25, 1) : 1;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    cmd.forward = (_d.x * fx + _d.z * fz) * speed;
    cmd.right = (_d.x * -fz + _d.z * fx) * speed;

    if (link?.kind === 'jump' && this.body.isGrounded) {
      const from = nodes[this.index];
      const out = Math.hypot(pos.x - from.x, pos.z - from.z);
      const span = Math.hypot(next.x - from.x, next.z - from.z);
      // Up onto a ledge: jump just short of it. Across a gap: jump at the edge.
      if (span <= 1.01 ? Math.hypot(next.x - pos.x, next.z - pos.z) < 1.1 : out > 0.3) cmd.jump = true;
    }

    // Look the way it's heading, a few metres out (never at a point right beside it, which
    // would swing the head round as it passes - and the keys are relative to the head).
    if (dist > 0.05 && toGoal > 1) {
      this.lookPoint.set(pos.x + _d.x * LOOK_AHEAD, next.y + PLAYER_FEET_OFFSET + EYE_OFFSET, pos.z + _d.z * LOOK_AHEAD);
    }
    _look.copy(this.lookPoint).sub(pos).setY(0);
    this.hasLookPoint = _look.lengthSq() > 1;
  }

  /** The route's last node is right by the goal, so the goal itself is the last waypoint. */
  private endsAtGoal(): boolean {
    const last = this.path!.nodes[this.path!.nodes.length - 1];
    return Math.hypot(last.x - this.goal.x, last.z - this.goal.z) <= 1;
  }

  /** Already beyond waypoint i, heading on along a flat walk (overshot it a little). */
  private passed(pos: THREE.Vector3, i: number): boolean {
    const { nodes } = this.path!;
    if (i + 1 >= nodes.length || !this.flat(i - 1) || !this.flat(i)) return false;
    const n = nodes[i];
    const m = nodes[i + 1];
    if (Math.hypot(n.x - pos.x, n.z - pos.z) > 1) return false;
    return (pos.x - n.x) * (m.x - n.x) + (pos.z - n.z) * (m.z - n.z) > 0;
  }

  /** Link i is a walk with no height change worth mentioning (corners can be cut). */
  private flat(i: number): boolean {
    const { nodes, links } = this.path!;
    return links[i]?.kind === 'walk' && Math.abs(nodes[i + 1].y - nodes[i].y) < 0.15;
  }

  /** More than 1.5 m sideways from the stretch of route around here, or well below it. */
  private offRoute(pos: THREE.Vector3): boolean {
    const nodes = this.path!.nodes;
    const feet = pos.y - PLAYER_FEET_OFFSET;
    let best = Infinity;
    let lowest = Infinity;
    for (let i = Math.max(0, this.index - 1); i < Math.min(nodes.length - 1, this.index + 3); i++) {
      const a = nodes[i];
      const b = nodes[i + 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      const t = THREE.MathUtils.clamp(((pos.x - a.x) * abx + (pos.z - a.z) * abz) / len2, 0, 1);
      best = Math.min(best, Math.hypot(a.x + abx * t - pos.x, a.z + abz * t - pos.z));
      lowest = Math.min(lowest, a.y, b.y);
    }
    if (nodes.length === 1) best = Math.hypot(nodes[0].x - pos.x, nodes[0].z - pos.z);
    return best > 1.5 || feet < lowest - 1.5;
  }

  private reached(pos: THREE.Vector3, n: NavNode): boolean {
    const feet = pos.y - PLAYER_FEET_OFFSET;
    return Math.hypot(n.x - pos.x, n.z - pos.z) < REACH && Math.abs(feet - n.y) < 0.8;
  }

  /**
   * A point LOOKAHEAD along the route from here. Corners are cut only along flat walks;
   * stairs, drops and jumps are aimed straight at their next waypoint. The last waypoint is
   * the goal itself when the route ends by it.
   */
  private steerPoint(pos: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const { nodes } = this.path!;
    const lastIndex = nodes.length - 1;
    const at = (k: number, o: THREE.Vector3) => {
      const n = nodes[k];
      return k === lastIndex && this.endsAtGoal() ? o.set(this.goal.x, n.y, this.goal.z) : o.set(n.x, n.y, n.z);
    };
    let i = this.index;
    let px = pos.x;
    let pz = pos.z;
    let left = LOOKAHEAD;
    for (;;) {
      const k = Math.min(i + 1, lastIndex);
      at(k, out);
      const seg = Math.hypot(out.x - px, out.z - pz);
      if (!this.flat(i) || k >= lastIndex) return out;
      if (seg >= left) return out.set(px + ((out.x - px) * left) / seg, out.y, pz + ((out.z - pz) * left) / seg);
      left -= seg;
      px = out.x;
      pz = out.z;
      i++;
      if (!this.flat(i)) return out.set(px, out.y, pz);
    }
  }

  private replan(): boolean {
    if (++this.replans > MAX_REPLANS) {
      this.status = 'stuck';
      this.path = null;
      return false;
    }
    this.plan();
    return this.status === 'moving';
  }
}
