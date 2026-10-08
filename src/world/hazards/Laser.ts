import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Level } from '../Level';
import { glowMaterial, materials } from '../Materials';
import { RECESS_DEPTH, type Portal } from '../../portals/Portal';
import { computePortalRelativeMatrix } from '../../portals/PortalMath';
import type { Hazard, HazardContext } from './Hazard';
import type { PlayerController } from '../../player/PlayerController';

const MAX_SEGMENTS = 8;
const MAX_RANGE = 160;
const BEAM_COLOR = 0xff2a1a;
/** Lethal in well under a second, but not instantly - the burn flash is the warning. */
const DAMAGE_PER_SECOND = 140;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _l = new THREE.Vector3();
const _ld = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

/** Something a beam can switch on (see Door). */
export class LaserReceiver implements Hazard {
  readonly colliderHandle: number;
  readonly position: THREE.Vector3;
  powered = false;
  private hitThisStep = false;
  private readonly lens: THREE.MeshBasicMaterial;
  private readonly glow: THREE.PointLight;
  private charge = 0;

  constructor(level: Level, position: THREE.Vector3, facing: THREE.Vector3) {
    this.position = position.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), facing.clone().normalize());
    const group = new THREE.Group();
    group.position.copy(position);
    group.quaternion.copy(q);
    const housing = new THREE.Mesh(level.own(new THREE.BoxGeometry(1.0, 1.0, 0.5)), materials().trim);
    housing.castShadow = true;
    this.lens = level.own(glowMaterial(0x30ff70, 0.4));
    const lens = new THREE.Mesh(level.own(new THREE.CylinderGeometry(0.32, 0.32, 0.12, 24)), this.lens);
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.28;
    const ring = new THREE.Mesh(level.own(new THREE.TorusGeometry(0.4, 0.05, 8, 28)), materials().hazard);
    ring.position.z = 0.27;
    this.glow = new THREE.PointLight(0x30ff70, 0, 6, 1.5);
    this.glow.position.z = 0.8;
    group.add(housing, lens, ring, this.glow);
    level.scene.add(group);
    level.addBlocker(housing);

    const body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z).setRotation(q),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.25), body);
    level.physics.registerOwner(c.handle, { type: 'receiver', ref: this });
    this.colliderHandle = c.handle;
  }

  hit(): void {
    this.hitThisStep = true;
  }

  update(dt: number): void {
    // A short charge-up so a beam flickering across it does not toggle doors.
    this.charge = THREE.MathUtils.clamp(this.charge + (this.hitThisStep ? dt * 4 : -dt * 3), 0, 1);
    this.powered = this.charge >= 1 || (this.powered && this.charge > 0.3);
    this.hitThisStep = false;
    const k = this.powered ? 2 : 0.4 + this.charge * 1.1;
    this.lens.color.setRGB(0.19 * k, 1.0 * k, 0.44 * k);
    this.glow.intensity = this.powered ? 1.8 : this.charge * 0.6;
  }

  reset(): void {
    this.charge = 0;
    this.powered = false;
  }
}

interface Segment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

/**
 * A beam emitter. The beam is traced every step: it is stopped by solid geometry, boxes and
 * the player (who it burns), lights up any receiver it reaches, and when it strikes a
 * portal's opening it carries on out of the other portal.
 */
export class LaserEmitter implements Hazard {
  readonly segments: Segment[] = [];
  private readonly origin: THREE.Vector3;
  private readonly baseDir: THREE.Vector3;
  private readonly dir = new THREE.Vector3();
  private readonly sweep: { axis: THREE.Vector3; angle: number; period: number } | null;
  private readonly beams: THREE.Mesh[] = [];
  private readonly glows: THREE.Mesh[] = [];
  private readonly impact: THREE.Mesh;
  private readonly impactLight: THREE.PointLight;
  private readonly emitterCollider: number;
  private readonly head: THREE.Group;
  private time = 0;

  constructor(
    level: Level,
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    sweep?: { axis: THREE.Vector3; angle: number; period: number },
  ) {
    this.origin = origin.clone();
    this.baseDir = direction.clone().normalize();
    this.dir.copy(this.baseDir);
    this.sweep = sweep ?? null;

    this.head = new THREE.Group();
    this.head.position.copy(origin);
    const housing = new THREE.Mesh(level.own(new THREE.BoxGeometry(0.7, 0.7, 0.9)), materials().trim);
    housing.position.z = 0.45;
    housing.castShadow = true;
    const stripe = new THREE.Mesh(level.own(new THREE.BoxGeometry(0.72, 0.16, 0.92)), materials().hazard);
    stripe.position.z = 0.45;
    const lens = new THREE.Mesh(level.own(new THREE.CylinderGeometry(0.16, 0.2, 0.1, 18)), level.own(glowMaterial(BEAM_COLOR, 2.2)));
    lens.rotation.x = Math.PI / 2;
    lens.position.z = -0.02;
    this.head.add(housing, stripe, lens);
    this.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.baseDir);
    level.scene.add(this.head);
    level.addBlocker(housing);

