import * as THREE from 'three';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { PLAYER_FEET_OFFSET } from '../../player/PlayerController';
import { BOX_HALF, type PropBox } from './PropBox';
import { type Hazard, type HazardContext } from './Hazard';

/** How far the plate stands proud of the floor it is set into (drawn, not solid: a crate is shoved onto it freely). */
export const PLATE_HEIGHT = 0.04;
/** The world's gravity and step (see PhysicsWorld, PlayerController). */
const GRAVITY = 20;
const STEP = 1 / 60;
/** A crate's linear damping (see PropBox): its arc is solved with it. */
const CRATE_DAMPING = 0.05;
/** Whatever has just been thrown is left alone this long. */
const COOLDOWN = 0.6;
const FLAP_UP = 0.95;
const EDGE_REACH = 0.1;
const MARKER_COLOR = 0x40d0ff;

const _from = new THREE.Vector3();
const _v = new THREE.Vector3();

export interface FaithPlateOptions {
  /** Centre of the surface the plate is set into. */
  center: THREE.Vector3;
  /** Width (x) and depth (z). */
  size: THREE.Vector2;
  /** Where the throw should come down: the floor point whoever is thrown lands on. */
  target: THREE.Vector3;
  /** How high the arc rises above the higher of the two ends (metres, at least 1). */
  apex?: number;
}

/**
 * How a throw is flown: a whole number of steps `n`, and for a crate (whose arc has linear
 * damping) the distance one unit of launch speed covers in them and what gravity alone does.
 */
export interface FlightPlan {
  n: number;
  time: number;
  /** Crate: distance per unit of launch speed over the flight, and the drop gravity adds. */
  run: number;
  fall: number;
}

/**
 * The flight from `from` to `to` under `gravity`, rising `apex` metres over the higher end,
 * in whole steps. A crate's integration (v <- (v - g dt) / (1 + c dt), then x += v dt) is
 * linear in its launch velocity, so a dry run of it gives `run` and `fall`.
 */
export function flightPlan(from: THREE.Vector3, to: THREE.Vector3, apex: number, gravity = GRAVITY): FlightPlan {
  const top = Math.max(from.y, to.y) + Math.max(1, apex);
  const up = Math.sqrt((2 * (top - from.y)) / gravity);
  const down = Math.sqrt((2 * (top - to.y)) / gravity);
  const n = Math.max(2, Math.round((up + down) / STEP));
  const damp = 1 / (1 + CRATE_DAMPING * STEP);
  let run = 0;
  let v = 1;
  let fall = 0;
  let w = 0;
  for (let i = 0; i < n; i++) {
    v *= damp;
    run += v * STEP;
    w = (w - gravity * STEP) * damp;
    fall += w * STEP;
  }
  return { n, time: n * STEP, run, fall };
}

/**
 * The launch velocity that carries a player from `from` (their feet) to `to` in the plan's
 * steps. The player's integration is exact (v -= g dt, then move), so it lands on `to`.
 */
export function playerLaunch(plan: FlightPlan, from: THREE.Vector3, to: THREE.Vector3, gravity = GRAVITY, out = new THREE.Vector3()): THREE.Vector3 {
  const { n, time } = plan;
  return out.set((to.x - from.x) / time, (to.y - from.y + (gravity * STEP * STEP * n * (n + 1)) / 2) / time, (to.z - from.z) / time);
}

/** Likewise for a crate, from where its underside is now to the floor point `to`. */
export function crateLaunch(plan: FlightPlan, from: THREE.Vector3, to: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set((to.x - from.x) / plan.run, (to.y - from.y - plan.fall) / plan.run, (to.z - from.z) / plan.run);
}

/** The throw from the middle of the plate (the editor draws it). */
export function faithArcs(from: THREE.Vector3, to: THREE.Vector3, apex: number): { player: THREE.Vector3; crate: THREE.Vector3; time: number } {
  const plan = flightPlan(from, to, apex);
  return { player: playerLaunch(plan, from, to), crate: crateLaunch(plan, from, to), time: plan.time };
}

