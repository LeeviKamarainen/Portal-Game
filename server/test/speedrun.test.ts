/**
 * Speedrun maps: surf ramps and their fins, fizzlers, checkpoint gates and the run clock,
 * and every route through the built-in courses (Slipstream, Updraft), played headless by a
 * scripted runner. Starting points are set by hand just before each mechanic, so a check
 * is about the course, not about steering.
 *
 *   npx tsx --test server/test/speedrun.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { MapData, Piece } from '../../src/world/maps/MapFormat';
import { mapToArena } from '../../src/world/maps/MapFormat';
import { ArenaSim } from '../../src/sim/ArenaSim';
import slipstream from '../../src/world/maps/slipstream.json';
import updraft from '../../src/world/maps/updraft.json';
import { V, scripted, DT } from './scripted';

type Game = Awaited<ReturnType<typeof scripted>>;

/** A long descending ramp in a void, the runner dropped on its right face heading down it. */
function rampMap(extra: Piece[] = []): MapData {
  return {
    id: 'surf-test',
    name: 'Surf test',
    hint: '',
    kind: 'speedrun',
    killY: -60,
    pieces: [
      { type: 'surf-ramp', at: [0, 0, 0], size: [16, 14, 120], drop: 20 },
      { type: 'spawn', at: [4, 17, 50], rot: 0 },
      { type: 'finish', at: [0, -30, -200] },
      ...extra,
    ],
  } as MapData;
}

/** Steps with `strafe` held, looking along `dir`, for `seconds` or until `done`. */
function ride(g: Game, dir: THREE.Vector3, strafe: number, seconds: number, done: () => boolean = () => false): void {
  for (let i = 0; i < seconds / DT && !done() && !g.me.dead; i++) {
    g.commands.next.right = strafe;
    g.commands.next.forward = 0;
    g.stepTo(g.body.getPosition().add(dir.clone().multiplyScalar(50)));
  }
  g.commands.next.right = 0;
}

/** Hands off for `seconds` or until `done`. */
function coast(g: Game, seconds: number, done: () => boolean): void {
  for (let i = 0; i < seconds / DT && !done() && !g.me.dead; i++) g.stepTo(null);
}

/** Puts the runner at `pos` going `vel`. */
function place(g: Game, pos: THREE.Vector3, vel = V(0, 0, 0)): void {
  g.body.setPosition(pos);
  g.body.setVelocity(vel);
}

/** As if the first `n` checkpoints were passed already (to start a check mid-course). */
function passed(g: Game, n: number): void {
  const run = g.sim.speedrun!;
  run.started = true;
  for (let i = 0; i < n; i++) {
    g.sim.arena.checkpoints[i].setPassed(true);
    run.splits.push(0);
  }
  run.next = n;
}

const happened = (g: Game, type: string) => g.events.includes(type);

async function course(data: unknown, check: (g: Game) => void): Promise<void> {
  const g = await scripted(data as MapData);
  try {
    g.idle(0.2);
    check(g);
  } finally {
    g.sim.dispose();
  }
}

test('a surf ramp is slid on, never stood on, and holding into it keeps you on and fast', async () => {
  const g = await scripted(rampMap());
  try {
    place(g, V(4, 18, 50), V(0, 0, -15));
    ride(g, V(0, 0, -1), -1, 0.5);
    assert.ok(g.body.surfing && !g.body.isGrounded, 'on the face, sliding');
    const start = g.body.horizontalSpeed();
    ride(g, V(0, 0, -1), -1, 4);
    assert.ok(!g.me.dead && g.body.surfing, `still riding after 4 s (at ${g.body.getPosition().toArray().map((n) => n.toFixed(1))})`);
    assert.ok(g.body.horizontalSpeed() > start + 5, `faster down the ramp: ${start.toFixed(1)} -> ${g.body.horizontalSpeed().toFixed(1)} m/s`);
  } finally {
    g.sim.dispose();
  }
  // Hands off, the runner slides down the face gently instead of dropping off it...
  const h = await scripted(rampMap());
  try {
    place(h, V(4, 18, 50), V(0, 0, -15));
    ride(h, V(0, 0, -1), 0, 0.3);
    const x = h.body.getPosition().x;
    ride(h, V(0, 0, -1), 0, 1);
    assert.ok(h.body.surfing, 'still on the face after a second hands off');
    // (This face looks east: sliding down it is moving east.)
    const slid = h.body.getPosition().x - x;
    assert.ok(slid < 3, `slid down the face slowly (${slid.toFixed(1)} m across in 1 s)`);
    // ...and steering away from the ramp jumps off it.
    ride(h, V(0, 0, -1), 1, 3);
    assert.ok(h.body.getPosition().y < 0, 'steering away leaves the ramp');
  } finally {
    h.sim.dispose();
  }
});

