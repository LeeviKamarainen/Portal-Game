import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { PORTAL_HALF_H, PORTAL_HALF_W, RECESS_DEPTH, TUNNEL_DEPTH, type Portal } from './Portal';
import type { PortalTraversable } from './PortalTraversable';
import { computePortalRelativeMatrix, relativeRotation } from './PortalMath';

/**
 * Portal travel.
 *
 * An entity whose centre is lined up with an opening and close to (or heading into) its
 * surface is *passing* that portal. While passing, collisions with the host surface are
 * switched off for that entity alone - the character controller filters it out of its
 * queries and a contact hook drops it for physics props - and the portal's tunnel
 * colliders take its place around the opening, so the entity can enter the hole but not
 * the wall beside it. Everything else keeps colliding with the host surface as normal and
 * ignores the tunnel colliders.
 *
 * The passage itself happens when the entity's crossing point (the player's eye, a prop's
 * centre) goes through the window plane. The entity is carried through the portal pair's
 * transform with its speed rotated but unchanged, then the exit pose is checked against
 * the world: a pose that would overlap geometry is slid into the opening, then out of it,
 * so nothing can land inside a wall or under the floor.
 */

const PASSING_MARGIN = 0.12;
/** Once passing, the state holds a little longer so it can't flicker at the boundary. */
const PASSING_HYSTERESIS = 0.25;
/** The portal frame's lateral pull on bodies that would otherwise catch on its edge. */
const FUNNEL_RATE = 14;
/**
 * Entry assist: a body heading into a portal at least this fast, whose centre is within
 * ASSIST_CATCH of the opening, is eased sideways into it over the last ASSIST_LEAD seconds
 * before contact - falling onto a floor portal slightly off-centre still goes in. Only
 * position is nudged; velocity, and so momentum through the portal, is untouched.
 */
const ASSIST_MIN_SPEED = 3;
const ASSIST_CATCH = 0.6;
const ASSIST_LEAD = 0.25;
const ASSIST_MAX_SPEED = 8;
const EXIT_CLEARANCE = 0.03;

const _l = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _vl = new THREE.Vector3();
const _prev = new THREE.Vector3();
const _curr = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _r = new THREE.Quaternion();
const _rInv = new THREE.Quaternion();
const _dir = new THREE.Vector3();

interface Tracked {
  entity: PortalTraversable;
  prevCross: THREE.Vector3;
  teleports: number;
}

export interface TeleportEvent {
  entity: PortalTraversable;
  from: Portal;
  to: Portal;
  speedIn: number;
  speedOut: number;
}

export class PortalSystem {
  /** Every portal in the arena, all players' pairs. */
  readonly portals: Portal[] = [];
  private readonly physics: PhysicsWorld;
  private readonly tracked: Tracked[] = [];
  private readonly byCollider = new Map<number, Tracked>();
  onTeleport: ((e: TeleportEvent) => void) | null = null;

  constructor(physics: PhysicsWorld, portals: readonly Portal[] = []) {
    this.physics = physics;
    this.portals.push(...portals);
    physics.hooks = {
      filterContactPair: (c1, c2) => {
        const t1 = this.byCollider.get(c1);
        const t2 = this.byCollider.get(c2);
        if (t1 && !this.allows(t1.entity, c2)) return null;
        if (t2 && !this.allows(t2.entity, c1)) return null;
        return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      },
      filterIntersectionPair: () => true,
    };
  }

  addPortals(...portals: Portal[]): void {
    this.portals.push(...portals);
  }

  /** Placed portals with a placed partner: the ones things can travel through. */
  private open(): Portal[] {
    return this.portals.filter((p) => p.isOpen);
  }

  register(entity: PortalTraversable): void {
    const t: Tracked = { entity, prevCross: entity.getCrossingPoint().clone(), teleports: 0 };
    this.tracked.push(t);
    this.byCollider.set(entity.colliderHandle, t);
  }

  /** Stops tracking `entity` (a player who left). */
  unregister(entity: PortalTraversable): void {
    const t = this.byCollider.get(entity.colliderHandle);
    if (!t) return;
    this.tracked.splice(this.tracked.indexOf(t), 1);
    this.byCollider.delete(entity.colliderHandle);
  }

