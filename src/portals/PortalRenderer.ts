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

/** Below this distance from the destination plane the oblique projection degenerates. */
const OBLIQUE_MIN_DISTANCE = 0.02;
const PORTAL_RADIUS = Math.hypot(PORTAL_HALF_W, PORTAL_HALF_H) + RECESS_DEPTH;

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

export interface PortalRenderStats {
  views: number;
}

/**
 * Draws what each portal looks through to, into that portal's render target.
 *
 * Each portal's surface samples its target in screen space, so the virtual camera has the
 * player's exact projection and is just the player's camera carried through the pair.
 * Recursion (a portal seen inside its own view, e.g. two portals facing each other) is
 * drawn deepest-first: level k samples level k+1 from the other target of the portal's
 * ping-pong pair, and the deepest level shows the closed swirl.
 */
export class PortalRenderer {
  private readonly virtualCamera = new THREE.PerspectiveCamera();
  maxDepth = 3;
  readonly stats: PortalRenderStats = { views: 0 };

  constructor() {
    // The one camera that does see the player's body - looking through a portal is the
    // only way to catch sight of yourself.
    this.virtualCamera.layers.enable(LAYER_AVATAR);
  }

  /**
   * `portals` is every portal in the arena. Views are shared out nearest-first within a
   * budget of two full-depth chains (one pair's worth), so each extra pair on screen costs
   * at most a view or two; every visible open portal gets at least its first level.
   * Other pairs' portals seen inside a portal's view show their closed swirl.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, mainCamera: THREE.PerspectiveCamera, portals: readonly Portal[]): void {
    this.stats.views = 0;
    const open: Portal[] = [];
    for (const p of portals) {
      p.setView(null);
      if (p.isOpen) open.push(p);
    }
    if (open.length === 0) return;

    renderer.getDrawingBufferSize(_size);
    for (const p of open) p.resizeTargets(_size.x, _size.y);
    mainCamera.updateMatrixWorld();

    const visible = open
      .filter((p) => portalVisible(mainCamera, p))
      .sort((p, q) => p.root.position.distanceToSquared(mainCamera.position) - q.root.position.distanceToSquared(mainCamera.position));
    let budget = 2 * this.maxDepth;
    const results = new Map<Portal, THREE.Texture>();
    for (const [i, p] of visible.entries()) {
      const later = visible.length - 1 - i;
      const depth = THREE.MathUtils.clamp(budget - later, 1, this.maxDepth);
      const before = this.stats.views;
      results.set(p, this.renderChain(renderer, scene, mainCamera, p, p.linked!, depth));
      budget -= this.stats.views - before;
    }

    // Restore for the main pass. A portal that was culled keeps its last image; it is not
    // on screen, but its texture must still not be the one being rendered next frame.
    renderer.setRenderTarget(null);
    for (const p of open) {
      p.setView(results.get(p) ?? p.targets[1].texture);
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
  ): THREE.Texture {
    computePortalRelativeMatrix(p, q, _relative);

    // How deep the self-view goes: level k+1 is needed only if `p` shows up in level k.
    const cams: THREE.Matrix4[] = [];
    _camMatrix.copy(mainCamera.matrixWorld);
    for (let k = 1; k <= maxDepth; k++) {
      _camMatrix.premultiply(_relative);
      cams.push(_camMatrix.clone());
      if (k === maxDepth) break;
      this.setupCamera(mainCamera, cams[k - 1], q);
      if (!portalVisible(this.virtualCamera, p)) break;
    }

    // `q`'s window sits on the virtual camera's clip plane: never draw it in these views.
    q.windowMesh.visible = false;
    let source: THREE.Texture | null = null;
    for (let k = cams.length; k >= 1; k--) {
      this.setupCamera(mainCamera, cams[k - 1], q);
      p.setView(source);
      const target = p.targets[k % 2];
      renderer.setRenderTarget(target);
      renderer.render(scene, this.virtualCamera);
      this.stats.views++;
      source = target.texture;
    }
    q.windowMesh.visible = true;
    return source!;
  }

  private setupCamera(mainCamera: THREE.PerspectiveCamera, world: THREE.Matrix4, dest: Portal): void {
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

    // Clip everything behind `dest`'s window so the wall it is set into (and anything
    // beyond) never leaks into the view.
    const dist = dest.plane.distanceToPoint(cam.position);
    if (dist < -OBLIQUE_MIN_DISTANCE) {
      _clipPlane.copy(dest.plane).applyMatrix4(cam.matrixWorldInverse);
      _clipVec4.set(_clipPlane.normal.x, _clipPlane.normal.y, _clipPlane.normal.z, _clipPlane.constant);
      applyObliqueClip(cam, _clipVec4);
    }
  }
}
