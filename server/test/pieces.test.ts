/**
 * The pieces built for the Catapult chamber, each on its own: glass, jump pads, floor
 * buttons and a switch-released cube dispenser - what they do, what they refuse, and that
 * they carry over to another screen like every other hazard.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { expandPieces, mapToArena, type MapData, type Piece } from '../../src/world/maps/MapFormat';
import { FaithPlate } from '../../src/world/hazards/FaithPlate';
import { FloorButton } from '../../src/world/hazards/FloorButton';
import { Dropper } from '../../src/world/hazards/Dropper';
import { Door } from '../../src/world/hazards/Door';
import { Switch } from '../../src/world/hazards/Switch';
import { BotController } from '../../src/bots/BotController';
import { BOT_SKILLS } from '../../src/bots/BotSkill';
import { DT, V, hazards, scripted } from './scripted';

/** A walled hall 40 x 12 x 40 (floor at y = 0) with a spawn at the south end and an exit at the north. */
function hall(extra: Piece[], kind: 'puzzle' | 'combat' = 'puzzle'): MapData {
  return {
    id: 'pieces-test',
    name: 'Pieces test',
    hint: '',
    kind,
    symmetry: 'none',
    killY: -6,
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [40, 12, 40], portal: ['walls'] },
      { type: 'spawn', at: [0, 0, 15], rot: 0 },
      ...(kind === 'puzzle' ? ([{ type: 'goal', at: [16, 0, -16] }] as Piece[]) : []),
      ...extra,
    ],
  };
}

test('glass stops bodies and portal shots but not the eye', async () => {
  const g = await scripted(hall([{ type: 'glass', at: [0, 0, 0], size: [10, 4, 0.15] }]));
  try {
    // The wall behind it takes portals; the pane in front of it does not pass a shot.
    g.shoot('orange', V(0, 1.6, -19.9));
    assert.equal(g.me.portals.orange.placed, false, 'a shot at the wall through the glass fizzled on the glass');
    g.shoot('orange', V(0, 10, -19.9));
    assert.equal(g.me.portals.orange.placed, true, 'a shot over the glass reached the wall');

    // Nothing walks through it.
    g.walk(0, -8, 0.3, 4);
    assert.ok(g.body.getPosition().z > 0.2, `stopped by the pane (z ${g.body.getPosition().z.toFixed(2)})`);

    // It is a pane of its own kind, so sight and shots can tell it from a wall.
    const hit = g.sim.physics.world.castRay(new RAPIER.Ray({ x: 0, y: 1.5, z: -5 }, { x: 0, y: 0, z: 1 }), 30, true);
    assert.equal(g.sim.physics.getOwner(hit!.collider.handle)?.type, 'glass');
  } finally {
    g.sim.dispose();
  }
});

test('bots on a map with a glass wall play on, and see across it', async () => {
  const data = hall(
    [
      { type: 'glass', at: [0, 0, 0], size: [12, 4, 0.15] },
      { type: 'block', at: [14, 0, 0], size: [8, 4, 0.15] },
      { type: 'spawn', at: [0, 0, -15], rot: 180, team: 'blue' },
    ],
    'combat',
  );
  const sim = await ArenaSim.load(mapToArena(data), {});
  try {
    const bots = [0, 1].map((i) => {
      const bot = new BotController(BOT_SKILLS.normal, 11 + i);
      const player = sim.addPlayer({ id: `b${i}`, name: `BOT ${i}` }, bot);
      bot.attach(sim, player);
      return { bot, player };
    });
    for (let i = 0; i < 20 / DT; i++) {
      sim.step(DT);
      for (const { player } of bots) assert.ok(Number.isFinite(player.controller.getPosition().x), 'a bot went to NaN');
    }
    // Stand a bot on each side of a pane, then of a wall: glass is clear, the wall is not.
    const { bot, player } = bots[0];
    const sight = (x: number) => {
      player.controller.setPosition(V(x, 1.02, 5));
      player.controller.setVelocity(V(0, 0, 0));
      bot.perception!.update(0);
      return bot.perception!.lineOfSight(V(x, 1.2, -5));
    };
    assert.equal(sight(0), true, 'a bot sees through glass');
    assert.equal(sight(14), false, 'but not through a wall');
  } finally {
    sim.dispose();
  }
});

