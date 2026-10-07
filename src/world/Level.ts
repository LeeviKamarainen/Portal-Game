import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { materials, type MaterialName } from './Materials';

/**
 * Static level geometry: axis-aligned solid boxes, each with one cuboid collider and up to
 * six visual faces.
 *
 * Faces that accept portals are kept as individual meshes so a portal can cut its opening
 * into one (see `Face.setHole`); every other face is merged per material into a handful of
 * static meshes to keep draw calls low across the several portal-view renders per frame.
 * Each face also has an invisible full-size raycast proxy, so the portal gun still sees a
 * surface where a hole has been cut.
 */

export type FaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
const ALL_FACES: FaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

const FACE_NORMALS: Record<FaceKey, THREE.Vector3> = {
  px: new THREE.Vector3(1, 0, 0),
  nx: new THREE.Vector3(-1, 0, 0),
  py: new THREE.Vector3(0, 1, 0),
  ny: new THREE.Vector3(0, -1, 0),
  pz: new THREE.Vector3(0, 0, 1),
  nz: new THREE.Vector3(0, 0, -1),
};

export interface Solid {
  collider: RAPIER.Collider;
  faces: Face[];
  min: THREE.Vector3;
  max: THREE.Vector3;
}

export class Face {
  readonly center: THREE.Vector3;
  readonly normal: THREE.Vector3;
  readonly right: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly width: number;
  readonly height: number;
  readonly portalable: boolean;
  readonly solid: Solid;
  readonly proxy: THREE.Mesh;
  /** Present only for portalable faces; others live in the merged static meshes. */
  mesh: THREE.Mesh | null = null;
  private readonly holes = new Map<object, THREE.Vector2[]>();

  constructor(
    solid: Solid,
    center: THREE.Vector3,
    normal: THREE.Vector3,
    width: number,
    height: number,
    portalable: boolean,
  ) {
    this.solid = solid;
    this.center = center;
    this.normal = normal;
    this.up = Math.abs(normal.y) > 0.5 ? new THREE.Vector3(0, 0, normal.y > 0 ? -1 : 1) : new THREE.Vector3(0, 1, 0);
    this.right = new THREE.Vector3().crossVectors(this.up, normal).normalize();
    this.width = width;
    this.height = height;
    this.portalable = portalable;

    this.proxy = new THREE.Mesh(new THREE.PlaneGeometry(width, height));
    this.proxy.matrixAutoUpdate = false;
    this.proxy.matrix.makeBasis(this.right, this.up, this.normal).setPosition(center);
    this.proxy.matrixWorld.copy(this.proxy.matrix);
    this.proxy.visible = false;
    this.proxy.userData.face = this;
  }

  /** World point -> face-local (x along right, y along up, z along normal). */
  toLocal(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    const d = p.clone().sub(this.center);
    return out.set(d.dot(this.right), d.dot(this.up), d.dot(this.normal));
  }

  toWorld(x: number, y: number, z = 0, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.center).addScaledVector(this.right, x).addScaledVector(this.up, y).addScaledVector(this.normal, z);
  }

  /** Builds the face's triangles in world space, with an opening per hole outline. */
  buildGeometry(): THREE.BufferGeometry {
    const hw = this.width / 2;
    const hh = this.height / 2;
    const shape = new THREE.Shape([
      new THREE.Vector2(-hw, -hh),
      new THREE.Vector2(hw, -hh),
      new THREE.Vector2(hw, hh),
      new THREE.Vector2(-hw, hh),
    ]);
    for (const outline of this.holes.values()) shape.holes.push(new THREE.Path(outline));
    const geo = new THREE.ShapeGeometry(shape, 1);

    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const normals = new Float32Array(pos.count * 3);
    const u0 = this.center.dot(this.right);
    const v0 = this.center.dot(this.up);
    const p = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      this.toWorld(x, y, 0, p);
      pos.setXYZ(i, p.x, p.y, p.z);
      // World-aligned texture coordinates: tiles line up across neighbouring faces.
      uv.setXY(i, u0 + x, v0 + y);
      normals[i * 3] = this.normal.x;
      normals[i * 3 + 1] = this.normal.y;
      normals[i * 3 + 2] = this.normal.z;
    }
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.computeBoundingSphere();
    return geo;
  }

  /** Cut (or with `null`, close) the opening owned by `key`, given in face-local coords. */
  setHole(key: object, outline: THREE.Vector2[] | null): void {
    if (outline) this.holes.set(key, outline);
    else this.holes.delete(key);
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry();
  }
}

export type RoomSide = 'floor' | 'ceiling' | 'north' | 'south' | 'east' | 'west';

export interface BoxOptions {
  /** Which faces accept portals (`true` = all emitted faces). */
  portalable?: boolean | FaceKey[];
  /** Faces to give visuals at all (hidden ones still collide). Default: all six. */
  faces?: FaceKey[];
  /** Material for non-portalable faces. */
  material?: MaterialName;
  /** Material for portalable faces (default: floor for upward faces, panel otherwise). */
  portalMaterial?: MaterialName;
  castShadow?: boolean;
}

export class Level {
  readonly scene: THREE.Scene;
  readonly physics: PhysicsWorld;
  readonly solids: Solid[] = [];
  readonly faces: Face[] = [];
  /** Everything the portal gun's ray can hit; userData.face set on surfaces. */
  readonly raycastTargets: THREE.Object3D[] = [];
  private readonly faceByCollider = new Map<number, Solid>();
  private readonly staticBatches = new Map<string, THREE.BufferGeometry[]>();
  private readonly owned: Array<{ dispose(): void }> = [];