    const body = level.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(origin.x, origin.y, origin.z)
        .setRotation(this.head.quaternion),
    );
    const c = level.physics.world.createCollider(RAPIER.ColliderDesc.cuboid(0.35, 0.35, 0.45).setTranslation(0, 0, 0.45), body);
    level.physics.registerOwner(c.handle, { type: 'hazard', ref: this });
    this.emitterCollider = c.handle;

    const core = level.own(glowMaterial(BEAM_COLOR, 2.6));
    const halo = level.own(
      glowMaterial(BEAM_COLOR, 0.9, { transparent: true, opacity: 0.22, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    const coreGeo = level.own(new THREE.CylinderGeometry(0.022, 0.022, 1, 8, 1, true));
    const haloGeo = level.own(new THREE.CylinderGeometry(0.08, 0.08, 1, 10, 1, true));
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const b = new THREE.Mesh(coreGeo, core);
      const g = new THREE.Mesh(haloGeo, halo);
      b.visible = g.visible = false;
      b.frustumCulled = g.frustumCulled = false;
      this.beams.push(b);
      this.glows.push(g);
      level.scene.add(b, g);
    }
    this.impact = new THREE.Mesh(level.own(new THREE.SphereGeometry(0.09, 12, 8)), core);
    this.impactLight = new THREE.PointLight(BEAM_COLOR, 1.4, 4, 1.6);
    level.scene.add(this.impact, this.impactLight);
  }

  update(dt: number, ctx: HazardContext): void {
    this.time += dt;
    if (this.sweep) {
      const a = Math.sin((this.time / this.sweep.period) * Math.PI * 2) * this.sweep.angle;
      this.dir.copy(this.baseDir).applyAxisAngle(this.sweep.axis, a);
      this.head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), this.dir);
    }
    this.trace(dt, ctx);
    this.draw();
  }

  private trace(dt: number, ctx: HazardContext): void {
    this.segments.length = 0;
    const world = ctx.physics.world;
    const origin = this.origin.clone().addScaledVector(this.dir, 0.02);
    const dir = this.dir.clone();
    let ignore = -1;
    let credit: string | null = null;
    const portals = ctx.portals.portals;

    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const skip = ignore;
      ignore = -1;
      const hit = world.castRay(
        new RAPIER.Ray(origin, dir),
        MAX_RANGE,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        (c) => {
          if (c.handle === this.emitterCollider || c.handle === skip) return false;
          return ctx.physics.getOwner(c.handle)?.type !== 'portal-tunnel';
        },
      );
      if (!hit) {
        this.segments.push({ from: origin.clone(), to: origin.clone().addScaledVector(dir, MAX_RANGE) });
        return;
      }
      const point = origin.clone().addScaledVector(dir, hit.timeOfImpact);
      const handle = hit.collider.handle;

      const portal = portals.find((p) => p.isOpen && p.hostCollider === handle && dir.dot(p.normal) < -0.01) as Portal | undefined;
      if (portal) {
        // Follow the beam down the recess to the window; if it gets there inside the
        // opening it continues out of the partner portal.
        portal.toLocal(point, _l);
        if (portal.inAperture(_l, 0)) {
          const along = RECESS_DEPTH / -dir.dot(portal.normal);
          const windowPoint = point.clone().addScaledVector(dir, along);
          portal.toLocal(windowPoint, _ld);
          if (portal.inAperture(_ld, 0)) {
            this.segments.push({ from: origin.clone(), to: windowPoint.clone() });
            computePortalRelativeMatrix(portal, portal.linked!, _m);
            _q.setFromRotationMatrix(_m);
            origin.copy(windowPoint).applyMatrix4(_m);
            dir.applyQuaternion(_q).normalize();
            origin.addScaledVector(dir, 0.01);
            ignore = portal.linked!.hostCollider;
            credit = portal.owner;
            continue;
          }
          // Grazed the inside of the recess.
          this.segments.push({ from: origin.clone(), to: windowPoint });
          return;
        }
      }

      this.segments.push({ from: origin.clone(), to: point });
      const owner = ctx.physics.getOwner(handle);
      if (owner?.type === 'player') ctx.hurtPlayer(owner.ref as PlayerController, DAMAGE_PER_SECOND * dt, credit);
      else if (owner?.type === 'receiver') (owner.ref as LaserReceiver).hit();
      return;
    }
  }

  /** Distance from `p` to the nearest point of the beam (the hum gets louder near it). */
  distanceTo(p: THREE.Vector3): number {
    let nearest = Infinity;
    for (const s of this.segments) nearest = Math.min(nearest, distanceToSegment(p, s.from, s.to));
    return nearest;
  }

  private draw(): void {
    const flicker = 1 + Math.sin(this.time * 60) * 0.08;
    for (let i = 0; i < MAX_SEGMENTS; i++) {
      const s = this.segments[i];
      const b = this.beams[i];
      const g = this.glows[i];
      if (!s) {
        b.visible = g.visible = false;
        continue;
      }
      const d = s.to.clone().sub(s.from);
      const len = Math.max(d.length(), 0.001);
      d.divideScalar(len);
      for (const m of [b, g]) {
        m.visible = true;
        m.position.copy(s.from).addScaledVector(d, len / 2);
        m.quaternion.setFromUnitVectors(Y, d);
        m.scale.set(m === g ? flicker : 1, len, m === g ? flicker : 1);
      }
    }
    const last = this.segments[this.segments.length - 1];
    if (last) {
      this.impact.position.copy(last.to);
      this.impact.scale.setScalar(0.8 + Math.random() * 0.6);
      this.impactLight.position.copy(last.to);
    }
  }
}

function distanceToSegment(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const ab = b.clone().sub(a);
  const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9), 0, 1);
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}