test('a surf ramp has to be steep, and its fins have to stand on a face it has', async () => {
  await assert.rejects(ArenaSim.load(mapToArena({ ...rampMap(), pieces: [{ type: 'surf-ramp', at: [0, 0, 0], size: [16, 6, 30] }, { type: 'spawn', at: [0, 0, 0] }, { type: 'finish', at: [0, 0, -5] }] } as MapData)), /at least 52 degrees/);
  await assert.rejects(
    ArenaSim.load(mapToArena({ ...rampMap(), pieces: [{ type: 'surf-ramp', at: [0, 0, 0], size: [8, 12, 30], sides: 'left', fins: [{ along: 10, side: 'right' }] }, { type: 'spawn', at: [0, 0, 0] }, { type: 'finish', at: [0, 0, -5] }] } as MapData)),
    /no right face/,
  );
});

test('a fin stops a surfer dead; a portal on it carries them on at speed', async () => {
  // A full fin halfway down the ramp (its back face at z = 0.2), and a wall panel off to the side to come out of.
  const fin = { along: 60, side: 'right', from: 0.03, to: 0.99, height: 4.5 };
  const extra: Piece[] = [{ type: 'portal-wall', at: [30, 0, -10], size: [10, 12, 0.6], rot: 90, portal: ['back', 'front'] }];
  const map = (): MapData => {
    const m = rampMap(extra);
    (m.pieces[0] as Piece).fins = [fin];
    return m;
  };
  const g = await scripted(map());
  try {
    place(g, V(4, 18, 50), V(0, 0, -15));
    ride(g, V(0, 0, -1), -1, 6, () => g.body.getPosition().z < -1);
    const speed = g.body.horizontalSpeed();
    assert.ok(speed < 3, `stopped at the fin (${speed.toFixed(1)} m/s at z ${g.body.getPosition().z.toFixed(1)})`);
  } finally {
    g.sim.dispose();
  }
  const h = await scripted(map());
  try {
    place(h, V(4, 18, 50), V(0, 0, -15));
    h.shoot('blue', V(29.7, 6, -10));
    assert.ok(h.me.portals.blue.placed, 'exit panel');
    place(h, V(4, 18, 50), V(0, 0, -15));
    ride(h, V(0, 0, -1), -1, 4, () => h.body.getPosition().z < 12);
    // Where it will meet the fin: level with where the body will be by then.
    const p = h.body.getPosition();
    const v = h.body.getVelocity();
    const t = (p.z - 0.6) / -v.z;
    h.shoot('orange', V(p.x, p.y + v.y * t, 0.15));
    assert.ok(h.me.portals.orange.placed, 'a portal on the fin, round the body riding the face');
    const before = h.body.getVelocity().length();
    const out = () => h.body.getPosition().distanceTo(V(29, 6, -10)) < 3;
    ride(h, V(0, 0, -1), -1, 2, out);
    const after = h.body.getVelocity().length();
    assert.ok(out(), `came out of the side panel (at ${h.body.getPosition().toArray().map((n) => n.toFixed(1))})`);
    assert.ok(after > before - 3, `kept its speed: ${before.toFixed(1)} -> ${after.toFixed(1)} m/s`);
  } finally {
    h.sim.dispose();
  }
});

