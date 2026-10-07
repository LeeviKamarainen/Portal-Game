import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { LAYER_AVATAR } from './RenderLayers';
import type { QualitySetting, Settings, ShadowSetting } from './Settings';

/** Far enough that fog always swallows geometry before the far plane can clip it. */
export const CAMERA_FAR = 320;
export const CAMERA_NEAR = 0.03;

/** Vignette, damage flash and fade-to-black, applied after tone mapping. */
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    damage: { value: 0 },
    fade: { value: 0 },
    heal: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float damage;
    uniform float fade;
    uniform float heal;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = vUv - 0.5;
      float r = dot(d, d);
      float vig = smoothstep(0.75, 0.18, r);
      c.rgb *= mix(0.72, 1.0, vig);
      float edge = smoothstep(0.08, 0.5, r);
      c.rgb = mix(c.rgb, vec3(0.75, 0.04, 0.02), damage * (0.25 + 0.75 * edge));
      c.rgb = mix(c.rgb, vec3(0.55, 0.85, 1.0), heal * edge * 0.5);
      c.rgb *= 1.0 - fade;
      gl_FragColor = c;
    }
  `,
};

interface QualityTier {
  pixelRatio: number;
  bloom: boolean;
  shadows: boolean;
  /** How many portals deep a view through a portal can see. */
  portalDepth: number;
}

const BLOOM_STRENGTH = 0.6;
const EXPOSURE = 0.95;

function tiersFor(quality: QualitySetting): QualityTier[] {
  const dpr = window.devicePixelRatio || 1;
  switch (quality) {
    case 'low':
      return [{ pixelRatio: Math.min(dpr, 1) * 0.75, bloom: false, shadows: false, portalDepth: 1 }];
    case 'medium':
      return [{ pixelRatio: Math.min(dpr, 1), bloom: true, shadows: true, portalDepth: 2 }];
    case 'high':
      return [{ pixelRatio: Math.min(dpr, 2), bloom: true, shadows: true, portalDepth: 3 }];
    default:
      return [
        { pixelRatio: Math.min(dpr, 1.5), bloom: true, shadows: true, portalDepth: 3 },
        { pixelRatio: Math.min(dpr, 1.0), bloom: true, shadows: true, portalDepth: 2 },
        { pixelRatio: Math.min(dpr, 1.0) * 0.8, bloom: true, shadows: true, portalDepth: 1 },
        { pixelRatio: Math.min(dpr, 1.0) * 0.65, bloom: false, shadows: false, portalDepth: 1 },
      ];
  }
}

export class Engine {
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly composer: EffectComposer;
  readonly envMap: THREE.Texture;
  readonly finish: ShaderPass;

  private readonly renderPass: RenderPass;
  private readonly bloomPass: UnrealBloomPass;
  private quality: QualitySetting;
  private tiers: QualityTier[];
  private tier = 0;
  private shadowSetting: ShadowSetting = 'high';
  private glow = 1;
  /** Ambient light multiplier; arenas read it when they set up their lights. */
  ambient = 1;
  private frameEma = 1 / 60;
  private slowTime = 0;
  private fastTime = 0;

  constructor(container: HTMLElement, overlayScene: THREE.Scene, overlayCamera: THREE.Camera, quality: QualitySetting) {
    this.quality = quality;
    this.tiers = tiersFor(quality);

    this.camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, CAMERA_NEAR, CAMERA_FAR);
    // The player's own body stays off this camera - it sits inside the avatar's head.
    this.camera.layers.disable(LAYER_AVATAR);

    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(this.tiers[0].pixelRatio);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;
    this.renderer.shadowMap.enabled = this.tiers[0].shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadows are drawn once per frame, not once per portal view (see beginFrame).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.localClippingEnabled = true;
    container.appendChild(this.renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.setPixelRatio(this.tiers[0].pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    this.renderPass = new RenderPass(new THREE.Scene(), this.camera);
    this.composer.addPass(this.renderPass);

    // The first-person gun: drawn over the finished world with depth cleared, so it never
    // sinks into a wall however close the player stands.
    const overlayPass = new RenderPass(overlayScene, overlayCamera);
    overlayPass.clear = false;
    overlayPass.clearDepth = true;
    this.composer.addPass(overlayPass);

    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), BLOOM_STRENGTH, 0.45, 1.15);
    this.bloomPass.enabled = this.tiers[0].bloom;
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.finish);

    window.addEventListener('resize', () => this.onResize());
  }

  setScene(scene: THREE.Scene): void {
    this.renderPass.scene = scene;
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Call before the first render of a frame: the shadow map is refreshed exactly once. */
  beginFrame(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  render(): void {
    this.composer.render();
  }

  /**
   * Applies the menu's graphics options. `quality` is passed separately so a ?quality=
   * flag can override the stored choice.
   */
  applySettings(s: Settings, quality: QualitySetting = s.quality): void {
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    this.ambient = s.ambient;
    this.renderer.toneMappingExposure = EXPOSURE * s.brightness;
    this.glow = s.glow;
    this.bloomPass.strength = BLOOM_STRENGTH * s.glow;
    this.shadowSetting = s.shadows;
    if (quality !== this.quality) {
      this.quality = quality;
      this.tiers = tiersFor(quality);
      this.frameEma = 1 / 60;
    }
    this.applyTier(Math.min(this.tier, this.tiers.length - 1));
  }

  /** Shadow map resolution for the arena's key light. */
  get shadowMapSize(): number {
    return this.shadowSetting === 'low' ? 1024 : 2048;
  }

  get tierIndex(): number {
    return this.tier;
  }

  get portalDepth(): number {
    return this.tiers[this.tier].portalDepth;
  }

  get pixelRatio(): number {
    return this.tiers[this.tier].pixelRatio;
  }

  /**
   * Automatic quality: frame time is smoothed, and a sustained slowdown steps the render
   * resolution (then bloom/shadows) down; sustained headroom steps it back up.
   */
  trackFrame(frameSeconds: number): void {
    if (this.quality !== 'auto') return;
    this.frameEma += (Math.min(frameSeconds, 0.1) - this.frameEma) * 0.05;
    if (this.frameEma > 1 / 52) {
      this.slowTime += frameSeconds;
      this.fastTime = 0;
    } else if (this.frameEma < 1 / 70) {
      this.fastTime += frameSeconds;
      this.slowTime = 0;
    } else {
      this.slowTime = 0;
      this.fastTime = 0;
    }
    if (this.slowTime > 1.5 && this.tier < this.tiers.length - 1) this.applyTier(this.tier + 1);
    else if (this.fastTime > 6 && this.tier > 0) this.applyTier(this.tier - 1);
  }

  get smoothedFrameTime(): number {
    return this.frameEma;
  }

  private applyTier(index: number): void {
    this.tier = index;
    this.slowTime = 0;
    this.fastTime = 0;
    const t = this.tiers[index];
    this.renderer.setPixelRatio(t.pixelRatio);
    this.composer.setPixelRatio(t.pixelRatio);
    this.composer.setSize(window.innerWidth, window.innerHeight);
    this.bloomPass.enabled = t.bloom && this.glow > 0;
    const shadows = t.shadows && this.shadowSetting !== 'off';
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      // Materials compile shadow support in or out; they must rebuild after the switch.
      this.renderPass.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
  }
}