  /** Takes portals out of the arena for good (they close first). */
  removePortals(...portals: Portal[]): void {
    for (const p of portals) {
      p.unplace();
      const i = this.portals.indexOf(p);
      if (i >= 0) this.portals.splice(i, 1);
    }
  }

  teleportCount(entity: PortalTraversable): number {
    return this.byCollider.get(entity.colliderHandle)?.teleports ?? 0;
  }

  /** Re-anchor after an entity was moved by something other than physics (respawn, tests). */
  resync(entity: PortalTraversable): void {
    const t = this.byCollider.get(entity.colliderHandle);
    if (!t) return;
    entity.passing = null;
    t.prevCross.copy(entity.getCrossingPoint());
  }

  /** Whether `entity` should collide with collider `handle` right now. */
  allows(entity: PortalTraversable, handle: number): boolean {
    if (handle === entity.colliderHandle) return false;
    const owner = this.physics.getOwner(handle);
    if (owner?.type === 'portal-tunnel') return entity.passing === owner.ref;
    if (entity.passing && handle === entity.passing.hostCollider) return false;
    return true;
  }

  /** Collider predicate for queries made on behalf of `entity` (its character controller). */
  filterFor(entity: PortalTraversable): (c: RAPIER.Collider) => boolean {
    return (c) => this.allows(entity, c.handle);
  }

  step(dt: number): void {
    const open = this.open();
    for (const t of this.tracked) this.stepTracked(t, dt, open);
  }

  /** Portal travel for one entity alone (a predicted player's steps being replayed). */
  stepEntity(entity: PortalTraversable, dt: number): void {
    const t = this.byCollider.get(entity.colliderHandle);
    if (t) this.stepTracked(t, dt, this.open());
  }

  private stepTracked(t: Tracked, dt: number, open: readonly Portal[]): void {
    const e = t.entity;
    // A portal that closed (or lost its partner) mid-passage lets go.
    if (e.passing && !e.passing.isOpen) e.passing = null;
    if (open.length === 0) {
      e.passing = null;
      t.prevCross.copy(e.getCrossingPoint());
      return;
    }

    const candidate = this.computePassing(e, dt, open);
    const cross = e.getCrossingPoint();
    let crossed: Portal | null = null;
    for (const p of [e.passing, candidate]) {
      if (!p || crossed) continue;
      p.toLocal(t.prevCross, _prev);
      p.toLocal(cross, _curr);
      if (_prev.z > 0 && _curr.z <= 0 && p.inAperture(_curr, 0.15)) crossed = p;
    }

    if (crossed) {
      this.teleport(t, crossed, crossed.linked!);
    } else {
      e.passing = candidate;
      t.prevCross.copy(cross);
    }
  }

  private computePassing(e: PortalTraversable, dt: number, open: readonly Portal[]): Portal | null {
    const center = e.getPosition();
    const vel = e.getVelocity();
    let best: Portal | null = null;
    let bestZ = Infinity;
    for (const p of open) {
      p.toLocal(center, _l);
      _vl.copy(vel).applyQuaternion(_rInv.copy(p.root.quaternion).invert());
      const hold = e.passing === p ? PASSING_HYSTERESIS : 0;
      // Look a couple of steps ahead so a fast body is already passing by the time it
      // reaches the surface, rather than being stopped by it for a frame.
      const ahead = Math.max(0, -_vl.z) * dt * 2.5;
      _lp.copy(_l).addScaledVector(_vl, dt * 2.5);
      // Something the entry assist is pulling in counts from a little outside the rim.
      const assist = -_vl.z >= ASSIST_MIN_SPEED ? ASSIST_CATCH : 0;
      const lateral = p.inAperture(_l, hold + assist) || p.inAperture(_lp, assist);
      if (!lateral) continue;
      if (_l.z < -TUNNEL_DEPTH) continue;
      const ext = e.extentAlong(p.normal);
      const zs = _l.z - RECESS_DEPTH;
      if (zs > ext + PASSING_MARGIN + ahead + hold) continue;
      if (zs < bestZ) {
        bestZ = zs;
        best = p;
      }
    }
    return best;
  }

