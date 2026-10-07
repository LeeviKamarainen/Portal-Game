import * as THREE from 'three';
import type { Engine } from '../core/Engine';
import type { InputManager } from '../core/InputManager';
import type { Audio } from '../core/Audio';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { Level } from '../world/Level';
import { ArenaBuilder, type ArenaDef, type SpawnPoint } from '../world/ArenaBuilder';
import { PLAYER_PALETTES, PORTAL_HALF_H, PORTAL_HALF_W, Portal, linkPortals, type PortalColor } from '../portals/Portal';
import { PortalRenderer } from '../portals/PortalRenderer';
import { PortalGun } from '../portals/PortalGun';
import { PortalSystem } from '../portals/PortalSystem';
import { PlayerController } from '../player/PlayerController';
import { KeyboardCommands, type CommandSource } from '../player/PlayerCommand';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { PortalGunModel } from '../player/PortalGunModel';
import { distanceGain, type HazardContext } from '../world/hazards/Hazard';
import type { PropBox } from '../world/hazards/PropBox';
import { Switch } from '../world/hazards/Switch';
import { PointOrbs, distanceToOpening } from '../world/PointOrbs';
import { Match, type MatchRules } from './Match';
import { ArenaPlayer, type PlayerSetup } from './ArenaPlayer';

const BOX_IMPACT_THRESHOLD = 10;
const BOX_IMPACT_SCALE = 4;
/** A destroyed crate comes back home after this long. */
const PROP_RESPAWN_DELAY = 1.2;
/** An opponent comes back this long after dying (the local player's fade is Game's). */
const OPPONENT_RESPAWN_DELAY = 1.5;
/** In a match, nothing can hurt a player for this long after they respawn. */
const SPAWN_PROTECTION = 1.5;

const _m = new THREE.Matrix4();
/** Rapier's default world gravity, matched by the player controller. */
const WORLD_GRAVITY = 20;

const _fwd = new THREE.Vector3();
const _funnel = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _look = new THREE.Quaternion();
const _feet = new THREE.Vector3();
/** No portal opening may come closer than this to a spawn pad's centre (in a match). */
const SPAWN_NO_PORTAL = 2.5;

const otherEnd = (c: PortalColor): PortalColor => (c === 'orange' ? 'blue' : 'orange');

/** How recent the last object hit must be to count as the killing blow. */
const KILLING_BLOW_WINDOW = 0.5;

export type SessionEvent =
  /** `by`: who gets the kill credit, if anyone (see Match). */
  | { type: 'death'; player: string; cause: string; by: string | null }
  | { type: 'goal' }
  | { type: 'score'; player: string; points: number; reason: 'orb' | 'kill'; victim?: string }
  | { type: 'win'; player: string }
  | { type: 'steal'; thief: string; victim: string };

/**
 * Something audible happening, for bots' hearing (see bots/Perception). `source` is the
 * player who made it, if any; `radius` is how far it carries.
 */
export interface Noise {
  kind: 'shot' | 'portal' | 'teleport' | 'land' | 'step' | 'steal';
  position: THREE.Vector3;
  radius: number;
  source: string | null;
}

const NOISE_RADIUS = { shot: 30, portal: 25, teleport: 20, land: 12, step: 10, steal: 30 } as const;
/** Footsteps: a player moving faster than this on the ground makes one every STEP_INTERVAL. */
const STEP_SPEED = 3;
const STEP_INTERVAL = 0.45;

/**
 * One arena in play: its own scene and physics world, the players (each with their own
 * portal pair) and every hazard. Built fresh for each arena and disposed on leaving it.
 */
export class Session {
  readonly def: ArenaDef;
  readonly scene = new THREE.Scene();
  readonly physics: PhysicsWorld;
  readonly level: Level;
  readonly arena: ArenaBuilder;
  /** Everyone in the arena; the local player is first. */
  readonly players: ArenaPlayer[] = [];
  /** Portal travel for every player's pair. */
  readonly system: PortalSystem;
  readonly portalRenderer = new PortalRenderer();
  readonly events: SessionEvent[] = [];
  /** Scores and win condition; null outside PvP. */
  readonly match: Match | null;
  readonly orbs: PointOrbs | null;
  time = 0;
  /** Noises made during the previous step: what bots can hear during this one. */
  heard: readonly Noise[] = [];
  private noises: Noise[] = [];
  private readonly stepTimers = new Map<ArenaPlayer, number>();

