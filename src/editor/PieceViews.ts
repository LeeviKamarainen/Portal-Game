import * as THREE from 'three';
import { materials, glowMaterial, type MaterialName } from '../world/Materials';
import { EFFECT_COLORS, iconTexture, type SwitchEffect } from '../world/hazards/Switch';
import { FACE_NAMES, ROOM_SIDES, TEAM_COLORS, color, faces, footprint, front, turn, type Piece, type Team } from '../world/maps/MapFormat';
import type { FaceKey } from '../world/Level';

/**
 * Stand-ins for map pieces in the editor: the same materials and proportions as in game,
 * built instantly and without physics. Solid geometry looks like the real thing (pale
 * panels where portals go); hazards are drawn with their footprint and the direction
 * they act in, since in the editor nothing moves.
 */

const BOX_FACES: FaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

const cache = new Map<string, THREE.Material>();
function cached<T extends THREE.Material>(key: string, make: () => T): T {
  let m = cache.get(key) as T | undefined;
  if (!m) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

const basic = (hex: number, opacity = 1) =>
  cached(`basic-${hex}-${opacity}`, () => new THREE.MeshBasicMaterial({ color: hex, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 }));
const glow = (hex: number, k = 1.2) => cached(`glow-${hex}-${k}`, () => glowMaterial(hex, k));
const line = (hex: number) => cached(`line-${hex}`, () => new THREE.LineBasicMaterial({ color: hex }));

/** A box spanning min..max with world-aligned UVs in metres, matching the level's texturing. */
function worldBox(min: THREE.Vector3, max: THREE.Vector3): THREE.BoxGeometry {
  const size = max.clone().sub(min);
  const g = new THREE.BoxGeometry(Math.max(size.x, 0.001), Math.max(size.y, 0.001), Math.max(size.z, 0.001));
  const center = min.clone().add(max).multiplyScalar(0.5);
  g.translate(center.x, center.y, center.z);
  const pos = g.attributes.position;
  const nrm = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    if (Math.abs(nrm.getX(i)) > 0.5) uv.setXY(i, z, y);
    else if (Math.abs(nrm.getY(i)) > 0.5) uv.setXY(i, x, z);
    else uv.setXY(i, x, y);
  }
  return g;
}

function solidMaterial(name: MaterialName, side: THREE.Side = THREE.FrontSide): THREE.Material {
  const base = materials()[name];
  if (side === THREE.FrontSide) return base;
  return cached(`${name}-back`, () => {
    const m = base.clone();
    m.side = THREE.BackSide;
    return m;
  });
}

/** Per-face materials for a box: portal faces pale, the rest the piece's material. */
function faceMaterials(p: Piece, rot: number): THREE.Material[] {
  const portal = new Set(faces(p.portal, rot));
  const hidden = new Set(faces(p.hide, rot));
  const mat = (p.material as MaterialName | undefined) ?? 'metal';
  return BOX_FACES.map((f) => {
    if (hidden.has(f)) return cached('hidden', () => new THREE.MeshBasicMaterial({ visible: false }));
    if (portal.has(f)) return solidMaterial(f === 'py' ? 'floor' : 'panel');
    return solidMaterial(mat);
  });
}

function solidBox(p: Piece): THREE.Object3D {
  const { min, max } = footprint(p);
  const mesh = new THREE.Mesh(worldBox(min, max), faceMaterials(p, p.rot ?? 0));
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** An arrow lying flat, pointing along `dir` from `from`. */
function arrow(from: THREE.Vector3, dir: THREE.Vector3, length: number, hex: number): THREE.Object3D {
  const a = new THREE.ArrowHelper(dir.clone().normalize(), from, length, hex, Math.min(0.6, length * 0.35), Math.min(0.45, length * 0.25));
  return a;
}

function flat(w: number, d: number, at: THREE.Vector3, mat: THREE.Material, lift = 0.01): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.copy(at).setY(at.y + lift);
  return m;
}

const V = (v: [number, number, number]) => new THREE.Vector3(v[0], v[1], v[2]);

/** The editor's view of one piece. Never throws: a broken piece shows as a red box. */
export function pieceView(p: Piece): THREE.Object3D {
  try {
    return build(p);
  } catch {
    const g = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), basic(0xff2030, 0.7));
    g.position.copy(V(p.at)).setY(p.at[1] + 0.5);
    g.userData.broken = true;
    return g;
  }
}