  private teleport(t: Tracked, from: Portal, to: Portal): void {
    const e = t.entity;
    computePortalRelativeMatrix(from, to, _m);
    relativeRotation(_m, _r);
    const speedIn = e.getVelocity().length();

    const ideal = e.exitCenter(_m, to);
    const center = this.findExit(e, to, ideal, _r);
    e.completeTeleport(center, _r.clone(), _m.clone());
    this.physics.world.propagateModifiedBodyPositionsToColliders();

    e.passing = to;
    t.prevCross.copy(e.getCrossingPoint());
    t.teleports++;
    this.onTeleport?.({ entity: e, from, to, speedIn, speedOut: e.getVelocity().length() });
  }

  /** Extent of the entity *after* the passage rotation, along a world direction. */
  private extentAfter(e: PortalTraversable, rotation: THREE.Quaternion, dir: THREE.Vector3): number {
    _dir.copy(dir).applyQuaternion(_rInv.copy(rotation).invert());
    return e.extentAlong(_dir);
  }

  /**
   * First collision-free pose among: the exact mapped pose; that pose slid sideways so the
   * body fits through the opening; slid and pushed fully out in front of the exit; and as
   * a last resort, straight out of the middle of the exit.
   */
  private findExit(e: PortalTraversable, exit: Portal, ideal: THREE.Vector3, rotation: THREE.Quaternion): THREE.Vector3 {
    const { shape, rotation: shapeRot } = e.exitShape(rotation);
    const ex = this.extentAfter(e, rotation, exit.right);
    const ey = this.extentAfter(e, rotation, exit.up);
    const en = this.extentAfter(e, rotation, exit.normal);

    const local = exit.toLocal(ideal);
    const fitX = Math.max(0, PORTAL_HALF_W - ex - 0.02);
    const fitY = Math.max(0, PORTAL_HALF_H - ey - 0.02);
    const clamped = local.clone();
    clamped.x = THREE.MathUtils.clamp(clamped.x, -fitX, fitX);
    clamped.y = THREE.MathUtils.clamp(clamped.y, -fitY, fitY);
    const pushed = clamped.clone();
    pushed.z = Math.max(pushed.z, RECESS_DEPTH + en + EXIT_CLEARANCE);
    const middle = new THREE.Vector3(0, 0, RECESS_DEPTH + en + 0.08);

    const toWorld = (l: THREE.Vector3) => l.clone().applyMatrix4(exit.root.matrixWorld);
    const candidates = [ideal.clone(), toWorld(clamped), toWorld(pushed), toWorld(middle)];
    const filter = (c: RAPIER.Collider) => this.exitAllows(e, exit, c.handle);
    const rot = { x: shapeRot.x, y: shapeRot.y, z: shapeRot.z, w: shapeRot.w };
    for (const c of candidates) {
      const hit = this.physics.world.intersectionWithShape(
        c,
        rot,
        shape,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        filter,
      );
      if (!hit) return c;
    }
    return candidates[candidates.length - 1];
  }

  private exitAllows(e: PortalTraversable, exit: Portal, handle: number): boolean {
    if (handle === e.colliderHandle) return false;
    const owner = this.physics.getOwner(handle);
    // Other movable bodies get pushed aside by the solver; only static geometry matters.
    if (owner?.type === 'player' || owner?.type === 'prop') return false;
    if (owner?.type === 'portal-tunnel') return owner.ref === exit;
    return handle !== exit.hostCollider;
  }