test('a fizzler stops portal shots and closes your portals as you pass it', async () => {
  const map: MapData = {
    id: 'fizz-test',
    name: 'Fizzler test',
    hint: '',
    kind: 'speedrun',
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [20, 8, 40], portal: ['walls'] },
      { type: 'fizzler', at: [0, 0, 0], size: [20, 8, 0.4] },
      { type: 'spawn', at: [0, 0, 15], rot: 0 },
      { type: 'finish', at: [0, 0, -15] },
    ],
  } as MapData;
  const g = await scripted(map);
  try {
    g.idle(0.2);
    g.shoot('orange', V(0, 3, -20));
    assert.ok(!g.me.portals.orange.placed, 'the far wall is behind the field');
    g.shoot('orange', V(-10, 3, 10));
    g.shoot('blue', V(10, 3, 10));
    assert.ok(g.me.portals.orange.placed && g.me.portals.blue.placed, 'portals on this side');
    assert.ok(g.walk(0, -5, 0.4, 6), 'walked through the field');
    assert.ok(!g.me.portals.orange.placed && !g.me.portals.blue.placed, 'and both portals closed');
  } finally {
    g.sim.dispose();
  }
});

test('the clock, the checkpoints in order, falls back to the last one, and a fresh run', async () => {
  const map: MapData = {
    id: 'gates-test',
    name: 'Gates test',
    hint: '',
    kind: 'speedrun',
    killY: -3,
    pieces: [
      { type: 'room', at: [0, -6, 0], size: [20, 14, 80], portal: [], skip: ['floor'] },
      { type: 'block', at: [0, -1, 0], size: [20, 1, 80] },
      { type: 'spawn', at: [0, 0, 35], rot: 0 },
      { type: 'checkpoint', at: [0, 0, 10], size: [20, 6, 1], respawn: [0, 0, 8] },
      { type: 'checkpoint', at: [0, 0, -10], size: [20, 6, 1], respawn: [0, 0, -12] },
      { type: 'finish', at: [0, 0, -30], size: [20, 6, 1] },
    ],
  } as MapData;
  const g = await scripted(map);
  const run = g.sim.speedrun!;
  try {
    g.idle(1);
    assert.equal(run.time, 0, 'the clock waits on the pad');
    // Past the second gate first: out of order, it does nothing.
    place(g, V(0, 1.1, -5));
    g.walk(0, -15, 0.4, 3);
    assert.equal(run.next, 0, 'a checkpoint out of order does not count');
    assert.ok(run.started && run.time > 0, 'the clock runs once off the pad');
    place(g, V(0, 1.1, 15));
    g.walk(0, 5, 0.4, 3);
    assert.equal(run.next, 1, 'first checkpoint');
    g.walk(0, -35, 0.4, 6);
    assert.equal(run.next, 2, 'second checkpoint');
    assert.equal(run.splits.length, 2);
    assert.ok(run.splits[1] > run.splits[0], 'splits in order');
    assert.ok(happened(g, 'finish') && run.finished, 'the finish counts after both');
    const time = run.time;
    g.idle(0.5);
    assert.equal(run.time, time, 'the clock stops at the finish');

    g.sim.restartRun();
    assert.ok(!run.started && run.next === 0 && run.time === 0, 'a fresh run');
    assert.ok(g.body.getPosition().distanceTo(V(0, 1.02, 35)) < 0.2, 'back on the pad');
    g.walk(0, 5, 0.4, 6);
    assert.equal(run.next, 1);
    // Falls back to the last checkpoint passed, not the start.
    g.sim.player.killInstantly();
    g.idle(0.1);
    assert.ok(g.me.dead);
    g.sim.respawn();
    assert.ok(g.body.getPosition().distanceTo(V(0, 1.02, 8)) < 0.2, `back at checkpoint 1 (${g.body.getPosition().toArray()})`);
    assert.equal(run.next, 1, 'still one checkpoint done');
  } finally {
    g.sim.dispose();
  }
});

test('no fall damage on a speedrun map', async () => {
  const g = await scripted(rampMap([{ type: 'block', at: [40, -40, 0], size: [10, 1, 10] }]));
  try {
    place(g, V(40, 30, 0));
    coast(g, 6, () => g.body.isGrounded);
    assert.ok(g.body.isGrounded && !g.me.dead && g.body.health.value === 100, 'a 70 m drop, unhurt');
  } finally {
    g.sim.dispose();
  }
});