test('a jump pad throws a crate that lands on it, and a player, to the marker', async () => {
  const g = await scripted(
    hall([
      { type: 'jump-pad', at: [0, 0, 8], size: [3, 0, 3], to: [0, 0, -8], apex: 3 },
      { type: 'jump-pad', at: [10, 0, 8], size: [3, 0, 3], to: [10, 0, -8], apex: 3 },
      { type: 'crate', at: [0.4, 2.5, 8] },
    ]),
  );
  try {
    const pad = hazards(g.sim, FaithPlate)[0];
    g.body.setPosition(V(10, 1.02, 14));
    const crate = g.sim.arena.props[0];
    let airborne = 0;
    for (let t = 0; t < 4; t += DT) {
      g.stepTo(null);
      if (crate.getPosition().y > 3) airborne++;
    }
    const at = crate.getPosition();
    console.log(`  crate came down at (${at.x.toFixed(2)}, ${at.y.toFixed(2)}, ${at.z.toFixed(2)}) after a ${pad.flightTime.toFixed(2)} s throw`);
    assert.ok(airborne > 20, 'the crate was thrown into the air');
    assert.ok(Math.hypot(at.x, at.z + 8) < 0.7, `crate landed on the marker (${at.x.toFixed(2)}, ${at.z.toFixed(2)})`);

    // And the player, from the near edge of the pad.
    g.walk(10, 8.9, 0.2, 5, () => !g.body.isGrounded);
    for (let i = 0; i < 4 / DT && !(g.body.isGrounded && g.body.getPosition().z < 0); i++) g.stepTo(null);
    const p = g.body.getPosition();
    assert.ok(Math.hypot(p.x - 10, p.z + 8) < 0.3, `player landed on the marker (${p.x.toFixed(2)}, ${p.z.toFixed(2)})`);
    assert.equal(g.body.health.value, g.body.health.max, 'a thrown player lands softly');
  } finally {
    g.sim.dispose();
  }
});

test('a floor button: held by a crate (or a player), with a hold time, driving its door', async () => {
  const g = await scripted(
    hall([
      { type: 'button', at: [0, 0, 8], size: [3, 0, 3], id: 'heavy', needs: 'crate' },
      { type: 'button', at: [8, 0, 8], size: [3, 0, 3], id: 'light', needs: 'any', hold: 1 },
      { type: 'door', at: [-8, 0, -4], size: [4, 3.6, 0.6], receiver: 'heavy' },
      { type: 'door', at: [8, 0, -4], size: [4, 3.6, 0.6], receiver: 'light' },
      { type: 'crate', at: [-6, 0.42, 8] },
    ]),
  );
  try {
    const [heavy, light] = hazards(g.sim, FloorButton);
    const [heavyDoor, lightDoor] = hazards(g.sim, Door);
    const crate = g.sim.arena.props[0];

    // The player alone cannot hold the heavy one; they can hold the light one.
    g.walk(0, 8, 0.3);
    g.idle(0.4);
    assert.equal(heavy.powered, false, 'a player is not heavy enough');
    g.walk(8, 8, 0.3);
    g.idle(0.3);
    assert.equal(light.powered, true, 'a player holds the light button');
    g.idle(2);
    assert.equal(lightDoor.isOpen, true, 'and its door opens');
    // Let go: it stays on for the hold time, then goes.
    g.walk(8, 13, 0.3);
    assert.equal(light.powered, true, 'still on just after stepping off');
    g.idle(1.5);
    assert.equal(light.powered, false, 'off once the hold is over');
    g.idle(2);
    assert.equal(lightDoor.isOpen, false, 'the door shut again');

    // The crate: shoved east onto the heavy button.
    for (let t = 0; t < 12 && !heavy.powered; t += DT) {
      const me = g.body.getPosition();
      const at = crate.getPosition();
      const behind = V(at.x - 1.1, 0, at.z);
      const inLine = Math.abs(me.z - at.z) < 0.25 && me.x < at.x && me.distanceTo(at) < 1.6;
      const target = inLine ? at : behind;
      g.commands.next.forward = 1;
      g.stepTo(V(target.x, me.y, target.z));
    }
    g.commands.next.forward = 0;
    g.idle(1.5);
    assert.equal(heavy.powered, true, 'a crate holds the heavy button');
    assert.equal(heavyDoor.isOpen, true, 'and its door opens');
  } finally {
    g.sim.dispose();
  }
});

