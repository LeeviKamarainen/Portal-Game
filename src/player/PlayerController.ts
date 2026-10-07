import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { PortalTraversable } from '../portals/PortalTraversable';
import type { Portal } from '../portals/Portal';
import type { PortalTrip } from '../game/Match';
import { Health } from './Health';
import { MOUSE_SENSITIVITY, clearCommand, emptyCommand, type CommandSource, type PlayerCommand } from './PlayerCommand';

const CAPSULE_HALF_HEIGHT = 0.6;
const CAPSULE_RADIUS = 0.4;
export const EYE_OFFSET = 0.8;

/** Full standing height of the capsule, and the drop from its centre to the soles. */
export const PLAYER_HEIGHT = 2 * (CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS);
export const PLAYER_FEET_OFFSET = CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS;
export const PLAYER_RADIUS = CAPSULE_RADIUS;
export const PLAYER_HALF_HEIGHT = CAPSULE_HALF_HEIGHT;

const GRAVITY = 20;
/** ~2 m jump apex: enough for a ledge, not enough to skip the arenas' portal puzzles. */
const JUMP_SPEED = 9;
const MAX_GROUND_SPEED = 7;
const MAX_AIR_SPEED = 7;
const GROUND_ACCEL = 60;
const AIR_ACCEL = 18;
const GROUND_FRICTION = 40;
const TERMINAL_SPEED = 45;
const SNAP_DISTANCE = 0.3;

/**
 * Landing faster than this hurts: above a normal jump's landing speed (9 m/s), so a hop
 * or a drop of up to ~4 m is free. Beyond it damage climbs steeply - with gravity at 20,
 * an 8 m drop costs ~20, 16 m ~49, 22 m ~67, and ~35 m is fatal.
 */
const FALL_DAMAGE_THRESHOLD = 13;
const FALL_DAMAGE_SCALE = 4;

const IMMUNITY_DURATION = 1.0;
const IMMUNITY_COOLDOWN = 5.0;

/**
 * How long the view takes to settle after a passage that the upright body can't follow
 * exactly (roll, or an eye re-seated on the body). Eased in and out, so the frame of the
 * passage itself is continuous and the correction never moves faster than a brisk walk.
 */
const CAMERA_SETTLE_TIME = 0.24;

