/**
 * The slope piece: a smooth ramp whose sloping top takes portals - tilted portals that
 * work like any other: placed by a shot, walked into from either side, falling in.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { MapData } from '../../src/world/maps/MapFormat';
import { V, scripted, DT } from './scripted';

/** A room, a spawn, a portal wall on the west side, and a 3 m rise over 12 m slope climbing north. */
function map(slope: object = {}): MapData {
  return {
    id: 'slope-test',
    name: 'Slope',
    hint: '',
    kind: 'puzzle',
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [40, 20, 60], portal: [], center: true },
      { type: 'spawn', at: [0, 0, 20], rot: 0 },
      { type: 'slope', at: [0, 0, -8], size: [6, 3, 12], rot: 0, ...slope },
      { type: 'portal-wall', at: [-12, 0, 8], size: [8, 6, 0.6], rot: 90, portal: ['front', 'back'] },
      { type: 'goal', at: [15, 0, 25] },
    ],
  } as unknown as MapData;
}

const fmt = (v: THREE.Vector3) => v.toArray().map((n) => n.toFixed(2)).join(', ');

test('a slope piece takes a portal lying in its sloping top', async () => {
  const g = await scripted(map());
  try {
    g.idle(0.5);
    g.shoot('orange', V(0, 1.5, -8));
    assert.ok(g.me.portals.orange.placed, 'a portal on the slope');
    const n = g.me.portals.orange.normal;
    const tilt = (Math.acos(n.y) * 180) / Math.PI;
    assert.ok(Math.abs(tilt - 14) < 1, `the portal lies in the slope plane (tilt ${tilt.toFixed(1)}°)`);
    assert.ok(n.z > 0.1, 'and faces back down the slope');
  } finally {
    g.sim.dispose();
  }
});

test('the slope is walkable: up and back down, steadily', async () => {
  const g = await scripted(map());
  const { body } = g;
  try {
    g.idle(0.5);
    const ys: number[] = [];
    g.commands.next.forward = 1;
    for (let i = 0; i < 6 / DT; i++) {
      g.stepTo(V(0, 1, -30));
      if (body.getPosition().z < -2.5) ys.push(body.getPosition().y);
      if (body.getPosition().z < -13) break;
    }
    const top = body.getPosition();
    assert.ok(top.y > 3.6, `climbed (y ${top.y.toFixed(2)})`);
    const steps = ys.slice(1).map((y, i) => y - ys[i]);
    const lo = Math.min(...steps);
    const hi = Math.max(...steps);
    assert.ok(hi - lo < 0.02, `a steady climb (${(lo * 1000).toFixed(0)}..${(hi * 1000).toFixed(0)} mm per step)`);
    // Back down the slope without leaving the ground for long.
    let airborne = 0;
    for (let i = 0; i < 4 / DT && body.getPosition().z < -4; i++) {
      g.commands.next.forward = 1;
      g.stepTo(V(0, 1, 15));
      if (!body.isGrounded) airborne++;
    }
    assert.ok(body.getPosition().z >= -4, 'walked back down');
    assert.ok(airborne < 5, `kept to the slope going down (${airborne} airborne steps)`);
  } finally {
    g.sim.dispose();
  }
});

test('walking up the slope into its portal comes out of the wall portal', async () => {
  const g = await scripted(map());
  const { body, me } = g;
  try {
    g.idle(0.3);
    g.shoot('blue', V(-11.69, 1.5, 8));
    assert.ok(me.portals.blue.placed, 'blue on the wall');
    g.shoot('orange', V(0, 1.5, -8));
    assert.ok(me.portals.orange.placed, 'orange on the slope');
    const mouth = me.portals.orange.surfaceCenter.clone();
    let through = false;
    g.commands.next.forward = 1;
    for (let i = 0; i < 8 / DT; i++) {
      g.stepTo(V(mouth.x, mouth.y + 1, mouth.z));
      if (body.getPosition().x < -8) {
        through = true;
        break;
      }
    }
    assert.ok(through, `came out at the wall portal (at ${fmt(body.getPosition())})`);
    g.commands.next.forward = 0;
    for (let i = 0; i < 90; i++) g.stepTo(null);
    const out = body.getPosition();
    assert.ok(out.x > -11.2 && out.x < -6, `out in the room, away from the wall (x ${out.x.toFixed(2)})`);
    assert.ok(Math.abs(out.z - 8) < 3, `by the portal (z ${out.z.toFixed(2)})`);
    assert.ok(out.y > 0.9 && out.y < 1.6, `on its feet on the floor (y ${out.y.toFixed(2)})`);
    assert.ok(!g.me.dead);
  } finally {
    g.sim.dispose();
  }
});

