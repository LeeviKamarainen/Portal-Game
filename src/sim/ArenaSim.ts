import * as THREE from 'three';
import { PhysicsWorld } from '../physics/PhysicsWorld';
import { Level } from '../world/Level';
import { ArenaBuilder, type ArenaDef, type SpawnPoint } from '../world/ArenaBuilder';
import { PLAYER_PALETTES, PORTAL_HALF_H, PORTAL_HALF_W, Portal, linkPortals, type PortalColor } from '../portals/Portal';
import { PortalGun } from '../portals/PortalGun';
import { PortalSystem } from '../portals/PortalSystem';
import { PlayerController } from '../player/PlayerController';
import type { CommandSource } from '../player/PlayerCommand';
import type { HazardContext } from '../world/hazards/Hazard';
import type { PropBox } from '../world/hazards/PropBox';
import { Switch } from '../world/hazards/Switch';
import { PointOrbs, distanceToOpening } from '../world/PointOrbs';
import { Match, type MatchRules } from '../game/Match';
import { ArenaPlayer, type PlayerSetup } from '../game/ArenaPlayer';
import type { Noise, SessionEvent, SimSound, SoundName } from './SimEvents';

const BOX_IMPACT_THRESHOLD = 10;
const BOX_IMPACT_SCALE = 4;
/** A destroyed crate comes back home after this long. */
const PROP_RESPAWN_DELAY = 1.2;
/** An opponent comes back this long after dying (the local player's fade is Game's). */
const OPPONENT_RESPAWN_DELAY = 1.5;
/** In a match, nothing can hurt a player for this long after they respawn. */
const SPAWN_PROTECTION = 1.5;

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

const NOISE_RADIUS = { shot: 30, portal: 25, teleport: 20, land: 12, step: 10, steal: 30 } as const;
/** Footsteps: a player moving faster than this on the ground makes one every STEP_INTERVAL. */
const STEP_SPEED = 3;
const STEP_INTERVAL = 0.45;

export interface AddPlayerOptions {
  /** Picks the palette, the spawn point and the portals' net ids; default: the lowest free one. */
  slot?: number;
  /** The one at this keyboard (camera, HUD); default: whoever drives `camera`. */
  local?: boolean;
}

/**
 * One arena in play, with nothing to look at or listen to: its own physics world, the
 * players (each with their own portal pair), every hazard, and - in a match - the score.
 * It runs the same in the browser (Session adds the picture and sound on top) and headless
 * on the game server. Built fresh for each arena and disposed on leaving it.
 */
export class ArenaSim {
  readonly def: ArenaDef;
  /** Holds the level's meshes: portal shots raycast against them, even headless. */
  readonly scene = new THREE.Scene();
  readonly physics: PhysicsWorld;
  readonly level: Level;
  readonly arena: ArenaBuilder;
  /** Everyone in the arena, in join order. */
  readonly players: ArenaPlayer[] = [];
  /** Portal travel for every player's pair. */
  readonly system: PortalSystem;
  readonly events: SessionEvent[] = [];
  /** Sounds made during the latest step (Session plays them straight away instead). */
  readonly sounds: SimSound[] = [];
  /** Scores and win condition; null outside PvP. */
  readonly match: Match | null;
  readonly orbs: PointOrbs | null;
  time = 0;
  /** Noises made during the previous step: what bots can hear during this one. */
  heard: readonly Noise[] = [];
  /** The player at this keyboard; null on the game server. */
  localPlayer: ArenaPlayer | null = null;
  /** Menu backdrop: the arena runs, but the player stands still and cannot be hurt. */
  demo = false;
  protected readonly hazardCtx: HazardContext;
  protected disposed = false;
  private noises: Noise[] = [];
  private readonly stepTimers = new Map<ArenaPlayer, number>();
  /** The bodies hazards act on this step: everyone alive. */
  private readonly alive: PlayerController[] = [];
  private readonly propHidden = new Map<PropBox, number>();
  private readonly propSpeed = new Map<PropBox, number[]>();
  private completed = false;
  private gravityFactor = 1;
  private gravityUntil = 0;
  private notice = '';
  private noticeUntil = 0;

  protected constructor(physics: PhysicsWorld, def: ArenaDef, rules: Partial<MatchRules> | null) {
    this.def = def;
    this.physics = physics;
    this.level = new Level(this.scene, physics);
    this.arena = new ArenaBuilder(this.level);
    def.build(this.arena);
    this.level.finalize();
    // Rapier's ray and shape queries only see colliders after a step: one quiet step now
    // so anything that surveys the level at load (bots' navigation) finds it.
    physics.world.step();

    this.system = new PortalSystem(physics);
    this.system.onTeleport = (e) => {
      this.sound('teleport', 0.6, e.to.root.position, 30);
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
      sound: (name, volume, at, radius) => this.sound(name, volume, at, radius),
      kill: (player, cause) => this.kill(player, cause),
      hurtPlayer: (player, amount, credit) => this.hurtPlayer(player, amount, credit),
      effects: {
        clearPortals: () => this.clearPortals(),
        setGravity: (factor, seconds) => this.setGravity(factor, seconds),
      },
    };
  }

  /** An arena with no picture or sound (the game server; Node tests). `rules` makes it a scored match. */
  static async load(def: ArenaDef, rules: Partial<MatchRules> | null = null): Promise<ArenaSim> {
    const physics = await PhysicsWorld.create();
    try {
      return new ArenaSim(physics, def, rules);
    } catch (e) {
      // A map that fails to build (bad editor data) must not leak its physics world.
      physics.dispose();
      throw e;
    }
  }

