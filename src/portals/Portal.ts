import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import type { Face } from '../world/Level';

export type PortalColor = 'orange' | 'blue';

export const PORTAL_COLORS: Record<PortalColor, number> = { orange: 0xff7a1a, blue: 0x2ab8ff };

/**
 * Each player's portal colours, by player slot. `orange` and `blue` name the two ends of a
 * pair (primary and secondary fire); only the first player's are actually orange and blue.
 * None of them is acid green, laser red or orb gold.
 */
export const PLAYER_PALETTES: readonly Record<PortalColor, number>[] = [
  PORTAL_COLORS,
  { orange: 0xff4fd8, blue: 0x9b6bff },
  { orange: 0xf2f4ff, blue: 0x22d8c8 },
  { orange: 0xffb0a0, blue: 0x4f7bff },
];

/**
 * Size of the opening: generous, so a player (0.8 m capsule) dropping onto a floor portal
 * has over half a metre of slack each side (and see PortalSystem's entry assist).
 */
export const PORTAL_WIDTH = 1.9;
export const PORTAL_HEIGHT = 2.9;
export const PORTAL_HALF_W = PORTAL_WIDTH / 2;
export const PORTAL_HALF_H = PORTAL_HEIGHT / 2;
const CORNER_RADIUS = 0.45;

/**
 * How far the window (the plane that actually links the two portals) sits behind the host
 * surface. The space in front of it is a short tunnel cut into the wall: walls of that
 * tunnel are real geometry, both visually and physically. Since both ends of a pair have
 * the same recess, looking through one shows the other's tunnel continuing the first.
 */
export const RECESS_DEPTH = 0.32;
/**
 * The window is drawn as a shallow box behind its plane rather than a flat quad: every
 * fragment of it samples the portal view in screen space, so the camera can come right up
 * to the plane without the near plane slicing the portal open.
 */
const WINDOW_DEPTH = 0.08;
/** How far the invisible tunnel colliders reach behind the window. */
export const TUNNEL_DEPTH = 2.4;
/** How far past the opening's edge the tunnel colliders stand in for the host surface. */
const TUNNEL_MARGIN = 1.3;
const RIM_WIDTH = 0.07;
const OPEN_TIME = 0.28;
/** Where its glow light sits, in front of the window (the light itself is the Session's: see glow). */
const GLOW_OFFSET = RECESS_DEPTH + 0.6;

/** Rounded-rectangle outline of the opening, counter-clockwise, in portal-local metres. */
export function portalOutline(hw = PORTAL_HALF_W, hh = PORTAL_HALF_H, r = CORNER_RADIUS, segments = 7): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const corners: Array<[number, number, number]> = [
    [hw - r, -hh + r, -Math.PI / 2],
    [hw - r, hh - r, 0],
    [-hw + r, hh - r, Math.PI / 2],
    [-hw + r, -hh + r, Math.PI],
  ];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = a0 + (i / segments) * (Math.PI / 2);
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  }
  return pts;
}

const ROUNDED_RECT_GLSL = /* glsl */ `
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
`;

const WINDOW_VERTEX = /* glsl */ `
varying vec4 vClip;
varying vec3 vLocal;
#include <clipping_planes_pars_vertex>
void main() {
  vLocal = position;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vec4 c = projectionMatrix * mvPosition;
  vClip = c;
  gl_Position = c;
  #include <clipping_planes_vertex>
}
`;

/**
 * Screen-space portal view, plus the effects layered on it: an energy edge, the swirl of a
 * portal that has no partner yet, and the iris that opens when it is placed.
 */
