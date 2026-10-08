import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  FACE_NAMES,
  MAP_KINDS,
  PIECES,
  ROOM_SIDES,
  expandPieces,
  isSymmetric,
  mapKind,
  rotated,
  withDefaults,
  type FieldSpec,
  type MapData,
  type MapKind,
  type Piece,
  type PieceGroup,
  type Vec3,
} from '../world/maps/MapFormat';
import { pieceView } from './PieceViews';
import { BUILT_IN_MAPS, blankMap } from './templates';
import { carried, directlyAttached, faceMotion, shift, surfaceBox, turnAbout } from './Attach';

/**
 * The map editor: build a map from the piece catalogue in 3D, tune every piece in an
 * inspector, and playtest it straight away. Works on the same MapData the game loads, so
 * a saved file drops straight into src/world/maps/.
 *
 * Selection: click a piece (its whole group), Shift/Ctrl+click to add or remove, drag a box
 * over empty space (or Shift/Ctrl+drag anywhere) to select everything in it, Alt+click for
 * one piece out of a group.
 * Whatever is selected moves, turns, copies and deletes together; with "Carry attached"
 * on, pieces standing on, hanging under or mounted on it come along too (see Attach.ts).
 *
 * Mouse: right drag orbits, middle drag (or Shift + right) pans, wheel zooms.
 */

export interface EditorHandlers {
  playtest(map: MapData): void;
  exit(): void;
}

const DRAFT_KEY = 'portal-arena.editor-draft';
const GRID_STEPS = [1, 0.5, 0.25, 2];
/** Pieces that hang on walls and face out of them. */
const MOUNTED = new Set(['ram', 'switch', 'laser', 'receiver', 'target']);
/** Pieces that hang under ceilings. */
const HUNG = new Set(['ceiling-slot', 'lights', 'dropper']);
const GROUPS: PieceGroup[] = ['Structure', 'Hazards', 'Interactive', 'Markers'];
const GROUP_COLORS: Record<PieceGroup, string> = { Structure: '#9fb0c8', Hazards: '#ff7a3a', Interactive: '#c070ff', Markers: '#40d8b0' };

const round = (v: number) => Math.round(v * 1000) / 1000;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const CSS = `
.editor { --text:#e8edf5; --muted:#8e9ab0; --line:rgba(255,255,255,0.1); --panel:rgba(13,16,22,0.94); --accent:#ff7a1a; --blue:#2ab8ff;
  position:absolute; inset:0; z-index:20; pointer-events:none; color:var(--text); font:13px "Segoe UI", system-ui, sans-serif; display:none; }
.editor.open { display:block; }
.editor > * { pointer-events:auto; }
.editor button, .editor input, .editor select, .editor textarea { font:inherit; color:inherit; }
.editor .bar { position:absolute; left:0; right:0; top:0; height:46px; display:flex; align-items:center; gap:6px; padding:0 10px;
  background:var(--panel); border-bottom:1px solid var(--line); box-sizing:border-box; }
.editor .bar .title { font-weight:700; letter-spacing:0.08em; margin-right:8px; white-space:nowrap; }
.editor .bar .title span { color:var(--muted); font-weight:400; letter-spacing:0; margin-left:6px; }
.editor .bar .sep { width:1px; height:24px; background:var(--line); margin:0 4px; }
.editor .bar .grow { flex:1; }
.editor .bar label { white-space:nowrap; display:flex; align-items:center; gap:5px; }
.editor .b { background:rgba(255,255,255,0.05); border:1px solid var(--line); border-radius:5px; padding:5px 10px; cursor:pointer; white-space:nowrap; }
.editor .b:hover { background:rgba(255,255,255,0.11); }
.editor .b:disabled { opacity:0.4; cursor:default; }
.editor .b.primary { background:var(--accent); border-color:var(--accent); color:#160a02; font-weight:650; }
.editor .b.primary:hover { background:#ff9040; }
.editor .b.danger:hover { background:rgba(255,60,60,0.25); }
.editor select, .editor input[type=number], .editor input[type=text], .editor textarea {
  background:rgba(0,0,0,0.35); border:1px solid var(--line); border-radius:4px; padding:4px 6px; }
.editor input[type=number] { width:64px; }
.editor input[type=checkbox] { accent-color:var(--blue); }
.editor .dropdown { position:relative; }
.editor .menu { position:absolute; top:34px; left:0; min-width:190px; background:#151922; border:1px solid var(--line); border-radius:6px;
  padding:4px; display:none; z-index:5; box-shadow:0 8px 24px rgba(0,0,0,0.5); }
.editor .menu.on { display:block; }
.editor .menu button { display:block; width:100%; text-align:left; background:none; border:none; padding:7px 10px; border-radius:4px; cursor:pointer; }
.editor .menu button:hover { background:rgba(255,255,255,0.08); }
.editor .side { position:absolute; top:46px; bottom:28px; background:var(--panel); box-sizing:border-box; overflow:auto; }
.editor .left { left:0; width:220px; border-right:1px solid var(--line); padding:10px; }
.editor .right { right:0; width:300px; border-left:1px solid var(--line); padding:12px 14px; }
.editor h3 { margin:12px 0 6px; font-size:11px; letter-spacing:0.16em; color:var(--muted); font-weight:600; text-transform:uppercase; }
.editor h3:first-child { margin-top:0; }
.editor .pal { display:block; width:100%; text-align:left; background:none; border:1px solid transparent; border-radius:5px; padding:5px 8px; cursor:pointer;
  display:flex; align-items:center; gap:8px; }
.editor .pal:hover { background:rgba(255,255,255,0.06); }
.editor .pal.on { border-color:var(--accent); background:rgba(255,122,26,0.12); }
.editor .pal i { width:8px; height:8px; border-radius:2px; flex-shrink:0; }
.editor .outline { max-height:260px; overflow:auto; border:1px solid var(--line); border-radius:5px; }
.editor .outline button { display:block; width:100%; text-align:left; background:none; border:none; padding:3px 8px; cursor:pointer; font-size:12px;
  color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.editor .outline button:hover { background:rgba(255,255,255,0.06); color:var(--text); }
.editor .outline button.on { background:rgba(255,122,26,0.18); color:var(--text); }
.editor .outline button.carried { color:#7fdcff; }
.editor .outline .grp { color:#c9a8ff; }
.editor .insp-title { font-size:17px; font-weight:650; }
.editor .insp-help { color:var(--muted); margin:4px 0 10px; line-height:1.4; }
.editor .note { color:#7fdcff; margin:6px 0; line-height:1.4; }
.editor .row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin:7px 0; }
.editor .row > label { color:#c4ccda; flex-shrink:0; }
.editor .row .hint { display:block; color:var(--muted); font-size:11px; }
.editor .vec { display:flex; gap:4px; }
.editor .vec input { width:58px; }
.editor .chips { display:flex; flex-wrap:wrap; gap:4px; justify-content:flex-end; max-width:190px; }
.editor .chip { padding:3px 7px; border-radius:4px; border:1px solid var(--line); cursor:pointer; font-size:11px; color:var(--muted); background:none; }
.editor .chip.on { background:var(--blue); border-color:var(--blue); color:#04121c; font-weight:650; }
.editor .actions { display:flex; flex-wrap:wrap; gap:6px; margin-top:14px; }
.editor .sel-list { margin-top:10px; border:1px solid var(--line); border-radius:5px; max-height:220px; overflow:auto; }
.editor .sel-list button { display:block; width:100%; text-align:left; background:none; border:none; padding:3px 8px; cursor:pointer; color:var(--muted); font-size:12px; }
.editor .sel-list button:hover { color:var(--text); background:rgba(255,255,255,0.06); }
.editor .checks { margin-top:8px; padding:0; list-style:none; }
.editor .checks li { padding:5px 8px; border-radius:4px; margin-bottom:4px; background:rgba(255,255,255,0.04); line-height:1.35; }
.editor .checks li.err { background:rgba(255,60,60,0.16); color:#ffb3b3; }
.editor .checks li.ok { color:#8de0a8; }
.editor textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:54px; }
.editor .status { position:absolute; left:0; right:0; bottom:0; height:28px; background:var(--panel); border-top:1px solid var(--line);
  display:flex; align-items:center; gap:16px; padding:0 12px; color:var(--muted); font-size:12px; box-sizing:border-box; }
.editor .status .msg { color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.editor .status .msg.err { color:#ff8f8f; }
.editor .status .coords { margin-left:auto; font-variant-numeric:tabular-nums; white-space:nowrap; }
.editor .toast { position:absolute; left:50%; top:60px; transform:translateX(-50%); background:#3a1518; border:1px solid #ff5a5a; color:#ffd0d0;
  padding:8px 14px; border-radius:6px; max-width:60vw; display:none; }
.editor .marquee { position:fixed; border:1px dashed #ffd040; background:rgba(255,208,64,0.08); pointer-events:none; display:none; }
`;