  private readonly engine: Engine;
  private readonly input: InputManager;
  private readonly audio: Audio;
  private readonly hazardCtx: HazardContext;
  /** The bodies hazards act on this step: everyone alive. */
  private readonly alive: PlayerController[] = [];
  private readonly propHidden = new Map<PropBox, number>();
  private readonly propSpeed = new Map<PropBox, number[]>();
  private completed = false;
  private disposed = false;
  private hemi!: THREE.HemisphereLight;
  private key!: THREE.DirectionalLight;
  /** Menu backdrop: the arena runs, but the player stands still and cannot be hurt. */
  demo = false;
  private gravityFactor = 1;
  private gravityUntil = 0;
  private notice = '';
  private noticeUntil = 0;

  private constructor(
    engine: Engine,
    input: InputManager,
    audio: Audio,
    physics: PhysicsWorld,
    def: ArenaDef,
    rules: Partial<MatchRules> | null,
  ) {
    this.def = def;
    this.engine = engine;
    this.input = input;
    this.audio = audio;
    this.physics = physics;
    this.level = new Level(this.scene, physics);
    this.arena = new ArenaBuilder(this.level);
    def.build(this.arena);
    this.level.finalize();
    // Rapier's ray and shape queries only see colliders after a step: one quiet step now
    // so anything that surveys the level at load (bots' navigation) finds it.
    physics.world.step();
    this.setupLighting();

    this.system = new PortalSystem(physics);
    this.system.onTeleport = (e) => {
      this.audio.play('teleport', 0.6 * this.gainAt(e.to.root.position, 30));
      // Kill credit: players only remember other people's portals; objects remember any.
      const self = e.entity.kind === 'player' ? (e.entity as PlayerController).id : null;
      if (e.from.owner !== self) e.entity.lastTrip = { owner: e.from.owner, time: this.time };
      this.makeNoise('teleport', e.to.root.position, self);
    };
    this.match = rules ? new Match(rules) : null;
    this.orbs = this.match ? new PointOrbs(this.arena, this.match.rules) : null;
    for (const p of this.arena.props) this.system.register(p);

    this.hazardCtx = {
      time: 0,
      physics,
      players: this.alive,
      props: this.arena.props,
      portals: this.system,
      audio,
      listener: engine.camera.position,
      kill: (player, cause) => this.kill(player, cause),
      hurtPlayer: (player, amount, credit) => this.hurtPlayer(player, amount, credit),
      effects: {
        clearPortals: () => this.clearPortals(),
        setGravity: (factor, seconds) => this.setGravity(factor, seconds),
      },
    };

    this.addPlayer({ id: 'p1', name: 'YOU' }, new KeyboardCommands(input), engine.camera);
  }

  /**
   * Someone joins: a body on their spawn point, a portal pair in their colours, a gun, and
   * a scoreboard row. The first player is the local one and drives `camera`.
   */
  addPlayer(setup: PlayerSetup, commands: CommandSource, camera: THREE.PerspectiveCamera | null = null): ArenaPlayer {
    const slot = this.players.length;
    const palette = PLAYER_PALETTES[slot % PLAYER_PALETTES.length];
    const spawn = this.spawnFor(slot);
    const controller = new PlayerController(this.physics, camera, commands, spawn.position, spawn.yaw);
    controller.id = setup.id;
    controller.gravityScale = this.gravityFactor;
    const portals = { orange: new Portal('orange', palette.orange), blue: new Portal('blue', palette.blue) };
    linkPortals(portals.orange, portals.blue);
    portals.orange.owner = portals.blue.owner = setup.id;
    this.scene.add(portals.orange.root, portals.blue.root);
    this.system.addPortals(portals.orange, portals.blue);
    const gun = new PortalGun(this.level, this.physics, portals, () => this.system.portals);
    if (this.match) gun.noPortalZone = (c, r, u) => this.noPortalZone(c, r, u);

    controller.filter = this.system.filterFor(controller);
    controller.funnel = (out) => this.system.funnel(controller, out);
    controller.guide = (vel, dt) => this.system.guide(controller, vel, dt);
    this.system.register(controller);

    const player = new ArenaPlayer({ setup, slot, local: slot === 0, controller, portals, gun, palette });
    this.players.push(player);
    this.match?.addPlayer(setup.id, setup.name);
    return player;
  }

