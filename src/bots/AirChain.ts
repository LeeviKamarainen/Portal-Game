import * as THREE from 'three';
import type { Face, Level } from '../world/Level';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { PORTAL_HALF_H, PORTAL_HALF_W } from '../portals/Portal';
import { FALL_DAMAGE_THRESHOLD, PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { NavGraph, NavNode } from './NavGraph';
import type { ClimbSpot } from './ClimbSpots';
import { flyFrom } from './TrapSpots';

/**
 * Chaining portals in the air (Ultra hard's `airChain`). Coming out of one portal with a good
 * way to fall, a body can shoot a new exit and a new way in on what it is about to hit, and
 * go through that too: each link lands nearer where it is going, or flings it across the map.
 * This file is the geometry - where a body in the air will hit a surface, what a portal
 * does to its velocity, where it comes down after - the decisions are BotBrain's.
 */

/** Where a body in the air is going to hit something a portal can go on. */
export interface AirEntrance {
  readonly face: Face;
  /** Where the opening's centre goes (on the surface). */
  readonly point: THREE.Vector3;
  readonly normal: THREE.Vector3;
  /** The way up the opening will have (it follows the shot on a floor or ceiling). */
  readonly up: THREE.Vector3;
  /** Seconds from now until the body gets there. */
  readonly time: number;
  /** Its velocity then. */
  readonly velocity: THREE.Vector3;
}

/** A way down: where it lands (the floor, a node of the nav graph), how hard, how long after leaving the exit. */
export interface AirLanding {
  readonly land: THREE.Vector3;
  readonly node: NavNode;
  readonly impact: number;
  readonly time: number;
}

/** How far ahead (seconds) a body's flight is followed to find what it will hit. */
const FORECAST_TIME = 4;
/** An exit portal this far (m) from the surface point is where a body comes out: matches TrapSpots' OUT. */
const OUT = 0.7;
/** Landing checks: the flight is also run this much slower and faster (a hair off the speed it was worked out for). */
const SPEED_SPREAD = [1, 0.9, 1.1];
/** Floor all round the landing this far out, metres. */
const LANDING_MARGIN = 1.3;

const _r = new THREE.Vector3();
const _rOut = new THREE.Vector3();
const _l = new THREE.Vector3();

/** The body's width: a flight is followed down its centre line and this far to either side, which have to agree. */
const BODY_HALF = 0.42;
/** ...to within this far (m) of one another where they come down. */
const FORECAST_AGREE = 1.4;

const _side = new THREE.Vector3();
const _start = new THREE.Vector3();

/**
 * The first portal-taking surface a body at `pos` going `vel` reaches under gravity (no
 * steering), with room for an opening there - or null: it hits nothing, or something that
 * takes no portal, or too near an edge for the opening to sit where the body arrives, or the
 * flight is a close call (a body is not a line: down the centre it clears a rim that its
 * side catches, so the flights down its two sides have to come down in the same place).
 */
export const entranceWhy = new Map<string, number>();
const why = (k: string): null => {
  entranceWhy.set(k, (entranceWhy.get(k) ?? 0) + 1);
  return null;
};
export function findEntrance(physics: PhysicsWorld, level: Level, killY: number, pos: THREE.Vector3, vel: THREE.Vector3, shotEye: THREE.Vector3): AirEntrance | null {
  const f = flyFrom(physics, killY, pos, vel, FORECAST_TIME);
  if (!f.land || !f.normal) return why(f.fell ? 'falls out of the world' : 'hits nothing');
  const hit = f.land;
  const n = f.normal;
  // Sideways of its horizontal heading (any way, standing still).
  _side.set(-vel.z, 0, vel.x);
  if (_side.lengthSq() < 1e-4) _side.set(1, 0, 0);
  _side.normalize().multiplyScalar(BODY_HALF);
  for (const k of [1, -1]) {
    _start.copy(pos).addScaledVector(_side, k);
    const g = flyFrom(physics, killY, _start, vel, FORECAST_TIME);
    if (!g.land || !g.normal || g.normal.dot(n) < 0.9 || g.land.distanceTo(hit) > FORECAST_AGREE) return why('close call');
  }
  let reason = 'not a portal surface';
  for (const face of level.faces) {
    if (face.normal.dot(n) < 0.98) continue;
    _l.copy(hit).sub(face.center);
    if (Math.abs(_l.dot(face.normal)) > 0.08) continue;
    const l = face.toLocal(hit);
    if (Math.abs(l.x) > face.width / 2 + 0.05 || Math.abs(l.y) > face.height / 2 + 0.05) continue;
    if (!face.portalable) continue;
    reason = 'too near an edge';
    // The opening the gun puts there (nudged in off the edge) has to take the body where it arrives.
    const up = openingUp(face.normal, shotEye, hit, new THREE.Vector3());
    if (!opensOver(face, l, up)) continue;
    return { face, point: hit.clone(), normal: face.normal.clone(), up, time: f.time, velocity: f.velocity.clone() };
  }
  return why(`${reason} (${n.y > 0.7 ? 'floor' : n.y < -0.7 ? 'ceiling' : 'wall'})`);
}

/**
 * A portal shot at `local` (face coordinates) on `face`, with its top toward `up`, is put
 * where it fits (PortalGun.findPlacement clamps it in off the edges): whether the opening
 * still takes a body that goes through `local` - the body's width (and a little for the
 * portal's funnelling) inside the opening's short side, its radius inside the long one.
 */
function opensOver(face: Face, local: THREE.Vector3, up: THREE.Vector3): boolean {
  const right = _r.crossVectors(up, face.normal).normalize();
  const ex = Math.abs(right.dot(face.right)) * PORTAL_HALF_W + Math.abs(up.dot(face.right)) * PORTAL_HALF_H;
  const ey = Math.abs(right.dot(face.up)) * PORTAL_HALF_W + Math.abs(up.dot(face.up)) * PORTAL_HALF_H;
  const limX = face.width / 2 - ex - 0.02;
  const limY = face.height / 2 - ey - 0.02;
  if (limX < 0 || limY < 0) return false;
  const dx = local.x - THREE.MathUtils.clamp(local.x, -limX, limX);
  const dy = local.y - THREE.MathUtils.clamp(local.y, -limY, limY);
  // The shift, along the opening's own axes.
  const sr = dx * right.dot(face.right) + dy * right.dot(face.up);
  const su = dx * up.dot(face.right) + dy * up.dot(face.up);
  return Math.abs(sr) <= PORTAL_HALF_W - 0.4 && Math.abs(su) <= PORTAL_HALF_H - 0.4;
}

/** The way up a portal on a surface faces when shot from `eye` (PortalGun.orientation), written into `out`. */
export function openingUp(normal: THREE.Vector3, eye: THREE.Vector3, point: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  if (Math.abs(normal.y) < 0.7) return out.set(0, 1, 0).addScaledVector(normal, -normal.y).normalize();
  out.copy(point).sub(eye);
  out.addScaledVector(normal, -out.dot(normal));
  if (out.lengthSq() < 1e-6) out.set(0, 0, normal.y > 0 ? -1 : 1);
  return out.normalize();
}

/**
 * What going into one portal does to a velocity: its parts along the entry's right / up /
 * normal come out along the exit's (minus right, up, minus normal) - the half turn the
 * game gives every passage (PortalMath's FLIP_Y).
 */
export function exitVelocity(vIn: THREE.Vector3, entryNormal: THREE.Vector3, entryUp: THREE.Vector3, exitNormal: THREE.Vector3, exitUp: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  _r.crossVectors(entryUp, entryNormal).normalize();
  const a = vIn.dot(_r);
  const b = vIn.dot(entryUp);
  const c = vIn.dot(entryNormal);
  _rOut.crossVectors(exitUp, exitNormal).normalize();
  return out.set(0, 0, 0).addScaledVector(_rOut, -a).addScaledVector(exitUp, b).addScaledVector(exitNormal, -c);
}

/**
 * Where a body coming out of an exit at `point` (facing `normal`) with velocity `vel` comes
 * down - on safe, walkable floor with floor all round, and not too hard a landing unless
 * `flashOk` (immunity ready to take it) - at that speed and a little under and over. Null if
 * it doesn't, or the landings are not all of the same sort.
 */
export function safeLanding(physics: PhysicsWorld, nav: NavGraph, killY: number, point: THREE.Vector3, normal: THREE.Vector3, vel: THREE.Vector3, flashOk: boolean): AirLanding | null {
  const start = point.clone().addScaledVector(normal, OUT);
  let first: AirLanding | null = null;
  let hardest = 0;
  const v = new THREE.Vector3();
  for (const k of SPEED_SPREAD) {
    v.copy(vel).multiplyScalar(k);
    const f = flyFrom(physics, killY, start, v);
    if (!f.land || !f.normal || f.normal.y < 0.7) return null;
    const node = nav.nearest(f.land.clone().setY(f.land.y + PLAYER_FEET_OFFSET), 1);
    if (!node || node.hazards.length || Math.abs(node.y - f.land.y) > 0.6) return null;
    if (first && Math.abs(first.node.y - node.y) > 0.5) return null;
    hardest = Math.max(hardest, f.impact);
    first ??= { land: f.land, node, impact: f.impact, time: f.time };
  }
  if (!first) return null;
  if (hardest > FALL_DAMAGE_THRESHOLD && !flashOk) return null;
  if (!roomAround(nav, first.land, LANDING_MARGIN, first.node.y)) return null;
  return { ...first, impact: hardest };
}

/** Walkable, safe floor at the same height in every direction `margin` out from `at`. */
export function roomAround(nav: NavGraph, at: THREE.Vector3, margin: number, floorY: number): boolean {
  const probe = new THREE.Vector3();
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    probe.set(at.x + Math.cos(a) * margin, floorY + PLAYER_FEET_OFFSET, at.z + Math.sin(a) * margin);
    const n = nav.nearest(probe, 0);
    if (!n || n.hazards.length || Math.abs(n.y - floorY) > 0.6) return false;
  }
  return true;
}

