import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PortalTestAdapter, PortalColor, EntityKind, TestEntity } from './PortalTests';
import type { Game } from '../game/Game';
import type { PortalTraversable } from '../portals/PortalTraversable';
import { PORTAL_HALF_H, PORTAL_HALF_W, PORTAL_HEIGHT, PORTAL_WIDTH, TUNNEL_DEPTH } from '../portals/Portal';
import { computePortalRelativeMatrix } from '../portals/PortalMath';
import { PLAYER_HALF_HEIGHT, PLAYER_RADIUS } from '../player/PlayerController';
import { BOX_HALF } from '../world/hazards/PropBox';

const SHRINK = 0.06;

/** Implements the portal test harness against the current game. */
export function makeGameAdapter(game: Game): PortalTestAdapter {
  const s = () => game.session!;
  const speeds: Record<EntityKind, Array<{ before: number; after: number }>> = { player: [], box: [] };
  const system = game.session!.system;
  const prevHook = system.onTeleport;
  system.onTeleport = (e) => {
    prevHook?.(e);
    speeds[e.entity.kind === 'player' ? 'player' : 'box'].push({ before: e.speedIn, after: e.speedOut });
  };
  const world = () => s().physics.world;
  const ownerType = (h: number) => s().physics.getOwner(h)?.type;
  const portal = (c: PortalColor) => s().portals[c];
  const box = () => s().arena.props[0];
  const entityFor = (kind: EntityKind): PortalTraversable => (kind === 'player' ? s().player : box());
  const name = (h: number) => ownerType(h) ?? `collider${h}`;

  /** Hosts of open portals do not count as solid inside their opening's tunnel. */
  const insideOpening = (handle: number, p: THREE.Vector3) => {
    for (const c of ['orange', 'blue'] as const) {
      const pt = portal(c);
      if (!pt.isOpen || pt.hostCollider !== handle) continue;
      const l = pt.toLocal(p);
      if (pt.inAperture(l, 0) && l.z > -TUNNEL_DEPTH) return true;
    }
    return false;
  };

  const wrapEntity = (kind: EntityKind): TestEntity => ({
    getPosition: () => entityFor(kind).getPosition(),
    getVelocity: () => entityFor(kind).getVelocity(),
    setPosition: (p) => {
      if (kind === 'player') s().player.setPosition(p);
      else box().respawnAt(p);
      s().system.resync(entityFor(kind));
    },
    setVelocity: (v) => {
      if (kind === 'player') s().player.setVelocity(v);
      else box().setVelocity(v);
    },
  });

  return {
    label: 'reworked',
    portalSize: { width: PORTAL_WIDTH, height: PORTAL_HEIGHT },
    reset() {
      portal('orange').unplace();
      portal('blue').unplace();
      const a = s().arena;
      s().player.respawn(a.spawn, a.spawnYaw);
      s().player.setInvulnerableFor(1e9);
      box().respawnAt(new THREE.Vector3(10, 0.42, -10));
      s().system.resync(s().player);
      s().system.resync(box());
      game.input.setScriptedKeys([]);
      // One step so the new poses are in the broad phase.
      game.step(1 / 60);
    },
    placePortal(color, point, normal, up) {
      const face = s().level.faces.find((f) => {
        if (!f.portalable || f.normal.dot(normal) < 0.99) return false;
        const l = f.toLocal(point);
        return Math.abs(l.z) < 0.01 && Math.abs(l.x) <= f.width / 2 && Math.abs(l.y) <= f.height / 2;
      });
      if (!face) throw new Error(`No portalable face at ${point.toArray()}`);
      const u = (up ?? new THREE.Vector3(0, 1, 0)).clone().addScaledVector(normal, -(up ?? new THREE.Vector3(0, 1, 0)).dot(normal)).normalize();
      const right = new THREE.Vector3().crossVectors(u, normal).normalize();
      portal(color).place(s().physics, face, point.clone(), right, u);
    },
    firePortal(color, eye, dir) {
      s().gun.fire(color, eye, dir);
    },
    portalPlaced: (c) => portal(c).placed,
    portalFrame(c) {
      const p = portal(c);
      return { center: p.surfaceCenter.clone(), normal: p.normal.clone(), right: p.right.clone(), up: p.up.clone() };
    },
    relativeMatrix(from) {
      const p = portal(from);
      return computePortalRelativeMatrix(p, p.linked!);
    },
    player: {
      ...wrapEntity('player'),
      setLook: (yaw, pitch) => s().player.setLook(yaw, pitch),
      setKeys: (keys) => game.input.setScriptedKeys(keys),
      cameraPosition: () => game.engine.camera.position.clone(),
      cameraQuaternion: () => game.engine.camera.quaternion.clone(),
    },
    box: wrapEntity('box'),
    teleportCount: (kind) => s().system.teleportCount(entityFor(kind)),
    teleportSpeeds: (kind) => speeds[kind],
    step: (dt) => game.step(dt),
    render: () => game.renderNow(),
    renderer: game.engine.renderer,
    setDebugBackground(color) {
      s().scene.background = new THREE.Color(color ?? s().arena.fog.color);
    },
    overlaps(kind) {
      const e = entityFor(kind);
      const pos = e.getPosition();
      let shape: RAPIER.Shape;
      let rot = { x: 0, y: 0, z: 0, w: 1 };
      if (kind === 'player') {
        shape = new RAPIER.Capsule(PLAYER_HALF_HEIGHT - SHRINK, PLAYER_RADIUS - SHRINK);
      } else {
        shape = new RAPIER.Cuboid(BOX_HALF - SHRINK, BOX_HALF - SHRINK, BOX_HALF - SHRINK);
        rot = box().mesh.quaternion;
      }
      const hits: string[] = [];
      world().intersectionsWithShape(pos, rot, shape, (c) => {
        const t = ownerType(c.handle);
        if (!c.isSensor() && t !== 'player' && t !== 'prop' && s().system.allows(e, c.handle)) hits.push(name(c.handle));
        return true;
      });
      return hits;
    },
    pointInSolid(p) {
      let inside = false;
      world().intersectionsWithShape(p, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Ball(0.005), (c) => {
        const t = ownerType(c.handle);
        if (c.isSensor() || t === 'player' || t === 'prop') return true;
        if (t === 'portal-tunnel' && !s().system.allows(s().player, c.handle)) return true;
        if (insideOpening(c.handle, p)) return true;
        inside = true;
        return false;
      });
      return inside;
    },
    insidePortalTunnel(p) {
      for (const c of ['orange', 'blue'] as const) {
        const pt = portal(c);
        if (!pt.isOpen) continue;
        const l = pt.toLocal(p);
        if (pt.inAperture(l, 0) && l.z > -TUNNEL_DEPTH && l.z < 0.5) return true;
      }
      return false;
    },
    apertureBlocked(color) {
      const p = portal(color);
      const center = p.surfaceCenter.clone().addScaledVector(p.normal, 0.4);
      const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(p.right, p.up, p.normal));
      const hits: string[] = [];
      world().intersectionsWithShape(center, q, new RAPIER.Cuboid(PORTAL_HALF_W - 0.05, PORTAL_HALF_H - 0.05, 0.25), (c) => {
        const t = ownerType(c.handle);
        if (!c.isSensor() && t !== 'player' && t !== 'prop' && t !== 'portal-tunnel' && c.handle !== p.hostCollider) hits.push(name(c.handle));
        return true;
      });
      return hits;
    },
    lineClear(a, b) {
      const dir = b.clone().sub(a);
      const len = dir.length();
      const hit = world().castRay(new RAPIER.Ray(a, dir.normalize()), len, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, undefined, undefined, (c) => {
        const t = ownerType(c.handle);
        return t !== 'player' && t !== 'prop' && t !== 'portal-tunnel';
      });
      return hit === null;
    },
  };
}
