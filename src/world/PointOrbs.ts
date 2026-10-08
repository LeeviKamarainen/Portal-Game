import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { ArenaBuilder } from './ArenaBuilder';
import { glowMaterial } from './Materials';
import { PORTAL_HALF_H, PORTAL_HALF_W, type Portal } from '../portals/Portal';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../player/PlayerController';
import type { MatchRules } from '../game/Match';

const ORB_COLOR = 0xffd23a;
/** Orb centre above the floor it hovers over (chest height). */
const HOVER = 1.1;
/** A player whose centre comes this close to an orb's centre picks it up. */
const PICKUP_RADIUS = 1.3;
/** Spacing kept between orbs, and from players, when one turns up (relaxed if the arena is too tight). */
const ORB_SPACING = 10;
const PLAYER_SPACING = 6;
const SPAWN_TRIES = 200;
/** The floor under an orb has to be flat this far out, so orbs don't land on posts and wall tops. */
const FLAT_REACH = 0.9;
const APPEAR_TIME = 0.6;
/** If no spot is found, look again after this long. */
const RETRY_DELAY = 1;
const BEAM_HEIGHT = 30;

const ZONE_VERTEX = /* glsl */ `
varying vec3 vNormal;
varying vec3 vView;
varying float vY;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vY = world.y;
  vec4 mv = viewMatrix * world;
  vNormal = normalize(normalMatrix * normal);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

/** The no-portal zone: a sphere that is nearly clear face-on and glows at its rim. */
const ZONE_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float time;
uniform float strength;
varying vec3 vNormal;
varying vec3 vView;
varying float vY;
void main() {
  float rim = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.5);
  float bands = 0.65 + 0.35 * sin(vY * 7.0 - time * 2.5);
  gl_FragColor = vec4(color * (rim * 0.3 + 0.012) * bands * strength, 1.0);
}
`;

const BEAM_VERTEX = /* glsl */ `
varying float vH;
void main() {
  vH = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float strength;
varying float vH;
void main() {
  float a = pow(1.0 - vH, 3.0) * 0.6 * strength;
  gl_FragColor = vec4(color * a, 1.0);
}
`;

interface Orb {
  readonly pos: THREE.Vector3;
  active: boolean;
  /** While inactive: seconds until it turns up again. While active: seconds since it did. */
  timer: number;
  readonly group: THREE.Group;
  readonly core: THREE.Mesh;
  readonly shell: THREE.Mesh;
  readonly zone: THREE.ShaderMaterial;
  readonly beam: THREE.ShaderMaterial;
  readonly light: THREE.PointLight;
}

export interface OrbCollector {
  readonly id: string;
  getPosition(): THREE.Vector3;
}

const _l = new THREE.Vector3();
const _c = new THREE.Vector3();

/** Shortest distance from `p` to a portal-sized rectangle at `center` with axes `right`/`up`. */
export function distanceToOpening(p: THREE.Vector3, center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): number {
  _l.copy(p).sub(center);
  const x = THREE.MathUtils.clamp(_l.dot(right), -PORTAL_HALF_W, PORTAL_HALF_W);
  const y = THREE.MathUtils.clamp(_l.dot(up), -PORTAL_HALF_H, PORTAL_HALF_H);
  _c.copy(center).addScaledVector(right, x).addScaledVector(up, y);
  return _c.distanceTo(p);
}

/**
 * Point orbs: a few at a time, each on a random patch of open, flat, safe floor somewhere
 * in the arena. Touching one scores; it then turns up somewhere else a few seconds later.
 * Around each orb is a no-portal zone (the shimmering sphere), so an orb can't be farmed
 * by parking a portal pair next to it.
 */
export class PointOrbs {
  readonly orbs: Orb[] = [];
  private readonly arena: ArenaBuilder;
  private readonly rules: MatchRules;
  /** Where orbs turn up (bot-vs-bot simulations seed it, so a match plays out the same each run). */
  random: () => number;
  private time = 0;

