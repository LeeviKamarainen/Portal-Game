import * as THREE from 'three';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { BotController } from './BotController';

/** The view cone is drawn this long (its real reach is the skill's view range, up to the fog). */
const CONE_LENGTH = 10;
const MAX_ENEMIES = 4;
const MAX_ORBS = 8;

const _eye = new THREE.Vector3();
const _look = new THREE.Quaternion();

function overlay<T extends THREE.Material>(m: T): T {
  m.depthTest = false;
  m.transparent = true;
  return m;
}

/**
 * `?debug=bots`: draws what a bot knows and means to do, over everything - its view cone,
 * the route it is walking, where it remembers enemies (red: seen, yellow: heard; fading
 * with its confidence), the orbs it knows of, what it is aiming at, and a label with its
 * difficulty, goal and walking status. Updated every step; purely visual.
 */
export class BotDebugView {
  readonly object = new THREE.Group();
  private readonly bot: BotController;
  private readonly cone: THREE.LineSegments;
  private readonly route: THREE.Line;
  private readonly enemies: THREE.Mesh[] = [];
  private readonly orbs: THREE.Mesh[] = [];
  private readonly aim: THREE.Mesh;
  private readonly label: THREE.Sprite;
  private readonly canvas = document.createElement('canvas');
  private readonly texture: THREE.CanvasTexture;
  private text = '';

  constructor(bot: BotController, color: number) {
    this.bot = bot;
    this.object.renderOrder = 999;

    const cg = new THREE.BufferGeometry();
    cg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3));
    this.cone = new THREE.LineSegments(cg, overlay(new THREE.LineBasicMaterial({ color, opacity: 0.8 })));

    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(256 * 3), 3));
    this.route = new THREE.Line(rg, overlay(new THREE.LineBasicMaterial({ color: 0x5cf2ff, opacity: 0.9 })));

    const sphere = new THREE.SphereGeometry(0.45, 10, 8);
    for (let i = 0; i < MAX_ENEMIES; i++) {
      const m = new THREE.Mesh(sphere, overlay(new THREE.MeshBasicMaterial({ color: 0xff4040, wireframe: true })));
      this.enemies.push(m);
    }
    const ring = new THREE.TorusGeometry(0.5, 0.05, 6, 20);
    for (let i = 0; i < MAX_ORBS; i++) {
      const m = new THREE.Mesh(ring, overlay(new THREE.MeshBasicMaterial({ color: 0x7dff6a, opacity: 0.9 })));
      m.rotation.x = Math.PI / 2;
      this.orbs.push(m);
    }
    this.aim = new THREE.Mesh(new THREE.OctahedronGeometry(0.25), overlay(new THREE.MeshBasicMaterial({ color: 0xff3df5, wireframe: true })));

    this.canvas.width = 512;
    this.canvas.height = 64;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.label = new THREE.Sprite(overlay(new THREE.SpriteMaterial({ map: this.texture })));
    this.label.scale.set(6.4, 0.8, 1);

    this.object.add(this.cone, this.route, this.aim, this.label, ...this.enemies, ...this.orbs);
    for (const o of this.object.children) o.renderOrder = 999;
  }

  update(): void {
    const { bot } = this;
    const perception = bot.perception;
    const self = bot.self;
    this.object.visible = !!perception && !!self && !self.dead;
    if (!perception || !self || self.dead) return;

    // View cone: a rectangular pyramid, as Perception.inView tests it.
    self.controller.viewPose(_eye, _look);
    const x = Math.tan(bot.skill.fovH) * CONE_LENGTH;
    const y = Math.tan(bot.skill.fovV) * CONE_LENGTH;
    const corners = [
      [-x, -y],
      [x, -y],
      [x, y],
      [-x, y],
    ].map(([cx, cy]) => new THREE.Vector3(cx, cy, -CONE_LENGTH).applyQuaternion(_look).add(_eye));
    const cp = this.cone.geometry.getAttribute('position') as THREE.BufferAttribute;
    corners.forEach((c, i) => {
      const next = corners[(i + 1) % 4];
      cp.setXYZ(i * 4, _eye.x, _eye.y, _eye.z);
      cp.setXYZ(i * 4 + 1, c.x, c.y, c.z);
      cp.setXYZ(i * 4 + 2, c.x, c.y, c.z);
      cp.setXYZ(i * 4 + 3, next.x, next.y, next.z);
    });
    cp.needsUpdate = true;
    this.cone.geometry.computeBoundingSphere();

    // The route ahead.
    const path = bot.follower?.path;
    const rp = this.route.geometry.getAttribute('position') as THREE.BufferAttribute;
    const nodes = path?.nodes.slice(0, rp.count) ?? [];
    nodes.forEach((n, i) => rp.setXYZ(i, n.x, n.y + 0.15, n.z));
    rp.needsUpdate = true;
    this.route.geometry.setDrawRange(0, nodes.length);
    this.route.geometry.computeBoundingSphere();
    this.route.visible = nodes.length > 1;

    // Memory of enemies, fading with confidence.
    const known = [...perception.enemies.values()];
    this.enemies.forEach((m, i) => {
      const e = known[i];
      m.visible = !!e;
      if (!e) return;
      m.position.copy(e.position);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(e.how === 'sight' ? 0xff4040 : 0xffd23a);
      mat.opacity = 0.25 + 0.75 * Math.max(0, e.confidence);
      m.scale.setScalar(e.visible ? 1.3 : 1);
    });

    this.orbs.forEach((m, i) => {
      const o = perception.orbs[i];
      m.visible = !!o;
      if (o) m.position.copy(o);
    });

    const aim = bot.brain?.aim;
    this.aim.visible = !!aim;
    if (aim) this.aim.position.copy(aim.point);

    const pos = self.controller.getPosition();
    this.label.position.set(pos.x, pos.y - PLAYER_FEET_OFFSET + 2.8, pos.z);
    const brain = bot.brain;
    const text = `${bot.skill.name}: ${brain?.goal ?? '-'}${aim?.fire ? ` (${aim.fire})` : ''} · ${bot.follower?.status ?? '-'}`;
    if (text !== this.text) this.drawLabel(text);
  }

  private drawLabel(text: string): void {
    this.text = text;
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = 'rgba(0, 0, 0, 0.55)';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    g.fillStyle = '#ffffff';
    g.font = 'bold 30px monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
    this.texture.needsUpdate = true;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | undefined;
      mat?.dispose();
    });
    this.texture.dispose();
  }
}
