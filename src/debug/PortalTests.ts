import * as THREE from 'three';

/**
 * Scripted, repeatable portal-travel tests. Each scenario places a portal pair, poses the
 * player or the box, drives the fixed-step simulation directly (the render loop is paused)
 * and checks the run for the failure modes portals are prone to:
 *
 *  - falling out of the world        (entity ends up under the floor)
 *  - getting stuck / embedded        (shape overlaps solid geometry it should not)
 *  - sudden launches / lost momentum (exit speed differs from entry speed)
 *  - camera popping at the teleport  (view is not continuous through the portal)
 *  - camera inside geometry          (player can see through walls)
 *  - see-through frames              (rendered frame shows the void behind the world)
 *
 * The harness talks to the game only through `PortalTestAdapter`, so the same scenarios
 * run unchanged against any build that implements it. Run with `?test=portals&mute=1`.
 */

export type PortalColor = 'orange' | 'blue';
export type EntityKind = 'player' | 'box';

export interface TestEntity {
  getPosition(): THREE.Vector3;
  getVelocity(): THREE.Vector3;
  setPosition(p: THREE.Vector3): void;
  setVelocity(v: THREE.Vector3): void;
}

export interface PortalTestAdapter {
  label: string;
  /** Clears portals, parks both entities out of the way, restores health. */
  reset(): void;
  placePortal(color: PortalColor, point: THREE.Vector3, normal: THREE.Vector3, up?: THREE.Vector3): void;
  /** Fires the gun from an arbitrary eye pose, exactly as a click would. */
  firePortal(color: PortalColor, eye: THREE.Vector3, dir: THREE.Vector3): void;
  portalPlaced(color: PortalColor): boolean;
  /** Centre of the opening where it meets the host surface, and the surface normal. */
  portalFrame(color: PortalColor): { center: THREE.Vector3; normal: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3 };
  /** World transform that carries anything entering `from` to its exit at the partner. */
  relativeMatrix(from: PortalColor): THREE.Matrix4;
  /** Portal opening size. */
  portalSize: { width: number; height: number };
  player: TestEntity & {
    setLook(yaw: number, pitch: number): void;
    setKeys(keys: string[]): void;
    cameraPosition(): THREE.Vector3;
    cameraQuaternion(): THREE.Quaternion;
  };
  box: TestEntity;
  /** Cumulative number of portal passages the entity has made. */
  teleportCount(kind: EntityKind): number;
  /** Speed immediately before and after each passage, if the build can report it. */
  teleportSpeeds?(kind: EntityKind): Array<{ before: number; after: number }>;
  step(dt: number): void;
  render(): void;
  renderer: THREE.WebGLRenderer;
  setDebugBackground(color: number | null): void;
  /** Solid colliders the (slightly shrunk) entity shape overlaps that it is not entitled to. */
  overlaps(kind: EntityKind): string[];
  /** Whether a point is inside solid geometry it should not be (camera check). */
  pointInSolid(p: THREE.Vector3): boolean;
  /** Whether a point is inside an open portal's tunnel (legitimately behind a surface). */
  insidePortalTunnel(p: THREE.Vector3): boolean;
  /** Whether anything solid occupies the space just in front of a placed portal's opening. */
  apertureBlocked(color: PortalColor): string[];
  /** Whether the straight line between two points is free of solid geometry. */
  lineClear(a: THREE.Vector3, b: THREE.Vector3): boolean;
}

interface PortalSpec {
  color: PortalColor;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  up?: THREE.Vector3;
}

