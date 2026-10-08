import * as THREE from 'three';
import { PORTAL_HALF_H, PORTAL_HALF_W, RECESS_DEPTH, type Portal } from './Portal';
import { LAYER_AVATAR } from '../core/RenderLayers';
import { computePortalRelativeMatrix } from './PortalMath';

const _relative = new THREE.Matrix4();
const _camMatrix = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _clipPlane = new THREE.Plane();
const _clipVec4 = new THREE.Vector4();
const _scaledClip = new THREE.Vector4();
const _q = new THREE.Vector4();
const _size = new THREE.Vector2();
const _frustum = new THREE.Frustum();
const _projView = new THREE.Matrix4();
const _sphere = new THREE.Sphere();
const _local = new THREE.Vector3();
const _corner = new THREE.Vector4();
const _drawnIn = new THREE.Vector4();

/** Below this distance from the destination plane the oblique projection degenerates. */
const OBLIQUE_MIN_DISTANCE = 0.02;
const PORTAL_RADIUS = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + RECESS_DEPTH;
/** The window's corners (its box reaches a little behind the plane), for its screen rectangle. */
const WINDOW_CORNERS = [-0.1, 0.01].flatMap((z) =>
  [-1, 1].flatMap((sx) => [-1, 1].map((sy) => new THREE.Vector3(sx * PORTAL_HALF_W, sy * PORTAL_HALF_H, z))),
);
/** Pixels of slack round a portal's screen rectangle. */
const RECT_PAD = 2;

/** A rectangle of the drawing buffer, in pixels from the bottom left. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function sign(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

/** Lengyel's oblique near-plane clipping, adapted for three.js's column-major Matrix4. */
function applyObliqueClip(camera: THREE.PerspectiveCamera, clipPlaneCameraSpace: THREE.Vector4): void {
  const m = camera.projectionMatrix.elements;
  _q.set(
    (sign(clipPlaneCameraSpace.x) + m[8]) / m[0],
    (sign(clipPlaneCameraSpace.y) + m[9]) / m[5],
    -1,
    (1 + m[10]) / m[14],
  );
  const dot = clipPlaneCameraSpace.dot(_q);
  const c = _scaledClip.copy(clipPlaneCameraSpace).multiplyScalar(2 / dot);
  m[2] = c.x;
  m[6] = c.y;
  m[10] = c.z + 1;
  m[14] = c.w;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** Whether `portal`'s opening can appear in `camera`'s view at all. */
function portalVisible(camera: THREE.PerspectiveCamera, portal: Portal): boolean {
  camera.updateMatrixWorld();
  // From behind its surface a portal is never seen (its window faces the other way).
  portal.toLocal(_pos.setFromMatrixPosition(camera.matrixWorld), _local);
  if (_local.z <= 0 && !portal.inAperture(_local, 0)) return false;
  if (_local.z < -0.5) return false;
  _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_projView);
  _sphere.set(portal.surfaceCenter, PORTAL_RADIUS);
  return _frustum.intersectsSphere(_sphere);
}

/**
 * Where `portal`'s window lands on `camera`'s screen (`width` x `height` pixels), within
 * `within`; the whole of `within` if some of it is behind the camera (it may be anywhere).
 */
function screenRect(camera: THREE.PerspectiveCamera, portal: Portal, width: number, height: number, within: Rect): Rect {
  _projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(portal.root.matrixWorld);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of WINDOW_CORNERS) {
    _corner.set(c.x, c.y, c.z, 1).applyMatrix4(_projView);
    if (_corner.w < 0.01) return { ...within };
    const sx = ((_corner.x / _corner.w) * 0.5 + 0.5) * width;
    const sy = ((_corner.y / _corner.w) * 0.5 + 0.5) * height;
    x0 = Math.min(x0, sx);
    y0 = Math.min(y0, sy);
    x1 = Math.max(x1, sx);
    y1 = Math.max(y1, sy);
  }
  const ax = Math.max(within.x, Math.floor(x0) - RECT_PAD);
  const ay = Math.max(within.y, Math.floor(y0) - RECT_PAD);
  const bx = Math.min(within.x + within.w, Math.ceil(x1) + RECT_PAD);
  const by = Math.min(within.y + within.h, Math.ceil(y1) + RECT_PAD);
  return { x: ax, y: ay, w: Math.max(0, bx - ax), h: Math.max(0, by - ay) };
}