/**
 * A jump pad (an "aerial faith plate"): a plate in the floor that throws whoever steps on it,
 * or whatever lands on it - players and crates alike - along an arc to a marked spot. The
 * flap springs up when it fires; a ring on the floor marks where the throw comes down.
 */
export class FaithPlate implements Hazard {
  readonly center: THREE.Vector3;
  readonly target: THREE.Vector3;
  /** Launch velocity for a player and for a crate thrown from the middle of the plate. */
  readonly playerVelocity: THREE.Vector3;
  readonly crateVelocity: THREE.Vector3;
  /** How long the flight takes. */
  readonly flightTime: number;
  private readonly plan: FlightPlan;
  private readonly half: THREE.Vector2;
  private readonly flap: THREE.Group;
  private readonly chevrons: THREE.MeshBasicMaterial;
  private readonly cooldowns = new Map<object, number>();
  /** Crates in the air from this plate, and how long until they come down. */
  private readonly flights = new Map<PropBox, number>();
  private kick = 0;
  private time = 0;

  constructor(level: Level, o: FaithPlateOptions) {
    this.center = o.center.clone();
    this.target = o.target.clone();
    this.half = o.size.clone().multiplyScalar(0.5);
    const from = this.center.clone().setY(this.center.y + PLATE_HEIGHT);
    this.plan = flightPlan(from, this.target, o.apex ?? 3);
    this.playerVelocity = playerLaunch(this.plan, from, this.target);
    this.crateVelocity = crateLaunch(this.plan, from, this.target);
    this.flightTime = this.plan.time;

    const m = materials();
    const { x: w, y: d } = o.size;
    const dir = new THREE.Vector3(this.target.x - this.center.x, 0, this.target.z - this.center.z);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    dir.normalize();
    const group = new THREE.Group();
    group.position.copy(this.center);
    group.rotation.y = Math.atan2(-dir.x, -dir.z);

    // Housing: a dark slab with a hazard border; the flap on top is hinged at its back edge.
    const border = new THREE.Mesh(level.own(new THREE.BoxGeometry(w + 0.24, 0.02, d + 0.24)), m.hazard);
    border.position.y = 0.01;
    const slab = new THREE.Mesh(level.own(new THREE.BoxGeometry(w, PLATE_HEIGHT, d)), m.trim);
    slab.position.y = PLATE_HEIGHT / 2;
    slab.receiveShadow = true;
    this.chevrons = level.own(glowMaterial(MARKER_COLOR, 1.7));
    this.flap = new THREE.Group();
    // Group-local +z is the back (away from the throw): the hinge sits there.
    const hinge = d * 0.5;
    this.flap.position.set(0, PLATE_HEIGHT, hinge);
    const leaf = new THREE.Mesh(level.own(new THREE.BoxGeometry(w * 0.86, 0.02, d * 0.88)), m.trim);
    leaf.position.set(0, 0, -d * 0.44);
    leaf.castShadow = true;
    const arrowShape = new THREE.Shape([
      new THREE.Vector2(-0.45, -0.3),
      new THREE.Vector2(0, 0.3),
      new THREE.Vector2(0.45, -0.3),
      new THREE.Vector2(0.45, -0.08),
      new THREE.Vector2(0, 0.5),
      new THREE.Vector2(-0.45, -0.08),
    ]);
    const arrowGeo = level.own(new THREE.ShapeGeometry(arrowShape));
    const count = Math.min(3, Math.max(1, Math.floor(d / 0.9)));
    for (let i = 0; i < count; i++) {
      const a = new THREE.Mesh(arrowGeo, this.chevrons);
      a.rotation.x = -Math.PI / 2;
      // Shape +y becomes group -z (toward the throw); they march from the hinge outward.
      a.position.set(0, 0.012, -d * 0.44 + ((count - 1) / 2 - i) * 0.75);
      a.scale.setScalar(Math.min(1, w / 1.4));
      this.flap.add(a);
    }
    this.flap.add(leaf);
    group.add(border, slab, this.flap);
    level.scene.add(group);
    level.addBlocker(slab);
    group.updateMatrixWorld(true);

    // Landing marker.
    const ring = new THREE.Mesh(level.own(new THREE.RingGeometry(0.78, 0.9, 40)), this.chevrons);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(this.target).setY(this.target.y + 0.02);
    const dot = new THREE.Mesh(level.own(new THREE.CircleGeometry(0.16, 20)), this.chevrons);
    dot.rotation.x = -Math.PI / 2;
    dot.position.copy(ring.position);
    level.scene.add(ring, dot);
  }