  /**
   * In a match, no portal may open near an orb (see PointOrbs) or on a spawn pad - else a
   * floor portal on someone's spawn sends them straight back into a trap every respawn.
   */
  private noPortalZone(center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): boolean {
    if (this.orbs?.blocks(center, right, up)) return true;
    return this.arena.spawns.some((s) => distanceToOpening(_feet.copy(s.position).setY(s.position.y - 1.02), center, right, up) < SPAWN_NO_PORTAL);
  }

  /**
   * Whether a portal centred near `point` would land in a no-portal zone, for bots: any
   * orientation, so a little conservative. `orbs` are the orbs the asker knows of (a bot
   * passes the ones it has seen); spawn pads are part of the map.
   */
  noPortalNear(point: THREE.Vector3, orbs: readonly THREE.Vector3[]): boolean {
    if (!this.match) return false;
    const margin = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H);
    if (orbs.some((o) => o.distanceTo(point) < this.match!.rules.orbNoPortalRadius + margin)) return true;
    return this.arena.spawns.some((s) => _feet.copy(s.position).setY(s.position.y - 1.02).distanceTo(point) < SPAWN_NO_PORTAL + margin);
  }

  /** The player at this keyboard. */
  get local(): ArenaPlayer {
    return this.players[0];
  }

  /** The local player's body. */
  get player(): PlayerController {
    return this.local.controller;
  }

  /** The local player's portal pair. */
  get portals(): Record<PortalColor, Portal> {
    return this.local.portals;
  }

  /** The local player's portal gun. */
  get gun(): PortalGun {
    return this.local.gun;
  }

  playerById(id: string): ArenaPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  private playerOf(body: PlayerController): ArenaPlayer | undefined {
    return this.players.find((p) => p.controller === body);
  }

  /** Slot i starts on spawn i (wrapping round), so a two-team map puts the opponent across the arena. */
  spawnFor(slot: number): SpawnPoint {
    const spawns = this.arena.spawns;
    if (spawns.length === 0) return { position: this.arena.spawn, yaw: this.arena.spawnYaw, team: null };
    return spawns[slot % spawns.length];
  }

  /** How loud something at `at` is for the local player. */
  private gainAt(at: THREE.Vector3, radius: number): number {
    return distanceGain(this.engine.camera.position, at, radius);
  }

  /** Every open portal closes, everyone's (a switch effect). */
  clearPortals(): void {
    const placed = this.system.portals.filter((p) => p.placed);
    if (placed.length === 0) return;
    for (const p of placed) p.unplace();
    this.audio.play('fizzle', 0.8);
    this.showNotice('ALL PORTALS CLOSED', 2);
  }

  /** Gravity multiplied for players and crates alike, for a while (a switch effect). */
  setGravity(factor: number, seconds: number): void {
    this.gravityFactor = factor;
    this.gravityUntil = this.time + seconds;
    for (const p of this.players) p.controller.gravityScale = factor;
    this.physics.world.gravity = { x: 0, y: -WORLD_GRAVITY * factor, z: 0 };
  }

  private showNotice(text: string, seconds: number): void {
    this.notice = text;
    this.noticeUntil = this.time + seconds;
  }

  /** A line for the HUD about whatever arena effect is on, or '' for none. */
  get effectText(): string {
    if (this.gravityFactor !== 1) {
      return `${this.gravityFactor > 1 ? 'HEAVY' : 'LIGHT'} GRAVITY ×${this.gravityFactor.toFixed(1)} · ${Math.ceil(this.gravityUntil - this.time)} s`;
    }
    return this.time < this.noticeUntil ? this.notice : '';
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
  }

  get isDead(): boolean {
    return this.local.dead;
  }

  /** The local player fires, from the camera. */
  fire(color: PortalColor, muzzle?: THREE.Vector3): boolean {
    const cam = this.engine.camera;
    return this.fireFrom(this.local, color, cam.position, cam.quaternion, muzzle);
  }

  /** `player` shoots a portal from `eye` along where `look` faces. */
  private fireFrom(player: ArenaPlayer, color: PortalColor, eye: THREE.Vector3, look: THREE.Quaternion, muzzle?: THREE.Vector3): boolean {
    _fwd.set(0, 0, -1).applyQuaternion(look);
    const r = player.gun.fire(color, eye.clone(), _fwd.clone(), muzzle);
    const gain = player.local ? 1 : this.gainAt(eye, 35);
    this.audio.play(color === 'orange' ? 'shootOrange' : 'shootBlue', 0.7 * gain);
    this.makeNoise('shot', eye, player.id);
    if (!player.local) {
      player.avatar?.shoot();
      player.gunModel?.charge(color);
    }
    if (r.interactable instanceof Switch) {
      r.interactable.shoot(this.hazardCtx);
      return false;
    }
    if (r.stolen && this.steal(player, color, r.stolen)) {
      this.audio.play('steal', 0.7 * this.gainAt(r.stolen.root.position, 35));
      this.makeNoise('steal', r.stolen.root.position, player.id);
      return true;
    }
    this.audio.play(r.placed ? 'portalOpen' : 'fizzle', 0.5 * gain);
    if (r.placed) this.makeNoise('portal', player.portals[color].root.position, player.id);
    if (r.noPortalZone && player.local) this.showNotice('NO PORTALS NEAR ORBS OR SPAWN PADS', 1.5);
    return r.placed;
  }

  /**
   * `thief` shot `target` - someone else's portal - with `color`, and takes it: it stays
   * where it is and becomes the thief's `color` portal, linked to their other one. The
   * thief's old portal of that colour closes and becomes the victim's (empty) replacement,
   * so the victim's remaining portal is left unlinked until they place a new one. Anything
   * mid-passage carries on to the new partner, or lets go if there is none.
   */
  steal(thief: ArenaPlayer, color: PortalColor, target: Portal): boolean {
    const victim = this.playerById(target.owner);
    if (!victim || victim === thief || victim.portals[target.color] !== target) return false;
    const slot = target.color;
    const spare = thief.portals[color];
    spare.unplace();
    thief.portals[color] = target;
    victim.portals[slot] = spare;
    target.color = color;
    target.owner = thief.id;
    target.setTint(thief.palette[color]);
    spare.color = slot;
    spare.owner = victim.id;
    spare.setTint(victim.palette[slot]);
    linkPortals(target, thief.portals[otherEnd(color)]);
    linkPortals(spare, victim.portals[otherEnd(slot)]);
    target.flashStolen();
    this.events.push({ type: 'steal', thief: thief.id, victim: victim.id });
    return true;
  }

  /** Something audible (for bots' hearing; the speakers are separate). */
  private makeNoise(kind: Noise['kind'], at: THREE.Vector3, source: string | null): void {
    this.noises.push({ kind, position: at.clone(), radius: NOISE_RADIUS[kind], source });
  }

  /** Footsteps and landings: moving players give themselves away. */
  private bodyNoises(dt: number): void {
    for (const p of this.players) {
      const c = p.controller;
      if (p.dead) continue;
      if (c.landingSpeed > 6) {
        this.noises.push({ kind: 'land', position: c.getPosition(), radius: NOISE_RADIUS.land + c.landingSpeed, source: p.id });
        // Game reads (and clears) the local player's for the landing sound.
        if (!p.local) c.landingSpeed = 0;
      }
      const t = c.isGrounded && c.horizontalSpeed() > STEP_SPEED ? (this.stepTimers.get(p) ?? 0) + dt : 0;
      if (t >= STEP_INTERVAL) this.makeNoise('step', c.getPosition(), p.id);
      this.stepTimers.set(p, t >= STEP_INTERVAL ? 0 : t);
    }
  }

  step(dt: number): void {
    this.time += dt;
    this.hazardCtx.time = this.time;
    this.heard = this.noises;
    this.noises = [];
    if (this.gravityFactor !== 1 && this.time >= this.gravityUntil) this.setGravity(1, 0);

    for (const h of this.arena.hazards) h.prePhysics?.(dt, this.hazardCtx);
    for (const p of this.players) {
      const c = p.controller;
      if (p.dead) {
        p.deadFor += dt;
        if ((!p.local || p.autopilot) && p.deadFor >= OPPONENT_RESPAWN_DELAY) this.respawnPlayer(p);
      }
      const demo = this.demo && p.local;
      c.inputEnabled = !p.dead && !this.completed && !demo;
      if (demo) c.setInvulnerableFor(1);
      c.update(dt);
      // Opponents shoot through their command; the local player's shots come from Game.
      if ((!p.local || p.autopilot) && c.inputEnabled && c.command.fire) {
        c.viewPose(_eye, _look);
        this.fireFrom(p, c.command.fire, _eye, _look);
      }
    }
    for (const p of this.arena.props) {
      if (p.passing) p.addVelocity(this.system.funnel(p, _funnel).multiplyScalar(dt * 4));
    }

    // Impact damage needs the speed a crate had coming in. By the time a contact event is
    // reported the collision has already stopped it (and the event can trail the impact by
    // a step), so keep the fastest speed of the last few steps.
    for (const p of this.arena.props) {
      const recent = this.propSpeed.get(p) ?? [];
      recent.push(p.speed());
      if (recent.length > 4) recent.shift();
      this.propSpeed.set(p, recent);
    }
    this.physics.step();
    this.system.step(dt);
    this.alive.length = 0;
    for (const p of this.players) if (!p.dead) this.alive.push(p.controller);
    this.handleCollisions();

    for (const p of this.arena.props) {
      p.syncMesh();
      this.updatePropLife(p, dt);
    }
    for (const h of this.arena.hazards) h.update(dt, this.hazardCtx);
    for (const p of this.players) {
      p.controller.postStep(dt);
      p.gun.update(dt);
    }
    this.bodyNoises(dt);
    if (this.orbs && !this.completed) {
      // The dead can't pick anything up, but orbs keep coming back meanwhile.
      for (const id of this.orbs.update(dt, this.alive, this.system.portals)) {
        this.score(id, this.match!.rules.orbPoints, 'orb');
      }
    }

    for (const p of this.players) {
      if (p.dead) continue;
      const c = p.controller;
      if (c.getPosition().y < this.arena.killY) this.kill(c, 'fell');
      if (c.health.isDead) this.kill(c, 'hurt');
    }
    const local = this.local;
    if (!local.dead && !this.completed && this.arena.goal?.contains(local.controller.getPosition())) {
      this.completed = true;
      this.events.push({ type: 'goal' });
    }
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

  private updatePropLife(p: PropBox, dt: number): void {
    if (p.getPosition().y < this.arena.killY && p.visible) p.setVisible(false);
    if (p.visible) {
      this.propHidden.delete(p);
      return;
    }
    const t = (this.propHidden.get(p) ?? 0) + dt;
    this.propHidden.set(p, t);
    // Droppers re-arm their own crates; anything else returns to where it started.
    if (t > PROP_RESPAWN_DELAY && !this.arena.hazards.some((h) => 'box' in h && (h as { box: PropBox }).box === p)) {
      p.resetHome();
      this.system.resync(p);
    }
  }

  private handleCollisions(): void {
    this.physics.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const o1 = this.physics.getOwner(h1);
      const o2 = this.physics.getOwner(h2);
      if (!o1 || !o2) return;
      const box = (o1.type === 'prop' ? o1.ref : o2.type === 'prop' ? o2.ref : null) as PropBox | null;
      const body = (o1.type === 'player' ? o1.ref : o2.type === 'player' ? o2.ref : null) as PlayerController | null;
      if (!box || !body) return;
      const speed = Math.max(box.speed(), ...(this.propSpeed.get(box) ?? []));
      if (speed > BOX_IMPACT_THRESHOLD) {
        this.hurtPlayer(body, (speed - BOX_IMPACT_THRESHOLD) * BOX_IMPACT_SCALE, this.creditOf(box.lastTrip));
        this.audio.play('hurt', 0.8 * this.gainAt(body.getPosition(), 25));
      }
    });
  }

  private hurtPlayer(body: PlayerController, amount: number, credit: string | null): void {
    const p = this.playerOf(body);
    if (!p || p.dead) return;
    body.damage(amount);
    p.lastHit = { by: credit, time: this.time };
  }

  /** Who a portal trip is still credited to (null outside a match or once it is stale). */
  private creditOf(trip: { owner: string; time: number } | null): string | null {
    return this.match?.creditOf(trip, this.time) ?? null;
  }

  /**
   * Who gets the kill: a beam or crate that dealt the killing blow is credited to the owner
   * of the portal it came out of; otherwise (or if it never went through one) the owner of
   * the last portal the victim came out of. Nobody scores from their own portals.
   */
  private killCredit(victim: ArenaPlayer, cause: string): string | null {
    const hit = victim.lastHit;
    const blow = cause === 'hurt' && hit && this.time - hit.time <= KILLING_BLOW_WINDOW ? hit.by : null;
    const by = blow ?? this.creditOf(victim.controller.lastTrip);
    return by === victim.id ? null : by;
  }

  private score(player: string, points: number, reason: 'orb' | 'kill', victim?: string): void {
    const match = this.match;
    if (!match?.award(player, points)) return;
    this.events.push({ type: 'score', player, points, reason, victim });
    if (match.winner) {
      this.completed = true;
      this.events.push({ type: 'win', player: match.winner.id });
    }
  }

  private kill(body: PlayerController, cause: string): void {
    const victim = this.playerOf(body);
    if (!victim || victim.dead || this.completed) return;
    if (cause !== 'hurt' && cause !== 'fell') {
      body.killInstantly();
      if (!body.health.isDead) return; // flash immunity saved them
    }
    victim.dead = true;
    victim.deadFor = 0;
    const by = this.killCredit(victim, cause);
    this.events.push({ type: 'death', player: victim.id, cause, by });
    if (by && this.match) this.score(by, this.match.rules.killPoints, 'kill', victim.id);
  }

  /**
   * The local player back on their spawn pad. Outside a match (the tutorial stages) the
   * whole arena starts over with them; in a match the arena keeps running.
   */
  respawn(): void {
    this.respawnPlayer(this.local);
    if (this.match) return;
    this.setGravity(1, 0);
    this.noticeUntil = 0;
    for (const h of this.arena.hazards) h.reset?.();
    for (const p of this.arena.props) this.system.resync(p);
  }

  /** One player back on their spawn with a clean slate; their portals close. */
  respawnPlayer(p: ArenaPlayer): void {
    p.portals.orange.unplace();
    p.portals.blue.unplace();
    const spawn = this.spawnFor(p.slot);
    p.controller.respawn(spawn.position, spawn.yaw);
    p.controller.gravityScale = this.gravityFactor;
    if (this.match) p.controller.setInvulnerableFor(SPAWN_PROTECTION);
    this.system.resync(p.controller);
    if (p.local) this.input.flush();
    p.lastHit = null;
    p.dead = false;
    p.deadFor = 0;
  }

  /** Per-frame visual updates and the portal view renders; the engine draws the rest. */
  prepareRender(dt: number): void {
    for (const p of this.system.portals) p.update(dt, this.time);
    this.arena.goal?.update(this.time);
    this.orbs?.animate(this.time);
    for (const prop of this.arena.props) {
      const enter = prop.passing && prop.passing.isOpen ? prop.passing : null;
      prop.setPassage(enter, enter ? this.system.passageTransform(enter, _m) : null);
    }
    let nearest = Infinity;
    for (const l of this.arena.lasers) nearest = Math.min(nearest, l.nearestDistance);
    this.audio.setHum(Math.max(0, 1 - nearest / 9));

    this.engine.beginFrame();
    this.portalRenderer.render(this.engine.renderer, this.scene, this.engine.camera, this.system.portals);
  }

  dispose(): void {
    this.disposed = true;
    for (const p of this.system.portals) p.dispose();
    for (const p of this.players) {
      if (p.local) continue;
      p.avatar?.dispose();
      p.gunModel?.dispose();
    }
    this.system.dispose();
    this.level.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    this.physics.dispose();
  }
}