/** Where a body at `pos` going `vel` will be after `t` seconds, under gravity (no steering), written into `out`. */
export function positionAfter(pos: THREE.Vector3, vel: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(pos).addScaledVector(vel, t);
  out.y -= 0.5 * 20 * t * t;
  return out;
}

/** What a world has to be asked about for a chain: static map knowledge and the kill plane. */
export interface ChainWorld {
  readonly physics: PhysicsWorld;
  readonly level: Level;
  readonly nav: NavGraph;
  readonly killY: number;
}

/** An exit it can take out of a way in, and where that lands it. */
export interface ChainOption {
  readonly spot: ClimbSpot;
  readonly landing: AirLanding;
}

/**
 * Of `spots` (in the order of preference), those `visible` ones that - carrying `entrance`'s
 * velocity through the way in and out of the spot (shot from `exitEye`;
 * the way up of a floor, ceiling or wall opening follows the shot) - land safely: at most
 * `maxFlights` of them get a flight worked out.
 */
export function chainOptions(w: ChainWorld, entrance: AirEntrance, exitEye: THREE.Vector3, spots: Iterable<ClimbSpot>, visible: (s: ClimbSpot) => boolean, flashOk: boolean, maxFlights: number): ChainOption[] {
  const entryUp = entrance.up;
  const exitUp = new THREE.Vector3();
  const vOut = new THREE.Vector3();
  const out: ChainOption[] = [];
  let flights = 0;
  for (const s of spots) {
    if (flights >= maxFlights) break;
    if (s.point.distanceTo(entrance.point) < 3.5 || !visible(s)) continue;
    flights++;
    openingUp(s.normal, exitEye, s.point, exitUp);
    exitVelocity(entrance.velocity, entrance.normal, entryUp, s.normal, exitUp, vOut);
    // (Grazing the way in turns hardly any of it out of the exit: it would only dribble out.)
    if (vOut.dot(s.normal) < MIN_OUT) continue;
    const landing = safeLanding(w.physics, w.nav, w.killY, s.point, s.normal, vOut, flashOk);
    if (landing) out.push({ spot: s, landing });
  }
  return out;
}

/** An exit has to turn the way it was going into this much of it, m/s, to carry it anywhere. */
const MIN_OUT = 3;