interface Scenario {
  name: string;
  entity: EntityKind;
  portals: PortalSpec[];
  start: { pos: THREE.Vector3; yaw?: number; pitch?: number; vel?: THREE.Vector3; keys?: string[] };
  duration: number;
  minTeleports: number;
  /** After the run the entity must be at least this far out of the last exit portal. */
  minExitDistance?: number;
  /** Exits a floor portal upward: must rise as far as its exit speed carries it. */
  popUp?: boolean;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScenarioResult {
  name: string;
  pass: boolean;
  checks: CheckResult[];
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const DOWN = V(0, -1, 0);
const NORTH_WALL_N = V(0, 0, 1); // the wall at z = -60 faces +z
const WEST_WALL_N = V(1, 0, 0); // the wall at x = -60 faces +x
const FLOOR_UP_Z = V(0, 0, 1);

/** yaw for a horizontal facing direction, in the controller's convention (forward = -Z at 0). */
function yawFor(dir: THREE.Vector3): number {
  return Math.atan2(-dir.x, -dir.z);
}

const PLAYER_Y = 1.15;
const LOW_WALL_Y = 1.47; // lowest opening a 2.9 m portal can have on a wall standing on the floor

export const SCENARIOS: Scenario[] = [
  {
    name: 'walk wall->wall',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -33), normal: WEST_WALL_N },
    ],
    start: { pos: V(-33, PLAYER_Y, -54), yaw: 0, keys: ['KeyW'] },
    duration: 2.2,
    minTeleports: 1,
    minExitDistance: 2,
  },
  {
    name: 'fall floor->ceiling loop',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-35, 0, -25), normal: UP, up: FLOOR_UP_Z },
      { color: 'blue', point: V(-35, 9, -25), normal: DOWN, up: FLOOR_UP_Z },
    ],
    start: { pos: V(-35, 4, -25), yaw: 0, pitch: -1.2 },
    duration: 3.5,
    minTeleports: 3,
  },
  {
    name: 'fast entry player 30 m/s',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -33), normal: WEST_WALL_N },
    ],
    start: { pos: V(-33, 2.6, -50), yaw: 0, vel: V(0, 0, -30) },
    duration: 1.2,
    minTeleports: 1,
    minExitDistance: 3,
  },
  {
    name: 'fast entry box 25 m/s',
    entity: 'box',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -33), normal: WEST_WALL_N },
    ],
    start: { pos: V(-33, 2.1, -50), vel: V(0, 2, -25) },
    duration: 1.2,
    minTeleports: 1,
    minExitDistance: 3,
  },
  {
    name: 'angled entry 45deg',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -33), normal: WEST_WALL_N },
    ],
    start: { pos: V(-28, PLAYER_Y, -55), yaw: yawFor(V(-1, 0, -1)), keys: ['KeyW'] },
    duration: 2.5,
    minTeleports: 1,
    minExitDistance: 2,
  },
  {
    name: 'angled entry 70deg',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -33), normal: WEST_WALL_N },
    ],
    start: {
      pos: V(-33 + 0.94 * 8, PLAYER_Y, -60 + 0.342 * 8),
      yaw: yawFor(V(-0.94, 0, -0.342)),
      keys: ['KeyW'],
    },
    duration: 3,
    minTeleports: 1,
    minExitDistance: 1.5,
  },
  {
    name: 'corner portals wall->wall',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-58.95, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-60, LOW_WALL_Y, -58.95), normal: WEST_WALL_N },
    ],
    start: { pos: V(-58.95, PLAYER_Y, -55), yaw: 0, keys: ['KeyW'] },
    duration: 2.5,
    minTeleports: 1,
    minExitDistance: 2,
  },
  {
    name: 'floor near wall -> low wall exit',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-58.95, 0, -25), normal: UP, up: FLOOR_UP_Z },
      { color: 'blue', point: V(-43, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
    ],
    start: { pos: V(-58.95, 3, -25.8), yaw: 0, pitch: -1.2 },
    duration: 2.5,
    minTeleports: 1,
    minExitDistance: 1.2,
  },
  {
    name: 'wall -> floor pop-up',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-33, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
      { color: 'blue', point: V(-35, 0, -25), normal: UP, up: FLOOR_UP_Z },
    ],
    start: { pos: V(-33, PLAYER_Y, -54), yaw: 0, keys: ['KeyW'] },
    duration: 1.6,
    minTeleports: 1,
    popUp: true,
  },
  {
    // Added after the baseline: the regression the arena playthrough found, where brushing
    // the opening's lip on the way out counted as landing and killed the climb.
    name: 'fall floor->floor fling',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-35, 0, -25), normal: UP, up: FLOOR_UP_Z },
      { color: 'blue', point: V(-20, 0, -40), normal: UP, up: FLOOR_UP_Z },
    ],
    start: { pos: V(-35, 7.5, -25), yaw: 0, pitch: -1.2 },
    duration: 2.2,
    minTeleports: 1,
    popUp: true,
  },
  {
    // Entry assist: dropping from 4 m with the centre 0.35 m outside the floor portal's rim
    // (the body overlapping the edge) still goes in instead of landing on the lip.
    name: 'off-centre drop onto floor portal',
    entity: 'player',
    portals: [
      { color: 'orange', point: V(-35, 0, -25), normal: UP, up: FLOOR_UP_Z },
      { color: 'blue', point: V(-43, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
    ],
    start: { pos: V(-35 + 0.95 + 0.35, 5, -25), yaw: 0 },
    duration: 2,
    minTeleports: 1,
    minExitDistance: 1.2,
  },
  {
    name: 'box floor -> low wall exit',
    entity: 'box',
    portals: [
      { color: 'orange', point: V(-35, 0, -25), normal: UP, up: FLOOR_UP_Z },
      { color: 'blue', point: V(-43, LOW_WALL_Y, -60), normal: NORTH_WALL_N },
    ],
    start: { pos: V(-35, 4, -25.8), vel: V(0, -2, 0) },
    duration: 2,
    minTeleports: 1,
    minExitDistance: 1.2,
  },
];

interface GunScenario {
  name: string;
  eye: THREE.Vector3;
  dir: THREE.Vector3;
}

/** Portal-gun placement next to other geometry: a valid portal must have a clear opening. */
export const GUN_SCENARIOS: GunScenario[] = [
  // Aimed at the north wall just above the tier-2 platform, which would cut the portal in half.
  { name: 'gun: wall/platform junction', eye: V(-9, 2.5, -45), dir: V(0, 0, -1) },
  // Aimed straight at a staircase, which is not a portal surface - the shot must not pass
  // through it and land on the wall hidden behind.
  { name: 'gun: blocked by stairs', eye: V(0, 1.0, -38), dir: V(0, 0, -1) },
  // Aimed into the inside corner between the floor and the west wall.
  { name: 'gun: floor/wall corner', eye: V(-55, 1.8, -20), dir: V(-0.9, -0.36, 0).normalize() },
];

const DT = 1 / 60;
const VOID_COLOR = 0xff00ff;

function isVoidPixel(r: number, g: number, b: number): boolean {
  return r > g + 90 && b > g + 90 && Math.abs(r - b) < 70;
}

/** Fraction of the frame showing the void colour, and fraction that is plain black. */
function frameStats(renderer: THREE.WebGLRenderer): { voidFrac: number; blackFrac: number } {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const pixels = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let voids = 0;
  let black = 0;
  let total = 0;
  for (let i = 0; i < pixels.length; i += 4 * 7) {
    total++;
    if (isVoidPixel(pixels[i], pixels[i + 1], pixels[i + 2])) voids++;
    if (pixels[i] + pixels[i + 1] + pixels[i + 2] < 4) black++;
  }
  return { voidFrac: voids / total, blackFrac: black / total };
}

function cameraForward(q: THREE.Quaternion): THREE.Vector3 {
  return V(0, 0, -1).applyQuaternion(q);
}

function nearestPortal(adapter: PortalTestAdapter, p: THREE.Vector3): PortalColor {
  const a = adapter.portalFrame('orange').center.distanceTo(p);
  const b = adapter.portalFrame('blue').center.distanceTo(p);
  return a < b ? 'orange' : 'blue';
}

function runScenario(adapter: PortalTestAdapter, s: Scenario, render: boolean): ScenarioResult {
  adapter.reset();
  for (const p of s.portals) adapter.placePortal(p.color, p.point, p.normal, p.up);

  const entity = s.entity === 'player' ? adapter.player : adapter.box;
  entity.setPosition(s.start.pos);
  entity.setVelocity(s.start.vel ?? V(0, 0, 0));
  if (s.entity === 'player') {
    adapter.player.setLook(s.start.yaw ?? 0, s.start.pitch ?? 0);
    adapter.player.setKeys(s.start.keys ?? []);
  }

  const speedLog0 = adapter.teleportSpeeds?.(s.entity).length ?? 0;
  const steps = Math.round(s.duration / DT);
  const positions: THREE.Vector3[] = [entity.getPosition().clone()];
  const camPos: THREE.Vector3[] = [];
  const camQuat: THREE.Quaternion[] = [];
  const teleportSteps: number[] = [];
  const teleportPortal: PortalColor[] = [];
  const overlapHits: string[] = [];
  const cameraHits: number[] = [];
  let minY = Infinity;
  let underWorld = '';
  let maxVoid = 0;
  let maxVoidStep = -1;
  let maxBlack = 0;
  if (s.entity === 'player') {
    camPos.push(adapter.player.cameraPosition().clone());
    camQuat.push(adapter.player.cameraQuaternion().clone());
  }

  for (let i = 1; i <= steps; i++) {
    const before = positions[i - 1];
    const count = adapter.teleportCount(s.entity);
    adapter.step(DT);
    const p = entity.getPosition().clone();
    positions.push(p);
    minY = Math.min(minY, p.y);
    if (!underWorld && p.y < -0.5 && !adapter.insidePortalTunnel(p)) underWorld = `step ${i}: y ${p.y.toFixed(2)}`;

    if (adapter.teleportCount(s.entity) > count) {
      teleportSteps.push(i);
      teleportPortal.push(nearestPortal(adapter, before));
    }

    const ov = adapter.overlaps(s.entity);
    if (ov.length > 0 && overlapHits.length < 6) overlapHits.push(`step ${i}: ${ov.join(',')}`);

    if (s.entity === 'player') {
      const c = adapter.player.cameraPosition().clone();
      camPos.push(c);
      camQuat.push(adapter.player.cameraQuaternion().clone());
      if (adapter.pointInSolid(c)) cameraHits.push(i);
    }

    if (render) {
      const nearTeleport = teleportSteps.some((t) => Math.abs(t - i) <= 10);
      if (nearTeleport || i % 6 === 0) {
        adapter.render();
        const f = frameStats(adapter.renderer);
        if (f.voidFrac > maxVoid) {
          maxVoid = f.voidFrac;
          maxVoidStep = i;
        }
        maxBlack = Math.max(maxBlack, f.blackFrac);
      }
    }
  }
  if (s.entity === 'player') adapter.player.setKeys([]);

  const checks: CheckResult[] = [];
  checks.push({
    name: 'teleported',
    pass: teleportSteps.length >= s.minTeleports,
    detail: `${teleportSteps.length} teleport(s), need >= ${s.minTeleports}`,
  });
  // Below the floor is only allowed inside a portal's own tunnel.
  checks.push({
    name: 'never under the world',
    pass: !underWorld,
    detail: underWorld ? `outside geometry at ${underWorld}` : `min centre y ${minY.toFixed(2)} (portal tunnels allowed)`,
  });
  checks.push({
    name: 'no embedding',
    pass: overlapHits.length === 0,
    detail: overlapHits.length ? overlapHits.join(' | ') : 'clear every step',
  });

  // Exit speed vs entry speed, measured from actual motion on either side of the jump.
  const speedNotes: string[] = [];
  let speedOk = true;
  for (const t of teleportSteps) {
    if (t < 2 || t + 2 >= positions.length) continue;
    const vin = positions[t - 1].distanceTo(positions[t - 2]) / DT;
    const vout = positions[t + 2].distanceTo(positions[t + 1]) / DT;
    const tol = 1.5 + vin * 0.15;
    const ok = Math.abs(vout - vin) <= tol;
    if (!ok) speedOk = false;
    speedNotes.push(`${vin.toFixed(1)}->${vout.toFixed(1)}`);
  }
  if (teleportSteps.length > 0 && speedNotes.length === 0) {
    speedOk = false;
    speedNotes.push('passage too late in the run to measure');
  }
  checks.push({
    name: 'exit speed = entry speed',
    pass: speedOk && teleportSteps.length > 0,
    detail: speedNotes.join(', ') || 'no teleport',
  });

  const exact = adapter.teleportSpeeds?.(s.entity).slice(speedLog0);
  if (exact) {
    // The passage itself must rotate velocity, never scale it.
    const worst = exact.reduce((m, e) => Math.max(m, Math.abs(e.after - e.before) / Math.max(e.before, 1e-3)), 0);
    checks.push({
      name: 'speed preserved through the portal',
      pass: exact.length > 0 && worst < 0.01,
      detail: exact.length ? `${exact.map((e) => `${e.before.toFixed(2)}->${e.after.toFixed(2)}`).join(', ')} (worst ${(worst * 100).toFixed(2)}%)` : 'no teleport',
    });
  }

  if (s.entity === 'player') {
    // Around each passage the camera must move continuously: every frame either follows on
    // from the previous one directly or follows on from it mapped through the portal (so a
    // one-frame-late camera is fine, but any push, snap or pop is not).
    let worstPos = 0;
    let worstAngle = 0;
    teleportSteps.forEach((t, k) => {
      const m = adapter.relativeMatrix(teleportPortal[k]);
      const rot = new THREE.Quaternion().setFromRotationMatrix(m);
      if (t < 3) return;
      // Per-frame motion from before the passage, in both frames of reference.
      const motion = camPos[t - 1].clone().sub(camPos[t - 2]);
      const motionMapped = motion.clone().applyQuaternion(rot);
      for (let j = t - 1; j <= Math.min(camPos.length - 1, t + 3); j++) {
        const prev = camPos[j - 1];
        const prevMapped = prev.clone().applyMatrix4(m);
        const candidates = [
          prev.clone().add(motion),
          prev.clone().add(motionMapped),
          prevMapped.clone().add(motionMapped),
        ];
        const err = Math.max(0, Math.min(...candidates.map((c) => camPos[j].distanceTo(c))) - 0.05);
        const f0 = cameraForward(camQuat[j - 1]);
        const f1 = cameraForward(camQuat[j]);
        const ang = THREE.MathUtils.radToDeg(Math.min(f0.angleTo(f1), f0.clone().applyQuaternion(rot).angleTo(f1)));
        worstPos = Math.max(worstPos, err);
        worstAngle = Math.max(worstAngle, ang);
      }
    });
    checks.push({
      name: 'camera continuous at teleport',
      pass: teleportSteps.length > 0 && worstPos < 0.2 && worstAngle < 5,
      detail: `max jump ${worstPos.toFixed(2)} m, ${worstAngle.toFixed(1)} deg`,
    });
    checks.push({
      name: 'camera never inside solid',
      pass: cameraHits.length === 0,
      detail: cameraHits.length ? `inside at steps ${cameraHits.slice(0, 6).join(',')}` : 'clear',
    });
  }

  if (s.minExitDistance !== undefined && teleportSteps.length > 0) {
    const last = teleportSteps[teleportSteps.length - 1];
    const exitColor: PortalColor = teleportPortal[teleportPortal.length - 1] === 'orange' ? 'blue' : 'orange';
    const frame = adapter.portalFrame(exitColor);
    const final = positions[positions.length - 1];
    const dist = final.clone().sub(frame.center).dot(frame.normal);
    checks.push({
      name: 'not stuck at exit',
      pass: dist >= s.minExitDistance,
      detail: `${dist.toFixed(2)} m out of exit after ${((positions.length - 1 - last) * DT).toFixed(2)} s`,
    });
  }

  if (s.popUp && teleportSteps.length > 0) {
    // Out of a floor portal the body must climb as far as its exit speed carries it
    // (v^2 / 2g) - not stop dead, and not be launched higher than that either.
    const t0 = teleportSteps[0];
    const vOut = t0 + 2 < positions.length ? (positions[t0 + 2].y - positions[t0 + 1].y) / DT : 0;
    const expected = (vOut * vOut) / (2 * 20);
    let peak = -Infinity;
    for (let i = t0 + 1; i < positions.length; i++) peak = Math.max(peak, positions[i].y);
    const rise = peak - positions[t0 + 1].y;
    checks.push({
      name: 'carries momentum out of floor portal',
      pass: vOut > 5 && rise > expected * 0.75 && rise < expected * 1.25 + 0.1,
      detail: `exit vy ${vOut.toFixed(1)} m/s, rose ${rise.toFixed(2)} m (ballistic ${expected.toFixed(2)} m)`,
    });
  }

  if (render) {
    checks.push({
      name: 'no see-through frames',
      pass: maxVoid < 0.01,
      detail: `worst frame ${(maxVoid * 100).toFixed(2)}% void (step ${maxVoidStep})`,
    });
    // A NaN anywhere in the HDR frame is smeared over the whole screen by bloom.
    checks.push({
      name: 'no broken (black) frames',
      pass: maxBlack < 0.3,
      detail: `worst frame ${(maxBlack * 100).toFixed(1)}% black`,
    });
  }

  return { name: s.name, pass: checks.every((c) => c.pass), checks };
}

function runGunScenario(adapter: PortalTestAdapter, s: GunScenario): ScenarioResult {
  adapter.reset();
  adapter.firePortal('orange', s.eye, s.dir);
  const checks: CheckResult[] = [];
  if (!adapter.portalPlaced('orange')) {
    checks.push({ name: 'placement', pass: true, detail: 'rejected (no valid spot) - acceptable' });
  } else {
    const blocked = adapter.apertureBlocked('orange');
    checks.push({
      name: 'opening clear of other geometry',
      pass: blocked.length === 0,
      detail: blocked.length ? `blocked by ${blocked.join(',')}` : 'clear',
    });
    const frame = adapter.portalFrame('orange');
    const target = frame.center.clone().addScaledVector(frame.normal, 0.3);
    checks.push({
      name: 'portal visible from shooter',
      pass: adapter.lineClear(s.eye, target),
      detail: `portal at ${frame.center.toArray().map((n) => n.toFixed(2)).join(', ')}`,
    });
  }
  return { name: s.name, pass: checks.every((c) => c.pass), checks };
}

export function runPortalTests(adapter: PortalTestAdapter, opts: { render?: boolean } = {}): ScenarioResult[] {
  const render = opts.render ?? true;
  if (render) adapter.setDebugBackground(VOID_COLOR);
  const results: ScenarioResult[] = [];
  try {
    for (const s of SCENARIOS) results.push(runScenario(adapter, s, render));
    for (const s of GUN_SCENARIOS) results.push(runGunScenario(adapter, s));
  } finally {
    if (render) adapter.setDebugBackground(null);
    adapter.reset();
  }
  return results;
}

export function formatResults(label: string, results: ScenarioResult[]): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.pass).length;
  lines.push(`Portal tests [${label}]: ${passed}/${results.length} scenarios pass`);
  for (const r of results) {
    lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
    for (const c of r.checks) {
      if (!c.pass || !r.pass) lines.push(`   ${c.pass ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
    }
  }
  return lines.join('\n');
}

export function showResultsOverlay(container: HTMLElement, text: string): void {
  const pre = document.createElement('pre');
  pre.id = 'portal-test-results';
  pre.textContent = text;
  pre.style.cssText = `position:absolute; top:40px; right:12px; max-width:46vw; max-height:85vh; overflow:auto;
    margin:0; padding:10px 12px; font:11px/1.35 ui-monospace,monospace; color:#e8ecf2;
    background:rgba(8,10,16,0.85); border:1px solid #334; border-radius:6px; z-index:20; white-space:pre-wrap;`;
  container.appendChild(pre);
}