  constructor(scene: THREE.Scene, physics: PhysicsWorld) {
    this.scene = scene;
    this.physics = physics;
  }

  solidOf(colliderHandle: number): Solid | undefined {
    return this.faceByCollider.get(colliderHandle);
  }

  /** An axis-aligned solid block, given by its min and max corners. */
  box(min: THREE.Vector3, max: THREE.Vector3, opts: BoxOptions = {}): Solid {
    const size = max.clone().sub(min);
    const center = min.clone().add(max).multiplyScalar(0.5);
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, center.y, center.z));
    const collider = this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setFriction(0.8),
      body,
    );
    const solid: Solid = { collider, faces: [], min: min.clone(), max: max.clone() };
    this.physics.registerOwner(collider.handle, { type: 'solid', ref: solid });
    this.faceByCollider.set(collider.handle, solid);
    this.solids.push(solid);

    const emit = opts.faces ?? ALL_FACES;
    const portalFaces = opts.portalable === true ? ALL_FACES : opts.portalable === false || !opts.portalable ? [] : opts.portalable;
    const castShadow = opts.castShadow ?? true;
    const mats = materials();

    for (const key of emit) {
      const n = FACE_NORMALS[key];
      const axis = key[1] as 'x' | 'y' | 'z';
      const faceCenter = center.clone().addScaledVector(n, size[axis] / 2);
      const [w, h] = axis === 'x' ? [size.z, size.y] : axis === 'y' ? [size.x, size.z] : [size.x, size.y];
      const portalable = portalFaces.includes(key);
      const face = new Face(solid, faceCenter, n.clone(), w, h, portalable);
      solid.faces.push(face);
      this.faces.push(face);
      this.raycastTargets.push(face.proxy);

      if (portalable) {
        const matName = opts.portalMaterial ?? (key === 'py' ? 'floor' : 'panel');
        const mesh = new THREE.Mesh(face.buildGeometry(), mats[matName]);
        mesh.receiveShadow = true;
        mesh.castShadow = castShadow;
        face.mesh = mesh;
        this.scene.add(mesh);
      } else {
        const matName = opts.material ?? 'metal';
        const batchKey = `${matName}|${castShadow ? 1 : 0}`;
        if (!this.staticBatches.has(batchKey)) this.staticBatches.set(batchKey, []);
        this.staticBatches.get(batchKey)!.push(face.buildGeometry());
      }
    }
    return solid;
  }

  /** A closed room shell (walls 1 m thick) around the interior box. Only inner faces are drawn. */
  room(
    min: THREE.Vector3,
    max: THREE.Vector3,
    opts: {
      portalable?: Partial<Record<RoomSide, boolean>>;
      /** Sides the caller builds itself (e.g. a floor with a pit in it). */
      skip?: RoomSide[];
    } = {},
  ): void {
    const t = 1;
    const p = opts.portalable ?? {};
    const sides: RoomSide[] = ['floor', 'ceiling', 'north', 'south', 'west', 'east'];
    let i = 0;
    const shell = (a: THREE.Vector3, b: THREE.Vector3, face: FaceKey, portalable: boolean | undefined) => {
      const side = sides[i++];
      if (opts.skip?.includes(side)) return;
      this.box(a, b, { faces: [face], portalable: portalable ? [face] : false, castShadow: false });
    };
    // Every slab covers exactly the interior span of its face, so a face never extends into
    // a neighbouring wall and a portal clamped to a face can never poke into one.
    shell(new THREE.Vector3(min.x, min.y - t, min.z), new THREE.Vector3(max.x, min.y, max.z), 'py', p.floor);
    shell(new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(max.x, max.y + t, max.z), 'ny', p.ceiling);
    shell(new THREE.Vector3(min.x, min.y, min.z - t), new THREE.Vector3(max.x, max.y, min.z), 'pz', p.north);
    shell(new THREE.Vector3(min.x, min.y, max.z), new THREE.Vector3(max.x, max.y, max.z + t), 'nz', p.south);
    shell(new THREE.Vector3(min.x - t, min.y, min.z), new THREE.Vector3(min.x, max.y, max.z), 'px', p.west);
    shell(new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x + t, max.y, max.z), 'nx', p.east);
  }

  /** Keeps a mesh/material/geometry alive for the level's lifetime and frees it with the level. */
  own<T extends { dispose(): void }>(resource: T): T {
    this.owned.push(resource);
    return resource;
  }

  /** Something solid but not a surface (hazard housings, doors): it blocks portal shots. */
  addBlocker(object: THREE.Object3D): void {
    object.updateMatrixWorld(true);
    this.raycastTargets.push(object);
  }

  /** Something a portal shot sets off instead of opening a portal on (see Switch). */
  addInteractable(object: THREE.Object3D, ref: unknown): void {
    object.userData.interactable = ref;
    this.addBlocker(object);
  }

  /** Merges all non-portalable faces into a few static meshes. Call once after building. */
  finalize(): void {
    const mats = materials();
    for (const [key, geos] of this.staticBatches) {
      const [matName, cast] = key.split('|');
      const merged = mergeGeometries(geos);
      geos.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mats[matName as MaterialName]);
      mesh.receiveShadow = true;
      mesh.castShadow = cast === '1';
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.owned.push(merged);
    }
    this.staticBatches.clear();
  }

  dispose(): void {
    for (const f of this.faces) {
      f.mesh?.geometry.dispose();
      f.proxy.geometry.dispose();
    }
    for (const r of this.owned) r.dispose();
  }
}