function build(p: Piece): THREE.Object3D {
  const group = new THREE.Group();
  const at = V(p.at);
  const rot = p.rot ?? 0;
  const fwd = front(rot);
  const size = p.size ?? [1, 1, 1];
  switch (p.type) {
    case 'block':
    case 'portal-wall':
    case 'wall':
    case 'floor':
      group.add(solidBox(p));
      break;
    case 'ceiling-slot': {
      const t = size[1];
      group.add(solidBox({ ...p, at: [p.at[0], p.at[1] - t, p.at[2]], portal: ['bottom'], material: 'trim' }));
      break;
    }
    case 'room': {
      const [w, h, d] = size;
      const min = new THREE.Vector3(at.x - w / 2, at.y, at.z - d / 2);
      const max = new THREE.Vector3(at.x + w / 2, at.y + h, at.z + d / 2);
      const portal = new Set<string>();
      for (const s of (p.portal as string[] | undefined) ?? []) {
        if (s === 'walls') ['north', 'south', 'east', 'west'].forEach((k) => portal.add(k));
        else portal.add(s);
      }
      const skip = new Set((p.skip as string[] | undefined) ?? []);
      // Box face order px nx py ny pz nz = east west ceiling floor south north. Drawn from
      // the inside, so from outside the near walls drop away and the room reads like a dollhouse.
      const sideOf = ['east', 'west', 'ceiling', 'floor', 'south', 'north'];
      const mats = sideOf.map((s) => {
        if (skip.has(s)) return cached('hidden', () => new THREE.MeshBasicMaterial({ visible: false }));
        return solidMaterial(portal.has(s) ? (s === 'floor' ? 'floor' : 'panel') : 'metal', THREE.BackSide);
      });
      const mesh = new THREE.Mesh(worldBox(min, max), mats);
      mesh.receiveShadow = true;
      mesh.userData.room = true;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), line(0x5d6b80));
      edges.position.copy(min.clone().add(max).multiplyScalar(0.5));
      edges.raycast = () => {};
      group.add(mesh, edges);
      break;
    }
    case 'stairs': {
      const [width, rise, run] = size;
      const steps = Math.max(1, Math.ceil(rise / 0.25));
      const base = at.clone().addScaledVector(fwd, -run / 2);
      const side = turn(new THREE.Vector3(1, 0, 0), rot);
      for (let i = 0; i < steps; i++) {
        const a = base.clone().addScaledVector(fwd, (i * run) / steps);
        const b = base.clone().addScaledVector(fwd, ((i + 1) * run) / steps);
        const h = at.y + ((i + 1) * rise) / steps;
        const c1 = a.clone().addScaledVector(side, width / 2);
        const c2 = b.clone().addScaledVector(side, -width / 2);
        const min = new THREE.Vector3(Math.min(c1.x, c2.x), at.y, Math.min(c1.z, c2.z));
        const max = new THREE.Vector3(Math.max(c1.x, c2.x), h, Math.max(c1.z, c2.z));
        group.add(new THREE.Mesh(worldBox(min, max), solidMaterial('metal')));
      }
      break;
    }
    case 'acid': {
      const { min, max } = footprint(p);
      group.add(flat(max.x - min.x, max.z - min.z, at.clone().set((min.x + max.x) / 2, at.y, (min.z + max.z) / 2), basic(0x48e83a, 0.8), 0));
      break;
    }
    case 'spikes': {
      const { min, max } = footprint(p);
      const w = max.x - min.x;
      const d = max.z - min.z;
      group.add(flat(w + 0.5, d + 0.5, at, solidMaterial('hazard'), 0.004));
      group.add(flat(w, d, at, basic(0x15171b), 0.006));
      const nx = Math.max(1, Math.min(12, Math.floor(w / 0.5)));
      const nz = Math.max(1, Math.min(12, Math.floor(d / 0.5)));
      const out = p.mode === 'static' ? 0.7 : 0.35;
      const cone = new THREE.ConeGeometry(0.1, out, 6);
      cone.translate(0, out / 2, 0);
      const spikes = new THREE.InstancedMesh(cone, cached('steel', () => new THREE.MeshStandardMaterial({ color: 0xb8c0cc, metalness: 0.85, roughness: 0.3 })), nx * nz);
      const m = new THREE.Matrix4();
      let i = 0;
      for (let ix = 0; ix < nx; ix++) {
        for (let iz = 0; iz < nz; iz++) {
          m.makeTranslation(min.x + ((ix + 0.5) * w) / nx, at.y, min.z + ((iz + 0.5) * d) / nz);
          spikes.setMatrixAt(i++, m);
        }
      }
      group.add(spikes);
      break;
    }
    case 'trapdoor': {
      const { min, max } = footprint({ ...p, at: [p.at[0], p.at[1] - size[1], p.at[2]] });
      group.add(new THREE.Mesh(worldBox(min, max), solidMaterial('metal')));
      group.add(flat(0.3, max.z - min.z, new THREE.Vector3(min.x + 0.17, at.y, at.z), solidMaterial('hazard')));
      group.add(flat(0.3, max.z - min.z, new THREE.Vector3(max.x - 0.17, at.y, at.z), solidMaterial('hazard')));
      group.add(flat(0.1, max.z - min.z, at, glow(0xffa020)));
      group.add(arrow(at.clone().setY(at.y - 0.2), new THREE.Vector3(0, -1, 0), 1.5, 0xffa020));
      break;
    }
    case 'crusher': {
      const { min, max } = footprint(p);
      const top = at.y + size[1];
      group.add(new THREE.Mesh(worldBox(new THREE.Vector3(min.x, top, min.z), new THREE.Vector3(max.x, top + 1.6, max.z)), solidMaterial('metal')));
      group.add(flat(max.x - min.x + 0.6, max.z - min.z + 0.6, at, solidMaterial('hazard'), 0.006));
      group.add(arrow(new THREE.Vector3(at.x, top - 0.1, at.z), new THREE.Vector3(0, -1, 0), Math.max(0.5, size[1] - 0.2), 0xff4020));
      break;
    }
    case 'ram': {
      const [w, h, t] = size;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), fwd);
      const head = new THREE.Mesh(new THREE.BoxGeometry(w, h, t), solidMaterial('hazard'));
      head.position.copy(at).addScaledVector(fwd, t / 2);
      head.quaternion.copy(q);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, h + 0.3, 0.7), solidMaterial('trim'));
      housing.position.copy(at).addScaledVector(fwd, -0.35);
      housing.quaternion.copy(q);
      const reach = typeof p.reach === 'number' ? p.reach : 3;
      const sweep = new THREE.Mesh(new THREE.BoxGeometry(w, h, reach), basic(0xffa020, 0.18));
      sweep.position.copy(at).addScaledVector(fwd, t + reach / 2);
      sweep.quaternion.copy(q);
      sweep.raycast = () => {};
      group.add(housing, head, sweep, arrow(at.clone().addScaledVector(fwd, t), fwd, reach, 0xffa020));
      break;
    }
    case 'laser': {
      const pitch = ((typeof p.pitch === 'number' ? p.pitch : 0) * Math.PI) / 180;
      const dir = fwd.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch));
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.9), solidMaterial('trim'));
      head.position.copy(at).addScaledVector(dir, -0.45);
      head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir);
      const beam = new THREE.Line(new THREE.BufferGeometry().setFromPoints([at, at.clone().addScaledVector(dir, 10)]), line(0xff2a1a));
      beam.raycast = () => {};
      group.add(head, beam);
      break;
    }
    case 'platform': {
      const { min, max } = footprint(p);
      const s = max.clone().sub(min);
      const slab = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), solidMaterial('metal'));
      slab.position.copy(at);
      group.add(slab);
      const to = Array.isArray(p.to) ? V(p.to as [number, number, number]) : at.clone().setZ(at.z - 8);
      const ghost = new THREE.Mesh(new THREE.BoxGeometry(s.x, s.y, s.z), basic(0x40c0ff, 0.25));
      ghost.position.copy(to);
      ghost.raycast = () => {};
      const path = new THREE.Line(new THREE.BufferGeometry().setFromPoints([at, to]), line(0x40c0ff));
      path.raycast = () => {};
      group.add(ghost, path);
      break;
    }
    case 'dropper': {
      const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.3, 0.8), glow(0xff3020, 1));
      lamp.position.copy(at);
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), basic(0xc8a040, 0.5));
      crate.position.copy(at).setY(at.y - 0.6);
      group.add(lamp, crate, arrow(at.clone().setY(at.y - 1.1), new THREE.Vector3(0, -1, 0), 2, 0xff3020));
      break;
    }
    case 'switch': {
      const effect = (p.effect as SwitchEffect | undefined) ?? 'trigger';
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 0.35), solidMaterial('trim'));
      housing.position.copy(at).addScaledVector(fwd, 0.175);
      housing.quaternion.copy(q);
      const face = new THREE.Mesh(
        new THREE.CircleGeometry(0.42, 32),
        cached(`icon-${effect}`, () => new THREE.MeshBasicMaterial({ map: iconTexture(effect) })),
      );
      face.position.copy(at).addScaledVector(fwd, 0.36);
      face.quaternion.copy(q);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.44, 0.52, 32), glow(EFFECT_COLORS[effect]));
      ring.position.copy(face.position).addScaledVector(fwd, 0.002);
      ring.quaternion.copy(q);
      group.add(housing, face, ring);
      break;
    }
    case 'receiver': {
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.4, 24), glow(0x30ff70, 0.9));
      lens.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), fwd);
      lens.position.copy(at);
      group.add(lens);
      break;
    }
    case 'door': {
      const { min, max } = footprint(p);
      group.add(new THREE.Mesh(worldBox(min, max), basic(0xd07030, 0.55)));
      break;
    }
    case 'target': {
      const r = typeof p.radius === 'number' ? p.radius : 1.3;
      const ring = new THREE.Mesh(new THREE.RingGeometry(r * 0.42, r * 0.5, 32), glow(0x30ff70));
      ring.position.copy(at).addScaledVector(fwd, 0.02);
      ring.lookAt(at.clone().addScaledVector(fwd, 1));
      group.add(ring);
      break;
    }
    case 'crate': {
      const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.8, 0.8), cached('crate', () => new THREE.MeshStandardMaterial({ color: 0xc8a040, roughness: 0.6 })));
      crate.position.copy(at);
      group.add(crate);
      break;
    }
    case 'spawn': {
      const team = (p.team as Team | undefined) ?? 'orange';
      const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 0.08, 32), glow(TEAM_COLORS[team], 0.9));
      pad.position.copy(at).setY(at.y + 0.04);
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.4, 1.2, 4, 12), basic(TEAM_COLORS[team], 0.35));
      body.position.copy(at).setY(at.y + 1);
      group.add(pad, body, arrow(at.clone().setY(at.y + 0.15), fwd, 1.6, TEAM_COLORS[team]));
      break;
    }
    case 'goal': {
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 0.1, 32), glow(0x40ffd0, 0.9));
      ring.position.copy(at).setY(at.y + 0.05);
      const column = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 4, 24, 1, true), basic(0x40ffd0, 0.25));
      column.position.copy(at).setY(at.y + 2);
      group.add(ring, column);
      break;
    }
    case 'lights': {
      const { min, max } = footprint(p);
      const spacing = typeof p.spacing === 'number' && p.spacing > 0 ? p.spacing : 6;
      const c = color(p.color, 0xdfe8ff);
      for (let x = min.x + spacing / 2; x < max.x; x += spacing) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, Math.max(0.1, max.z - min.z - 2)), glow(c, 1));
        strip.position.set(x, at.y - 0.04, (min.z + max.z) / 2);
        group.add(strip);
      }
      break;
    }
    case 'strip': {
      const team = p.team as Team | undefined;
      const c = team ? TEAM_COLORS[team] : color(p.color, 0xdfe8ff);
      const half = turn(new THREE.Vector3(1, 0, 0), rot).multiplyScalar(size[0] / 2);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, Math.max(size[0], 0.1)), glow(c, 1));
      strip.position.copy(at);
      strip.lookAt(at.clone().add(half));
      group.add(strip);
      break;
    }
    default:
      throw new Error(`no view for ${p.type}`);
  }
  return group;
}

/** Faces a piece can name, for the inspector. */
export { FACE_NAMES, ROOM_SIDES };
