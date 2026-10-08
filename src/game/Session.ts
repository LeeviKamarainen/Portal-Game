import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { Audio } from '../core/Audio';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import type { ArenaDef } from '../world/ArenaBuilder';
import type { PortalColor } from '../portals/Portal';
import { PortalRenderer } from '../portals/PortalRenderer';
import { KeyboardCommands } from '../player/PlayerCommand';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { PortalGunModel } from '../player/PortalGunModel';
import { distanceGain } from '../world/hazards/Hazard';
import type { MatchRules } from './Match';
import type { ArenaPlayer } from './ArenaPlayer';
import { ArenaSim } from '../sim/ArenaSim';
import type { SoundName } from '../sim/SimEvents';

export type { Noise, SessionEvent } from '../sim/SimEvents';

const _m = new THREE.Matrix4();
/** Glow lights shared by all the portals (the nearest placed ones get them); see Portal.glow. */
const PORTAL_LIGHTS = 4;
const PORTAL_LIGHT_RANGE = 5.5;
const PORTAL_LIGHT_DECAY = 1.6;
const _glowAt = new THREE.Vector3();

/**
 * One arena in play on this screen: the simulation (ArenaSim) plus everything to see and
 * hear it by - lights, portal views, opponents' bodies, sounds heard from the camera - and
 * the local player on the keyboard and mouse.
 */
export class Session extends ArenaSim {
  readonly portalRenderer = new PortalRenderer();

  private readonly engine: Engine;
  private readonly input: InputManager;
  private readonly audio: Audio;
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.DirectionalLight;
  /**
   * Always in the scene, dark when unused: a light coming or going makes three.js recompile
   * every lit material (over a second's hitch), so their number never changes.
   */
  private readonly portalLights: THREE.PointLight[] = [];

  private constructor(
    engine: Engine,
    input: InputManager,
    audio: Audio,
    physics: PhysicsWorld,
    def: ArenaDef,
    rules: Partial<MatchRules> | null,
  ) {
    super(physics, def, rules);
    this.engine = engine;
    this.input = input;
    this.audio = audio;
    this.setupLighting();
    for (let i = 0; i < PORTAL_LIGHTS; i++) {
      const light = new THREE.PointLight(0xffffff, 0, PORTAL_LIGHT_RANGE, PORTAL_LIGHT_DECAY);
      this.portalLights.push(light);
      this.scene.add(light);
    }
    this.addPlayer({ id: 'p1', name: 'YOU' }, new KeyboardCommands(input), engine.camera);
  }

  /** `rules` makes it a scored match (PvP); null for the tutorial stages. */
  static async create(
    engine: Engine,
    input: InputManager,
    audio: Audio,
    def: ArenaDef,
    rules: Partial<MatchRules> | null = null,
  ): Promise<Session> {
    const physics = await PhysicsWorld.create();
    try {
      return new Session(engine, input, audio, physics, def, rules);
    } catch (e) {
      // A map that fails to build (bad editor data) must not leak its physics world.
      physics.dispose();
      throw e;
    }
  }

  /** Sounds play as they happen, as loud as they are from the camera. */
  protected override sound(name: SoundName, volume: number, at?: THREE.Vector3, radius = 25): void {
    this.audio.play(name, at ? volume * distanceGain(this.engine.camera.position, at, radius) : volume);
  }

  private setupLighting(): void {
    const { fog, bounds } = this.arena;
    this.scene.fog = new THREE.Fog(fog.color, fog.near, fog.far);
    this.scene.background = new THREE.Color(fog.color);
    this.scene.environment = this.engine.envMap;

    this.hemi = new THREE.HemisphereLight(0xc4d4ff, 0x30343c, 0.55);
    this.scene.add(this.hemi);

    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    const key = (this.key = new THREE.DirectionalLight(0xfff2e0, 1.6));
    key.position.copy(center).add(new THREE.Vector3(size.x * 0.25, size.y + 30, size.z * 0.15));
    key.target.position.copy(center);
    key.castShadow = true;
    const half = Math.max(size.x, size.z) * 0.6;
    const cam = key.shadow.camera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = size.y + 80;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    key.shadow.radius = 2;
    this.scene.add(key, key.target);
    this.applyLighting();
  }

