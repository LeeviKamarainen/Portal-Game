import * as THREE from 'three';
import type { Level } from '../Level';
import { BOX_HALF } from './PropBox';
import { PLAYER_FEET_OFFSET } from '../../player/PlayerController';
import { type Hazard, type HazardContext } from './Hazard';

const ACID_VERTEX = /* glsl */ `
varying vec2 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xz;
  vec4 mvPosition = viewMatrix * world;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/** Glowing, churning toxic liquid: the brightest green in the game, so it reads as "no". */
const ACID_FRAGMENT = /* glsl */ `
uniform float time;
varying vec2 vWorld;
#include <fog_pars_fragment>
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 p = vWorld * 0.6;
  float n = noise(p + vec2(time * 0.25, time * 0.18)) * 0.6 + noise(p * 2.3 - vec2(time * 0.4, -time * 0.3)) * 0.4;
  float cells = smoothstep(0.62, 0.7, noise(p * 3.0 + time * 0.5));
  float bubble = smoothstep(0.93, 0.97, noise(vWorld * 2.5 + vec2(0.0, time * 0.9)));
  vec3 deep = vec3(0.03, 0.24, 0.03);
  vec3 bright = vec3(0.26, 0.92, 0.1);
  vec3 col = mix(deep, bright, n) + bright * (cells * 0.25 + bubble * 0.55);
  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * A pit of acid: anything that touches the surface is destroyed. The pit's walls belong to
 * the level; this is the liquid and its kill volume.
 */
export class AcidPool implements Hazard {
  /** The liquid's extent (x, z) and height. */
  readonly min: THREE.Vector2;
  readonly max: THREE.Vector2;
  readonly surfaceY: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly center: THREE.Vector3;

  constructor(level: Level, min: THREE.Vector2, max: THREE.Vector2, surfaceY: number) {
    this.min = min.clone();
    this.max = max.clone();
    this.surfaceY = surfaceY;
    this.material = level.own(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { time: { value: 0 } }]),
        vertexShader: ACID_VERTEX,
        fragmentShader: ACID_FRAGMENT,
        fog: true,
      }),
    );
    const size = max.clone().sub(min);
    const surface = new THREE.Mesh(level.own(new THREE.PlaneGeometry(size.x, size.y, 1, 1)), this.material);
    surface.rotation.x = -Math.PI / 2;
    this.center = new THREE.Vector3((min.x + max.x) / 2, surfaceY, (min.y + max.y) / 2);
    surface.position.copy(this.center);
    level.scene.add(surface);

    // Green spill light so the pit glows up its walls and the room around it.
    const n = Math.max(1, Math.round(Math.max(size.x, size.y) / 10));
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const light = new THREE.PointLight(0x50ff30, 2, 9, 1.4);
      light.position.set(
        size.x >= size.y ? min.x + size.x * t : this.center.x,
        surfaceY + 0.8,
        size.x >= size.y ? this.center.z : min.y + size.y * t,
      );
      level.scene.add(light);
    }
  }

  private inside(x: number, z: number, margin: number): boolean {
    return x > this.min.x - margin && x < this.max.x + margin && z > this.min.y - margin && z < this.max.y + margin;
  }

  covers(p: THREE.Vector3): boolean {
    return this.inside(p.x, p.z, 0.6) && p.y < this.surfaceY + 0.5;
  }

  update(_dt: number, ctx: HazardContext): void {
    this.material.uniforms.time.value = ctx.time;
    for (const player of ctx.players) {
      const p = player.getPosition();
      if (this.inside(p.x, p.z, -0.1) && p.y - PLAYER_FEET_OFFSET < this.surfaceY + 0.05) {
        ctx.sound('sizzle', 0.8, p, 30);
        ctx.kill(player, 'acid');
      }
    }
    for (const box of ctx.props) {
      const b = box.getPosition();
      if (box.visible && this.inside(b.x, b.z, 0) && b.y - BOX_HALF < this.surfaceY) {
        ctx.sound('sizzle', 0.6, b, 25);
        box.setVisible(false);
      }
    }
  }
}
