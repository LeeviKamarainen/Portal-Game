/**
 * Walking up a staircase: the body rises smoothly along the flight and the view - drawn
 * from the camera - does not bob at each tread.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { mapToArena, type MapData } from '../../src/world/maps/MapFormat';
import { BufferedCommands } from '../../src/player/PlayerCommand';
import { DT } from './scripted';

/** A flat floor with one flight of stairs climbing north (-z) from z = -2. */
function flight(rise: number, run: number): MapData {
  return {
    id: 'stairs-test',
    name: 'Stairs',
    kind: 'puzzle',
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [20, 30, 60], center: true },
      { type: 'spawn', at: [0, 0, 20], rot: 0 },
      { type: 'stairs', at: [0, 0, -2 - run / 2], size: [6, rise, run], rot: 0 },
      { type: 'floor', at: [0, rise - 0.4, -2 - run - 6], size: [12, 0.4, 12], center: true },
      { type: 'goal', at: [0, rise, -2 - run - 6] },
    ],
  } as unknown as MapData;
}

interface Trace {
  /** The body's height each step, and the camera's. */
  body: number[];
  cam: number[];
  grounded: boolean[];
}

async function climb(rise: number, run: number): Promise<Trace> {
  const camera = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 200);
  const sim = await ArenaSim.load(mapToArena(flight(rise, run)), null);
  const commands = new BufferedCommands();
  const me = sim.addPlayer({ id: 'p1', name: 'TESTER' }, commands, camera, { local: true });
  const body = me.controller;
  // Settle on the floor, facing the stairs (north), then walk straight up them.
  commands.next.forward = 0;
  for (let i = 0; i < 60; i++) sim.step(DT);
  const trace: Trace = { body: [], cam: [], grounded: [] };
  commands.next.forward = 1;
  const endZ = -2 - run - 2;
  for (let i = 0; i < 6 / DT && body.getPosition().z > endZ; i++) {
    const s = body.saveMove();
    commands.next.yaw = Math.atan2(Math.sin(-s.yaw), Math.cos(-s.yaw));
    commands.next.pitch = -s.pitch;
    sim.step(DT);
    commands.next.yaw = commands.next.pitch = 0;
    if (body.getPosition().z > 0) continue; // still on the approach
    trace.body.push(body.getPosition().y);
    trace.cam.push(camera.position.y);
    trace.grounded.push(body.isGrounded);
  }
  sim.dispose?.();
  return trace;
}

/** Metres the camera rose each step, over the part of the climb on the flight itself. */
function rises(cam: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < cam.length; i++) out.push(cam[i] - cam[i - 1]);
  return out;
}

for (const [rise, run] of [
  [8, 20],
  [6, 12],
  [4, 6],
] as const) {
  test(`stairs ${rise} over ${run}: the view glides up instead of bobbing at each tread`, async () => {
    const t = await climb(rise, run);
    assert.ok(t.cam.length > 60, `walked the flight (${t.cam.length} steps)`);
    const r = rises(t.cam);
    // Mid-flight, once on it and before the top: the pace of the climb stays within a band.
    const mid = r.slice(Math.floor(r.length * 0.25), Math.floor(r.length * 0.6));
    const lo = Math.min(...mid);
    const hi = Math.max(...mid);
    // Tread by tread the old climb hopped ~110 mm then crept ~20 mm; a glide holds close to one pace.
    console.log(`  rise ${rise} run ${run}: ${(lo * 1000).toFixed(0)}..${(hi * 1000).toFixed(0)} mm per step, ${t.cam.length} steps`);
    assert.ok(hi - lo < 0.015, `the climb's pace varies ${(lo * 1000).toFixed(0)}..${(hi * 1000).toFixed(0)} mm per step`);
    // Nor does it ever jump: the biggest single-step rise or change of pace on the way.
    const stepMax = Math.max(...r.map(Math.abs));
    let accelMax = 0;
    for (let i = 1; i < r.length; i++) accelMax = Math.max(accelMax, Math.abs(r[i] - r[i - 1]));
    assert.ok(stepMax < 0.08, `a step of ${(stepMax * 1000).toFixed(0)} mm`);
    assert.ok(accelMax < 0.05, `a change of pace of ${(accelMax * 1000).toFixed(0)} mm per step`);
    // The camera is the body's eye all the way: there is no lag or offset to hide a bob.
    assert.ok(t.body.every((y, i) => Math.abs(t.cam[i] - y - 0.8) < 0.02 || i < 3), 'camera rides the body');
  });
}
