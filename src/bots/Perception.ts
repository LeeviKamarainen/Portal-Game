import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Session } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { Portal } from '../portals/Portal';
import { EYE_OFFSET } from '../player/PlayerController';
import type { BotSkill } from './BotSkill';

/** An enemy the bot knows about - seen or heard - and its best guess of where they are. */
export interface KnownEnemy {
  readonly id: string;
  /** Where their body's centre was when last sensed (a heard position is only rough). */
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  /** In sight (and noticed) right now. */
  visible: boolean;
  how: 'sight' | 'sound';
  /** When last seen or heard. */
  sensedAt: number;
  /** 1 when just seen (less when only heard), fading to 0 over the skill's memory. */
  confidence: number;
  /** Confidence at the moment it was sensed. */
  base: number;
}

/** Every time something became known and how - tests check it really was perceivable. */
export interface PerceptionRecord {
  time: number;
  what: 'enemy' | 'orb' | 'portal';
  id: string;
  how: 'sight' | 'sound';
}

/** Heard positions start at this confidence (a seen enemy starts at 1). */
const HEARD_CONFIDENCE = 0.6;
/** Someone lost from sight this recently is picked up again without the noticing delay. */
const REACQUIRE_WINDOW = 0.5;
/** An orb's light column counts as seen this far above it. */
const BEAM_SIGHT = 8;
/** Noises that give away where a player is (a portal opening shows only the portal). */
const REVEALING = new Set(['shot', 'teleport', 'land', 'step']);

const _eye = new THREE.Vector3();
const _look = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * What a bot knows. It is never handed the world: it sees through a view cone (range
 * capped by fog, line of sight needed, and someone has to stay in view briefly before they
 * register), hears noises within range (which give only a rough position), and remembers
 * for a few seconds. Decisions read from here and nothing else.
 */
export class Perception {
  readonly enemies = new Map<string, KnownEnemy>();
  /** Orbs it has seen (or seen the light column of) and not yet seen gone. */
  readonly orbs: THREE.Vector3[] = [];
  /** Other players' portals it has seen, and where. */
  readonly portals = new Map<Portal, THREE.Vector3>();
  readonly log: PerceptionRecord[] = [];

  private readonly session: Session;
  private readonly self: ArenaPlayer;
  private readonly skill: BotSkill;
  private readonly random: () => number;
  private readonly seenFor = new Map<string, number>();
  private readonly range: number;

  constructor(session: Session, self: ArenaPlayer, skill: BotSkill, random: () => number) {
    this.session = session;
    this.self = self;
    this.skill = skill;
    this.random = random;
    this.range = Math.min(skill.viewRange, session.arena.fog.far);
  }

  /** The eye, and which way it looks. */
  eye(out = new THREE.Vector3()): THREE.Vector3 {
    this.self.controller.viewPose(out, _look);
    return out;
  }

  update(dt: number): void {
    const now = this.session.time;
    this.self.controller.viewPose(_eye, _look);
    _fwd.set(0, 0, -1).applyQuaternion(_look);
    _right.set(1, 0, 0).applyQuaternion(_look);
    _up.set(0, 1, 0).applyQuaternion(_look);
    this.see(dt, now);
    this.hear(now);
    this.fade(now);
    this.watchOrbs(now);
    this.watchPortals(now);
  }

  private see(dt: number, now: number): void {
    for (const other of this.session.players) {
      if (other === this.self) continue;
      const known = this.enemies.get(other.id);
      if (other.dead) {
        this.seenFor.set(other.id, 0);
        if (known) known.visible = false;
        continue;
      }
      const c = other.controller;
      const body = c.getPosition();
      const handle = c.colliderHandle;
      const visible = [EYE_OFFSET, 0.3, -0.5].some((dy) => this.canSee(_p.copy(body).setY(body.y + dy), handle));
      const t = visible ? (this.seenFor.get(other.id) ?? 0) + dt : 0;
      this.seenFor.set(other.id, t);
      const recent = known?.how === 'sight' && now - known.sensedAt <= REACQUIRE_WINDOW;
      if (visible && (t >= this.skill.acquireTime || recent)) {
        if (!known?.visible) this.log.push({ time: now, what: 'enemy', id: other.id, how: 'sight' });
        this.remember(other.id, body, c.getVelocity(), 'sight', 1, now);
      } else if (known) {
        known.visible = false;
      }
    }
  }