const WINDOW_FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float closed;
uniform vec3 color;
uniform float time;
uniform float open;
uniform vec2 halfSize;
uniform float radius;
uniform vec4 viewRect;
varying vec4 vClip;
varying vec3 vLocal;
#include <clipping_planes_pars_fragment>
${ROUNDED_RECT_GLSL}
void main() {
  #include <clipping_planes_fragment>
  // Where on the whole screen this fragment is: a view narrowed to part of the screen (see
  // PortalRenderer) spans just viewRect (offset, size) of it.
  vec2 suv = viewRect.xy + (vClip.xy / vClip.w * 0.5 + 0.5) * viewRect.zw;
  vec3 view = closed > 0.5 ? vec3(0.0) : texture2D(map, suv).rgb;

  vec2 p = vLocal.xy / halfSize;
  float rad = length(p);
  float ang = atan(p.y, p.x);
  float swirl = sin(ang * 3.0 + rad * 9.0 - time * 3.5) * 0.5 + 0.5;
  float swirl2 = sin(ang * 5.0 - rad * 6.0 + time * 2.0) * 0.5 + 0.5;
  vec3 closedCol = color * (0.18 + 0.75 * swirl * swirl2 + 0.6 * smoothstep(0.35, 1.0, rad));
  vec3 col = mix(view, closedCol, closed);

  float d = sdRoundRect(vLocal.xy, halfSize, radius);
  float edge = smoothstep(-0.18, 0.0, d);
  float flicker = 0.85 + 0.15 * sin(time * 9.0 + ang * 4.0);
  col += color * edge * edge * 1.6 * flicker;

  float iris = smoothstep(open * 1.45 - 0.12, open * 1.45, rad);
  col = mix(col, color * 2.0, iris);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

const RECESS_VERTEX = /* glsl */ `
varying vec2 vUv;
#include <fog_pars_vertex>
#include <clipping_planes_pars_vertex>
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
  #include <fog_vertex>
}
`;

/** Inner walls of the recess: dark metal lit by the portal, with energy bands drawn inward. */
const RECESS_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float time;
uniform float energy;
varying vec2 vUv;
#include <fog_pars_fragment>
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  // Clamped: with MSAA, varyings are extrapolated past the triangle at its edges, and
  // pow() of a negative base is NaN - which the bloom pass would smear over the screen.
  float depth = clamp(vUv.y, 0.0, 1.0);   // 0 at the window, 1 at the host surface
  float glow = pow(1.0 - depth, 2.2);
  float bands = pow(max(sin((depth * 3.0 + time * 1.6) * 6.2831) * 0.5 + 0.5, 0.0), 6.0);
  float ribs = smoothstep(0.82, 1.0, sin(vUv.x * 160.0) * 0.5 + 0.5);
  vec3 base = vec3(0.03, 0.035, 0.045) * (1.0 + ribs * 2.0);
  vec3 col = base + color * energy * (glow * 1.9 + bands * 0.7 * (1.0 - depth) + 0.06 + ribs * 0.2 * (1.0 - depth));
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/** Soft additive glow the portal throws onto the surface around it. */
const HALO_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform vec2 halfSize;
uniform float radius;
uniform float energy;
varying vec2 vLocal;
${ROUNDED_RECT_GLSL}
void main() {
  float d = sdRoundRect(vLocal, halfSize, radius);
  if (d < RIM) discard;
  float a = exp(-(d - RIM) * 6.5) * 0.32 * energy;
  gl_FragColor = vec4(color * a, 1.0);
}
`;

const HALO_VERTEX = /* glsl */ `
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function buildWindowGeometry(outline: THREE.Vector2[]): THREE.BufferGeometry {
  // Side walls from z = 0 back to -WINDOW_DEPTH plus a back cap, all facing inward: from in
  // front only the far inside surfaces face the camera, so each view ray gets one fragment.
  const pos: number[] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    pos.push(a.x, a.y, 0, b.x, b.y, 0, b.x, b.y, -WINDOW_DEPTH);
    pos.push(a.x, a.y, 0, b.x, b.y, -WINDOW_DEPTH, a.x, a.y, -WINDOW_DEPTH);
  }
  for (let i = 1; i < n - 1; i++) {
    const a = outline[0];
    const b = outline[i];
    const c = outline[i + 1];
    pos.push(a.x, a.y, -WINDOW_DEPTH, b.x, b.y, -WINDOW_DEPTH, c.x, c.y, -WINDOW_DEPTH);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  return geo;
}

function buildRecessGeometry(outline: THREE.Vector2[]): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const n = outline.length;
  let perimeter = 0;
  const lens: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = outline[i].distanceTo(outline[(i + 1) % n]);
    lens.push(l);
    perimeter += l;
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    const u0 = acc / perimeter;
    acc += lens[i];
    const u1 = acc / perimeter;
    // Wound so the faces point into the opening.
    pos.push(a.x, a.y, 0, a.x, a.y, RECESS_DEPTH, b.x, b.y, RECESS_DEPTH);
    uv.push(u0, 0, u0, 1, u1, 1);
    pos.push(a.x, a.y, 0, b.x, b.y, RECESS_DEPTH, b.x, b.y, 0);
    uv.push(u0, 0, u1, 1, u1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

function buildRimGeometry(outline: THREE.Vector2[], width: number, z: number): THREE.BufferGeometry {
  const n = outline.length;
  const outer: THREE.Vector2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = outline[(i - 1 + n) % n];
    const next = outline[(i + 1) % n];
    const t = next.clone().sub(prev).normalize();
    outer.push(outline[i].clone().add(new THREE.Vector2(t.y, -t.x).multiplyScalar(width)));
  }
  const pos: number[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = outline[i];
    const p1 = outline[(i + 1) % n];
    const q0 = outer[i];
    const q1 = outer[(i + 1) % n];
    pos.push(p0.x, p0.y, z, q0.x, q0.y, z, q1.x, q1.y, z);
    pos.push(p0.x, p0.y, z, q1.x, q1.y, z, p1.x, p1.y, z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeBoundingSphere();
  return geo;
}

const _m = new THREE.Matrix4();

export class Portal {
  /** Which end of its pair it is (primary / secondary fire); changes when it is stolen. */
  color: PortalColor;
  /** What it is drawn in: its owner's palette colour for this end. */
  tint: number;
  /** Id of the player whose gun placed it (kill credit). */
  owner = '';
  /**
   * Fixed for the portal's lifetime, the same on the server and every client (the slot it
   * was made for, see ArenaSim.addPlayer) - stealing swaps Portal objects between players,
   * so neither owner nor colour can name one over the network.
   */
  netId = -1;
  linked: Portal | null = null;
  placed = false;
  face: Face | null = null;
  hostCollider = -1;
  readonly tunnelColliders = new Set<number>();

  /** Origin at the centre of the window, +Z out of the surface. */
  readonly root = new THREE.Group();
  readonly windowMesh: THREE.Mesh;
  /**
   * How brightly it lights its surroundings right now (0 when not placed). It owns no light
   * of its own: a light appearing in the scene makes three.js recompile every lit material
   * (a second-long hitch), so the Session keeps a fixed few and lends them out (see
   * Session.portalLights).
   */
  glow = 0;

  readonly normal = new THREE.Vector3(0, 0, 1);
  readonly right = new THREE.Vector3(1, 0, 0);
  readonly up = new THREE.Vector3(0, 1, 0);
  /** Centre of the opening where it meets the host surface. */
  readonly surfaceCenter = new THREE.Vector3();
  readonly matrixInverse = new THREE.Matrix4();
  /** World-space plane of the window, normal pointing out. */
  readonly plane = new THREE.Plane();

  private readonly windowMaterial: THREE.ShaderMaterial;
  private readonly recessMaterial: THREE.ShaderMaterial;
  private readonly haloMaterial: THREE.ShaderMaterial;
  private readonly rimMaterial: THREE.MeshBasicMaterial;
  private readonly owned: Array<{ dispose(): void }> = [];
  private tunnelBody: RAPIER.RigidBody | null = null;
  private physics: PhysicsWorld | null = null;
  private openT = 1;
  /** 1 right after it changed hands, fading to 0 (a burst of light on the frame). */
  private stolenFlash = 0;

  /** `tint` overrides the slot's default colour (another player's palette). */
  constructor(color: PortalColor, tint = PORTAL_COLORS[color]) {
    this.color = color;
    this.tint = tint;
    const col = new THREE.Color(tint);
    const outline = portalOutline();

    this.windowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        closed: { value: 1 },
        viewRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        color: { value: col.clone() },
        time: { value: 0 },
        open: { value: 1 },
        halfSize: { value: new THREE.Vector2(PORTAL_HALF_W, PORTAL_HALF_H) },
        radius: { value: CORNER_RADIUS },
      },
      vertexShader: WINDOW_VERTEX,
      fragmentShader: WINDOW_FRAGMENT,
      clipping: true,
    });
    this.windowMesh = new THREE.Mesh(this.own(buildWindowGeometry(outline)), this.own(this.windowMaterial));
    this.windowMesh.frustumCulled = false;

    this.recessMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { color: { value: col.clone() }, time: { value: 0 }, energy: { value: 1 } },
      ]),
      vertexShader: RECESS_VERTEX,
      fragmentShader: RECESS_FRAGMENT,
      fog: true,
      clipping: true,
    });
    const recess = new THREE.Mesh(this.own(buildRecessGeometry(outline)), this.own(this.recessMaterial));

    const rimMat = (this.rimMaterial = this.own(new THREE.MeshBasicMaterial({ color: col.clone().multiplyScalar(2.4) })));
    const rim = new THREE.Mesh(this.own(buildRimGeometry(outline, RIM_WIDTH, RECESS_DEPTH + 0.006)), rimMat);
    const innerRim = new THREE.Mesh(this.own(buildRimGeometry(outline, 0.025, 0.004)), rimMat);

    this.haloMaterial = new THREE.ShaderMaterial({
      uniforms: {
        color: { value: col.clone() },
        halfSize: { value: new THREE.Vector2(PORTAL_HALF_W, PORTAL_HALF_H) },
        radius: { value: CORNER_RADIUS },
        energy: { value: 1 },
      },
      defines: { RIM: RIM_WIDTH.toFixed(3) },
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const halo = new THREE.Mesh(this.own(new THREE.PlaneGeometry(PORTAL_WIDTH + 1.6, PORTAL_HEIGHT + 1.6)), this.haloMaterial);
    halo.position.z = RECESS_DEPTH + 0.004;

    this.root.add(this.windowMesh, recess, rim, innerRim, halo);
    this.root.visible = false;
  }

  private own<T extends { dispose(): void }>(r: T): T {
    this.owned.push(r);
    return r;
  }

  /** A burst of light on the frame: it just changed hands. */
  flashStolen(): void {
    this.stolenFlash = 1;
  }

  /** Repaints it (a stolen portal takes its new owner's colours). */
  setTint(tint: number): void {
    this.tint = tint;
    const col = new THREE.Color(tint);
    this.windowMaterial.uniforms.color.value.copy(col);
    this.recessMaterial.uniforms.color.value.copy(col);
    this.haloMaterial.uniforms.color.value.copy(col);
    this.rimMaterial.color.copy(col).multiplyScalar(2.4);
  }

  /** Where its glow light goes: just in front of the opening. */
  glowPosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.root.position).addScaledVector(this.normal, GLOW_OFFSET);
  }

  /**
   * What the window shows: `texture` (a view in screen space), or the closed swirl. `drawnIn`
   * is the part of the screen the view it is being drawn in covers (offset and size, 0-1):
   * the whole screen for the main view, less for a portal view narrowed to its portal.
   */
  setView(texture: THREE.Texture | null, drawnIn?: THREE.Vector4): void {
    const u = this.windowMaterial.uniforms;
    u.closed.value = texture ? 0 : 1;
    if (texture) u.map.value = texture;
    if (drawnIn) u.viewRect.value.copy(drawnIn);
    else u.viewRect.value.set(0, 0, 1, 1);
  }

  get isOpen(): boolean {
    return this.placed && !!this.linked?.placed;
  }

  place(
    physics: PhysicsWorld,
    face: Face,
    surfaceCenter: THREE.Vector3,
    right: THREE.Vector3,
    up: THREE.Vector3,
  ): void {
    this.unplace();
    this.physics = physics;
    this.face = face;
    this.hostCollider = face.solid.collider.handle;
    this.normal.copy(face.normal);
    this.right.copy(right);
    this.up.copy(up);
    this.surfaceCenter.copy(surfaceCenter);

    this.root.position.copy(surfaceCenter).addScaledVector(this.normal, -RECESS_DEPTH);
    this.root.quaternion.setFromRotationMatrix(_m.makeBasis(this.right, this.up, this.normal));
    this.root.updateMatrixWorld(true);
    this.matrixInverse.copy(this.root.matrixWorld).invert();
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.root.position);

    // Cut the opening into the host surface.
    const outline = portalOutline().map((p) => {
      const w = this.root.position.clone().addScaledVector(this.right, p.x).addScaledVector(this.up, p.y);
      const l = face.toLocal(w);
      return new THREE.Vector2(l.x, l.y);
    });
    face.setHole(this, outline);

    this.buildTunnel(physics);

    this.placed = true;
    this.root.visible = true;
    this.openT = 0;
  }

  /**
   * Four boxes framing the opening, from the host surface back past the window. They are
   * the host surface's stand-in for whatever is passing through - which is allowed to
   * ignore the host itself - and are ignored by everything else (see PortalSystem).
   */
  private buildTunnel(physics: PhysicsWorld): void {
    const p = this.root.position;
    const q = this.root.quaternion;
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }),
    );
    this.tunnelBody = body;
    const hw = PORTAL_HALF_W;
    const hh = PORTAL_HALF_H;
    const e = TUNNEL_MARGIN;
    const zc = (RECESS_DEPTH - TUNNEL_DEPTH) / 2;
    const hz = (RECESS_DEPTH + TUNNEL_DEPTH) / 2;
    const boxes: Array<[number, number, number, number, number]> = [
      [-hw - e / 2, 0, e / 2, hh + e, hz],
      [hw + e / 2, 0, e / 2, hh + e, hz],
      [0, -hh - e / 2, hw, e / 2, hz],
      [0, hh + e / 2, hw, e / 2, hz],
    ];
    for (const [x, y, hx, hy, hzz] of boxes) {
      const c = physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hzz).setTranslation(x, y, zc).setFriction(0.8),
        body,
      );
      this.tunnelColliders.add(c.handle);
      physics.registerOwner(c.handle, { type: 'portal-tunnel', ref: this });
    }
  }

  unplace(): void {
    if (this.face) this.face.setHole(this, null);
    if (this.tunnelBody && this.physics) {
      for (const h of this.tunnelColliders) this.physics.owners.delete(h);
      this.physics.world.removeRigidBody(this.tunnelBody);
    }
    this.tunnelBody = null;
    this.tunnelColliders.clear();
    this.face = null;
    this.hostCollider = -1;
    this.placed = false;
    this.root.visible = false;
    this.glow = 0;
  }

  /** World -> portal-local (window frame). */
  toLocal(p: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(p).applyMatrix4(this.matrixInverse);
  }

  /** Whether a portal-local point lies within the opening's rectangle, grown by `margin`. */
  inAperture(local: THREE.Vector3, margin = 0): boolean {
    return Math.abs(local.x) <= PORTAL_HALF_W + margin && Math.abs(local.y) <= PORTAL_HALF_H + margin;
  }

  update(dt: number, time: number): void {
    this.openT = Math.min(1, this.openT + dt / OPEN_TIME);
    const open = 1 - Math.pow(1 - this.openT, 3);
    this.windowMaterial.uniforms.time.value = time;
    this.windowMaterial.uniforms.open.value = open;
    this.recessMaterial.uniforms.time.value = time;
    const linked = this.isOpen;
    this.stolenFlash = Math.max(0, this.stolenFlash - dt * 2);
    const burst = 1 + this.stolenFlash * 3;
    this.recessMaterial.uniforms.energy.value = (linked ? 1 : 0.65) * burst;
    this.haloMaterial.uniforms.energy.value = open * (linked ? 1 : 0.7) * burst;
    this.glow = this.placed ? open * (2.2 + 0.4 * Math.sin(time * 7)) * burst : 0;
  }

  dispose(): void {
    this.unplace();
    for (const r of this.owned) r.dispose();
  }
}

export function linkPortals(a: Portal, b: Portal): void {
  a.linked = b;
  b.linked = a;
}