test('Slipstream start: step off the deck and you land on the ramp, and stay there hands off', async () => {
  await course(slipstream, (g) => {
    // The way a new player goes: walk west off the deck, then let go of everything.
    g.walk(-14, 23, 0.3, 4, () => !g.body.isGrounded);
    g.commands.next.forward = 0;
    coast(g, 1.3, () => false);
    assert.ok(g.body.surfing, `landed on the ramp face (at ${g.body.getPosition().toArray().map((n) => n.toFixed(1))})`);
    coast(g, 0.7, () => false);
    assert.ok(g.body.surfing && !g.me.dead, 'still on it a second later, hands off');
    // Face down the ramp and cling (A): high on the face, over the first fin, at speed.
    ride(g, V(0, 0, -1), -1, 2.5, () => g.body.getPosition().z < -20);
    assert.ok(g.body.getPosition().z < -20, `past the first fin (at z ${g.body.getPosition().z.toFixed(1)})`);
    assert.ok(g.body.surfing && g.body.horizontalSpeed() > 15, `riding at ${g.body.horizontalSpeed().toFixed(1)} m/s`);
  });
});

test('Slipstream hall 1: the pit dive and the fin both take the corner to checkpoint 1', async () => {
  await course(slipstream, (g) => {
    g.walk(-3, 16.6, 0.2, 4);
    g.idle(0.2);
    g.shoot('blue', V(-29.4, 160, -94));
    g.shoot('orange', V(-3, 110, -2));
    assert.ok(g.me.portals.blue.placed && g.me.portals.orange.placed, 'wall panel and pit floor, from the tower');
    g.commands.next.forward = 1;
    coast(g, 6, () => happened(g, 'checkpoint'));
    assert.ok(happened(g, 'checkpoint'), 'dove through the pit floor and out across the hall');
    assert.ok(g.body.horizontalSpeed() > 40, `at speed (${g.body.horizontalSpeed().toFixed(1)} m/s)`);
  });
  await course(slipstream, (g) => {
    place(g, V(-10.6, 153.2, 8), V(0, -3, -13));
    g.shoot('blue', V(-29.4, 158, -94));
    place(g, V(-10.6, 153.2, 8), V(0, -3, -13));
    ride(g, V(0, 0, -1), -1, 6, () => g.body.getPosition().z < -30);
    const p = g.body.getPosition();
    const v = g.body.getVelocity();
    const t = (p.z + 41.4) / -v.z;
    g.shoot('orange', V(p.x, p.y + v.y * t - 0.3, -41.7));
    assert.ok(g.me.portals.orange.placed, 'a portal on the full fin');
    // Into the fin, then hands off: strafing in the air would steer against the throw.
    ride(g, V(0, 0, -1), -1, 2, () => g.body.getPosition().x < -25);
    coast(g, 3, () => happened(g, 'checkpoint'));
    assert.ok(happened(g, 'checkpoint'), 'through the fin, out of the wall panel, through the doorway');
  });
});

test('Slipstream hall 2: corner portals, a fin shortcut, or the jump pads', async () => {
  const toCheckpoint2 = (g: Game) => {
    ride(g, V(1, 0, 0), 0, 5, () => g.sim.speedrun!.next === 2);
    assert.equal(g.sim.speedrun!.next, 2, 'checkpoint 2');
  };
  await course(slipstream, (g) => {
    passed(g, 1);
    place(g, V(90, 93.5, -97.1));
    g.shoot('blue', V(114, 128, -77.1));
    place(g, V(110, 88.5, -97.2), V(25, -6, 0));
    g.shoot('orange', V(129, 78.2, -97.2));
    assert.ok(g.me.portals.blue.placed && g.me.portals.orange.placed);
    toCheckpoint2(g);
  });
  await course(slipstream, (g) => {
    passed(g, 1);
    place(g, V(66, 100.2, -96.1));
    g.shoot('blue', V(114, 128, -77.1));
    place(g, V(66, 100.2, -96.1), V(24, -5, 0));
    ride(g, V(1, 0, 0), -1, 0.4);
    // Aim where it will meet fin 2 (its back face at x 81.8): level with the body by then.
    const p = g.body.getPosition();
    const v = g.body.getVelocity();
    const t = (81.4 - p.x) / v.x;
    g.shoot('orange', V(81.7, p.y + v.y * t - 0.3, p.z + v.z * t));
    assert.ok(g.me.portals.blue.placed && g.me.portals.orange.placed);
    ride(g, V(1, 0, 0), -1, 2, () => g.body.getPosition().z > -90);
    coast(g, 3, () => g.sim.speedrun!.next === 2);
    assert.equal(g.sim.speedrun!.next, 2, 'checkpoint 2 by the fin');
  });
  await course(slipstream, (g) => {
    passed(g, 1);
    place(g, V(6, 127.1, -93));
    g.walk(8, -86, 0.3, 4, () => !g.body.isGrounded);
    coast(g, 12, () => g.sim.speedrun!.next === 2);
    assert.equal(g.sim.speedrun!.next, 2, 'four jump pads to checkpoint 2');
  });
});

