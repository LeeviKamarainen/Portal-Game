import * as THREE from 'three';

/**
 * Procedural surface materials - generated on canvases at start-up, no image files.
 *
 * The art follows Portal's visual language so surfaces read at a glance:
 *   panel  - pale concrete tiles: portals stick here
 *   metal  - dark ribbed steel:    portals never stick here
 *   floor  - darker concrete tiles (portalable floor)
 *   hazard - yellow/black stripes on anything that moves or hurts
 *
 * Every texture tiles once per `TILE_METRES`, and the builder writes world-scale UVs, so
 * seams line up across neighbouring faces.
 */

export const TILE_METRES = 2;
const SIZE = 256;

type Painter = (x: number, y: number) => { h: number; r: number; g: number; b: number; rough: number };

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function valueNoise(x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wrap = (n: number, p: number) => ((n % p) + p) % p;
  const p = 16;
  const a = hash(wrap(xi, p), wrap(yi, p));
  const b = hash(wrap(xi + 1, p), wrap(yi, p));
  const c = hash(wrap(xi, p), wrap(yi + 1, p));
  const d = hash(wrap(xi + 1, p), wrap(yi + 1, p));
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < 4; i++) {
    sum += valueNoise(x * f, y * f) * amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum;
}

interface TextureSet {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function makeTextures(paint: Painter, normalStrength: number): TextureSet {
  const height = new Float32Array(SIZE * SIZE);
  const color = document.createElement('canvas');
  const rough = document.createElement('canvas');
  const normal = document.createElement('canvas');
  for (const c of [color, rough, normal]) {
    c.width = SIZE;
    c.height = SIZE;
  }
  const cctx = color.getContext('2d')!;
  const rctx = rough.getContext('2d')!;
  const nctx = normal.getContext('2d')!;
  const cimg = cctx.createImageData(SIZE, SIZE);
  const rimg = rctx.createImageData(SIZE, SIZE);
  const nimg = nctx.createImageData(SIZE, SIZE);

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const p = paint(x / SIZE, y / SIZE);
      const i = (y * SIZE + x) * 4;
      height[y * SIZE + x] = p.h;
      cimg.data[i] = p.r;
      cimg.data[i + 1] = p.g;
      cimg.data[i + 2] = p.b;
      cimg.data[i + 3] = 255;
      const rv = Math.round(THREE.MathUtils.clamp(p.rough, 0, 1) * 255);
      // three reads roughness from the green channel.
      rimg.data[i] = rv;
      rimg.data[i + 1] = rv;
      rimg.data[i + 2] = rv;
      rimg.data[i + 3] = 255;
    }
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const hl = height[y * SIZE + ((x - 1 + SIZE) % SIZE)];
      const hr = height[y * SIZE + ((x + 1) % SIZE)];
      const hu = height[((y - 1 + SIZE) % SIZE) * SIZE + x];
      const hd = height[((y + 1) % SIZE) * SIZE + x];
      const n = new THREE.Vector3((hl - hr) * normalStrength, (hd - hu) * normalStrength, 1).normalize();
      const i = (y * SIZE + x) * 4;
      nimg.data[i] = Math.round((n.x * 0.5 + 0.5) * 255);
      nimg.data[i + 1] = Math.round((n.y * 0.5 + 0.5) * 255);
      nimg.data[i + 2] = Math.round((n.z * 0.5 + 0.5) * 255);
      nimg.data[i + 3] = 255;
    }
  }
  cctx.putImageData(cimg, 0, 0);
  rctx.putImageData(rimg, 0, 0);
  nctx.putImageData(nimg, 0, 0);

  const wrapTex = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.repeat.set(1 / TILE_METRES, 1 / TILE_METRES);
    return t;
  };
  return { map: wrapTex(color, true), normalMap: wrapTex(normal, false), roughnessMap: wrapTex(rough, false) };
}

/** Distance (0..0.5) from the nearest grid line of an n x n tiling. */
function gridDist(u: number, v: number, n: number): number {
  const fu = (u * n) % 1;
  const fv = (v * n) % 1;
  return Math.min(fu, 1 - fu, fv, 1 - fv);
}