  /**
   * Lateral velocity that eases a passing body into the part of the opening it fits
   * through, so it slides in instead of snagging on the frame (Portal's "funnelling").
   */
  funnel(e: PortalTraversable, out = new THREE.Vector3()): THREE.Vector3 {
    out.set(0, 0, 0);
    const pos = e.getPosition();
    const vel = e.getVelocity();
    for (const p of this.open()) {
      p.toLocal(pos, _l);
      const gap = _l.z - RECESS_DEPTH - e.extentAlong(p.normal);
      const fitX = Math.max(0, PORTAL_HALF_W - e.extentAlong(p.right) - 0.03);
      const fitY = Math.max(0, PORTAL_HALF_H - e.extentAlong(p.up) - 0.03);
      const dx = THREE.MathUtils.clamp(_l.x, -fitX, fitX) - _l.x;
      const dy = THREE.MathUtils.clamp(_l.y, -fitY, fitY) - _l.y;
      if (dx === 0 && dy === 0) continue;
      if (e.passing === p && gap <= 0.05) {
        // Touching the surface or in the opening: it has to fit the opening now.
        out.copy(p.right).multiplyScalar(dx * FUNNEL_RATE).addScaledVector(p.up, dy * FUNNEL_RATE);
        return out;
      }
      // Entry assist: heading in fast, close to the rim, about to make contact.
      const into = -_vl.copy(vel).applyQuaternion(_rInv.copy(p.root.quaternion).invert()).z;
      if (into < ASSIST_MIN_SPEED || gap < 0) continue;
      const lead = gap / into;
      if (lead > ASSIST_LEAD || Math.hypot(dx, dy) > ASSIST_CATCH + 0.5) continue;
      if (!p.inAperture(_l, ASSIST_CATCH)) continue;
      const k = 1 / Math.max(lead, 0.05);
      out.copy(p.right).multiplyScalar(dx * k).addScaledVector(p.up, dy * k);
      if (out.length() > ASSIST_MAX_SPEED) out.setLength(ASSIST_MAX_SPEED);
      return out;
    }
    return out;
  }

  /**
   * Steers a body that is already touching an opening and moving into it so it goes in
   * rather than glancing off the frame: lateral motion may not carry the centre out of
   * the region where the body fits through, and whatever lateral speed that removes is
   * turned inward - the direction changes, the speed does not.
   */
  guide(e: PortalTraversable, vel: THREE.Vector3, dt: number): void {
    const p = e.passing;
    if (!p || !p.isOpen) return;
    p.toLocal(e.getPosition(), _l);
    // Walls: from first contact, so a glancing approach slides in instead of snagging.
    // Floors and ceilings: only once the body is actually in the opening - hovering over a
    // floor portal, the player is still free to steer away and land beside it.
    const reach = Math.abs(p.normal.y) < 0.6 ? 0.05 : -0.05;
    if (_l.z - RECESS_DEPTH > e.extentAlong(p.normal) + reach) return;
    _vl.copy(vel).applyQuaternion(_rInv.copy(p.root.quaternion).invert());
    if (-_vl.z < 0.3) return;
    const speed = _vl.length();
    const fitX = Math.max(0, PORTAL_HALF_W - e.extentAlong(p.right) - 0.03);
    const fitY = Math.max(0, PORTAL_HALF_H - e.extentAlong(p.up) - 0.03);
    const limit = (pos: number, v: number, fit: number) => {
      if (Math.abs(pos) > fit + 0.02) return v; // still outside: the funnel brings it in
      const next = pos + v * dt;
      if (next > fit) return Math.max(0, (fit - pos) / dt);
      if (next < -fit) return Math.min(0, (-fit - pos) / dt);
      return v;
    };
    const vx = limit(_l.x, _vl.x, fitX);
    const vy = p.normal.y > 0.6 || p.normal.y < -0.6 ? limit(_l.y, _vl.y, fitY) : _vl.y;
    if (vx === _vl.x && vy === _vl.y) return;
    _vl.set(vx, vy, -Math.sqrt(Math.max(0, speed * speed - vx * vx - vy * vy)));
    vel.copy(_vl.applyQuaternion(p.root.quaternion));
  }

  /** The transform an entity passing `p` would take, for drawing its far-side copy. */
  passageTransform(p: Portal, out: THREE.Matrix4): THREE.Matrix4 {
    return computePortalRelativeMatrix(p, p.linked!, out);
  }

  dispose(): void {
    this.physics.hooks = undefined;
  }
}
