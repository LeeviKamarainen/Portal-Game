/**
 * Bot portal traps on any map: what an exit portal sends someone to is read off the arena's
 * own hazards and kill plane (and the fall itself), not tied to one map's acid pit.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { mapToArena, type MapData, type Piece } from '../../src/world/maps/MapFormat';
import { BUILT_IN_ONLINE_MAPS } from '../../src/net/protocol';
import { TrapSpots, trapValue } from '../../src/bots/TrapSpots';
import { Spikes } from '../../src/world/hazards/Spikes';
import { BotController } from '../../src/bots/BotController';
import { BOT_SKILLS, seededRandom } from '../../src/bots/BotSkill';

const DT = 1 / 60;

/** A plain 40 x 40 room 10 m high with a spawn, plus whatever else the test adds. */
function room(extra: Piece[], height = 10, killY = -6): MapData {
  return {
    id: 'trap-test',
    name: 'Trap test',
    hint: '',
    kind: 'combat',
    symmetry: 'none',
    killY,
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [40, height, 40], portal: ['walls'], skip: ['floor'] },
      { type: 'block', at: [0, -3, 0], size: [40, 3, 40], portal: ['top'], hide: ['bottom'] },
      { type: 'ceiling-slot', at: [0, height, 0], size: [6, 0.3, 6] },
      { type: 'spawn', at: [0, 0, 17], rot: 0, team: 'orange' },
      { type: 'spawn', at: [4, 0, 17], rot: 0 },
      ...extra,
    ],
  };
}

async function spotsOf(data: MapData) {
  const sim = await ArenaSim.load(mapToArena(data), {});
  const traps = TrapSpots.for(sim, sim.arena, sim.level, sim.physics);
  return { sim, traps };
}

test('every built-in map has trap exits, not only the one with acid', async () => {
  for (const { id, data } of BUILT_IN_ONLINE_MAPS) {
    const { sim, traps } = await spotsOf(data);
    assert.ok(traps.spots.length > 0, `${id}: no trap exits`);
    // Ceiling slots are used (they drop whoever comes out straight down).
    assert.ok(traps.spots.some((s) => s.drop), `${id}: no ceiling exit`);
    assert.ok(traps.buildMs < 2000, `${id}: took ${traps.buildMs.toFixed(0)} ms`);
    sim.dispose();
  }
});

test('a ceiling slot over a spike bed is a kill; over plain floor it is a long fall', async () => {
  // Spikes straight under the slot (the room is only 10 m high: a drop there is a nuisance).
  const over = await spotsOf(room([{ type: 'spikes', at: [0, 0, 0], size: [8, 0, 8], mode: 'static' }]));
  const slot = over.traps.spots.filter((s) => s.drop && Math.abs(s.point.x) < 3 && Math.abs(s.point.z) < 3);
  assert.ok(slot.length > 0, 'no exit found in the slot');
  assert.ok(slot.every((s) => s.kind === 'lethal' && s.cause === 'spikes'), `slot exits: ${slot.map((s) => `${s.kind}/${s.cause}`).join(', ')}`);
  assert.equal(trapValue(slot[0], 100), 1);
  over.sim.dispose();

  // The same slot, 26 m up over bare floor: damaging, not deadly - and it says how much.
  const tall = await spotsOf(room([], 26));
  const drop = tall.traps.spots.filter((s) => s.drop);
  assert.ok(drop.length > 0, 'no ceiling exit in the tall room');
  for (const s of drop) {
    assert.equal(s.kind, 'fall');
    // v = sqrt(2 g h) at 26 m is about 32 m/s: (32 - 13) * 4 = 75 damage; never zero, never a sure kill from full health.
    assert.ok(s.damage > 40 && s.damage < 100, `fall damage ${s.damage}`);
    assert.ok(trapValue(s, 100) > 0.4 && trapValue(s, 100) < 1);
    // Someone already down to 60 health: the same drop finishes them.
    assert.equal(trapValue(s, 60), 1);
  }
  tall.sim.dispose();
});