  constructor(arena: ArenaBuilder, rules: MatchRules, random: () => number = Math.random) {
    this.arena = arena;
    this.rules = rules;
    this.random = random;
    const level = arena.level;
    const coreGeo = level.own(new THREE.IcosahedronGeometry(0.3, 1));
    const shellGeo = level.own(new THREE.IcosahedronGeometry(0.52, 0));
    const zoneGeo = level.own(new THREE.SphereGeometry(rules.orbNoPortalRadius, 48, 24));
    const beamGeo = level.own(new THREE.CylinderGeometry(0.06, 0.22, BEAM_HEIGHT, 12, 1, true));
    beamGeo.translate(0, BEAM_HEIGHT / 2, 0);
    const coreMat = level.own(glowMaterial(ORB_COLOR, 3));
    const shellMat = level.own(glowMaterial(ORB_COLOR, 1.6, { wireframe: true, transparent: true, opacity: 0.75 }));
    const color = new THREE.Color(ORB_COLOR);

    for (let i = 0; i < rules.orbCount; i++) {
      const group = new THREE.Group();
      const core = new THREE.Mesh(coreGeo, coreMat);
      const shell = new THREE.Mesh(shellGeo, shellMat);
      const zone = level.own(
        new THREE.ShaderMaterial({
          uniforms: { color: { value: color }, time: { value: 0 }, strength: { value: 0 } },
          vertexShader: ZONE_VERTEX,
          fragmentShader: ZONE_FRAGMENT,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      const beam = level.own(
        new THREE.ShaderMaterial({
          uniforms: { color: { value: color }, strength: { value: 0 } },
          vertexShader: BEAM_VERTEX,
          fragmentShader: BEAM_FRAGMENT,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          side: THREE.DoubleSide,
        }),
      );
      const zoneMesh = new THREE.Mesh(zoneGeo, zone);
      const beamMesh = new THREE.Mesh(beamGeo, beam);
      zoneMesh.renderOrder = beamMesh.renderOrder = 2;
      group.add(core, shell, zoneMesh, beamMesh);
      group.visible = false;
      // Lights stay in the scene at zero intensity while unused: adding or removing a
      // light recompiles every material.
      const light = new THREE.PointLight(ORB_COLOR, 0, 7, 1.5);
      level.scene.add(group, light);
      this.orbs.push({ pos: new THREE.Vector3(), active: false, timer: 0, group, core, shell, zone, beam, light });
    }
  }

  /** Active orbs' positions. */
  get positions(): THREE.Vector3[] {
    return this.orbs.filter((o) => o.active).map((o) => o.pos);
  }

  /** For the portal gun: an opening there would reach into an orb's no-portal zone. */
  blocks(center: THREE.Vector3, right: THREE.Vector3, up: THREE.Vector3): boolean {
    const r = this.rules.orbNoPortalRadius;
    return this.orbs.some((o) => o.active && distanceToOpening(o.pos, center, right, up) < r);
  }

  /**
   * Places waiting orbs and checks pickups (call after the physics step). Returns the ids
   * of the players who picked one up this step.
   */
  update(dt: number, players: readonly OrbCollector[], portals: readonly Portal[]): string[] {
    this.time += dt;
    const collected: string[] = [];
    for (const orb of this.orbs) {
      if (!orb.active) {
        orb.timer -= dt;
        if (orb.timer <= 0) this.spawn(orb, players, portals);
        continue;
      }
      orb.timer += dt;
      // Not collectable until it has fully appeared - nobody scores from an orb they couldn't see.
      if (orb.timer < APPEAR_TIME) continue;
      const taker = players.find((p) => p.getPosition().distanceTo(orb.pos) < PICKUP_RADIUS);
      if (taker) {
        collected.push(taker.id);
        this.hide(orb, this.rules.orbRespawn);
      }
    }
    return collected;
  }

  /** Per-frame animation. */
  animate(time: number): void {
    for (const [i, orb] of this.orbs.entries()) {
      if (!orb.active) continue;
      const appear = THREE.MathUtils.smoothstep(orb.timer, 0, APPEAR_TIME);
      const bob = Math.sin(time * 2.2 + i * 1.7) * 0.12;
      orb.core.position.y = orb.shell.position.y = bob;
      orb.core.rotation.set(time * 0.9, time * 1.3, 0);
      orb.shell.rotation.set(-time * 0.5, time * 0.7, time * 0.3);
      const pulse = 1 + Math.sin(time * 5 + i) * 0.06;
      orb.core.scale.setScalar(appear * pulse);
      orb.shell.scale.setScalar(appear * (1.6 - 0.6 * appear));
      orb.zone.uniforms.time.value = time;
      orb.zone.uniforms.strength.value = appear;
      orb.beam.uniforms.strength.value = appear;
      orb.light.intensity = 3 * appear;
      orb.light.position.copy(orb.pos).y += bob;
    }
  }

  /** Every orb gone, each back after `delay` seconds (Infinity: until cleared again). */
  clear(delay = 0): void {
    for (const orb of this.orbs) this.hide(orb, delay);
  }

  private hide(orb: Orb, delay: number): void {
    orb.active = false;
    orb.timer = delay;
    orb.group.visible = false;
    orb.light.intensity = 0;
  }

  private spawn(orb: Orb, players: readonly OrbCollector[], portals: readonly Portal[]): void {
    const others = this.positions;
    const spot =
      this.findSpot(others, players, portals, ORB_SPACING, PLAYER_SPACING) ??
      this.findSpot(others, players, portals, ORB_SPACING / 2, PLAYER_SPACING / 2);
    if (!spot) {
      orb.timer = RETRY_DELAY;
      return;
    }
    orb.pos.copy(spot);
    orb.active = true;
    orb.timer = 0;
    orb.group.position.copy(spot);
    orb.group.visible = true;
  }

  /** A random hover point over open, flat, safe floor clear of other orbs, players and portals. */
  findSpot(
    orbs: readonly THREE.Vector3[],
    players: readonly OrbCollector[],
    portals: readonly Portal[],
    orbSpacing = ORB_SPACING,
    playerSpacing = PLAYER_SPACING,
  ): THREE.Vector3 | null {
    const b = this.arena.bounds;
    const r = this.rules.orbNoPortalRadius;
    for (let i = 0; i < SPAWN_TRIES; i++) {
      // A random height as well, so every tier of a multi-level arena gets its share.
      const start = new THREE.Vector3(
        THREE.MathUtils.lerp(b.min.x + 1, b.max.x - 1, this.random()),
        THREE.MathUtils.lerp(b.min.y + 0.5, b.max.y - 0.5, this.random()),
        THREE.MathUtils.lerp(b.min.z + 1, b.max.z - 1, this.random()),
      );
      const floor = this.floorBelow(start, b.max.y - b.min.y);
      if (!floor || floor.y < this.arena.killY + 0.5) continue;
      const pos = floor.clone().setY(floor.y + HOVER);
      if (pos.y > b.max.y - 0.5) continue;
      if (this.arena.hazards.some((h) => h.covers?.(floor))) continue;
      if (orbs.some((o) => o.distanceTo(pos) < orbSpacing)) continue;
      if (players.some((p) => p.getPosition().distanceTo(pos) < playerSpacing)) continue;
      if (portals.some((p) => p.placed && distanceToOpening(pos, p.surfaceCenter, p.right, p.up) < r + 0.25)) continue;
      if (!this.isFlat(floor) || !this.hasHeadroom(floor)) continue;
      return pos;
    }
    return null;
  }

  /** Static level geometry facing up under `from`, or null (nothing, something moving, or a hazard). */
  private floorBelow(from: THREE.Vector3, range: number): THREE.Vector3 | null {
    const physics = this.arena.level.physics;
    const hit = physics.world.castRayAndGetNormal(
      new RAPIER.Ray(from, { x: 0, y: -1, z: 0 }),
      range,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => {
        const t = physics.getOwner(c.handle)?.type;
        return t !== 'portal-tunnel' && t !== 'player' && t !== 'prop';
      },
    );
    // Starting inside something reports a hit at 0.
    if (!hit || hit.timeOfImpact < 0.05 || hit.normal.y < 0.9) return null;
    if (physics.getOwner(hit.collider.handle)?.type !== 'solid') return null;
    return from.clone().setY(from.y - hit.timeOfImpact);
  }

  private isFlat(floor: THREE.Vector3): boolean {
    for (const [dx, dz] of [
      [FLAT_REACH, 0],
      [-FLAT_REACH, 0],
      [0, FLAT_REACH],
      [0, -FLAT_REACH],
    ]) {
      const p = this.floorBelow(new THREE.Vector3(floor.x + dx, floor.y + 0.5, floor.z + dz), 0.8);
      if (!p || Math.abs(p.y - floor.y) > 0.25) return false;
    }
    return true;
  }

  /** Room for a player to stand there. */
  private hasHeadroom(floor: THREE.Vector3): boolean {
    const physics = this.arena.level.physics;
    const half = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;
    const hit = physics.world.intersectionWithShape(
      { x: floor.x, y: floor.y + PLAYER_HEIGHT / 2 + 0.1, z: floor.z },
      { x: 0, y: 0, z: 0, w: 1 },
      new RAPIER.Capsule(half, PLAYER_RADIUS + 0.1),
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => {
        const t = physics.getOwner(c.handle)?.type;
        return t !== 'portal-tunnel' && t !== 'player' && t !== 'prop';
      },
    );
    return hit === null;
  }
}