export interface PortalRenderStats {
  views: number;
  /** Share of the screen's pixels the views were drawn over (1 per full-screen view). */
  coverage: number;
}

/**
 * Narrows `camera`'s projection to `r` of a `width` x `height` screen: drawn with the
 * viewport set to `r`, every pixel comes out exactly as the full view would have it - but
 * only what can be seen through that rectangle survives frustum culling.
 */
function narrowTo(camera: THREE.PerspectiveCamera, r: Rect, width: number, height: number): void {
  const sx = width / r.w;
  const sy = height / r.h;
  const tx = sx - (2 * r.x) / r.w - 1;
  const ty = sy - (2 * r.y) / r.h - 1;
  const m = camera.projectionMatrix.elements;
  for (let c = 0; c < 4; c++) {
    m[c * 4] = sx * m[c * 4] + tx * m[c * 4 + 3];
    m[c * 4 + 1] = sy * m[c * 4 + 1] + ty * m[c * 4 + 3];
  }
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * Draws what each portal looks through to.
 *
 * Each portal's surface samples its view in screen space, so the virtual camera has the
 * player's exact projection and is just the player's camera carried through the pair - and
 * only the part of the screen the portal covers needs drawing. Each view is narrowed to that
 * rectangle (viewport, scissor and frustum): a far portal costs a few pixels and only the
 * handful of things visible through it, not a second whole scene. Recursion (a portal seen inside its own
 * view, e.g. two portals facing each other) is drawn deepest-first: level k samples level
 * k+1, and the deepest level shows the closed swirl.
 *
 * Render targets are shared, not per portal: one per portal drawn this frame (holding its
 * finished view) plus one to ping-pong a recursion against, so eight portals in an arena
 * don't each hold two screen-sized buffers.
 */
export class PortalRenderer {
  private readonly virtualCamera = new THREE.PerspectiveCamera();
  maxDepth = 3;
  readonly stats: PortalRenderStats = { views: 0, coverage: 0 };
  private readonly pool: THREE.WebGLRenderTarget[] = [];

  constructor() {
    // The one camera that does see the player's body - looking through a portal is the
    // only way to catch sight of yourself.
    this.virtualCamera.layers.enable(LAYER_AVATAR);
  }

  /** The i-th shared target, made (and matched to the drawing buffer) as needed. */
  private target(i: number, width: number, height: number): THREE.WebGLRenderTarget {
    let t = this.pool[i];
    if (!t) {
      t = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace });
      this.pool[i] = t;
    }
    if (t.width !== width || t.height !== height) t.setSize(width, height);
    return t;
  }

  /** One of its targets (for compiling shaders as they'll be drawn: into a half-float target). */
  anyTarget(renderer: THREE.WebGLRenderer): THREE.WebGLRenderTarget {
    renderer.getDrawingBufferSize(_size);
    return this.target(0, _size.x, _size.y);
  }

  /**
   * Makes `count` targets now (at load), so the first portals opened don't allocate
   * screen-sized buffers mid-game.
   */
  prepare(renderer: THREE.WebGLRenderer, count: number): void {
    renderer.getDrawingBufferSize(_size);
    for (let i = 0; i < count; i++) renderer.initRenderTarget(this.target(i, _size.x, _size.y));
  }

  /**
   * `portals` is every portal in the arena. Views are shared out nearest-first within a
   * budget of two full-depth chains (one pair's worth), so each extra pair on screen costs
   * at most a view or two; every visible open portal gets at least its first level.
   * Other pairs' portals seen inside a portal's view show their closed swirl.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, mainCamera: THREE.PerspectiveCamera, portals: readonly Portal[]): void {
    this.stats.views = 0;
    this.stats.coverage = 0;
    const open: Portal[] = [];
    for (const p of portals) {
      p.setView(null);
      if (p.isOpen) open.push(p);
    }
    if (open.length === 0) return;

    renderer.getDrawingBufferSize(_size);
    const width = _size.x;
    const height = _size.y;
    const screen: Rect = { x: 0, y: 0, w: width, h: height };
    mainCamera.updateMatrixWorld();

    const visible = open
      .filter((p) => portalVisible(mainCamera, p))
      .map((p) => ({ p, rect: screenRect(mainCamera, p, width, height, screen) }))
      .filter((v) => v.rect.w > 0 && v.rect.h > 0)
      .sort((a, b) => a.p.root.position.distanceToSquared(mainCamera.position) - b.p.root.position.distanceToSquared(mainCamera.position));
    let budget = 2 * this.maxDepth;
    const results = new Map<Portal, THREE.Texture>();
    const scratch = visible.length > 0 ? this.target(visible.length, width, height) : null;
    for (const [i, { p, rect }] of visible.entries()) {
      const later = visible.length - 1 - i;
      const depth = THREE.MathUtils.clamp(budget - later, 1, this.maxDepth);
      const before = this.stats.views;
      results.set(p, this.renderChain(renderer, scene, mainCamera, p, p.linked!, depth, rect, this.target(i, width, height), scratch!, width, height));
      budget -= this.stats.views - before;
    }

    // Restore for the main pass. A portal off screen shows nothing in particular (the swirl).
    renderer.setRenderTarget(null);
    for (const p of open) {
      p.setView(results.get(p) ?? null);
      p.windowMesh.visible = true;
    }
  }

  private renderChain(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    mainCamera: THREE.PerspectiveCamera,
    p: Portal,
    q: Portal,
    maxDepth: number,
    rect: Rect,
    result: THREE.WebGLRenderTarget,
    scratch: THREE.WebGLRenderTarget,
    width: number,
    height: number,
  ): THREE.Texture {
    computePortalRelativeMatrix(p, q, _relative);

    // How deep the self-view goes: level k+1 is needed only if `p` shows up in level k -
    // and only where it shows up there (within where level k itself is seen).
    const cams: THREE.Matrix4[] = [];
    const rects: Rect[] = [rect];
    _camMatrix.copy(mainCamera.matrixWorld);
    for (let k = 1; k <= maxDepth; k++) {
      _camMatrix.premultiply(_relative);
      cams.push(_camMatrix.clone());
      if (k === maxDepth) break;
      this.setupCamera(mainCamera, cams[k - 1], q);
      if (!portalVisible(this.virtualCamera, p)) break;
      const next = screenRect(this.virtualCamera, p, width, height, rects[k - 1]);
      if (next.w <= 0 || next.h <= 0) break;
      rects.push(next);
    }

    // `q`'s window sits on the virtual camera's clip plane: never draw it in these views.
    q.windowMesh.visible = false;
    let source: THREE.Texture | null = null;
    for (let k = cams.length; k >= 1; k--) {
      const r = rects[k - 1];
      this.setupCamera(mainCamera, cams[k - 1], q, r, width, height);
      // Its own window, seen in this view, shows the next level down.
      p.setView(source, _drawnIn.set(r.x / width, r.y / height, r.w / width, r.h / height));
      // Level 1 (what the screen samples) lands in `result`; deeper ones alternate with it.
      const target = k % 2 === 1 ? result : scratch;
      target.viewport.set(r.x, r.y, r.w, r.h);
      target.scissor.set(r.x, r.y, r.w, r.h);
      target.scissorTest = true;
      renderer.setRenderTarget(target);
      renderer.render(scene, this.virtualCamera);
      this.stats.views++;
      this.stats.coverage += (r.w * r.h) / (width * height);
      source = target.texture;
    }
    q.windowMesh.visible = true;
    // Seen in other portals' views it shows the swirl - its texture may be drawn into next.
    p.setView(null);
    return source!;
  }

  /** The virtual camera at `world`, clipped at `dest`'s window - and narrowed to `rect` of the screen, if given. */
  private setupCamera(mainCamera: THREE.PerspectiveCamera, world: THREE.Matrix4, dest: Portal, rect?: Rect, width = 0, height = 0): void {
    const cam = this.virtualCamera;
    world.decompose(_pos, _quat, _scale);
    cam.position.copy(_pos);
    cam.quaternion.copy(_quat);
    cam.fov = mainCamera.fov;
    cam.near = mainCamera.near;
    cam.far = mainCamera.far;
    cam.aspect = mainCamera.aspect;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    if (rect) narrowTo(cam, rect, width, height);

    // Clip everything behind `dest`'s window so the wall it is set into (and anything
    // beyond) never leaks into the view.
    const dist = dest.plane.distanceToPoint(cam.position);
    if (dist < -OBLIQUE_MIN_DISTANCE) {
      _clipPlane.copy(dest.plane).applyMatrix4(cam.matrixWorldInverse);
      _clipVec4.set(_clipPlane.normal.x, _clipPlane.normal.y, _clipPlane.normal.z, _clipPlane.constant);
      applyObliqueClip(cam, _clipVec4);
    }
  }

  dispose(): void {
    for (const t of this.pool) t.dispose();
    this.pool.length = 0;
  }
}