  /**
   * Someone joins: a body on their spawn point, a portal pair in their colours, a gun, and
   * a scoreboard row. The local player drives `camera`.
   */
  addPlayer(
    setup: PlayerSetup,
    commands: CommandSource,
    camera: THREE.PerspectiveCamera | null = null,
    options: AddPlayerOptions = {},
  ): ArenaPlayer {
    const slot = options.slot ?? this.freeSlot();
    const local = options.local ?? camera !== null;
    const palette = PLAYER_PALETTES[slot % PLAYER_PALETTES.length];
    const spawn = this.spawnFor(slot);
    const controller = new PlayerController(this.physics, camera, commands, spawn.position, spawn.yaw);
    controller.id = setup.id;
    controller.gravityScale = this.gravityFactor;
    const portals = { orange: new Portal('orange', palette.orange), blue: new Portal('blue', palette.blue) };
    linkPortals(portals.orange, portals.blue);
    portals.orange.owner = portals.blue.owner = setup.id;
    portals.orange.netId = slot * 2;
    portals.blue.netId = slot * 2 + 1;
    this.scene.add(portals.orange.root, portals.blue.root);
    this.system.addPortals(portals.orange, portals.blue);
    const gun = new PortalGun(this.level, this.physics, portals, () => this.system.portals);
    if (this.match) gun.noPortalZone = (c, r, u) => this.noPortalZone(c, r, u);

    controller.filter = this.system.filterFor(controller);
    controller.funnel = (out) => this.system.funnel(controller, out);
    controller.guide = (vel, dt) => this.system.guide(controller, vel, dt);
    this.system.register(controller);

    const player = new ArenaPlayer({ setup, slot, local, controller, portals, gun, palette });
    this.players.push(player);
    if (local) this.localPlayer = player;
    this.match?.addPlayer(setup.id, setup.name);
    return player;
  }

  /**
   * Someone leaves: their body and portals go (whoever was mid-passage through one lets
   * go); their scoreboard row stays, so a match result still shows what they scored.
   */
  removePlayer(id: string): void {
    const p = this.playerById(id);
    if (!p) return;
    const portals = [p.portals.orange, p.portals.blue];
    this.system.removePortals(...portals);
    for (const portal of portals) {
      this.scene.remove(portal.root);
      portal.dispose();
    }
    this.system.unregister(p.controller);
    p.controller.dispose();
    if (p.avatar) {
      this.scene.remove(p.avatar.object);
      p.avatar.dispose();
    }
    p.gunModel?.dispose();
    this.players.splice(this.players.indexOf(p), 1);
    this.stepTimers.delete(p);
    if (this.localPlayer === p) this.localPlayer = null;
  }

  /** The lowest slot nobody has. */
  private freeSlot(): number {
    let slot = 0;
    while (this.players.some((p) => p.slot === slot)) slot++;
    return slot;
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

  /** The player at this keyboard (only where there is one - not on the game server). */
  get local(): ArenaPlayer {
    if (!this.localPlayer) throw new Error('this arena has no local player');
    return this.localPlayer;
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

  get isDead(): boolean {
    return this.local.dead;
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

  /**
   * A sound: at full `volume` everywhere, or fading out over `radius` metres from `at`.
   * Here it is only recorded (the game server sends them on); Session plays them.
   */
  protected sound(name: SoundName, volume: number, at?: THREE.Vector3, radius = 25): void {
    this.sounds.push({ name, volume, at: at ? at.clone() : null, radius });
  }

  /** Every open portal closes, everyone's (a switch effect). */
  clearPortals(): void {
    const placed = this.system.portals.filter((p) => p.placed);
    if (placed.length === 0) return;
    for (const p of placed) p.unplace();
    this.sound('fizzle', 0.8);
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

  /** `player` shoots a portal from `eye` along where `look` faces. */
  protected fireFrom(player: ArenaPlayer, color: PortalColor, eye: THREE.Vector3, look: THREE.Quaternion, muzzle?: THREE.Vector3): boolean {
    _fwd.set(0, 0, -1).applyQuaternion(look);
    const r = player.gun.fire(color, eye.clone(), _fwd.clone(), muzzle);
    // Your own gun is right by your ear.
    const from = player.local ? undefined : eye;
    this.sound(color === 'orange' ? 'shootOrange' : 'shootBlue', 0.7, from, 35);
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
      this.sound('steal', 0.7, r.stolen.root.position, 35);
      this.makeNoise('steal', r.stolen.root.position, player.id);
      return true;
    }
    this.sound(r.placed ? 'portalOpen' : 'fizzle', 0.5, from, 35);
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
    this.sounds.length = 0;
    if (this.gravityFactor !== 1 && this.time >= this.gravityUntil) this.setGravity(1, 0);

    for (const h of this.arena.hazards) h.prePhysics?.(dt, this.hazardCtx);
    for (const p of this.players) {
      const c = p.controller;
      // Everyone but the local player fires through their command and comes back on their
      // own; the local player's shots and respawn come from Game.
      const auto = !p.local || p.autopilot;
      if (p.dead) {
        p.deadFor += dt;
        if (auto && p.deadFor >= OPPONENT_RESPAWN_DELAY) this.respawnPlayer(p);
      }
      const demo = this.demo && p.local;
      c.inputEnabled = !p.dead && !this.completed && !demo;
      if (demo) c.setInvulnerableFor(1);
      c.update(dt);
      if (auto && c.inputEnabled && c.command.fire) {
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
    // A puzzle ends when its player reaches the exit (combat maps have no goal).
    const local = this.localPlayer;
    if (local && !local.dead && !this.completed && this.arena.goal?.contains(local.controller.getPosition())) {
      this.completed = true;
      this.events.push({ type: 'goal' });
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
        this.sound('hurt', 0.8, body.getPosition(), 25);
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
    p.lastHit = null;
    p.dead = false;
    p.deadFor = 0;
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