test('Slipstream hall 3: surf to the finish, or fling there from the pit', async () => {
  await course(slipstream, (g) => {
    passed(g, 2);
    place(g, V(118.2, 51, -214), V(0, -8, -28));
    ride(g, V(0, 0, -1), -1, 4, () => happened(g, 'finish'));
    assert.ok(happened(g, 'finish'), 'off the last ramp through the finish');
  });
  await course(slipstream, (g) => {
    passed(g, 2);
    place(g, V(104, 97.1, -121.5));
    g.idle(0.2);
    g.shoot('blue', V(104, 46.5, -170));
    g.shoot('orange', V(104, 50, -138));
    assert.ok(g.me.portals.blue.placed && g.me.portals.orange.placed, 'launcher and pit floor, from the deck');
    g.commands.next.forward = 1;
    g.stepTo(V(104, 97, -140));
    coast(g, 0.9, () => false);
    g.commands.next.forward = 0;
    coast(g, 8, () => happened(g, 'finish'));
    assert.ok(happened(g, 'finish'), 'flung from the launcher to the finish');
  });
});

test('Updraft: the well dive, the fall loops, and the jump pads all climb the tower', async () => {
  // Jump pads, ground floor to the first checkpoint.
  await course(updraft, (g) => {
    g.walk(-10, -10, 0.3, 6, () => !g.body.isGrounded);
    coast(g, 15, () => g.sim.speedrun!.next === 1);
    assert.equal(g.sim.speedrun!.next, 1, 'up the pads to floor 1');
  });
  // The well: exit under the opening, dive, shoot the well's floor on the way down.
  await course(updraft, (g) => {
    g.walk(6, 0, 0.3, 5);
    g.shoot('blue', V(6, 0, -6));
    g.walk(-10, 5.5, 0.15, 5);
    g.walk(-10, 9, 0.3, 3, () => !g.body.isGrounded);
    coast(g, 1, () => g.body.getPosition().y < -10);
    g.shoot('orange', V(-10, -52, 10));
    assert.ok(g.me.portals.blue.placed && g.me.portals.orange.placed);
    coast(g, 1, () => g.body.getPosition().y < -25);
    place(g, V(-10, g.body.getPosition().y, 10), V(0, g.body.getVelocity().y, 0));
    coast(g, 6, () => g.sim.speedrun!.next === 1);
    assert.equal(g.sim.speedrun!.next, 1, 'shot up through the opening to floor 1');
  });
  // Floors 1 and 2: fall in a loop between floor and ceiling, then move the ceiling end under the opening.
  const loop = (g: Game, floor: number, pad: THREE.Vector3, ceiling: THREE.Vector3, launch: THREE.Vector3, done: () => boolean) => {
    place(g, V(pad.x, floor + 1.9, pad.z + 3));
    g.idle(0.3);
    g.shoot('orange', pad);
    g.shoot('blue', ceiling);
    assert.ok(g.me.portals.orange.placed && g.me.portals.blue.placed, 'loop portals');
    g.walk(pad.x, pad.z, 0.2, 3, () => !g.body.isGrounded);
    coast(g, 8, () => g.body.getVelocity().y < -44);
    assert.ok(g.body.getVelocity().y < -44, 'looped to terminal speed');
    coast(g, 3, () => g.body.getPosition().y < floor + 20 && g.body.getVelocity().y < 0);
    g.shoot('blue', launch);
    assert.ok(g.me.portals.blue.placed, 'moved one end under the opening');
    coast(g, 6, done);
    assert.ok(done(), 'shot up through the opening');
  };
  await course(updraft, (g) => {
    passed(g, 1);
    loop(g, 40, V(-11, 40, -11), V(-11, 78.2, -11), V(-5, 40, 6), () => g.sim.speedrun!.next === 2);
  });
  await course(updraft, (g) => {
    passed(g, 2);
    loop(g, 80.8, V(-9, 80.8, -11), V(-9, 118.2, -10), V(6, 80, 6), () => happened(g, 'finish'));
  });
});

