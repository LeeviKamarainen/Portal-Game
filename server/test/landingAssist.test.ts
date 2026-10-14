/**
 * Landing assist: shooting a floor portal from the air, close to where you will come down,
 * puts it where you land. Headless, no browser.
 *
 *   npx tsx --test server/test/landingAssist.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { mapToArena, type MapData } from '../../src/world/maps/MapFormat';
import { IdleCommands } from '../../src/player/PlayerCommand';

const DT = 1 / 60;

const MAP: MapData = {
  id: 'landing-test',
  name: 'Landing test',
  hint: '',
  kind: 'combat',
  symmetry: 'none',
  killY: -6,
  pieces: [
    { type: 'room', at: [0, 0, 0], size: [40, 20, 40], portal: ['walls'], skip: ['floor'] },
    { type: 'block', at: [0, -3, 0], size: [40, 3, 40], portal: ['top'], hide: ['bottom'] },
    { type: 'spawn', at: [0, 0, 17], rot: 0, team: 'orange' },
    { type: 'spawn', at: [4, 0, 17], rot: 0 },
  ],
};

/** Shoots at `aim` (a floor point) from 6 m up, flying along +x at 5 m/s; returns where the portal opened and where the body lands. */
async function shootFromAir(assist: boolean, aim: THREE.Vector3, grounded = false) {
  const sim = await ArenaSim.load(mapToArena(MAP), {});
  try {
    const player = sim.addPlayer({ id: 'p1', name: 'P1' }, new IdleCommands(), null, { slot: 0, local: false });
    player.landingAssist = assist;
    const c = player.controller;
    c.setPosition(new THREE.Vector3(-4, grounded ? 0.5 : 6, -4));
    c.setVelocity(new THREE.Vector3(5, 0, 0));
    sim.step(DT);
    const landing = c.predictLanding(0, 5);
    const eye = c.getPosition().add(new THREE.Vector3(0, 0.8, 0));
    const look = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(eye, aim, new THREE.Vector3(0, 1, 0)));
    const fireFrom = (sim as unknown as { fireFrom: (...a: unknown[]) => boolean }).fireFrom.bind(sim);
    const placed = fireFrom(player, 'orange', eye, look);
    return { placed, landing, center: player.portals.orange.surfaceCenter.clone(), isGrounded: c.isGrounded };
  } finally {
    sim.dispose();
  }
}

test('a shot at the floor near where you land is centred on the landing spot', async () => {
  // Body at x=-4 going +x: lands about 3.5 m further on, around x=0.
  const probe = await shootFromAir(false, new THREE.Vector3(0.9, 0, -4));
  assert.ok(probe.landing, 'airborne body has a predicted landing');
  const land = probe.landing!;
  const aim = new THREE.Vector3(land.x + 0.9, 0, land.z);
  const plain = await shootFromAir(false, aim);
  const assisted = await shootFromAir(true, aim);
  assert.ok(plain.placed && assisted.placed);
  assert.ok(Math.hypot(plain.center.x - land.x, plain.center.z - land.z) > 0.7, 'unassisted lands beside the spot');
  assert.ok(Math.hypot(assisted.center.x - land.x, assisted.center.z - land.z) < 0.15, `assisted centre ${assisted.center.toArray()} vs ${land.toArray()}`);
});

test('a shot far from the landing spot is left where it was aimed', async () => {
  const probe = await shootFromAir(false, new THREE.Vector3(0, 0, -4));
  const land = probe.landing!;
  const aim = new THREE.Vector3(land.x, 0, land.z + 6);
  const plain = await shootFromAir(false, aim);
  const assisted = await shootFromAir(true, aim);
  assert.ok(plain.center.distanceTo(assisted.center) < 0.01);
});

test('on the ground there is no assist', async () => {
  const r = await shootFromAir(true, new THREE.Vector3(3, 0, 3), true);
  assert.ok(r.placed);
  assert.ok(Math.hypot(r.center.x - 3, r.center.z - 3) < 0.1, 'shot lands where aimed');
});