test('into the wall portal and out of the slope: leaves the surface along its normal', async () => {
  const g = await scripted(map());
  const { body, me } = g;
  try {
    g.idle(0.3);
    g.shoot('orange', V(0, 1.5, -8));
    g.shoot('blue', V(-11.69, 1.5, 8));
    assert.ok(me.portals.orange.placed && me.portals.blue.placed);
    const mouth = me.portals.orange.surfaceCenter.clone();
    const n = me.portals.orange.normal.clone();
    // Into the wall portal from the east, until the step it carries the body over to the slope.
    let at: THREE.Vector3 | null = null;
    let vel = V(0, 0, 0);
    for (let i = 0; i < 12 / DT && !at; i++) {
      g.commands.next.forward = 1;
      g.stepTo(V(-14, body.getPosition().y, 8));
      if (body.getPosition().x > -5 && body.getPosition().z < 3) {
        at = body.getPosition();
        vel = body.getVelocity();
      }
    }
    g.commands.next.forward = 0;
    assert.ok(at, 'came through');
    console.log(`  out of the slope portal at ${fmt(at!)}, velocity ${fmt(vel)}`);
    assert.ok(at!.distanceTo(mouth) < 1.5, `at the slope portal (${at!.distanceTo(mouth).toFixed(2)} m from its centre)`);
    // A wall portal's walker leaves a floor-like portal along its normal: up and a little downhill-ward.
    assert.ok(vel.dot(n) > 4, `thrown out of the surface (${vel.dot(n).toFixed(1)} m/s along the normal)`);
    assert.ok(vel.y > 3, 'upward');
    for (let i = 0; i < 4 / DT; i++) g.stepTo(null);
    assert.ok(!g.me.dead, 'alive');
  } finally {
    g.sim.dispose();
  }
});

test('falling onto the slope\'s portal from above goes through (the ground below is out of the way)', async () => {
  const g = await scripted(map());
  const { body, me } = g;
  try {
    g.idle(0.3);
    g.shoot('orange', V(0, 1.5, -8));
    g.shoot('blue', V(-11.69, 1.5, 8));
    const mouth = me.portals.orange.surfaceCenter.clone();
    body.setPosition(mouth.clone().add(V(0, 5, 0)));
    body.setVelocity(V(0, 0, 0));
    let through = false;
    for (let i = 0; i < 3 / DT; i++) {
      g.stepTo(null);
      if (body.getPosition().x < -8) {
        through = true;
        break;
      }
    }
    assert.ok(through, `fell through to the wall portal (at ${fmt(body.getPosition())})`);
  } finally {
    g.sim.dispose();
  }
});

test('the wedge\'s triangular side and high end are surfaces, but take no portal', async () => {
  const g = await scripted(map());
  try {
    const hit = (from: [number, number, number], dir: [number, number, number]) => {
      const ray = new THREE.Raycaster(new THREE.Vector3(...from), new THREE.Vector3(...dir).normalize(), 0, 100);
      return ray.intersectObjects(g.sim.level.raycastTargets, false)[0];
    };
    // From the west, level with the middle of the wedge: its triangular side (x = -3).
    const side = hit([-10, 1, -8], [1, 0, 0]);
    assert.ok(side, 'the side is solid to a shot');
    const sideFace = side.object.userData.face;
    assert.ok(!sideFace.portalable && Math.abs(sideFace.normal.x + 1) < 1e-6, 'a plain face looking west');
    assert.ok(Math.abs(side.point.x + 3) < 0.01);
    // Above the slope's surface at the same spot the side is open air: a shot goes past it.
    const over = hit([-10, 2.9, -4], [1, 0, 0]);
    assert.ok(!over || over.point.x > -2.9, 'no side where the wedge is not');
    // From the north, level with the high end: the upright back, not portalable.
    const back = hit([0, 1.5, -30], [0, 0, 1]);
    assert.ok(back && !back.object.userData.face.portalable, 'the high end is a plain wall');
    assert.ok(Math.abs(back.point.z + 14) < 0.01);
  } finally {
    g.sim.dispose();
  }
});

test('a slope too steep to walk is refused', async () => {
  await assert.rejects(() => scripted(map({ size: [6, 8, 8] })), /at most/);
});

test('a slope with no portal faces takes none', async () => {
  const g = await scripted(map({ portal: [] }));
  try {
    g.idle(0.3);
    g.shoot('orange', V(0, 1.5, -8));
    assert.ok(!g.me.portals.orange.placed);
  } finally {
    g.sim.dispose();
  }
});
