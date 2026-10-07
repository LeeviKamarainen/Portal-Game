import * as THREE from 'three';
import type { Game } from '../game/Game';
import { ARENAS } from '../world/arenas';

/**
 * GPU cost per frame, measured with timer queries (EXT_disjoint_timer_query_webgl2) while
 * rendering frames back to back - independent of whether the page is visible or vsynced.
 * Each arena is measured from its spawn view and from a worst-case view: a pair of portals
 * facing each other in front of the camera (the deepest portal recursion).
 */

interface Sample {
  label: string;
  gpuMs: number;
  cpuMs: number;
  views: number;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

async function measure(game: Game, label: string, frames = 40): Promise<Sample> {
  const gl = game.engine.renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const queries: WebGLQuery[] = [];
  let cpu = 0;
  for (let i = 0; i < frames + 5; i++) {
    game.step(1 / 60);
    const q = ext && i >= 5 ? gl.createQuery() : null;
    if (q && ext) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    const t0 = performance.now();
    game.renderNow();
    if (i >= 5) cpu += performance.now() - t0;
    if (q && ext) {
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      queries.push(q);
    }
  }
  gl.finish();
  let gpu = 0;
  let n = 0;
  for (const q of queries) {
    for (let k = 0; k < 50 && !gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE); k++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
      gpu += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      n++;
    }
    gl.deleteQuery(q);
  }
  return { label, gpuMs: n ? gpu / n : NaN, cpuMs: cpu / frames, views: game.session!.portalRenderer.stats.views };
}

/** Puts both portals on whatever portalable surfaces are in view from where the player stands. */
function twoInView(game: Game): boolean {
  const s = game.session!;
  const eye = s.player.getPosition().add(V(0, 0.8, 0));
  const yaw = s.player.lookYaw;
  let placed: THREE.Vector3 | null = null;
  for (const pitch of [0, -0.15, 0.15, -0.3, 0.3]) {
    for (const off of [-0.45, 0.45, -0.3, 0.3, -0.15, 0.15, 0]) {
      const a = yaw + off;
      const dir = new THREE.Vector3(-Math.sin(a) * Math.cos(pitch), Math.sin(pitch), -Math.cos(a) * Math.cos(pitch));
      const color = placed ? 'blue' : 'orange';
      const r = s.gun.fire(color, eye, dir);
      if (!r.placed || !r.point) continue;
      if (!placed) placed = r.point;
      else if (r.point.distanceTo(placed) > 2) return true;
    }
  }
  return false;
}

export async function runPerf(game: Game): Promise<{ text: string; results: Sample[] }> {
  const results: Sample[] = [];
  const size = game.engine.renderer.getDrawingBufferSize(new THREE.Vector2());
  for (let i = 0; i < ARENAS.length; i++) {
    await game.loadArena(i);
    game.session!.player.setInvulnerableFor(1e9);
    for (let k = 0; k < 30; k++) game.step(1 / 60);
    results.push(await measure(game, `${ARENAS[i].name}: spawn view`));
    if (twoInView(game)) results.push(await measure(game, `${ARENAS[i].name}: both portals in view`));
  }
  // Worst case: two portals facing each other straight ahead, so each shows itself
  // recursively, at the maximum recursion depth.
  await game.loadArena(-1);
  const s = game.session!;
  s.player.setInvulnerableFor(1e9);
  const faceAt = (n: THREE.Vector3, p: THREE.Vector3) => s.level.faces.find((f) => f.portalable && f.normal.dot(n) > 0.99 && Math.abs(f.toLocal(p).z) < 0.01)!;
  const up = V(0, 1, 0);
  const place = (c: 'orange' | 'blue', p: THREE.Vector3, n: THREE.Vector3) =>
    s.portals[c].place(s.physics, faceAt(n, p), p, new THREE.Vector3().crossVectors(up, n).normalize(), up);
  place('orange', V(-30, 1.6, -60), V(0, 0, 1));
  place('blue', V(-30, 1.6, 0), V(0, 0, -1));
  s.player.setPosition(V(-30.4, 1.02, -55));
  s.system.resync(s.player);
  s.player.setLook(0, 0);
  for (let k = 0; k < 10; k++) game.step(1 / 60);
  results.push(await measure(game, 'Test chamber: facing pair, 5 m away'));
  const worst = Math.max(...results.map((r) => r.gpuMs));
  const lines = [
    `GPU frame time at ${size.x}x${size.y}, quality tier ${game.engine.tierIndex} (worst ${worst.toFixed(2)} ms = ${(1000 / worst).toFixed(0)} fps GPU-bound)`,
  ];
  for (const r of results) {
    lines.push(`${r.label.padEnd(42)} GPU ${r.gpuMs.toFixed(2)} ms  CPU ${r.cpuMs.toFixed(2)} ms  portal views ${r.views}`);
  }
  return { text: lines.join('\n'), results };
}