const panelPainter: Painter = (u, v) => {
  const g = gridDist(u, v, 2);
  const seam = g < 0.012 ? 1 : 0;
  const bevel = THREE.MathUtils.smoothstep(g, 0.012, 0.03);
  const n = fbm(u * 8, v * 8);
  const stain = fbm(u * 3 + 7, v * 3 + 3);
  const base = 188 - n * 26 - stain * 16;
  const c = seam ? 92 : base - (1 - bevel) * 30;
  return { h: seam ? 0 : 0.4 + bevel * 0.6 + n * 0.08, r: c, g: c + 2, b: c + 6, rough: 0.72 + n * 0.2 - seam * 0.1 };
};

const floorPainter: Painter = (u, v) => {
  const g = gridDist(u, v, 2);
  const seam = g < 0.01 ? 1 : 0;
  const n = fbm(u * 10, v * 10);
  const scuff = fbm(u * 2.5 + 11, v * 2.5 + 5);
  const c = seam ? 40 : 118 - n * 22 - scuff * 18;
  return { h: seam ? 0 : 0.6 + n * 0.12, r: c - 2, g: c, b: c + 4, rough: 0.82 + n * 0.12 };
};

const metalPainter: Painter = (u, v) => {
  // Diagonal tread plate on dark steel, with a coarse panel grid.
  const g = gridDist(u, v, 1);
  const seam = g < 0.008 ? 1 : 0;
  const k = 12;
  const du = ((u + v) * k) % 1;
  const dv = ((u - v + 4) * k) % 1;
  const bump = Math.max(0, 1 - Math.hypot(du - 0.5, (dv - 0.5) * 3) * 3.2);
  const n = fbm(u * 14, v * 14);
  const c = seam ? 22 : 66 + bump * 24 - n * 14;
  return { h: seam ? 0 : 0.5 + bump * 0.5, r: c, g: c + 3, b: c + 8, rough: 0.48 - bump * 0.15 + n * 0.2 };
};

const hazardPainter: Painter = (u, v) => {
  const stripe = ((u + v) * 4) % 1 < 0.5;
  const n = fbm(u * 12, v * 12);
  const wear = n > 0.62 ? 0.55 : 1;
  const r = stripe ? 228 * wear : 26;
  const g = stripe ? 182 * wear : 26;
  const b = stripe ? 30 : 28;
  return { h: 0.5 + n * 0.1, r, g, b, rough: 0.55 + n * 0.25 };
};

export type MaterialName = 'panel' | 'floor' | 'metal' | 'hazard' | 'trim';

let cache: Record<MaterialName, THREE.MeshStandardMaterial> | null = null;

export function materials(): Record<MaterialName, THREE.MeshStandardMaterial> {
  if (cache) return cache;
  const panel = makeTextures(panelPainter, 6);
  const floor = makeTextures(floorPainter, 5);
  const metal = makeTextures(metalPainter, 9);
  const hazard = makeTextures(hazardPainter, 3);
  cache = {
    panel: new THREE.MeshStandardMaterial({ ...panel, color: 0xffffff, metalness: 0.0, envMapIntensity: 0.5 }),
    floor: new THREE.MeshStandardMaterial({ ...floor, color: 0xffffff, metalness: 0.05, envMapIntensity: 0.5 }),
    metal: new THREE.MeshStandardMaterial({ ...metal, color: 0xffffff, metalness: 0.75, envMapIntensity: 0.9 }),
    hazard: new THREE.MeshStandardMaterial({ ...hazard, color: 0xffffff, metalness: 0.2, envMapIntensity: 0.6 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.45, metalness: 0.8, envMapIntensity: 0.9 }),
  };
  return cache;
}

/** Bright, unlit, bloom-catching colour (values above 1 glow through the bloom pass). */
export function glowMaterial(color: number, intensity = 2.5, opts: THREE.MeshBasicMaterialParameters = {}): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color, ...opts });
  m.color.multiplyScalar(intensity);
  return m;
}
