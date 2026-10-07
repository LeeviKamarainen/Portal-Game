import * as THREE from 'three';
import type { Level } from './Level';
import { glowMaterial, materials } from './Materials';

const BEAM_VERTEX = /* glsl */ `
varying float vH;
void main() {
  vH = uv.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const BEAM_FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float time;
varying float vH;
void main() {
  float bands = 0.75 + 0.25 * sin(vH * 40.0 - time * 4.0);
  float a = (1.0 - vH) * 0.55 * bands;
  gl_FragColor = vec4(color * a, 1.0);
}
`;

/**
 * The exit: a glowing pad with a tall light column that is visible from anywhere in the
 * arena (fog is off for the column), so the objective is always readable.
 */
export class Goal {
  readonly position: THREE.Vector3;
  readonly radius = 1.3;
  private readonly rings: THREE.Mesh[] = [];
  private readonly beam: THREE.ShaderMaterial;

  constructor(level: Level, position: THREE.Vector3) {
    this.position = position.clone();
    const color = new THREE.Color(0x40ffd0);
    const pad = new THREE.Mesh(level.own(new THREE.CylinderGeometry(1.5, 1.6, 0.12, 40)), materials().trim);
    pad.position.copy(position).add(new THREE.Vector3(0, 0.06, 0));
    pad.receiveShadow = true;
    const glow = level.own(glowMaterial(0x40ffd0, 3));
    const ring = new THREE.Mesh(level.own(new THREE.TorusGeometry(1.35, 0.06, 8, 48)), glow);
    ring.rotation.x = Math.PI / 2;
    ring.position.copy(position).add(new THREE.Vector3(0, 0.14, 0));
    level.scene.add(pad, ring);
    for (let i = 0; i < 3; i++) {
      const r = new THREE.Mesh(level.own(new THREE.TorusGeometry(0.9 - i * 0.18, 0.035, 6, 40)), glow);
      r.position.copy(position);
      level.scene.add(r);
      this.rings.push(r);
    }
    this.beam = level.own(
      new THREE.ShaderMaterial({
        uniforms: { color: { value: color }, time: { value: 0 } },
        vertexShader: BEAM_VERTEX,
        fragmentShader: BEAM_FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    const column = new THREE.Mesh(level.own(new THREE.CylinderGeometry(1.1, 1.3, 14, 32, 1, true)), this.beam);
    column.position.copy(position).add(new THREE.Vector3(0, 7, 0));
    level.scene.add(column);
    const light = new THREE.PointLight(0x40ffd0, 4, 10, 1.5);
    light.position.copy(position).add(new THREE.Vector3(0, 1.5, 0));
    level.scene.add(light);
  }

  update(time: number): void {
    this.beam.uniforms.time.value = time;
    this.rings.forEach((r, i) => {
      const phase = (time * 0.5 + i / 3) % 1;
      r.position.y = this.position.y + 0.2 + phase * 2.2;
      r.rotation.set(Math.PI / 2 + Math.sin(time + i) * 0.15, 0, time * (i + 1) * 0.4);
      r.scale.setScalar(1 - phase * 0.35);
    });
  }

  /** Whether a player centred at `p` is standing in the exit. */
  contains(p: THREE.Vector3): boolean {
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    return dx * dx + dz * dz < this.radius * this.radius && p.y > this.position.y - 0.2 && p.y < this.position.y + 3;
  }
}

/** Where the player (re)appears: a ring and an arrow toward the way forward. */
export function addSpawnPad(level: Level, position: THREE.Vector3, yaw: number): void {
  const group = new THREE.Group();
  group.position.copy(position);
  group.rotation.y = yaw;
  const pad = new THREE.Mesh(level.own(new THREE.CylinderGeometry(1.2, 1.3, 0.08, 36)), materials().trim);
  pad.position.y = 0.04;
  pad.receiveShadow = true;
  const glow = level.own(glowMaterial(0xffd27a, 2.2));
  const ring = new THREE.Mesh(level.own(new THREE.TorusGeometry(1.05, 0.04, 6, 40)), glow);
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.1;
  const arrowShape = new THREE.Shape([
    new THREE.Vector2(-0.25, -0.1),
    new THREE.Vector2(0, 0.55),
    new THREE.Vector2(0.25, -0.1),
    new THREE.Vector2(0, 0.1),
  ]);
  const arrow = new THREE.Mesh(level.own(new THREE.ShapeGeometry(arrowShape)), glow);
  arrow.rotation.x = -Math.PI / 2;
  arrow.position.y = 0.09;
  group.add(pad, ring, arrow);
  level.scene.add(group);
}

/** A strip light: emissive bar that the bloom pass turns into a light fixture. */
export function addLightStrip(level: Level, from: THREE.Vector3, to: THREE.Vector3, color = 0xdfe8ff, intensity = 1.15): void {
  const len = from.distanceTo(to);
  const mesh = new THREE.Mesh(level.own(new THREE.BoxGeometry(0.16, 0.06, len)), level.own(glowMaterial(color, intensity)));
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.lookAt(to);
  level.scene.add(mesh);
}
