import * as THREE from 'three';
import { LAYER_AVATAR } from '../core/RenderLayers';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { PortalGunModel } from '../player/PortalGunModel';
import { PLAYER_FEET_OFFSET, PLAYER_HEIGHT } from '../player/PlayerController';

/**
 * A turntable of the chosen character in the settings menu. It has its own small renderer
 * and only draws while it is on screen.
 */
export class SkinPreview {
  readonly element: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  private readonly gun = new PortalGunModel('blue');
  private avatar: PlayerAvatar | null = null;
  private skin = '';
  private loading = 0;
  private running = false;
  private last = 0;
  private yaw = 0.5;

  constructor() {
    this.element = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.element, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.camera.layers.enable(LAYER_AVATAR);
    this.camera.position.set(0, PLAYER_HEIGHT * 0.55, 5.4);
    this.camera.lookAt(0, PLAYER_HEIGHT * 0.5, 0);
    this.scene.add(new THREE.HemisphereLight(0xdde6ff, 0x2a2e36, 1.6));
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2);
    key.position.set(2, 4, 3);
    const rim = new THREE.DirectionalLight(0x6ab8ff, 1.4);
    rim.position.set(-3, 2, -3);
    for (const l of [key, rim]) l.layers.enableAll();
    this.scene.add(key, rim);
  }

  async show(skin: string): Promise<void> {
    if (skin === this.skin && this.avatar) return;
    this.skin = skin;
    const ticket = ++this.loading;
    const avatar = await PlayerAvatar.load(skin);
    // A newer pick arrived while this one loaded.
    if (ticket !== this.loading) {
      avatar.dispose();
      return;
    }
    this.avatar?.dispose();
    this.avatar = avatar;
    avatar.attachToHand(this.gun.object);
    this.scene.add(avatar.object);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const tick = (now: number) => {
      if (!this.running) return;
      requestAnimationFrame(tick);
      const dt = Math.min((now - this.last) / 1000, 0.1);
      this.last = now;
      this.draw(dt);
    };
    requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
  }

  private draw(dt: number): void {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (!w || !h) return;
    if (this.element.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.yaw += dt * 0.6;
    this.avatar?.update(dt, {
      position: new THREE.Vector3(0, PLAYER_FEET_OFFSET, 0),
      yaw: this.yaw,
      pitch: 0,
      speed: 0,
      grounded: true,
    });
    this.renderer.render(this.scene, this.camera);
  }
}