  /** Picks up the ambient level and shadow resolution from the settings menu. */
  applyLighting(): void {
    this.scene.environmentIntensity = 0.32 * this.engine.ambient;
    this.hemi.intensity = 0.55 * this.engine.ambient;
    const size = this.engine.shadowMapSize;
    if (this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
  }

  attachAvatar(avatar: PlayerAvatar): void {
    this.scene.add(avatar.object);
  }

  /**
   * Gets everything ready to draw before play starts (behind the load fade), so nothing
   * hitches the first time it's seen: compiles every shader in the arena - portals that
   * aren't open yet, your own body (only ever seen through a portal), shot effects - and
   * makes the portal views' render targets.
   */
  async warmUp(): Promise<void> {
    this.portalRenderer.prepare(this.engine.renderer, 3);
    await this.precompile(this.scene);
  }

  /** Compiles `object`'s shaders as they will be drawn: into an off-screen target, with this arena's lights. */
  private precompile(object: THREE.Object3D): Promise<unknown> {
    const r = this.engine.renderer;
    // Everything is drawn into render targets (the composer's, the portal views'), never
    // straight to the screen - which would compile tone-mapped variants nobody uses.
    const before = r.getRenderTarget();
    r.setRenderTarget(this.portalRenderer.anyTarget(r));
    const done = r.compileAsync(object, this.engine.camera, this.scene);
    r.setRenderTarget(before);
    return done;
  }

  detachAvatar(avatar: PlayerAvatar): void {
    this.scene.remove(avatar.object);
  }

  /** Gives an opponent their third-person body (loaded asynchronously by Game). */
  setOpponentBody(player: ArenaPlayer, avatar: PlayerAvatar, gunModel: PortalGunModel): void {
    if (this.disposed) {
      avatar.dispose();
      gunModel.dispose();
      return;
    }
    avatar.attachToHand(gunModel.object);
    avatar.setSeenByMainCamera();
    player.avatar = avatar;
    player.gunModel = gunModel;
    this.scene.add(avatar.object);
    void this.precompile(avatar.object);
  }

  /** The local player fires, from the camera. */
  fire(color: PortalColor, muzzle?: THREE.Vector3): boolean {
    const cam = this.engine.camera;
    return this.fireFrom(this.local, color, cam.position, cam.quaternion, muzzle);
  }

  override step(dt: number): void {
    super.step(dt);
    this.updateOpponentBodies(dt);
  }

  /** Opponents' third-person bodies follow their controllers; the dead vanish until they respawn. */
  private updateOpponentBodies(dt: number): void {
    for (const p of this.players) {
      if (p.local || !p.avatar) continue;
      const c = p.controller;
      p.avatar.object.visible = !p.dead;
      p.avatar.update(dt, {
        position: c.getPosition(),
        yaw: c.lookYaw,
        pitch: c.lookPitch,
        speed: c.horizontalSpeed(),
        grounded: c.isGrounded,
      });
      p.gunModel?.update(dt);
    }
  }

  override respawnPlayer(p: ArenaPlayer): void {
    super.respawnPlayer(p);
    if (p.local) this.input.flush();
  }

  /** Per-frame visual updates and the portal view renders; the engine draws the rest. */
  prepareRender(dt: number): void {
    for (const p of this.system.portals) p.update(dt, this.time);
    this.lendPortalLights();
    this.arena.goal?.update(this.time);
    this.orbs?.animate(this.time);
    for (const prop of this.arena.props) {
      const enter = prop.passing && prop.passing.isOpen ? prop.passing : null;
      prop.setPassage(enter, enter ? this.system.passageTransform(enter, _m) : null);
    }
    let nearest = Infinity;
    for (const l of this.arena.lasers) nearest = Math.min(nearest, l.distanceTo(this.engine.camera.position));
    this.audio.setHum(Math.max(0, 1 - nearest / 9));

    this.engine.beginFrame();
    this.portalRenderer.render(this.engine.renderer, this.scene, this.engine.camera, this.system.portals);
  }

  /** The glow lights go to the glowing portals nearest the camera (far ones barely light anything you see). */
  private lendPortalLights(): void {
    const cam = this.engine.camera.position;
    const lit = this.system.portals
      .filter((p) => p.glow > 0)
      .sort((a, b) => a.surfaceCenter.distanceToSquared(cam) - b.surfaceCenter.distanceToSquared(cam));
    this.portalLights.forEach((light, i) => {
      const p = lit[i];
      light.intensity = p ? p.glow : 0;
      if (!p) return;
      light.position.copy(p.glowPosition(_glowAt));
      light.color.setHex(p.tint);
    });
  }

  override dispose(): void {
    this.portalRenderer.dispose();
    super.dispose();
  }
}