test('a cube dispenser holds its crate until the switch, drops it, and gives a fresh one on request', async () => {
  const g = await scripted(
    hall([
      { type: 'dropper', at: [0, 11.2, 0], ceiling: 12, auto: false, id: 'cubes' },
      { type: 'switch', at: [0, 3, -19.99], rot: 180, effect: 'trigger', targets: ['cubes'], cooldown: 1 },
      { type: 'acid', at: [8, 0.01, 0], size: [4, 0, 4] },
    ]),
  );
  try {
    const hatch = hazards(g.sim, Dropper)[0];
    const crate = hatch.box;
    assert.ok(hazards(g.sim, Switch).length === 1);
    g.idle(4);
    assert.ok(crate.getPosition().y > 10, 'the crate hangs there while nobody asks');

    const sw = V(0, 3, -19.9);
    g.shoot('orange', sw);
    g.idle(3);
    const down = crate.getPosition();
    assert.ok(down.y < 1 && down.y > 0.3, `dropped to the floor (y ${down.y.toFixed(2)})`);
    g.idle(5);
    assert.ok(crate.getPosition().y < 1, 'and stays where it fell');

    // Another press: the crate is called back and dropped again.
    g.shoot('orange', sw);
    g.idle(0.2);
    assert.ok(crate.getPosition().y > 10, 'recalled to the hatch');
    g.idle(2.5);
    assert.ok(crate.getPosition().y < 1, 'dropped again');

    // One lost in acid is put back, and waits.
    crate.respawnAt(V(8, 0.4, 0));
    g.idle(0.3);
    assert.equal(crate.visible, false, 'the acid took it');
    g.idle(2);
    assert.ok(crate.visible && crate.getPosition().y > 10, 'back in the hatch');
    g.idle(3);
    assert.ok(crate.getPosition().y > 10, 'waiting for the switch');
  } finally {
    g.sim.dispose();
  }
});

test('buttons, pads and dispensers carry over to another screen with the rest of the hazards', async () => {
  const data = hall([
    { type: 'button', at: [0, 0, 8], size: [3, 0, 3], id: 'b', needs: 'any' },
    { type: 'door', at: [8, 0, -4], size: [4, 3.6, 0.6], receiver: 'b' },
    { type: 'jump-pad', at: [10, 0, 8], size: [3, 0, 3], to: [10, 0, -8] },
    { type: 'dropper', at: [-8, 11.2, 0], ceiling: 12, auto: false },
  ]);
  const server = await scripted(data);
  const client = await ArenaSim.load(mapToArena(data), null);
  try {
    client.netClient = true;
    server.walk(0, 8, 0.3);
    server.idle(0.5);
    assert.equal(hazards(server.sim, FloorButton)[0].powered, true);
    const states = server.sim.arena.hazards.filter((h) => h.netState).map((h) => h.netState!());
    assert.ok(states.length >= 2, 'the button and the dispenser send their state');
    client.syncHazards(states, 0, DT);
    assert.equal(hazards(client, FloorButton)[0].powered, true, 'the button is down on the other screen');
    // …and the door there follows it without being told.
    for (let i = 0; i < 2 / DT; i++) client.step(DT);
    assert.equal(hazards(client, Door)[0].isOpen, true, 'its door opened');
    assert.equal(hazards(client, Dropper)[0].netState()[3], 0, 'a held crate is still held');
  } finally {
    server.sim.dispose();
    client.dispose();
  }
});

test('a mirrored map flips what a button powers: each half has its own', async () => {
  const data: MapData = {
    ...hall(
      [
        { type: 'button', at: [-8, 0, 8], size: [3, 0, 3], id: 'plate' },
        { type: 'door', at: [-8, 0, -4], size: [4, 3.6, 0.6], receiver: 'plate' },
        { type: 'spawn', at: [-12, 0, 15], rot: 0, team: 'orange' },
      ],
      'combat',
    ),
    symmetry: 'rotate180',
  };
  const pieces = expandPieces(data);
  assert.deepEqual(pieces.filter((p) => p.type === 'door').map((d) => d.receiver), ['plate', 'plate~']);
  assert.deepEqual(pieces.filter((p) => p.type === 'button').map((b) => b.id), ['plate', 'plate~']);
  const sim = await ArenaSim.load(mapToArena(data), {});
  try {
    assert.equal(hazards(sim, FloorButton).length, 2);
    assert.equal(hazards(sim, Door).length, 2);
  } finally {
    sim.dispose();
  }
});