const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _q2 = new THREE.Quaternion();
const _funnel = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class PlayerController implements PortalTraversable {
  readonly kind = 'player' as const;
  readonly health = new Health(100);
  readonly colliderHandle: number;
  passing: Portal | null = null;
  /** Last trip through someone else's portal: who gets the credit if a hazard kills us. */
  lastTrip: PortalTrip | null = null;
  /** Match identity; portals this player places carry it as their owner. */
  id = 'p1';
  /** Where this step's command comes from: keyboard and mouse, or a bot. */
  commands: CommandSource;
  /** The command applied on the latest step. */
  readonly command: PlayerCommand = emptyCommand();

  /** Collider filter supplied by the portal system (host surfaces off while passing). */
  filter: ((c: RAPIER.Collider) => boolean) | undefined;
  /** Lateral pull into a portal opening, supplied by the portal system. */
  funnel: ((out: THREE.Vector3) => THREE.Vector3) | undefined;
  /** Steers velocity into an opening the player is touching (see PortalSystem.guide). */
  guide: ((vel: THREE.Vector3, dt: number) => void) | undefined;
  /** Displacement imposed this step by something moving the player (a platform). */
  readonly externalDelta = new THREE.Vector3();
  /** Collider the player stood on after the last step, or -1. */
  groundCollider = -1;
  inputEnabled = true;
  /** Downward speed of the most recent landing, for effects; reset by the reader. */
  landingSpeed = 0;
  /** Heavier (or lighter) gravity from an arena effect; 1 = normal. */
  gravityScale = 1;
  /** 0..1 flash strength for the HUD, set on damage and decayed here. */
  damageFlash = 0;

  private readonly physics: PhysicsWorld;
  private readonly body: RAPIER.RigidBody;
  private readonly collider: RAPIER.Collider;
  private readonly controller: RAPIER.KinematicCharacterController;
  /** The view this player drives (the local player only). */
  private readonly camera: THREE.PerspectiveCamera | null;

  private yaw = 0;
  private pitch = 0;
  private velocity = new THREE.Vector3();
  private wasGrounded = false;
  private lookDelta = new THREE.Vector2();

  /** View correction left over from the last passage, eased out over CAMERA_SETTLE_TIME. */
  private readonly camOffset0 = new THREE.Vector3();
  private readonly camCorrection0 = new THREE.Quaternion();
  private settle = 1;

  private immuneUntil = -Infinity;
  private immunityReadyAt = 0;
  private clock = 0;

  constructor(
    physics: PhysicsWorld,
    camera: THREE.PerspectiveCamera | null,
    commands: CommandSource,
    spawn: THREE.Vector3,
    yaw = 0,
  ) {
    this.physics = physics;
    this.camera = camera;
    this.commands = commands;
    this.yaw = yaw;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn.x, spawn.y, spawn.z),
    );
    const colliderDesc = RAPIER.ColliderDesc.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
      // Kinematic bodies skip kinematic-vs-fixed pairs by default; sensors need them.
      .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL);
    this.collider = physics.world.createCollider(colliderDesc, this.body);
    physics.registerOwner(this.collider.handle, { type: 'player', ref: this });
    this.colliderHandle = this.collider.handle;

    this.controller = physics.world.createCharacterController(0.02);
    this.controller.enableAutostep(0.3, 0.2, true);
    // Rapier's own snap-to-ground intermittently cancels the horizontal part of a move
    // (the player stalls for a frame on flat ground, at collider seams and at the lip of a
    // portal). Snapping is done as a separate downward move instead - see update().
    this.controller.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    this.controller.setCharacterMass(80);

    this.syncCamera(0);
  }

  update(dt: number): void {
    this.clock += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.5);
    // Always read (so a mouse moved while input is off doesn't land all at once later).
    this.commands.read(this.command, dt);
    if (!this.inputEnabled) clearCommand(this.command);
    this.updateLook();

    const grounded = this.wasGrounded;
    this.updateHorizontalVelocity(dt, grounded);

    if (grounded) {
      this.velocity.y = this.command.jump ? JUMP_SPEED : -0.5;
    } else {
      this.velocity.y = Math.max(this.velocity.y - GRAVITY * this.gravityScale * dt, -TERMINAL_SPEED);
    }
    this.guide?.(this.velocity, dt);
    const preMoveVelY = this.velocity.y;

    const own = this.velocity.clone().multiplyScalar(dt);
    const funnel = this.funnel ? this.funnel(_funnel).multiplyScalar(dt) : _funnel.set(0, 0, 0);
    const desired = own.clone().add(this.externalDelta).add(funnel);

    const corrected = this.move(desired);
    let groundedNow = this.controller.computedGrounded();

    // Rapier's controller now and then returns almost no movement when all it touched was
    // the ground, or a wall running alongside the motion (a known glitch at contact
    // distance; it hits roughly one frame in eight on a moving platform, and when walking
    // out of a portal along its tunnel's side). Redo such a move clear of them: lift a few
    // centimetres and off the side walls, slide, and set back down.
    const wantH = Math.hypot(desired.x, desired.z);
    const away = new THREE.Vector3();
    if (wantH > 0.002 && Math.hypot(corrected.x, corrected.z) < wantH * 0.5 && this.notBlocked(desired, away)) {
      const t = this.body.translation();
      const start = new THREE.Vector3(t.x, t.y, t.z);
      const lift = this.moveFrom(start, away.multiplyScalar(0.01).setY(0.05));
      const slide = this.moveFrom(start.clone().add(lift), new THREE.Vector3(desired.x, Math.max(0, desired.y), desired.z));
      const drop = this.moveFrom(start.clone().add(lift).add(slide), new THREE.Vector3(0, -(lift.y + 0.02), 0));
      this.collider.setTranslation(t);
      const total = lift.add(slide).add(drop);
      if (Math.hypot(total.x, total.z) > Math.hypot(corrected.x, corrected.z)) {
        corrected.copy(total);
        groundedNow = groundedNow || this.controller.computedGrounded();
      }
    }

    // Stay glued to stairs and slopes going down: if the player was on the ground, is not
    // jumping, and this move left them hanging, drop them onto ground close below.
    if (grounded && !groundedNow && this.velocity.y <= 0) {
      const t = this.body.translation();
      this.collider.setTranslation({ x: t.x + corrected.x, y: t.y + corrected.y, z: t.z + corrected.z });
      const drop = this.move(new THREE.Vector3(0, -SNAP_DISTANCE, 0));
      this.collider.setTranslation(t);
      if (this.controller.computedGrounded()) {
        corrected.y += drop.y;
        groundedNow = true;
      }
      // Re-run the main move so the slide normals below describe it, not the snap probe.
      this.move(desired);
    }

    // Keep the velocity honest: what walls and ceilings take away is gone, rather than
    // being stored up and released the moment they stop being in the way (a portal).
    const n = new THREE.Vector3();
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit) continue;
      n.set(hit.normal1.x, hit.normal1.y, hit.normal1.z);
      if (n.y > 0.7) continue;
      if (n.y < -0.7) {
        if (this.velocity.y > 0) this.velocity.y = 0;
        continue;
      }
      const into = this.velocity.dot(n);
      if (into < 0) this.velocity.addScaledVector(n, -into);
    }

    const pos = this.body.translation();
    this.body.setNextKinematicTranslation({ x: pos.x + corrected.x, y: pos.y + corrected.y, z: pos.z + corrected.z });

    // Something brushed underfoot while flying upward (the lip of a floor portal one is
    // shooting out of) is not ground: counting it would zero the climb next step.
    if (this.velocity.y > 0.5) groundedNow = false;
    if (!this.wasGrounded && groundedNow) {
      const impactSpeed = Math.max(0, -preMoveVelY);
      this.landingSpeed = impactSpeed;
      this.applyImpactDamage(impactSpeed);
    }
    this.wasGrounded = groundedNow;
    this.externalDelta.set(0, 0, 0);

    if (this.command.immunity) this.tryFlashImmunity();
  }

  private move(desired: THREE.Vector3): THREE.Vector3 {
    this.controller.computeColliderMovement(
      this.collider,
      desired,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      this.filter,
    );
    const c = this.controller.computedMovement();
    return new THREE.Vector3(c.x, c.y, c.z);
  }

  /** A controller move as if the collider started at `from` (the caller restores it). */
  private moveFrom(from: THREE.Vector3, desired: THREE.Vector3): THREE.Vector3 {
    this.collider.setTranslation(from);
    return this.move(desired);
  }

  /**
   * True if nothing the last move touched faces against `desired`: a collapsed move is then
   * the controller glitching, not a real obstacle. Sums the side contacts' normals into `away`.
   */
  private notBlocked(desired: THREE.Vector3, away: THREE.Vector3): boolean {
    const dir = new THREE.Vector3(desired.x, 0, desired.z).normalize();
    for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit || hit.normal1.y >= 0.7) continue;
      const n = new THREE.Vector3(hit.normal1.x, 0, hit.normal1.z);
      if (n.dot(dir) < -0.3) return false;
      away.add(n);
    }
    if (away.lengthSq() > 1e-6) away.normalize();
    return true;
  }

  /** After the physics step: find the ground and place the camera. */
  postStep(dt: number): void {
    this.groundCollider = -1;
    if (this.wasGrounded) {
      const p = this.body.translation();
      const hit = this.physics.world.castRay(
        new RAPIER.Ray(p, { x: 0, y: -1, z: 0 }),
        PLAYER_FEET_OFFSET + 0.25,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        this.collider,
        undefined,
        this.filter,
      );
      if (hit) this.groundCollider = hit.collider.handle;
    }
    this.syncCamera(dt);
  }

  private updateHorizontalVelocity(dt: number, grounded: boolean): void {
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

    const cmd = this.command;
    const wish = forward.multiplyScalar(THREE.MathUtils.clamp(cmd.forward, -1, 1)).addScaledVector(right, THREE.MathUtils.clamp(cmd.right, -1, 1));
    if (wish.lengthSq() > 1) wish.normalize();

    const horiz = new THREE.Vector3(this.velocity.x, 0, this.velocity.z);
    if (!grounded) {
      // Air control adds speed toward the wish direction only up to the air cap and never
      // brakes momentum the player already has - a fling out of a portal keeps its speed.
      if (wish.lengthSq() > 0) {
        const current = horiz.dot(wish);
        const add = MAX_AIR_SPEED - current;
        if (add > 0) horiz.addScaledVector(wish, Math.min(AIR_ACCEL * dt, add));
      }
    } else {
      const target = wish.multiplyScalar(MAX_GROUND_SPEED);
      const delta = target.sub(horiz);
      const maxDelta = GROUND_ACCEL * dt;
      if (delta.length() > maxDelta) delta.setLength(maxDelta);
      horiz.add(delta);
      if (wish.lengthSq() === 0 && horiz.length() > 0) {
        const drop = Math.min(horiz.length(), GROUND_FRICTION * dt);
        horiz.addScaledVector(horiz.clone().normalize(), -drop);
      }
    }
    this.velocity.x = horiz.x;
    this.velocity.z = horiz.z;
  }

  private updateLook(): void {
    const { yaw, pitch } = this.command;
    // In mouse pixels, for the first-person gun's sway.
    this.lookDelta.set(-yaw / MOUSE_SENSITIVITY, -pitch / MOUSE_SENSITIVITY);
    this.yaw += yaw;
    this.pitch += pitch;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  }

  private baseQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromEuler(_euler.set(this.pitch, this.yaw, 0, 'YXZ'));
  }

  private settleWeight(): number {
    const x = Math.min(1, this.settle);
    return 1 - x * x * (3 - 2 * x);
  }

  /** Where the camera is drawn: the eye plus whatever is left of the passage correction. */
  private viewPosition(out: THREE.Vector3): THREE.Vector3 {
    const pos = this.body.translation();
    return out.set(pos.x, pos.y + EYE_OFFSET, pos.z).addScaledVector(this.camOffset0, this.settleWeight());
  }

  private viewQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    const w = this.settleWeight();
    _q2.identity().slerp(this.camCorrection0, w);
    return out.copy(_q2).multiply(this.baseQuaternion(_q));
  }

  private syncCamera(dt: number): void {
    if (dt > 0 && this.settle < 1) this.settle = Math.min(1, this.settle + dt / CAMERA_SETTLE_TIME);
    if (!this.camera) return;
    this.viewPosition(this.camera.position);
    this.viewQuaternion(this.camera.quaternion);
    this.camera.updateMatrixWorld();
  }

  /** Where this player sees from and which way they look (shots start here). */
  viewPose(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.viewPosition(position);
    this.viewQuaternion(quaternion);
  }

  get lookYaw(): number {
    return this.yaw;
  }

  get lookPitch(): number {
    return this.pitch;
  }

  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    this.settle = 1;
    this.syncCamera(0);
  }

  get isGrounded(): boolean {
    return this.wasGrounded;
  }

  get lastLookDelta(): THREE.Vector2 {
    return this.lookDelta;
  }

  horizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  applyImpactDamage(impactSpeed: number): void {
    if (impactSpeed <= FALL_DAMAGE_THRESHOLD) return;
    this.damage((impactSpeed - FALL_DAMAGE_THRESHOLD) * FALL_DAMAGE_SCALE);
  }

  damage(amount: number): void {
    if (this.isImmune() || amount <= 0 || this.health.isDead) return;
    this.health.damage(amount);
    this.damageFlash = Math.min(1, this.damageFlash + 0.35 + amount / 60);
  }

  killInstantly(): void {
    if (this.isImmune()) return;
    this.damage(this.health.max);
  }

  respawn(spawn: THREE.Vector3, yaw: number): void {
    this.body.setTranslation({ x: spawn.x, y: spawn.y, z: spawn.z }, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.velocity.set(0, 0, 0);
    this.wasGrounded = false;
    this.health.reset();
    this.damageFlash = 0;
    this.passing = null;
    this.lastTrip = null;
    this.settle = 1;
    this.yaw = yaw;
    this.pitch = 0;
    this.immuneUntil = -Infinity;
    this.syncCamera(0);
  }

  private tryFlashImmunity(): void {
    if (this.clock < this.immunityReadyAt) return;
    this.immuneUntil = this.clock + IMMUNITY_DURATION;
    this.immunityReadyAt = this.clock + IMMUNITY_COOLDOWN;
  }

  /** Test hook: no damage at all for the given time. */
  setInvulnerableFor(seconds: number): void {
    this.immuneUntil = this.clock + seconds;
  }

  isImmune(): boolean {
    return this.clock < this.immuneUntil;
  }

  immunityCooldownFraction(): number {
    if (this.clock >= this.immunityReadyAt) return 1;
    return 1 - (this.immunityReadyAt - this.clock) / IMMUNITY_COOLDOWN;
  }

  // PortalTraversable
  getPosition(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  setPosition(pos: THREE.Vector3): void {
    this.body.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true);
    this.physics.world.propagateModifiedBodyPositionsToColliders();
    this.syncCamera(0);
  }

  getVelocity(): THREE.Vector3 {
    return this.velocity.clone();
  }

  setVelocity(vel: THREE.Vector3): void {
    this.velocity.copy(vel);
  }

  /**
   * A shove from a hazard: at least `v` along its horizontal direction (speed already
   * going that way is kept), and lifted off the ground so ground friction cannot eat it.
   */
  knockback(v: THREE.Vector3): void {
    const flat = new THREE.Vector3(v.x, 0, v.z);
    const speed = flat.length();
    if (speed > 1e-6) {
      flat.divideScalar(speed);
      const along = this.velocity.x * flat.x + this.velocity.z * flat.z;
      if (along < speed) {
        this.velocity.x += flat.x * (speed - along);
        this.velocity.z += flat.z * (speed - along);
      }
    }
    this.velocity.y = Math.max(this.velocity.y, v.y);
    this.wasGrounded = false;
  }

  getCrossingPoint(): THREE.Vector3 {
    return this.getPosition().addScaledVector(UP, EYE_OFFSET);
  }

  extentAlong(dir: THREE.Vector3): number {
    // Exact for an upright capsule.
    return CAPSULE_RADIUS + CAPSULE_HALF_HEIGHT * Math.abs(dir.y / Math.max(dir.length(), 1e-6));
  }

  exitShape(): { shape: RAPIER.Shape; rotation: THREE.Quaternion } {
    return { shape: new RAPIER.Capsule(CAPSULE_HALF_HEIGHT - 0.01, CAPSULE_RADIUS - 0.01), rotation: new THREE.Quaternion() };
  }

  exitCenter(transform: THREE.Matrix4, exit: Portal): THREE.Vector3 {
    // The body keeps its place relative to the opening. It stays upright, so the eye can
    // end up somewhere the carried view isn't - the camera eases that difference out - but
    // the eye must at least be on the near side of the exit window (out of a ceiling
    // portal it would otherwise start above the opening).
    const center = this.getPosition().applyMatrix4(transform);
    const eyeZ = exit.toLocal(center.clone().addScaledVector(UP, EYE_OFFSET)).z;
    const minZ = 0.03;
    if (eyeZ < minZ) center.addScaledVector(exit.normal, minZ - eyeZ);
    return center;
  }

  completeTeleport(center: THREE.Vector3, rotation: THREE.Quaternion, transform: THREE.Matrix4): void {
    // Where the view would be if it went straight through - the frame after the passage
    // must show exactly that, or the player sees a pop. (Taken from the body as it is now,
    // after this step's physics, not from the camera, which was placed a step earlier.)
    const camPos = this.viewPosition(new THREE.Vector3()).applyMatrix4(transform);
    const camQuat = rotation.clone().multiply(this.viewQuaternion(new THREE.Quaternion()));

    this.body.setTranslation({ x: center.x, y: center.y, z: center.z }, true);
    this.velocity.applyQuaternion(rotation);
    this.wasGrounded = false;

    // Re-derive yaw/pitch from the carried view. Taking yaw from the forward vector alone
    // is unstable when looking straight up or down; blending in the up vector is exact
    // for any roll-free view and degrades gracefully when the passage adds roll.
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camQuat);
    this.pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(f.y, -1, 1)), -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const dx = -f.x * cp + u.x * sp;
    const dz = -f.z * cp + u.z * sp;
    if (dx * dx + dz * dz > 1e-8) this.yaw = Math.atan2(dx, dz);

    // Whatever the upright body can't reproduce (roll, a re-seated eye) eases out.
    this.camCorrection0.copy(camQuat).multiply(this.baseQuaternion(_q).invert());
    this.camOffset0.copy(camPos).sub(center).addScaledVector(UP, -EYE_OFFSET);
    this.settle = 0;
    this.syncCamera(0);
  }
}
