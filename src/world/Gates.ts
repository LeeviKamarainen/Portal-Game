import * as THREE from 'three';
import type { Level } from './Level';
import { glowMaterial, materials } from './Materials';

/**
 * Speedrun gates: upright boxes a body flies through. A checkpoint records a split and
 * becomes where a fall brings you back; the finish ends the run; a fizzler (Portal's
 * emancipation grill) stops portal shots and closes your portals as you pass it, so a
 * course is cut into sections that each need portals of their own.
 *
 * Crossing is tested along the segment a body moved in a step, so nothing at speed can
 * skip through a thin gate between two steps. A flat gate lies across a shaft (a tower's
 * floor opening) and is flown up or down through.
 */

export type GateKind = 'checkpoint' | 'finish' | 'fizzler';

const COLORS: Record<GateKind, number> = { checkpoint: 0xffc23a, finish: 0x40ffd0, fizzler: 0x7cc4ff };
const PASSED = 0x5aff8a;

const SHEET_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHEET_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float time;
uniform float strength;
uniform float stripes;
varying vec2 vUv;
void main() {
  float edge = smoothstep(0.0, 0.08, vUv.y) * smoothstep(0.0, 0.08, 1.0 - vUv.y);
  float band = 0.6 + 0.4 * sin(vUv.y * stripes - time * 3.0);
  float a = strength * (0.35 + 0.65 * band) * (0.55 + 0.45 * edge);
  gl_FragColor = vec4(color * a, 1.0);
}
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

export class Gate {
  readonly kind: GateKind;
  /** Middle of the box. */
  readonly center: THREE.Vector3;
  /** Half extents in the gate's own frame: across, up, through. */
  readonly half: THREE.Vector3;
  readonly yaw: number;
  /** Where a fall brings you back (checkpoints): feet position and the way to face. */
  readonly respawn: { feet: THREE.Vector3; yaw: number };
  private readonly sheet: THREE.ShaderMaterial;
  private readonly lamps: THREE.MeshBasicMaterial;

  /**
   * `at`: bottom centre; `size`: width, height, thickness - or, `flat`, width, thickness,
   * depth; `yaw` in radians (front faces -z at 0).
   */
  constructor(level: Level, kind: GateKind, at: THREE.Vector3, size: THREE.Vector3, yaw: number, respawn?: { feet: THREE.Vector3; yaw: number }, flat = false) {
    this.kind = kind;
    this.center = at.clone().setY(at.y + size.y / 2);
    this.half = size.clone().multiplyScalar(0.5);
    if (flat) this.half.y = Math.max(this.half.y, 0.05);
    else this.half.z = Math.max(this.half.z, 0.05);
    this.yaw = yaw;
    this.respawn = respawn ?? { feet: at.clone(), yaw };

    const group = new THREE.Group();
    group.position.copy(this.center);
    group.rotation.y = yaw;
    const color = new THREE.Color(COLORS[kind]);
    this.sheet = level.own(
      new THREE.ShaderMaterial({
        uniforms: {
          color: { value: color },
          time: { value: 0 },
          strength: { value: kind === 'fizzler' ? 0.32 : 0.22 },
          stripes: { value: kind === 'fizzler' ? 90 : 18 },
        },
        vertexShader: SHEET_VERTEX,
        fragmentShader: SHEET_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    const sheet = new THREE.Mesh(level.own(new THREE.PlaneGeometry(size.x, flat ? size.z : size.y)), this.sheet);
    if (flat) sheet.rotation.x = -Math.PI / 2;
    sheet.renderOrder = 3;
    group.add(sheet);

    // Posts at both sides (and a lintel on the run gates), with glowing strips down them;
    // a flat gate has a glowing rim round its edge instead.
    const post = 0.22;
    const frame = materials().trim;
    this.lamps = level.own(glowMaterial(COLORS[kind], 2.4));
    for (const s of flat ? [] : [-1, 1]) {
      const m = new THREE.Mesh(level.own(new THREE.BoxGeometry(post, size.y, post)), frame);
      m.position.set(s * (size.x / 2 + post / 2), 0, 0);
      m.castShadow = true;
      const lamp = new THREE.Mesh(level.own(new THREE.BoxGeometry(0.05, size.y * 0.9, post + 0.02)), this.lamps);
      lamp.position.set(s * (size.x / 2 + 0.02), 0, 0);
      group.add(m, lamp);
    }
    if (flat) {
      for (const [w, d, x, z] of [
        [size.x, 0.12, 0, size.z / 2],
        [size.x, 0.12, 0, -size.z / 2],
        [0.12, size.z, size.x / 2, 0],
        [0.12, size.z, -size.x / 2, 0],
      ]) {
        const rim = new THREE.Mesh(level.own(new THREE.BoxGeometry(w, 0.06, d)), this.lamps);
        rim.position.set(x, size.y / 2 + 0.03, z);
        group.add(rim);
      }
    } else if (kind !== 'fizzler') {
      const lintel = new THREE.Mesh(level.own(new THREE.BoxGeometry(size.x + post * 2, post, post)), frame);
      lintel.position.y = size.y / 2 + post / 2;
      lintel.castShadow = true;
      group.add(lintel);
    }
    level.scene.add(group);
    group.updateMatrixWorld(true);
    // A fizzler's field stops portal shots (whatever is behind it can't be reached through it).
    if (kind === 'fizzler') level.addBlocker(sheet);
  }

  /** Whether the segment from `a` to `b` touches the gate's box. */
  crossed(a: THREE.Vector3, b: THREE.Vector3): boolean {
    const c = Math.cos(-this.yaw);
    const s = Math.sin(-this.yaw);
    const local = (p: THREE.Vector3, out: THREE.Vector3) => {
      const x = p.x - this.center.x;
      const z = p.z - this.center.z;
      return out.set(x * c + z * s, p.y - this.center.y, -x * s + z * c);
    };
    local(a, _a);
    local(b, _b);
    let t0 = 0;
    let t1 = 1;
    for (const axis of ['x', 'y', 'z'] as const) {
      const p = _a[axis];
      const d = _b[axis] - p;
      const h = this.half[axis];
      if (Math.abs(d) < 1e-9) {
        if (p < -h || p > h) return false;
        continue;
      }
      let u0 = (-h - p) / d;
      let u1 = (h - p) / d;
      if (u0 > u1) [u0, u1] = [u1, u0];
      t0 = Math.max(t0, u0);
      t1 = Math.min(t1, u1);
      if (t0 > t1) return false;
    }
    return true;
  }

  /** Checkpoints: lit up once passed (and back to waiting on a fresh run). */
  setPassed(passed: boolean): void {
    if (this.kind !== 'checkpoint') return;
    const c = new THREE.Color(passed ? PASSED : COLORS.checkpoint);
    this.sheet.uniforms.color.value.copy(c);
    this.sheet.uniforms.strength.value = passed ? 0.1 : 0.22;
    this.lamps.color.copy(c).multiplyScalar(2.4);
  }

  update(time: number): void {
    this.sheet.uniforms.time.value = time;
  }
}