test('a ceiling slot over a pit with nothing below is the kill plane', async () => {
  // Take the floor away under the slot: whoever comes out falls out of the world.
  const data = room([], 12, -4);
  data.pieces = data.pieces.filter((p) => p.type !== 'block');
  data.pieces.push(
    { type: 'block', at: [-20, -3, 0], size: [10, 3, 40], portal: ['top'], hide: ['bottom'] },
    { type: 'block', at: [20, -3, 0], size: [10, 3, 40], portal: ['top'], hide: ['bottom'] },
    { type: 'block', at: [0, -3, 17], size: [30, 3, 6], portal: ['top'], hide: ['bottom'] },
  );
  const { sim, traps } = await spotsOf(data);
  const slot = traps.spots.filter((s) => s.drop && Math.abs(s.point.x) < 3 && Math.abs(s.point.z) < 3);
  assert.ok(slot.length > 0 && slot.every((s) => s.kind === 'lethal' && s.cause === 'void'), `${slot.map((s) => `${s.kind}/${s.cause}`).join(', ')}`);
  sim.dispose();
});

test('a cycling spike bed is a timed trap with a window the bed keeps', async () => {
  const { sim, traps } = await spotsOf(room([{ type: 'spikes', at: [0, 0, 0], size: [8, 0, 8], mode: 'cycle', rest: 3 }]));
  const timed = traps.spots.filter((s) => s.kind === 'timed');
  assert.ok(timed.length > 0, `no timed exits (${traps.spots.map((s) => s.kind).join(',')})`);
  const bed = timed[0].hazard as Spikes;
  assert.ok(bed instanceof Spikes);
  assert.equal(trapValue(timed[0], 100), 0.9);

  // The window the bed reports is the window it keeps: from `from` it is out far enough to
  // kill, and past `to` it is back down.
  const beds = sim.arena.hazards.filter((h): h is Spikes => h instanceof Spikes);
  assert.equal(beds.length, 1);
  const spikes = beds[0];
  for (let i = 0; i < 5; i++) {
    // Somewhere in the cycle.
    for (let k = 0; k < 37 * (i + 1); k++) sim.step(DT);
    const w = spikes.deadlyWindow();
    assert.ok(w, 'a cycling bed always has a next window');
    assert.ok(w.from >= 0 && w.to > w.from, `window ${w.from}..${w.to}`);
    // A little before it opens it is still low; inside it is out; after it is down again.
    const at = (t: number) => {
      const s2 = Math.round(t / DT);
      for (let k = 0; k < s2; k++) sim.step(DT);
    };
    if (w.from > 0.2) {
      at(w.from - 0.2);
      assert.ok(spikes.extended < 0.35, `out too early (${spikes.extended.toFixed(2)})`);
      at(0.2 + 0.1);
    } else {
      at(w.from + 0.1);
    }
    assert.ok(spikes.extended >= 0.34, `not out inside its window (${spikes.extended.toFixed(2)})`);
    const left = (w.to - w.from) - 0.1;
    at(Math.max(0, left - 0.15));
    assert.ok(spikes.extended >= 0.34, `back down before the window closed (${spikes.extended.toFixed(2)})`);
    at(0.3);
    assert.ok(spikes.extended < 0.5, `still out after the window (${spikes.extended.toFixed(2)})`);
  }
  sim.dispose();
});

test('a bot sets a trap on a map with no acid, no spikes and no pit: a long fall', async () => {
  const sim = await ArenaSim.load(mapToArena(room([], 26)), {});
  try {
    sim.orbs!.random = seededRandom(5);
    sim.orbs!.clear(Infinity);
    const bots = (['hard', 'hard'] as const).map((d, i) => {
      const bot = new BotController(BOT_SKILLS[d], 11 + i);
      bot.attach(sim, sim.addPlayer({ id: `p${i + 1}`, name: `BOT ${i + 1}` }, bot));
      return bot;
    });
    let deaths = 0;
    for (let t = 0; t < 90 && deaths === 0; t += DT) {
      sim.step(DT);
      for (const e of sim.events.splice(0)) if (e.type === 'death') deaths++;
    }
    const sprung = bots.reduce((n, b) => n + (b.brain!.stats.sprung.get('fall') ?? 0), 0);
    assert.ok(sprung > 0, 'no fall trap was sprung in 90 s');
  } finally {
    sim.dispose();
  }
});