interface Drag {
  members: number[];
  starts: Map<number, Vec3 | [Vec3, Vec3]>;
  grab: THREE.Vector3;
  plane: THREE.Plane;
  before: string;
  moved: boolean;
}

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  add: boolean;
  /** Shift/Ctrl went down on this piece: a click without dragging toggles it. */
  clicked: number;
  single: boolean;
}

export class Editor {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly handlers: EditorHandlers;
  private readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly world = new THREE.Group();
  private readonly highlights = new THREE.Group();
  private readonly gridHelper: THREE.GridHelper;
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x7fdcff, transparent: true, opacity: 0.22, depthWrite: false });
  private readonly placeMaterial = new THREE.MeshBasicMaterial({ color: 0xffb060, transparent: true, opacity: 0.5, depthWrite: false });
  private map: MapData = blankMap();
  private views: THREE.Object3D[] = [];
  /** Selected piece indices; the last one is the "primary" the inspector shows. */
  private sel: number[] = [];
  /** Pieces that ride along with the selection (attached to it). */
  private riders: number[] = [];
  private carry = true;
  private placing: string | null = null;
  private placeRot = 0;
  private ghost: THREE.Object3D | null = null;
  private ghostPose: { at: Vec3; rot: number; extra?: Partial<Piece> } | null = null;
  private drag: Drag | null = null;
  private marquee: Marquee | null = null;
  private history: string[] = [];
  private future: string[] = [];
  private gridIndex = 0;
  private buildHeight = 0;
  private readonly keys = new Set<string>();
  private active = false;
  private loaded = false;

  constructor(container: HTMLElement, renderer: THREE.WebGLRenderer, envMap: THREE.Texture, handlers: EditorHandlers) {
    this.renderer = renderer;
    this.handlers = handlers;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'editor';
    this.root.innerHTML = this.layout();
    container.appendChild(this.root);
    for (const name of ['palette', 'outline', 'inspector', 'msg', 'coords', 'title', 'toast', 'open-menu', 'grid', 'height', 'undo', 'redo', 'file', 'carry', 'marquee']) {
      this.el[name] = this.root.querySelector(`[data-el="${name}"]`)!;
    }

    this.scene.background = new THREE.Color(0x0d1118);
    this.scene.environment = envMap;
    this.scene.environmentIntensity = 0.35;
    this.scene.add(new THREE.HemisphereLight(0xc4d4ff, 0x30343c, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2e0, 1.4);
    sun.position.set(30, 60, 20);
    this.scene.add(sun, this.world, this.highlights);
    this.gridHelper = new THREE.GridHelper(200, 200, 0x3a4658, 0x1f2633);
    (this.gridHelper.material as THREE.Material).transparent = true;
    (this.gridHelper.material as THREE.Material).opacity = 0.55;
    this.gridHelper.raycast = () => {};
    this.scene.add(this.gridHelper);

    this.camera.position.set(40, 45, 55);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    // Left button is the editor's own (select, place, drag).
    this.controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15;
    this.controls.enabled = false;

    this.bindUi();
    const canvas = renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => this.active && this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.active && this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.active && this.onPointerUp(e));
    window.addEventListener('keydown', (e) => this.active && this.onKey(e));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  get isOpen(): boolean {
    return this.active;
  }

  /** The piece the inspector shows, or -1. */
  get selected(): number {
    return this.sel.length ? this.sel[this.sel.length - 1] : -1;
  }

  get selection(): readonly number[] {
    return this.sel;
  }

  open(): void {
    if (!this.loaded) {
      this.loaded = true;
      this.setMap(this.loadDraft() ?? blankMap(), false);
      this.frameAll();
    }
    this.active = true;
    this.controls.enabled = true;
    this.root.classList.add('open');
    this.status('');
  }

  close(): void {
    this.active = false;
    this.controls.enabled = false;
    this.root.classList.remove('open');
    this.cancelPlacing();
  }

  /** A playtest failed to build: say why. */
  showError(message: string): void {
    this.toast(message);
    this.status(message, true);
  }

  render(dt: number): void {
    this.panCamera(dt);
    this.controls.update();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (this.camera.aspect !== w / h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.setRenderTarget(null);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------- map state

  private setMap(map: MapData, undoable = true): void {
    if (undoable) this.remember();
    this.map = map;
    this.sel = [];
    this.rebuildAll();
    this.afterSelection();
    this.saveDraft();
  }

  private remember(before = JSON.stringify(this.map)): void {
    this.history.push(before);
    if (this.history.length > 200) this.history.shift();
    this.future.length = 0;
    this.updateUndo();
  }

  private undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.map));
    this.restore(prev);
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(JSON.stringify(this.map));
    this.restore(next);
  }

  private restore(json: string): void {
    this.map = JSON.parse(json);
    this.sel = this.sel.filter((i) => i < this.map.pieces.length);
    this.rebuildAll();
    this.afterSelection();
    this.saveDraft();
    this.updateUndo();
  }

  private updateUndo(): void {
    (this.el.undo as HTMLButtonElement).disabled = this.history.length === 0;
    (this.el.redo as HTMLButtonElement).disabled = this.future.length === 0;
  }

  /** After pieces changed: redraw them, the highlights and the panels, and keep the draft. */
  private changed(indices: Iterable<number> | null, refreshInspector = true): void {
    if (indices === null) this.rebuildAll();
    else for (const i of new Set(indices)) this.rebuildOne(i);
    this.riders = this.ridersOf(this.sel);
    this.refreshHighlights();
    this.refreshOutline();
    if (refreshInspector) this.refreshInspector();
    this.saveDraft();
  }

  private saveDraft(): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(this.map));
    } catch {
      // No storage: the draft just doesn't survive a reload.
    }
  }

  private loadDraft(): MapData | null {
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      const data = raw ? (JSON.parse(raw) as MapData) : null;
      return data && Array.isArray(data.pieces) ? data : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- 3D views

  private disposeView(v: THREE.Object3D): void {
    v.removeFromParent();
    v.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
  }

  private viewFor(p: Piece, index: number): THREE.Object3D {
    const group = new THREE.Group();
    const full = withDefaults(p);
    const main = pieceView(full);
    main.userData.pieceIndex = index;
    group.add(main);
    if (isSymmetric(this.map) && !p.center) {
      const mirror = pieceView(rotated(full));
      mirror.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.material = this.ghostMaterial;
        o.userData.mirror = true;
        o.raycast = () => {};
      });
      group.add(mirror);
    }
    group.userData.pieceIndex = index;
    return group;
  }

  private rebuildAll(): void {
    for (const v of this.views) this.disposeView(v);
    this.views = this.map.pieces.map((p, i) => this.viewFor(p, i));
    for (const v of this.views) this.world.add(v);
  }

  private rebuildOne(i: number): void {
    const old = this.views[i];
    if (old) this.disposeView(old);
    this.views[i] = this.viewFor(this.map.pieces[i], i);
    this.world.add(this.views[i]);
  }

  /** Yellow boxes round the selection, blue round what rides along with it. */
  private refreshHighlights(): void {
    for (const h of [...this.highlights.children]) {
      h.removeFromParent();
      (h as THREE.Box3Helper).geometry.dispose();
    }
    const add = (i: number, color: number) => {
      const v = this.views[i]?.children[0];
      if (!v) return;
      const box = new THREE.Box3().setFromObject(v);
      if (!box.isEmpty()) this.highlights.add(new THREE.Box3Helper(box.expandByScalar(0.03), color));
    };
    for (const i of this.riders) add(i, 0x55c8ff);
    for (const i of this.sel) add(i, 0xffd040);
  }

  private frameAll(): void {
    const box = new THREE.Box3();
    for (const v of this.views) box.expandByObject(v.children[0] ?? v);
    if (box.isEmpty()) box.set(new THREE.Vector3(-20, 0, -20), new THREE.Vector3(20, 10, 20));
    this.frameBox(box);
  }

  private frameBox(box: THREE.Box3): void {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(size * 0.35, size * 0.55, size * 0.6));
    this.camera.far = Math.max(600, size * 6);
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- selection

  /** `indices` plus every piece grouped with them. */
  private withGroups(indices: number[]): number[] {
    const groups = new Set(indices.map((i) => this.map.pieces[i]?.group).filter((g): g is string => typeof g === 'string' && !!g));
    if (!groups.size) return indices;
    const out = new Set(indices);
    this.map.pieces.forEach((p, i) => {
      if (typeof p.group === 'string' && groups.has(p.group)) out.add(i);
    });
    // Keep the clicked piece last (the primary).
    const last = indices[indices.length - 1];
    out.delete(last);
    return [...out, last];
  }

  private ridersOf(indices: number[]): number[] {
    if (!this.carry || !indices.length) return [];
    return carried(this.map.pieces, indices);
  }

  private setSelection(indices: number[]): void {
    this.sel = [...new Set(indices)].filter((i) => i >= 0 && i < this.map.pieces.length);
    this.afterSelection();
  }

  private afterSelection(): void {
    this.riders = this.ridersOf(this.sel);
    this.refreshHighlights();
    this.refreshPanels();
    const n = this.sel.length;
    if (n === 1) {
      const p = this.map.pieces[this.sel[0]];
      this.status(`${PIECES[p.type]?.label ?? p.type} selected: drag to move, R to turn, Ctrl+D to copy, Del to remove.${this.riders.length ? ` ${this.riders.length} attached piece(s) come along.` : ''}`);
    } else if (n > 1) {
      this.status(`${n} pieces selected: drag, arrows, R, Ctrl+D and Del act on all of them. Ctrl+G groups them.`);
    } else this.status('');
  }

  /** Click on a piece: replace the selection, or toggle it (Shift/Ctrl); Alt ignores groups. */
  private clickSelect(i: number, toggle: boolean, single: boolean): void {
    const picked = single ? [i] : this.withGroups([i]);
    if (!toggle) return this.setSelection(picked);
    const on = this.sel.includes(i);
    const rest = this.sel.filter((j) => !picked.includes(j));
    this.setSelection(on ? rest : [...rest, ...picked]);
  }

  // ---------------------------------------------------------------- edits on the selection

  /** Moves the selection (and its riders) by `d`. */
  private moveSelection(d: THREE.Vector3): void {
    if (!this.sel.length || d.lengthSq() === 0) return;
    this.remember();
    const members = [...this.sel, ...this.riders];
    for (const i of members) shift(this.map.pieces[i], d);
    this.changed(members);
  }

  /**
   * Turns the selection. One piece turns in place; several turn together about their
   * middle, as do a piece and what's attached to it (in 90 degree steps).
   */
  private turnSelection(deg: number): void {
    if (this.placing) {
      this.placeRot = (((this.placeRot + deg) % 360) + 360) % 360;
      this.updateGhost();
      return;
    }
    if (!this.sel.length) return;
    const pieces = this.map.pieces;
    const together = this.sel.length > 1 || (this.riders.length > 0 && deg % 90 === 0);
    if (!together) {
      const p = pieces[this.sel[0]];
      if (PIECES[p.type].turn === 'none') return;
      if (PIECES[p.type].turn === 'quarter' && deg % 90 !== 0) return;
      this.remember();
      p.rot = ((((p.rot ?? 0) + deg) % 360) + 360) % 360;
      this.changed([this.sel[0]]);
      return;
    }
    if (deg % 90 !== 0) {
      this.status('Several pieces turn together in 90 degree steps only (R / Shift+R).', true);
      return;
    }
    this.remember();
    const members = [...this.sel, ...this.riders];
    const pivot = new THREE.Vector3();
    if (this.sel.length === 1) pivot.set(pieces[this.sel[0]].at[0], 0, pieces[this.sel[0]].at[2]);
    else {
      for (const i of this.sel) pivot.add(new THREE.Vector3(pieces[i].at[0], 0, pieces[i].at[2]));
      pivot.divideScalar(this.sel.length);
      pivot.set(this.snap(pivot.x), 0, this.snap(pivot.z));
    }
    for (const i of members) turnAbout(pieces[i], pivot, deg, PIECES[pieces[i].type].turn !== 'none');
    this.changed(members);
  }

  /** New size for piece `i`; what's attached to a face that moves moves with it. */
  private resize(i: number, size: Vec3): void {
    const p = this.map.pieces[i];
    const before = surfaceBox(p);
    const attached = this.carry ? directlyAttached(this.map.pieces, i).filter((a) => this.map.pieces[a.index].type !== 'room' && !this.sel.includes(a.index)) : [];
    const rides = attached.map((a) => [a.index, ...carried(this.map.pieces, [a.index]).filter((j) => j !== i && !this.sel.includes(j))]);
    p.size = size;
    const after = surfaceBox(p);
    // Each piece moves once: with the face it sits on directly if it does, otherwise with
    // the first attached piece that carries it.
    const motion = new Map<number, THREE.Vector3>();
    if (before && after) {
      attached.forEach((a) => motion.set(a.index, faceMotion(a.face, before, after)));
      attached.forEach((a, k) => {
        for (const j of rides[k]) if (!motion.has(j)) motion.set(j, motion.get(a.index)!);
      });
    }
    const moved: number[] = [i];
    for (const [j, d] of motion) {
      if (d.lengthSq() === 0) continue;
      shift(this.map.pieces[j], d);
      moved.push(j);
    }
    this.changed(moved);
  }

  private deleteSelection(): void {
    if (!this.sel.length) return;
    this.remember();
    const gone = new Set(this.sel);
    this.map.pieces = this.map.pieces.filter((_, i) => !gone.has(i));
    this.sel = [];
    this.rebuildAll();
    this.afterSelection();
    this.saveDraft();
  }

  private duplicateSelection(): void {
    if (!this.sel.length) return;
    this.remember();
    const step = Math.max(1, GRID_STEPS[this.gridIndex]);
    const groupMap = new Map<string, string>();
    const start = this.map.pieces.length;
    for (const i of this.sel) {
      const copy = structuredClone(this.map.pieces[i]);
      shift(copy, new THREE.Vector3(step, 0, step));
      if (typeof copy.id === 'string' && copy.id) copy.id = `${copy.id}-2`;
      if (typeof copy.group === 'string' && copy.group) {
        if (!groupMap.has(copy.group)) groupMap.set(copy.group, this.newGroupId());
        copy.group = groupMap.get(copy.group);
      }
      this.map.pieces.push(copy);
    }
    this.rebuildAll();
    this.setSelection(this.sel.map((_, k) => start + k));
    this.saveDraft();
  }

  private newGroupId(): string {
    const used = new Set(this.map.pieces.map((p) => p.group));
    let n = 1;
    while (used.has(`g${n}`)) n++;
    return `g${n}`;
  }

  private groupSelection(): void {
    if (this.sel.length < 2) {
      this.status('Select two or more pieces to group them.', true);
      return;
    }
    this.remember();
    const id = this.newGroupId();
    for (const i of this.sel) this.map.pieces[i].group = id;
    this.changed([], true);
    this.status(`Grouped ${this.sel.length} pieces as "${id}": clicking any of them selects them all. Ctrl+Shift+G ungroups.`);
  }

  private ungroupSelection(): void {
    if (!this.sel.some((i) => this.map.pieces[i].group)) return;
    this.remember();
    for (const i of this.sel) delete this.map.pieces[i].group;
    this.changed([], true);
    this.status('Ungrouped.');
  }

  /** Single-piece edits from the inspector. */
  private mutatePrimary(fn: (p: Piece) => void, refresh = true): void {
    const i = this.selected;
    if (i < 0) return;
    this.remember();
    fn(this.map.pieces[i]);
    this.changed([i], refresh);
  }

  // ---------------------------------------------------------------- picking

  private setPointer(e: PointerEvent): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private indexOf(o: THREE.Object3D | null): number {
    while (o) {
      if (typeof o.userData.pieceIndex === 'number') return o.userData.pieceIndex;
      o = o.parent;
    }
    return -1;
  }

  /** Surfaces under the pointer, nearest first, with world normals (rooms are seen from inside). */
  private surfaceHits(): { point: THREE.Vector3; normal: THREE.Vector3; index: number; room: boolean }[] {
    const hits = this.raycaster.intersectObjects(this.views, true);
    const out = [];
    for (const h of hits) {
      if (h.object.userData.mirror || !h.face) continue;
      const mesh = h.object as THREE.Mesh;
      const n = h.face.normal.clone().transformDirection(mesh.matrixWorld);
      const mat = Array.isArray(mesh.material) ? mesh.material[h.face.materialIndex] : mesh.material;
      if (mat && (mat as THREE.Material).side === THREE.BackSide) n.negate();
      if (mat && !(mat as THREE.Material).visible) continue;
      out.push({ point: h.point.clone(), normal: n, index: this.indexOf(h.object), room: !!h.object.userData.room });
    }
    return out;
  }

  private snap(v: number): number {
    const s = GRID_STEPS[this.gridIndex];
    return round(Math.round(v / s) * s);
  }

  /** Where a new piece of `type` would go under the pointer. */
  private placementPose(type: string): { at: Vec3; rot: number; extra?: Partial<Piece> } | null {
    const hit = this.surfaceHits()[0];
    const turnable = PIECES[type].turn !== 'none';
    if (hit) {
      const n = hit.normal;
      const p = hit.point;
      if (MOUNTED.has(type) && Math.abs(n.y) < 0.5) {
        // On a wall: stick to it, facing out.
        const yaw = Math.round((Math.atan2(-n.x, -n.z) * 180) / Math.PI / 15) * 15;
        const along = Math.abs(n.x) > Math.abs(n.z) ? [round(p.x), this.snap(p.z)] : [this.snap(p.x), round(p.z)];
        return { at: [along[0], this.snap(p.y), along[1]], rot: ((yaw % 360) + 360) % 360 };
      }
      if (HUNG.has(type) && n.y < -0.5) {
        const extra = type === 'dropper' ? { ceiling: round(p.y) } : undefined;
        return { at: [this.snap(p.x), round(type === 'dropper' ? p.y - 0.8 : p.y), this.snap(p.z)], rot: turnable ? this.placeRot : 0, extra };
      }
      if (n.y > 0.5) {
        const lift = type === 'crate' ? 0.42 : 0;
        return { at: [this.snap(p.x), round(p.y + lift), this.snap(p.z)], rot: turnable ? this.placeRot : 0 };
      }
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.buildHeight);
    const q = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    if (!q) return null;
    return { at: [this.snap(q.x), this.buildHeight, this.snap(q.z)], rot: turnable ? this.placeRot : 0 };
  }

  // ---------------------------------------------------------------- pointer

  private onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.setPointer(e);
    if (this.placing) {
      if (this.ghostPose) this.place(this.placing, this.ghostPose, e.shiftKey);
      return;
    }
    const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
    const hit = this.surfaceHits().find((h) => !h.room && h.index >= 0);
    if (!hit || toggle) {
      // Empty space, or Shift/Ctrl held: drag a selection box (a plain click toggles the piece).
      this.marquee = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, add: toggle, clicked: hit?.index ?? -1, single: e.altKey };
      this.controls.enabled = false;
      return;
    }
    if (e.altKey || !this.sel.includes(hit.index)) this.clickSelect(hit.index, false, e.altKey);
    if (!this.sel.includes(hit.index)) return;
    // Drag everything selected, and what rides on it.
    const members = [...this.sel, ...this.riders];
    const starts = new Map<number, Vec3 | [Vec3, Vec3]>();
    for (const i of members) {
      const p = this.map.pieces[i];
      starts.set(i, Array.isArray(p.to) ? [[...p.at] as Vec3, [...(p.to as Vec3)] as Vec3] : ([...p.at] as Vec3));
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -hit.point.y);
    this.drag = { members, starts, grab: hit.point.clone(), plane, before: JSON.stringify(this.map), moved: false };
    this.controls.enabled = false;
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.marquee) {
      this.marquee.x1 = e.clientX;
      this.marquee.y1 = e.clientY;
      this.drawMarquee();
      return;
    }
    if (e.target !== this.renderer.domElement && !this.drag) return;
    this.setPointer(e);
    if (this.placing) {
      this.updateGhost();
      return;
    }
    const q = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.buildHeight), new THREE.Vector3());
    if (q) this.el.coords.textContent = `x ${q.x.toFixed(1)}  z ${q.z.toFixed(1)}  (y ${this.buildHeight})  grid ${GRID_STEPS[this.gridIndex]} m`;
    const d = this.drag;
    if (!d) return;
    const pt = this.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!pt) return;
    const dx = this.snap(pt.x - d.grab.x);
    const dz = this.snap(pt.z - d.grab.z);
    const primary = this.selected;
    const ps = d.starts.get(primary);
    const startAt = (Array.isArray(ps?.[0]) ? ps![0] : ps) as Vec3;
    const cur = this.map.pieces[primary].at;
    if (round(startAt[0] + dx) === cur[0] && round(startAt[2] + dz) === cur[2]) return;
    if (!d.moved) {
      this.remember(d.before);
      d.moved = true;
    }
    for (const i of d.members) {
      const s = d.starts.get(i)!;
      const p = this.map.pieces[i];
      const at = (Array.isArray(s[0]) ? s[0] : s) as Vec3;
      p.at = [round(at[0] + dx), at[1], round(at[2] + dz)];
      if (Array.isArray(s[0])) {
        const to = s[1] as Vec3;
        p.to = [round(to[0] + dx), to[1], round(to[2] + dz)];
      }
      this.rebuildOne(i);
    }
    this.refreshHighlights();
  }

  private onPointerUp(e: PointerEvent): void {
    if (this.marquee) {
      this.finishMarquee(e);
      this.controls.enabled = true;
      return;
    }
    if (this.drag) {
      if (this.drag.moved) this.changed(this.drag.members);
      this.drag = null;
      this.controls.enabled = true;
    }
  }

  private drawMarquee(): void {
    const m = this.marquee!;
    const r = this.el.marquee;
    r.style.display = 'block';
    r.style.left = `${Math.min(m.x0, m.x1)}px`;
    r.style.top = `${Math.min(m.y0, m.y1)}px`;
    r.style.width = `${Math.abs(m.x1 - m.x0)}px`;
    r.style.height = `${Math.abs(m.y1 - m.y0)}px`;
  }

  /** Selects every piece (not rooms) whose middle lies inside the dragged box. */
  private finishMarquee(e: PointerEvent): void {
    const m = this.marquee!;
    this.marquee = null;
    this.el.marquee.style.display = 'none';
    const small = Math.abs(m.x1 - m.x0) < 5 && Math.abs(m.y1 - m.y0) < 5;
    if (small) {
      if (m.clicked >= 0) this.clickSelect(m.clicked, true, m.single);
      else if (!m.add) this.setSelection([]);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const [x0, x1] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1)];
    const [y0, y1] = [Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
    const inside: number[] = [];
    this.map.pieces.forEach((p, i) => {
      if (p.type === 'room') return;
      const v = this.views[i]?.children[0];
      if (!v) return;
      const c = new THREE.Box3().setFromObject(v).getCenter(new THREE.Vector3()).project(this.camera);
      if (c.z > 1) return;
      const sx = rect.left + ((c.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - c.y) / 2) * rect.height;
      if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) inside.push(i);
    });
    const picked = inside.length ? this.withGroups(inside) : [];
    this.setSelection(m.add || e.shiftKey ? [...this.sel, ...picked] : picked);
  }

  // ---------------------------------------------------------------- placing

  private startPlacing(type: string): void {
    this.cancelPlacing();
    this.placing = type;
    this.setSelection([]);
    this.refreshPalette();
    this.status(`Placing ${PIECES[type].label}: click to place, Shift+click to keep placing, R to turn, Esc to stop.`);
  }

  private cancelPlacing(): void {
    this.placing = null;
    this.ghostPose = null;
    if (this.ghost) this.disposeView(this.ghost);
    this.ghost = null;
    this.refreshPalette();
  }

  private updateGhost(): void {
    if (!this.placing) return;
    const pose = this.placementPose(this.placing);
    this.ghostPose = pose;
    if (this.ghost) this.disposeView(this.ghost);
    this.ghost = null;
    if (!pose) return;
    const piece = withDefaults({ type: this.placing, at: pose.at, rot: pose.rot, ...pose.extra });
    this.ghost = pieceView(piece);
    this.ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = this.placeMaterial;
      o.raycast = () => {};
    });
    this.scene.add(this.ghost);
    this.el.coords.textContent = `at ${pose.at.join(', ')}  turn ${pose.rot}°`;
  }

  private place(type: string, pose: { at: Vec3; rot: number; extra?: Partial<Piece> }, keepGoing: boolean): void {
    this.remember();
    const spec = PIECES[type];
    const piece: Piece = { type, at: pose.at, ...structuredClone(spec.defaults ?? {}), ...pose.extra };
    if (spec.turn !== 'none') piece.rot = pose.rot;
    this.map.pieces.push(piece);
    const i = this.map.pieces.length - 1;
    this.views[i] = this.viewFor(piece, i);
    this.world.add(this.views[i]);
    this.saveDraft();
    if (keepGoing) {
      this.refreshOutline();
      return;
    }
    this.cancelPlacing();
    this.setSelection([i]);
  }

  // ---------------------------------------------------------------- keyboard

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const step = GRID_STEPS[this.gridIndex];
    const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    let handled = true;
    if (ctrl && e.code === 'KeyZ') e.shiftKey ? this.redo() : this.undo();
    else if (ctrl && e.code === 'KeyY') this.redo();
    else if (ctrl && e.code === 'KeyD') this.duplicateSelection();
    else if (ctrl && e.code === 'KeyA') this.setSelection(this.map.pieces.map((_, i) => i).filter((i) => this.map.pieces[i].type !== 'room'));
    else if (ctrl && e.code === 'KeyG') e.shiftKey ? this.ungroupSelection() : this.groupSelection();
    else if (ctrl) handled = false;
    else if (e.code === 'Escape') this.placing ? this.cancelPlacing() : this.setSelection([]);
    else if (e.code === 'Delete' || e.code === 'Backspace') this.deleteSelection();
    else if (e.code === 'KeyR') this.turnSelection(e.altKey ? (e.shiftKey ? -15 : 15) : e.shiftKey ? -90 : 90);
    else if (e.code === 'ArrowLeft') this.moveSelection(V(-step, 0, 0));
    else if (e.code === 'ArrowRight') this.moveSelection(V(step, 0, 0));
    else if (e.code === 'ArrowUp') this.moveSelection(V(0, 0, -step));
    else if (e.code === 'ArrowDown') this.moveSelection(V(0, 0, step));
    else if (e.code === 'PageUp') this.moveSelection(V(0, step, 0));
    else if (e.code === 'PageDown') this.moveSelection(V(0, -step, 0));
    else if (e.code === 'BracketRight') this.setBuildHeight(this.buildHeight + step);
    else if (e.code === 'BracketLeft') this.setBuildHeight(this.buildHeight - step);
    else if (e.code === 'KeyG') this.setGrid((this.gridIndex + 1) % GRID_STEPS.length);
    else if (e.code === 'KeyF') this.frameSelection();
    else if (e.code === 'KeyC') this.setCarry(!this.carry);
    else if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE'].includes(e.code)) this.keys.add(e.code);
    else handled = false;
    if (handled) e.preventDefault();
  }

  /** WASD slides the camera across the map, Q/E down and up. */
  private panCamera(dt: number): void {
    if (this.keys.size === 0) return;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const speed = Math.max(6, dist * 0.9) * dt;
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    const move = new THREE.Vector3();
    if (this.keys.has('KeyW')) move.add(fwd);
    if (this.keys.has('KeyS')) move.sub(fwd);
    if (this.keys.has('KeyD')) move.add(right);
    if (this.keys.has('KeyA')) move.sub(right);
    if (this.keys.has('KeyE')) move.y += 1;
    if (this.keys.has('KeyQ')) move.y -= 1;
    if (move.lengthSq() === 0) return;
    move.normalize().multiplyScalar(speed);
    this.camera.position.add(move);
    this.controls.target.add(move);
  }

  private frameSelection(): void {
    if (!this.sel.length) return this.frameAll();
    const box = new THREE.Box3();
    for (const i of this.sel) box.expandByObject(this.views[i].children[0]);
    box.expandByScalar(4);
    this.frameBox(box);
  }

  private setGrid(i: number): void {
    this.gridIndex = i;
    (this.el.grid as HTMLSelectElement).value = String(i);
    this.gridHelper.scale.setScalar(GRID_STEPS[i]);
  }

  private setBuildHeight(y: number): void {
    this.buildHeight = round(y);
    this.gridHelper.position.y = this.buildHeight;
    (this.el.height as HTMLInputElement).value = String(this.buildHeight);
    if (this.placing) this.updateGhost();
  }

  private setCarry(on: boolean): void {
    this.carry = on;
    (this.el.carry as HTMLInputElement).checked = on;
    this.afterSelection();
  }

  // ---------------------------------------------------------------- panels

  private layout(): string {
    return `
      <div class="bar">
        <div class="title">MAP EDITOR<span data-el="title"></span></div>
        <button class="b" data-act="new" title="Start from the blank template">New</button>
        <div class="dropdown">
          <button class="b" data-act="open">Open ▾</button>
          <div class="menu" data-el="open-menu">
            ${BUILT_IN_MAPS.map((m, i) => `<button data-act="builtin" data-i="${i}">${esc(m.label)}</button>`).join('')}
            <button data-act="file">From a .json file…</button>
          </div>
        </div>
        <button class="b" data-act="save" title="Download the map as a .json file">Save .json</button>
        <button class="b" data-act="copy" title="Copy the map's JSON">Copy JSON</button>
        <div class="sep"></div>
        <button class="b" data-act="undo" data-el="undo" title="Ctrl+Z">Undo</button>
        <button class="b" data-act="redo" data-el="redo" title="Ctrl+Y">Redo</button>
        <div class="sep"></div>
        <label>Grid <select data-el="grid">${GRID_STEPS.map((s, i) => `<option value="${i}">${s} m</option>`).join('')}</select></label>
        <label title="Height of the build plane ([ and ])">Height <input type="number" step="0.5" value="0" data-el="height"></label>
        <label title="Pieces standing on, hanging under or mounted on what you move, turn or resize go with it (C)"><input type="checkbox" data-el="carry" checked> Carry attached</label>
        <div class="grow"></div>
        <button class="b primary" data-act="play">▶ Playtest</button>
        <button class="b" data-act="exit">Exit</button>
        <input type="file" accept=".json,application/json" data-el="file" hidden>
      </div>
      <div class="side left">
        <h3>Pieces</h3>
        <div data-el="palette"></div>
        <h3>In this map</h3>
        <div class="outline" data-el="outline"></div>
      </div>
      <div class="side right" data-el="inspector"></div>
      <div class="status"><span class="msg" data-el="msg"></span><span class="coords" data-el="coords"></span></div>
      <div class="toast" data-el="toast"></div>
      <div class="marquee" data-el="marquee"></div>`;
  }

  private bindUi(): void {
    this.root.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      const menu = this.el['open-menu'];
      if (!btn || btn.dataset.act !== 'open') menu.classList.remove('on');
      if (!btn) return;
      const toggle = e.shiftKey || e.ctrlKey || e.metaKey;
      switch (btn.dataset.act) {
        case 'new':
          this.setMap(blankMap());
          this.frameAll();
          break;
        case 'open':
          menu.classList.toggle('on');
          break;
        case 'builtin':
          this.setMap(BUILT_IN_MAPS[Number(btn.dataset.i)].data());
          this.frameAll();
          break;
        case 'file':
          (this.el.file as HTMLInputElement).click();
          break;
        case 'save':
          this.download();
          break;
        case 'copy':
          void navigator.clipboard?.writeText(this.json()).then(
            () => this.status('Map JSON copied to the clipboard.'),
            () => this.status('Could not copy - use Save instead.', true),
          );
          break;
        case 'undo':
          this.undo();
          break;
        case 'redo':
          this.redo();
          break;
        case 'play':
          this.playtest();
          break;
        case 'exit':
          this.handlers.exit();
          break;
        case 'pick':
          if (this.placing === btn.dataset.type) this.cancelPlacing();
          else this.startPlacing(btn.dataset.type!);
          break;
        case 'outline':
          this.cancelPlacing();
          this.clickSelect(Number(btn.dataset.i), toggle, e.altKey);
          break;
        case 'only':
          this.setSelection([Number(btn.dataset.i)]);
          break;
        case 'turn':
          this.turnSelection(Number(btn.dataset.deg));
          break;
        case 'dup':
          this.duplicateSelection();
          break;
        case 'del':
          this.deleteSelection();
          break;
        case 'frame':
          this.frameSelection();
          break;
        case 'group':
          this.groupSelection();
          break;
        case 'ungroup':
          this.ungroupSelection();
          break;
        case 'chip':
          this.toggleChip(btn);
          break;
      }
    });
    (this.el.grid as HTMLSelectElement).addEventListener('change', (e) => this.setGrid(Number((e.target as HTMLSelectElement).value)));
    (this.el.height as HTMLInputElement).addEventListener('change', (e) => this.setBuildHeight(Number((e.target as HTMLInputElement).value) || 0));
    (this.el.carry as HTMLInputElement).addEventListener('change', (e) => this.setCarry((e.target as HTMLInputElement).checked));
    (this.el.file as HTMLInputElement).addEventListener('change', async (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text()) as MapData;
        if (!Array.isArray(data.pieces)) throw new Error('not a map file (no "pieces")');
        this.setMap(data);
        this.frameAll();
        this.status(`Opened ${f.name}.`);
      } catch (err) {
        this.showError(`Could not open ${f.name}: ${(err as Error).message}`);
      }
      (e.target as HTMLInputElement).value = '';
    });
    this.el.inspector.addEventListener('change', (e) => this.onField(e.target as HTMLInputElement));
  }

  private refreshPanels(): void {
    this.refreshPalette();
    this.refreshOutline();
    this.refreshInspector();
    this.el.title.textContent = this.map.name ? `· ${this.map.name}` : '';
    this.updateUndo();
  }

  private refreshPalette(): void {
    this.el.palette.innerHTML = GROUPS.map(
      (g) =>
        `<h3>${g}</h3>` +
        Object.entries(PIECES)
          .filter(([, s]) => s.group === g)
          .map(
            ([type, s]) =>
              `<button class="pal ${this.placing === type ? 'on' : ''}" data-act="pick" data-type="${type}" title="${esc(s.help)}"><i style="background:${GROUP_COLORS[g]}"></i>${esc(s.label)}</button>`,
          )
          .join(''),
    ).join('');
  }

  private pieceLabel(i: number): string {
    const p = this.map.pieces[i];
    const label = PIECES[p.type]?.label ?? p.type;
    const id = typeof p.id === 'string' && p.id ? ` "${esc(p.id)}"` : '';
    const grp = typeof p.group === 'string' && p.group ? ` <span class="grp">[${esc(p.group)}]</span>` : '';
    return `${i}. ${esc(label)}${id}${grp} <span>(${p.at.join(', ')})</span>`;
  }

  private refreshOutline(): void {
    const sel = new Set(this.sel);
    const riders = new Set(this.riders);
    this.el.outline.innerHTML = this.map.pieces
      .map((_, i) => `<button class="${sel.has(i) ? 'on' : riders.has(i) ? 'carried' : ''}" data-act="outline" data-i="${i}">${this.pieceLabel(i)}</button>`)
      .join('');
    this.el.outline.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }

  private refreshInspector(): void {
    if (this.sel.length === 0) {
      this.el.inspector.innerHTML = this.mapPanel();
      return;
    }
    if (this.sel.length > 1) {
      this.el.inspector.innerHTML = this.multiPanel();
      return;
    }
    const i = this.sel[0];
    const p = this.map.pieces[i];
    const spec = PIECES[p.type];
    const full = withDefaults(p);
    const rows: string[] = [];
    rows.push(`<div class="insp-title">${esc(spec?.label ?? p.type)}</div><div class="insp-help">${esc(spec?.help ?? '')}</div>`);
    if (this.riders.length) rows.push(`<div class="note">${this.riders.length} attached piece(s) move with it (blue outlines).</div>`);
    if (typeof p.group === 'string' && p.group) rows.push(`<div class="note">In group "${esc(p.group)}" (Alt+click picks one piece).</div>`);
    rows.push(this.vecRow('Position', 'at', p.at));
    if (spec?.sizeLabels && full.size) {
      rows.push(
        `<div class="row"><label>Size</label><div class="vec">${full.size
          .map((v, k) => (spec.sizeLabels![k] === '-' ? '' : `<input type="number" step="0.1" data-key="size" data-k="${k}" value="${v}" title="${spec.sizeLabels![k]}">`))
          .join('')}</div></div><div class="row"><span class="hint">${spec.sizeLabels.filter((l) => l !== '-').join(' · ')}</span></div>`,
      );
    }
    if (spec && spec.turn !== 'none') {
      rows.push(`<div class="row"><label>Turn</label><div class="vec">
        <button class="b" data-act="turn" data-deg="-90" title="Shift+R">⟲</button>
        <input type="number" step="${spec.turn === 'quarter' ? 90 : 15}" data-key="rot" value="${p.rot ?? 0}">
        <button class="b" data-act="turn" data-deg="90" title="R">⟳</button></div></div>`);
    }
    if (isSymmetric(this.map)) {
      rows.push(`<div class="row"><label title="Placed once, on the symmetry centre - not copied to the other half">On the centre</label><input type="checkbox" data-key="center" ${p.center ? 'checked' : ''}></div>`);
    }
    for (const f of spec?.fields ?? []) rows.push(this.fieldRow(f, full));
    rows.push(`<div class="actions">
      <button class="b" data-act="frame" title="F">Focus</button>
      <button class="b" data-act="dup" title="Ctrl+D">Duplicate</button>
      ${p.group ? '<button class="b" data-act="ungroup" title="Ctrl+Shift+G">Ungroup</button>' : ''}
      <button class="b danger" data-act="del" title="Del">Delete</button></div>`);
    this.el.inspector.innerHTML = rows.join('');
  }

  private multiPanel(): string {
    const n = this.sel.length;
    const grouped = this.sel.some((i) => this.map.pieces[i].group);
    return `
      <div class="insp-title">${n} pieces selected</div>
      <div class="insp-help">They move, turn, copy and delete together. Shift/Ctrl+click adds or removes pieces; Shift+drag a box to pick more.</div>
      ${this.riders.length ? `<div class="note">${this.riders.length} attached piece(s) come along (blue outlines).</div>` : ''}
      <div class="row"><label>Move by</label><div class="vec">${[0, 1, 2].map((k) => `<input type="number" step="0.5" data-key="move-by" data-k="${k}" value="0" title="${'xyz'[k]}">`).join('')}</div></div>
      <div class="row"><label>Turn together</label><div class="vec">
        <button class="b" data-act="turn" data-deg="-90" title="Shift+R">⟲ 90°</button>
        <button class="b" data-act="turn" data-deg="90" title="R">⟳ 90°</button></div></div>
      <div class="actions">
        <button class="b" data-act="group" title="Ctrl+G">Group</button>
        ${grouped ? '<button class="b" data-act="ungroup" title="Ctrl+Shift+G">Ungroup</button>' : ''}
        <button class="b" data-act="frame" title="F">Focus</button>
        <button class="b" data-act="dup" title="Ctrl+D">Duplicate</button>
        <button class="b danger" data-act="del" title="Del">Delete</button>
      </div>
      <div class="sel-list">${this.sel.map((i) => `<button data-act="only" data-i="${i}" title="Edit just this one">${this.pieceLabel(i)}</button>`).join('')}</div>`;
  }

  private vecRow(label: string, key: string, v: Vec3): string {
    return `<div class="row"><label>${label}</label><div class="vec">${v.map((x, k) => `<input type="number" step="0.5" data-key="${key}" data-k="${k}" value="${x}">`).join('')}</div></div>`;
  }

  private fieldRow(f: FieldSpec, p: Piece): string {
    const v = p[f.key];
    const hint = f.hint ? `<span class="hint">${esc(f.hint)}</span>` : '';
    const label = `<label>${esc(f.label)}${hint}</label>`;
    switch (f.kind) {
      case 'number':
        return `<div class="row">${label}<input type="number" step="${f.step ?? 0.1}" data-key="${f.key}" data-kind="number" value="${v ?? ''}"></div>`;
      case 'text':
        return `<div class="row">${label}<input type="text" data-key="${f.key}" data-kind="text" value="${esc(String(v ?? ''))}"></div>`;
      case 'ids':
        return `<div class="row">${label}<input type="text" data-key="${f.key}" data-kind="ids" value="${esc(((v as string[] | undefined) ?? []).join(', '))}"></div>`;
      case 'select':
        return `<div class="row">${label}<select data-key="${f.key}" data-kind="select">${f.options!.map((o) => `<option value="${o}" ${String(v ?? '') === o ? 'selected' : ''}>${o || '(none)'}</option>`).join('')}</select></div>`;
      case 'bool':
        return `<div class="row">${label}<input type="checkbox" data-key="${f.key}" data-kind="bool" ${v === false ? '' : 'checked'}></div>`;
      case 'color':
        return `<div class="row">${label}<input type="color" data-key="${f.key}" data-kind="color" value="${typeof v === 'string' ? v : '#dfe8ff'}"></div>`;
      case 'vec3': {
        const vec = (Array.isArray(v) ? v : [p.at[0], p.at[1], p.at[2] - 8]) as Vec3;
        return `<div class="row">${label}<div class="vec">${vec.map((x, k) => `<input type="number" step="0.5" data-key="${f.key}" data-kind="vec3" data-k="${k}" value="${x}">`).join('')}</div></div>`;
      }
      case 'faces':
      case 'sides': {
        const names = f.kind === 'faces' ? FACE_NAMES : ROOM_SIDES;
        const on = this.expandNames((v as string[] | undefined) ?? [], f.kind);
        return `<div class="row">${label}<div class="chips">${names
          .map((n) => `<button class="chip ${on.has(n) ? 'on' : ''}" data-act="chip" data-key="${f.key}" data-kind="${f.kind}" data-name="${n}">${n}</button>`)
          .join('')}</div></div>`;
      }
    }
  }

  private expandNames(list: string[], kind: 'faces' | 'sides'): Set<string> {
    const out = new Set<string>();
    for (const n of list) {
      if (kind === 'faces' && n === 'all') FACE_NAMES.forEach((x) => out.add(x));
      else if (kind === 'faces' && n === 'sides') ['front', 'back', 'left', 'right'].forEach((x) => out.add(x));
      else if (kind === 'sides' && n === 'walls') ['north', 'south', 'east', 'west'].forEach((x) => out.add(x));
      else out.add(n);
    }
    return out;
  }

  private toggleChip(btn: HTMLElement): void {
    const key = btn.dataset.key!;
    const kind = btn.dataset.kind as 'faces' | 'sides';
    const name = btn.dataset.name!;
    this.mutatePrimary((p) => {
      const set = this.expandNames((withDefaults(p)[key] as string[] | undefined) ?? [], kind);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      p[key] = [...set];
    });
  }

  private onField(input: HTMLInputElement): void {
    const key = input.dataset.key;
    if (!key) return;
    if (this.sel.length === 0) return this.onMapField(input);
    const kind = input.dataset.kind;
    const k = input.dataset.k === undefined ? -1 : Number(input.dataset.k);
    const value = round(Number(input.value) || 0);
    if (key === 'move-by') {
      const d = new THREE.Vector3();
      d.setComponent(k, value);
      this.moveSelection(d);
      return;
    }
    const i = this.selected;
    const p = this.map.pieces[i];
    if (key === 'at') {
      // Moving one piece by its numbers carries what's attached, like dragging it.
      const d = new THREE.Vector3();
      d.setComponent(k, value - p.at[k]);
      this.moveSelection(d);
      return;
    }
    if (key === 'size') {
      this.remember();
      const next = [...(withDefaults(p).size as Vec3)] as Vec3;
      next[k] = value;
      this.resize(i, next);
      return;
    }
    this.mutatePrimary((q) => {
      if (kind === 'vec3') {
        const next = [...((q[key] as Vec3 | undefined) ?? [q.at[0], q.at[1], q.at[2] - 8])] as Vec3;
        next[k] = value;
        q[key] = next;
      } else if (key === 'rot') {
        q.rot = ((Math.round(Number(input.value) || 0) % 360) + 360) % 360;
      } else if (key === 'center') {
        if (input.checked) q.center = true;
        else delete q.center;
      } else if (kind === 'number') {
        if (input.value === '') delete q[key];
        else q[key] = Number(input.value);
      } else if (kind === 'bool') {
        q[key] = input.checked;
      } else if (kind === 'ids') {
        q[key] = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      } else if (kind === 'select' && input.value === '') {
        delete q[key];
      } else {
        q[key] = input.value;
      }
    }, kind !== 'number' && kind !== 'text');
  }

  private mapPanel(): string {
    const m = this.map;
    const checks = this.validate();
    return `
      <div class="insp-title">Map</div>
      <div class="insp-help">Nothing selected. Pick a piece on the left to place it, click one in the view to edit it, or drag a box to select several.</div>
      <div class="row"><label>Name</label><input type="text" data-key="name" value="${esc(m.name)}"></div>
      <div class="row"><label>Id</label><input type="text" data-key="id" value="${esc(m.id)}"></div>
      <div class="row"><label>Card line</label><input type="text" data-key="blurb" value="${esc(m.blurb ?? '')}"></div>
      <label>On-screen hint</label><textarea data-key="hint">${esc(m.hint)}</textarea>
      <div class="row"><label title="${esc(MAP_KINDS.map((k) => `${k.label}: ${k.help}`).join(' · '))}">Level type</label>
        <select data-key="kind">${MAP_KINDS.map((k) => `<option value="${k.id}" ${mapKind(m) === k.id ? 'selected' : ''}>${k.label}</option>`).join('')}</select></div>
      <div class="insp-help">${esc(MAP_KINDS.find((k) => k.id === mapKind(m))!.help)}</div>
      ${
        mapKind(m) === 'combat'
          ? `<div class="row"><label title="Copy everything not marked 'on the centre' with a half turn, swapping teams">Symmetry</label>
        <select data-key="symmetry"><option value="rotate180" ${m.symmetry === 'rotate180' ? 'selected' : ''}>Half turn (2 teams)</option><option value="none" ${m.symmetry !== 'rotate180' ? 'selected' : ''}>None</option></select></div>`
          : ''
      }
      <div class="row"><label>Fog colour</label><input type="color" data-key="fog.color" value="${m.fog?.color ?? '#0c1018'}"></div>
      <div class="row"><label>Fog near / far</label><div class="vec"><input type="number" step="5" data-key="fog.near" value="${m.fog?.near ?? 40}"><input type="number" step="5" data-key="fog.far" value="${m.fog?.far ?? 160}"></div></div>
      <div class="row"><label>Death below y</label><input type="number" step="0.5" data-key="killY" value="${m.killY ?? -6}"></div>
      <h3>Checks</h3>
      <ul class="checks">${checks.length ? checks.map((c) => `<li class="err">${esc(c)}</li>`).join('') : '<li class="ok">Ready to playtest.</li>'}</ul>
      <h3>Keys</h3>
      <div class="insp-help">Shift/Ctrl+click add to selection · Shift+drag (or drag on empty space): box select · Ctrl+A all · Ctrl+G group, Ctrl+Shift+G ungroup · Alt+click one piece of a group · C carry attached on/off · R / Shift+R turn · Alt+R fine turn · arrows move · PgUp/PgDn raise · Del remove · Ctrl+D copy · Ctrl+Z undo · F focus · G grid · [ ] build height · WASD/QE camera</div>`;
  }

  private onMapField(input: HTMLInputElement): void {
    const key = input.dataset.key!;
    this.remember();
    const m = this.map;
    const fog = (m.fog ??= { color: '#0c1018', near: 40, far: 160 });
    if (key === 'fog.color') fog.color = input.value;
    else if (key === 'fog.near') fog.near = Number(input.value) || 0;
    else if (key === 'fog.far') fog.far = Number(input.value) || 0;
    else if (key === 'killY') m.killY = Number(input.value);
    else if (key === 'symmetry') {
      m.symmetry = input.value as MapData['symmetry'];
      this.rebuildAll();
    } else if (key === 'kind') {
      m.kind = input.value as MapKind;
      this.rebuildAll();
    } else (m as unknown as Record<string, string>)[key] = input.value;
    this.saveDraft();
    this.refreshPanels();
  }

  /** Problems that would stop the map from playing, in plain words. */
  private validate(): string[] {
    const out: string[] = [];
    let pieces: Piece[] = [];
    try {
      pieces = expandPieces(this.map);
    } catch (e) {
      return [(e as Error).message];
    }
    if (!pieces.some((p) => p.type === 'spawn')) out.push('Add a spawn point - there is nowhere to start.');
    const goals = pieces.filter((p) => p.type === 'goal').length;
    if (mapKind(this.map) === 'puzzle') {
      if (goals === 0) out.push('A puzzle needs an exit goal (Markers → Exit goal) - nothing ends the level yet.');
      if (goals > 1) out.push('A puzzle has one exit goal; remove the extra ones.');
    }
    if (!pieces.some((p) => p.type === 'room')) out.push('No room shell: the map has no outer walls or sky cover.');
    const ids = new Set(pieces.map((p) => p.id).filter((x): x is string => typeof x === 'string' && !!x));
    const has = (id: string) => ids.has(id) || (id.endsWith('~') && ids.has(id.replace(/~+$/, '')));
    for (const p of pieces) {
      for (const id of (p.targets as string[] | undefined) ?? []) if (!has(id)) out.push(`A switch at (${p.at.join(', ')}) sets off "${id}", but nothing has that id.`);
      if (p.type === 'door' && typeof p.receiver === 'string' && !has(p.receiver)) out.push(`A door at (${p.at.join(', ')}) waits for receiver "${p.receiver}", which doesn't exist.`);
    }
    this.views.forEach((v, i) => {
      v.traverse((o) => {
        if (o.userData.broken && !o.userData.mirror) out.push(`Piece ${i} (${this.map.pieces[i].type}) has settings that don't work - check its numbers.`);
      });
    });
    return [...new Set(out)].slice(0, 12);
  }

  // ---------------------------------------------------------------- output

  private json(): string {
    const { pieces, ...rest } = this.map;
    const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
    return `${head},\n  "pieces": [\n${pieces.map((p) => `    ${JSON.stringify(p)}`).join(',\n')}\n  ]\n}\n`;
  }

  private download(): void {
    const blob = new Blob([this.json()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${this.map.id || 'map'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    this.status(`Saved ${a.download}. Put it in src/world/maps/ to ship it with the game.`);
  }

  private playtest(): void {
    const problems = this.validate();
    if (problems.length) {
      this.showError(`Can't playtest yet: ${problems[0]}`);
      return;
    }
    this.cancelPlacing();
    this.handlers.playtest(structuredClone(this.map));
  }

  private status(text: string, error = false): void {
    this.el.msg.textContent = text || 'Pick a piece to place · click a piece to edit it · Shift+drag to box-select · right-drag orbit, middle-drag pan, wheel zoom';
    this.el.msg.classList.toggle('err', error);
  }

  private toast(text: string): void {
    const t = this.el.toast;
    t.textContent = text;
    t.style.display = 'block';
    clearTimeout((t as unknown as { timer?: number }).timer);
    (t as unknown as { timer?: number }).timer = window.setTimeout(() => (t.style.display = 'none'), 5000);
  }
}