  /** The surface bodies stand on. */
  get surfaceY(): number {
    return this.center.y + PLATE_HEIGHT;
  }

  private under(x: number, z: number): boolean {
    return Math.abs(x - this.center.x) <= this.half.x + EDGE_REACH && Math.abs(z - this.center.z) <= this.half.y + EDGE_REACH;
  }

  /**
   * The plate and a margin round it. A bot has no use for being thrown across the room, so it
   * keeps off it like off acid, and nothing (a point orb) is put on it.
   */
  covers(p: THREE.Vector3): boolean {
    return Math.abs(p.x - this.center.x) < this.half.x + 0.6 && Math.abs(p.z - this.center.z) < this.half.y + 0.6 && Math.abs(p.y - this.center.y) < 0.6;
  }

  private ready(who: object): boolean {
    return this.time >= (this.cooldowns.get(who) ?? 0);
  }

  update(dt: number, ctx: HazardContext): void {
    this.time += dt;
    const top = this.surfaceY;
    let fired = false;
    for (const player of ctx.players) {
      const p = player.getPosition();
      const feet = p.y - PLAYER_FEET_OFFSET - top;
      if (!this.under(p.x, p.z) || feet < -0.15 || feet > 0.3 || !this.ready(player)) continue;
      this.cooldowns.set(player, this.time + COOLDOWN);
      // Aimed from wherever on the plate they stand, so it always comes down on the marker.
      player.launch(playerLaunch(this.plan, _from.set(p.x, p.y - PLAYER_FEET_OFFSET, p.z), this.target, GRAVITY, _v));
      fired = true;
    }
    // Online, on a player's screen, crates are wherever the game server says.
    if (!ctx.netClient) {
      for (const box of ctx.props) {
        if (!box.visible || box.passing || !this.ready(box)) continue;
        const p = box.getPosition();
        const base = p.y - BOX_HALF - top;
        if (!this.under(p.x, p.z) || base < -0.2 || base > 0.35) continue;
        this.cooldowns.set(box, this.time + COOLDOWN);
        box.launch(crateLaunch(this.plan, _from.set(p.x, p.y - BOX_HALF, p.z), this.target, _v));
        this.flights.set(box, this.plan.time);
        fired = true;
      }
      this.land(dt);
    }
    if (fired) {
      this.kick = 1;
      ctx.sound('launch', 0.9, this.center, 40);
    }
    this.kick = Math.max(0, this.kick - dt * 2.4);
    // Springs up fast, settles back slowly.
    const k = this.kick > 0.7 ? 1 : this.kick / 0.7;
    this.flap.rotation.x = FLAP_UP * k;
    this.chevrons.color.set(MARKER_COLOR).multiplyScalar(1.7 + this.kick * 2.5);
  }

  /**
   * A thrown crate that is about to come down on the marker comes down square: a throw
   * fast enough to cross a room would otherwise land edge first and tumble off the spot.
   */
  private land(dt: number): void {
    for (const [box, left] of this.flights) {
      const next = left - dt;
      if (next > STEP * 0.25) {
        this.flights.set(box, next);
        continue;
      }
      this.flights.delete(box);
      const p = box.getPosition();
      if (box.visible && Math.hypot(p.x - this.target.x, p.z - this.target.z) < 1.5 && p.y - BOX_HALF - this.target.y < 1.5) box.stopSliding();
    }
  }

  reset(): void {
    this.flights.clear();
    this.cooldowns.clear();
    this.kick = 0;
  }
}
