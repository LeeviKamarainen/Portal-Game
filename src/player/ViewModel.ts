import * as THREE from 'three';
import type { PortalColor } from '../portals/Portal';
import { PortalGunModel } from './PortalGunModel';

/**
 * The gun in the player's own hands, drawn in a pass of its own after the world.
 *
 * It can't simply hang off the main camera: at the arena's 90-degree vertical fov a
 * viewmodel half a metre away is enormous and smeared by the wide-angle projection. Its
 * own scene and a normal-looking fov give it a stable size and shape, and clearing depth
 * first keeps it in front of the world however close the player stands to a wall. The
 * portal renderer never touches this scene, so through a portal you see the avatar's gun
 * rather than one floating where the player's eyes are.
 */

const FOV = 55;
/** Resting offset from the eye: right hand, below the sight line, clear of the crosshair. */
const REST = new THREE.Vector3(0.245, -0.235, -0.78);
const VIEW_SCALE = 0.76;
/**
 * Held slightly toed-in and canted over, which puts the gun's flank towards the eye. Aimed
 * straight down -Z it is all rear plate, and a box seen end-on reads as nothing at all.
 */
const TILT = new THREE.Euler(0.02, 0.15, 0.05);

const BOB_RATE = 1.5;
const BOB_SIDE = 0.014;
const BOB_RISE = 0.009;
const REFERENCE_SPEED = 7;

const SWAY_PER_PIXEL = 0.0007;
const SWAY_LIMIT = 0.05;
const SWAY_SMOOTHING = 9;

const RECOIL_DECAY = 9;
const RECOIL_KICK = 0.08;
const RECOIL_PITCH = 0.32;

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 10);
  private readonly gun = new PortalGunModel();

  private readonly sway = new THREE.Vector2();
  private readonly swayTarget = new THREE.Vector2();
  private readonly offset = new THREE.Vector3();

  private bobPhase = 0;
  private recoil = 0;

  constructor() {
    this.gun.object.scale.setScalar(VIEW_SCALE);
    this.scene.add(this.gun.object);
    // Lit on its own so the gun reads the same in every corner of the arena, roughly
    // matching the Engine's key light so it doesn't look pasted on.
    this.scene.add(new THREE.HemisphereLight(0xaeb6ff, 0x3a3a48, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(-0.6, 1, 0.8);
    this.scene.add(key);
  }

  /** Fires the muzzle flash and kicks the gun back; `color` is the portal just shot. */
  fire(color: PortalColor): void {
    this.gun.charge(color);
    this.recoil = 1;
  }

  update(dt: number, speed: number, grounded: boolean, lookDelta: THREE.Vector2): void {
    this.gun.update(dt);
    this.recoil = Math.max(0, this.recoil - this.recoil * RECOIL_DECAY * dt - dt * 0.6);

    const stride = grounded ? Math.min(speed / REFERENCE_SPEED, 1) : 0;
    this.bobPhase += speed * BOB_RATE * dt;

    // The gun trails the mouse by a fraction of the movement, then eases back to rest.
    this.swayTarget.set(
      THREE.MathUtils.clamp(-lookDelta.x * SWAY_PER_PIXEL, -SWAY_LIMIT, SWAY_LIMIT),
      THREE.MathUtils.clamp(lookDelta.y * SWAY_PER_PIXEL, -SWAY_LIMIT, SWAY_LIMIT),
    );
    this.sway.lerp(this.swayTarget, Math.min(1, SWAY_SMOOTHING * dt));

    this.offset.set(
      Math.sin(this.bobPhase) * BOB_SIDE * stride + this.sway.x,
      Math.sin(this.bobPhase * 2) * BOB_RISE * stride + this.sway.y - this.recoil * 0.014,
      this.recoil * RECOIL_KICK,
    );

    this.gun.object.position.copy(REST).add(this.offset);
    this.gun.object.rotation.set(
      TILT.x + this.recoil * RECOIL_PITCH,
      TILT.y + this.sway.x * 1.2,
      TILT.z + this.sway.y * 0.8,
    );
  }

  /**
   * The point in the world that `camera` (the main one) sees where this gun's muzzle is
   * drawn - `distance` metres from the eye - so a shot's tracer seems to leave the gun.
   */
  muzzleIn(camera: THREE.Camera, out: THREE.Vector3, distance = 0.6): THREE.Vector3 {
    this.gun.muzzlePosition(out).project(this.camera);
    out.setZ(0.5).unproject(camera).sub(camera.position).normalize();
    return out.multiplyScalar(distance).add(camera.position);
  }

  /** The gun is drawn by the engine's overlay pass; this only keeps its projection current. */
  setAspect(aspect: number): void {
    if (this.camera.aspect === aspect) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.gun.dispose();
  }
}