  private hear(now: number): void {
    for (const n of this.session.heard) {
      if (!n.source || n.source === this.self.id || !REVEALING.has(n.kind)) continue;
      const d = n.position.distanceTo(_eye);
      if (d > n.radius * this.skill.hearing) continue;
      if (this.enemies.get(n.source)?.visible) continue;
      // Only roughly where: the further away, the rougher.
      const err = (1 + 0.12 * d) * Math.sqrt(this.random());
      const a = this.random() * Math.PI * 2;
      const guess = n.position.clone().add(_v.set(Math.cos(a) * err, 0, Math.sin(a) * err));
      this.log.push({ time: now, what: 'enemy', id: n.source, how: 'sound' });
      this.remember(n.source, guess, _v.set(0, 0, 0), 'sound', HEARD_CONFIDENCE, now);
    }
  }

  private remember(id: string, position: THREE.Vector3, velocity: THREE.Vector3, how: 'sight' | 'sound', base: number, now: number): void {
    let e = this.enemies.get(id);
    if (!e) {
      e = { id, position: new THREE.Vector3(), velocity: new THREE.Vector3(), visible: false, how, sensedAt: now, confidence: base, base };
      this.enemies.set(id, e);
    }
    e.position.copy(position);
    e.velocity.copy(velocity);
    e.visible = how === 'sight';
    e.how = how;
    e.sensedAt = now;
    e.base = base;
    e.confidence = base;
  }

  private fade(now: number): void {
    for (const [id, e] of this.enemies) {
      if (e.visible) continue;
      e.confidence = e.base * (1 - (now - e.sensedAt) / this.skill.memory);
      if (e.confidence <= 0) this.enemies.delete(id);
    }
  }

  private watchOrbs(now: number): void {
    const orbs = this.session.orbs;
    if (!orbs) return;
    const active = orbs.positions;
    const top = this.session.arena.bounds.max.y - 0.5;
    for (const o of active) {
      if (this.orbs.some((k) => k.distanceToSquared(o) < 0.25)) continue;
      const beam = _p.copy(o).setY(Math.min(o.y + BEAM_SIGHT, top));
      if (this.canSee(o) || this.canSee(beam)) {
        this.orbs.push(o.clone());
        this.log.push({ time: now, what: 'orb', id: o.toArray().map((v) => v.toFixed(1)).join(','), how: 'sight' });
      }
    }
    // Looking at the spot (or standing in it) and nothing there: it's gone.
    const body = this.self.controller.getPosition();
    for (let i = this.orbs.length - 1; i >= 0; i--) {
      const k = this.orbs[i];
      if (!active.some((o) => o.distanceToSquared(k) < 0.25) && (k.distanceTo(body) < 1.5 || this.canSee(k))) this.orbs.splice(i, 1);
    }
  }

  private watchPortals(now: number): void {
    for (const p of this.session.system.portals) {
      const front = _p.copy(p.surfaceCenter).addScaledVector(p.normal, 0.15);
      const mine = p.owner === this.self.id;
      const known = this.portals.get(p);
      if (mine || !p.placed) {
        // Ours now (stolen), or seen to be gone.
        if (known && (mine || this.canSee(known))) this.portals.delete(p);
        continue;
      }
      const facing = p.normal.dot(_v.copy(_eye).sub(front)) > 0;
      if (facing && this.canSee(front)) {
        if (!known) this.log.push({ time: now, what: 'portal', id: `${p.owner}:${p.color}`, how: 'sight' });
        this.portals.set(p, front.clone());
      }
    }
  }

  /** Within the view cone and range (no line-of-sight check). */
  inView(point: THREE.Vector3): boolean {
    _v.copy(point).sub(_eye);
    const d = _v.length();
    if (d > this.range) return false;
    if (d < 0.5) return true;
    const z = _v.dot(_fwd);
    if (z <= 0) return false;
    return Math.atan2(Math.abs(_v.dot(_right)), z) <= this.skill.fovH && Math.atan2(Math.abs(_v.dot(_up)), z) <= this.skill.fovV;
  }

  /** In view and nothing solid in between (`target`: a collider that counts as reaching it). */
  canSee(point: THREE.Vector3, target = -1): boolean {
    return this.inView(point) && this.lineOfSight(point, target);
  }

  lineOfSight(point: THREE.Vector3, target = -1): boolean {
    const physics = this.session.physics;
    const dir = _v.copy(point).sub(_eye);
    const dist = dir.length();
    if (dist < 1e-3) return true;
    dir.divideScalar(dist);
    const own = this.self.controller.colliderHandle;
    const hit = physics.world.castRay(
      new RAPIER.Ray(_eye, dir),
      dist,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      undefined,
      undefined,
      undefined,
      (c) => c.handle !== own && physics.getOwner(c.handle)?.type !== 'portal-tunnel',
    );
    return !hit || hit.collider.handle === target || hit.timeOfImpact >= dist - 0.05;
  }
}