/**
 * No portal surface of a later section can be shot from anywhere in an earlier one (free
 * points sampled all over it, the doorways' approaches included): fizzlers and walls cut
 * every course into sections, so one portal can't carry a whole run.
 */
test('no later section can be shot at from anywhere in an earlier one', async () => {
  const box = (min: THREE.Vector3, max: THREE.Vector3) => new THREE.Box3(min, max);
  const courses: { data: unknown; regions: THREE.Box3[]; sectionOf: (p: THREE.Vector3) => number }[] = [
    // Slipstream: hall 1 (x < 0), hall 2 (z > -110, x >= 0), hall 3.
    {
      data: slipstream,
      regions: [box(V(-30, 5, -110), V(0, 190, 30)), box(V(0, 5, -110), V(130, 190, -76)), box(V(100, 5, -260), V(130, 190, -110))],
      sectionOf: (p) => (p.x < 0 ? 0 : p.z > -110 ? 1 : 2),
    },
    // Updraft: below floor 1, floor 1, floor 2 (the roof is the finish).
    {
      data: updraft,
      regions: [box(V(-16, -51, -16), V(16, 39, 16)), box(V(-16, 40, -16), V(16, 79, 16)), box(V(-16, 80, -16), V(16, 119, 16))],
      sectionOf: (p) => (p.y < 39 ? 0 : p.y < 79 ? 1 : 2),
    },
  ];
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (const { data, regions, sectionOf } of courses) {
    const sim = await ArenaSim.load(mapToArena(data as MapData));
    try {
      sim.scene.updateMatrixWorld(true);
      const faces = sim.level.faces.filter((f) => f.portalable);
      const ray = new THREE.Raycaster();
      ray.far = 500;
      const probe = new RAPIER.Ball(0.3);
      regions.forEach((region, section) => {
        const later = faces.filter((f) => sectionOf(f.center) > section);
        const targets = later.flatMap((f) => [[0, 0], [-0.4, -0.4], [0.4, 0.4], [-0.4, 0.4], [0.4, -0.4]].map(([u, w]) => ({ f, at: f.toWorld(u * f.width, w * f.height) })));
        let tried = 0;
        for (let n = 0; n < 4000 && tried < 400; n++) {
          const eye = V(
            region.min.x + rand() * (region.max.x - region.min.x),
            region.min.y + rand() * (region.max.y - region.min.y),
            region.min.z + rand() * (region.max.z - region.min.z),
          );
          // Only points a body could be at: not inside anything solid.
          if (sim.physics.world.intersectionWithShape(eye, { x: 0, y: 0, z: 0, w: 1 }, probe)) continue;
          tried++;
          for (const { f, at } of targets) {
            ray.set(eye, at.clone().sub(eye).normalize());
            const hit = ray.intersectObjects(sim.level.raycastTargets, false)[0];
            assert.ok(
              hit?.object.userData.face !== f,
              `${(data as MapData).id}: from ${eye.toArray().map((x) => x.toFixed(1))} in section ${section + 1}, the portal surface at ${f.center.toArray().map((x) => x.toFixed(1))} in section ${sectionOf(f.center) + 1} is in sight`,
            );
          }
        }
        assert.ok(tried >= 200, `sampled enough free points in section ${section + 1}`);
      });
    } finally {
      sim.dispose();
    }
  }
});
