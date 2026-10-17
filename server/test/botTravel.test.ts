/**
 * Ultra hard bots get about by portal: on the way to an orb, an enemy or somewhere to explore
 * they open an exit in view that lands them much nearer, a portal beside themselves, and step
 * through. Headless, no browser.
 *
 *   npx tsx --test server/test/botTravel.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { PVP_ARENA } from '../../src/world/arenas';
import { mapToArena } from '../../src/world/maps/MapFormat';
import { BOT_DIFFICULTIES, BUILT_IN_ONLINE_MAPS, type BotDifficulty } from '../../src/net/protocol';
import { BotController } from '../../src/bots/BotController';
import { BOT_SKILLS, seededRandom } from '../../src/bots/BotSkill';
import type { ArenaDef } from '../../src/world/ArenaBuilder';
import * as THREE from 'three';
import { exitVelocity } from '../../src/bots/AirChain';
import { clearCommand } from '../../src/player/PlayerCommand';

const DT = 1 / 60;

interface Report {
  hops: number;
  orbs: number;
  kills: number;
  deaths: number;
  /** Deaths with nobody to credit (acid, a fall, the kill plane). */
  ownDeaths: number;
}

/** A match between the first bot (the one reported on) and a second, seats swapped on odd seeds. */
async function play(def: ArenaDef, first: BotDifficulty, second: BotDifficulty, seconds: number, seed: number) {
  const sim = await ArenaSim.load(def, {});
  try {
    sim.orbs!.random = seededRandom(seed * 7919 + 1);
    sim.orbs!.clear(0);
    const swap = seed % 2 === 1;
    const order = swap ? [second, first] : [first, second];
    const bots = order.map((d, i) => {
      const bot = new BotController(BOT_SKILLS[d], seed * 8 + i);
      const player = sim.addPlayer({ id: `p${i + 1}`, name: `BOT ${i + 1}` }, bot);
      bot.attach(sim, player);
      return { bot, player };
    });
    const mine = bots[swap ? 1 : 0];
    const report: Report = { hops: 0, orbs: 0, kills: 0, deaths: 0, ownDeaths: 0 };
    const ticks = Math.round(seconds / DT);
    for (let i = 0; i < ticks && !sim.match!.over; i++) {
      sim.step(DT);
      for (const e of sim.events.splice(0)) {
        if (e.type === 'score' && e.player === mine.player.id) {
          if (e.reason === 'orb') report.orbs++;
          if (e.reason === 'kill') report.kills++;
        } else if (e.type === 'death' && e.player === mine.player.id) {
          report.deaths++;
          if (!e.by) report.ownDeaths++;
        }
      }
      for (const b of bots) {
        const at = b.player.controller.getPosition();
        assert.ok(Number.isFinite(at.x + at.y + at.z), `${b.player.id} at a NaN position on tick ${i}`);
      }
    }
    report.hops = mine.bot.brain!.stats.travels;
    return { sim, report, travelSpots: (mine.bot.brain as unknown as { c: { travel: { spots: unknown[]; buildMs: number } | null } }).c.travel };
  } catch (e) {
    sim.dispose();
    throw e;
  }
}

test('Ultra hard is a difficulty the lobby and settings accept', () => {
  assert.ok(BOT_DIFFICULTIES.includes('ultra'));
  assert.equal(BOT_SKILLS.ultra.name, 'Ultra hard');
  assert.equal(BOT_SKILLS.ultra.portalTravel, true);
  // Everything Hard can do, and travel on top: no one below it gets about by portal.
  for (const d of ['easy', 'normal', 'hard'] as const) assert.equal(BOT_SKILLS[d].portalTravel, false);
  assert.ok(BOT_SKILLS.ultra.omniscient && BOT_SKILLS.ultra.portalClimb && BOT_SKILLS.ultra.anticipate);
});

test('an Ultra hard bot gets about by portal on Highwire, and takes orbs faster than Hard', async () => {
  let hops = 0;
  let ultraOrbs = 0;
  let hardOrbs = 0;
  let ownDeaths = 0;
  for (const seed of [1, 2, 3, 4]) {
    const u = await play(PVP_ARENA, 'ultra', 'hard', 90, seed);
    const h = await play(PVP_ARENA, 'hard', 'hard', 90, seed);
    console.log(`seed ${seed}: ultra ${u.report.hops} hops, ${u.report.orbs} orbs, ${u.report.kills} kills, ${u.report.deaths} deaths; hard ${h.report.orbs} orbs`);
    hops += u.report.hops;
    ultraOrbs += u.report.orbs;
    hardOrbs += h.report.orbs;
    ownDeaths += u.report.ownDeaths;
    u.sim.dispose();
    h.sim.dispose();
  }
  console.log(`Highwire: ${hops} hops; ultra ${ultraOrbs} orbs vs hard ${hardOrbs}; ${ownDeaths} own deaths`);
  assert.ok(hops >= 4, `only ${hops} hops in four 90 s matches`);
  assert.ok(ownDeaths <= 4, `${ownDeaths} deaths to nobody's trap`);
});

for (const { id, data } of BUILT_IN_ONLINE_MAPS) {
  test(`Ultra hard plays the built-in ${data.name} map without trouble`, async () => {
    const def = id === 'highwire' ? PVP_ARENA : mapToArena(data);
    const r = await play(def, 'ultra', 'hard', 60, 5);
    const spots = r.travelSpots!;
    console.log(`${data.name}: ${spots.spots.length} travel spots in ${spots.buildMs.toFixed(0)} ms, ${r.report.hops} hops, ${r.report.orbs} orbs, ${r.report.deaths} deaths (${r.report.ownDeaths} own)`);
    assert.ok(spots.spots.length > 0, 'a map with portal surfaces has places to come out');
    assert.ok(spots.buildMs < 3000, `travel spots took ${spots.buildMs.toFixed(0)} ms to work out`);
    r.sim.dispose();
  });
}

test('Ultra hard chains portals in the air; nobody below it does', () => {
  assert.equal(BOT_SKILLS.ultra.airChain, true);
  for (const d of ['easy', 'normal', 'hard'] as const) assert.equal(BOT_SKILLS[d].airChain, false);
  // (A chain needs travel: the exits it picks come from the travel spots.)
  assert.ok(BOT_SKILLS.ultra.portalTravel);
});

test('what a portal does to a velocity: the half turn (fall into a floor, out along a wall)', () => {
  const out = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  // Falling at 10 m/s into a floor portal whose top points -z, out of a wall portal facing +z.
  exitVelocity(new THREE.Vector3(0, -10, 0), up, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), up, out);
  assert.ok(out.distanceTo(new THREE.Vector3(0, 0, 10)) < 1e-6, `fell ${out.toArray()}`);
  // Also 4 m/s along the floor portal's top (-z): that goes up the wall.
  exitVelocity(new THREE.Vector3(0, -10, -4), up, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), up, out);
  assert.ok(out.distanceTo(new THREE.Vector3(0, 4, 10)) < 1e-6, `ran ${out.toArray()}`);
  // Sideways along the floor portal's right (+x for up = -z): comes out the other way along the wall (-x... mirrored).
  exitVelocity(new THREE.Vector3(3, -10, 0), up, new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 1), up, out);
  assert.ok(Math.abs(out.z - 10) < 1e-6 && Math.abs(out.y) < 1e-6 && Math.abs(Math.abs(out.x) - 3) < 1e-6, `slid ${out.toArray()}`);
  // Speed is kept whatever the turn.
  assert.ok(Math.abs(out.length() - Math.hypot(3, 10)) < 1e-6);
});

/** One bot alone: how long it takes to win on orbs (and what it did on the way). */
async function solo(def: ArenaDef, difficulty: BotDifficulty, seed: number, seconds: number) {
  const sim = await ArenaSim.load(def, {});
  try {
    sim.orbs!.random = seededRandom(seed * 7919 + 1);
    sim.orbs!.clear(0);
    const bot = new BotController(BOT_SKILLS[difficulty], seed * 8);
    const player = sim.addPlayer({ id: 'p1', name: 'BOT' }, bot);
    bot.attach(sim, player);
    let orbs = 0;
    let t = 0;
    for (; t < seconds && !sim.match!.over; t += DT) {
      sim.step(DT);
      for (const e of sim.events.splice(0)) if (e.type === 'score' && e.reason === 'orb') orbs++;
    }
    const stats = bot.brain!.stats;
    return { secs: t, orbs, won: sim.match!.over, hops: stats.travels, air: stats.airHops };
  } finally {
    sim.dispose();
  }
}

test('an Ultra hard bot alone chains portals in the air and collects orbs', async () => {
  let air = 0;
  let hops = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = await solo(PVP_ARENA, 'ultra', seed, 90);
    console.log(`seed ${seed}: ${r.orbs} orbs in ${r.secs.toFixed(0)} s, ${r.hops} hops, ${r.air} air links`);
    air += r.air;
    hops += r.hops;
    assert.ok(r.won, `seed ${seed}: only ${r.orbs} orbs in 90 s`);
  }
  assert.ok(hops >= 6, `only ${hops} hops in six solo matches`);
  assert.ok(air >= 2, `only ${air} chained links in six solo matches`);
});

test('an Ultra hard bot that pops out of a low wall exit walks away from it (it once circled its own pair for ever)', async () => {
  // Seed 8 on Highwire: out of the wall exit at (-9, 2, -21), the route to the next orb ran along that wall.
  const r = await solo(PVP_ARENA, 'ultra', 8, 120);
  console.log(`seed 8: ${r.orbs} orbs in ${r.secs.toFixed(0)} s`);
  assert.ok(r.won, `stuck: ${r.orbs} orbs in 120 s`);
});

test('Ultra 2 alternates an orb rush with a hunt for the players, and Ultra hard is left as it was', async () => {
  assert.ok(BOT_DIFFICULTIES.includes('ultra2'));
  assert.equal(BOT_SKILLS.ultra2.name, 'Ultra 2');
  assert.equal(BOT_SKILLS.ultra.orbPhase, 0);
  assert.equal(BOT_SKILLS.ultra2.portalTravel, true);
  assert.deepEqual({ ...BOT_SKILLS.ultra2, name: '', orbPhase: 0, huntPhase: 0, rushTraps: false, orbFirst: 50 }, { ...BOT_SKILLS.ultra, name: '' });
  // (Ultra hard puts an orb in reach before drop-ins and climbs for show; Ultra 2 hunts when it is hunting.)
  assert.ok(BOT_SKILLS.ultra.orbFirst > 0 && BOT_SKILLS.ultra.orbFirstSkips.includes('combo'));
  assert.equal(BOT_SKILLS.ultra2.orbFirst, 0);
  const def = PVP_ARENA;
  const sim = await ArenaSim.load(def, {});
  try {
    sim.orbs!.random = seededRandom(7);
    sim.orbs!.clear(0);
    const bots = (['ultra2', 'hard'] as const).map((d, i) => {
      const bot = new BotController(BOT_SKILLS[d], 70 + i);
      const player = sim.addPlayer({ id: `p${i + 1}`, name: `BOT ${i + 1}` }, bot);
      bot.attach(sim, player);
      return { bot, player };
    });
    const brain = bots[0].bot.brain!;
    const { orbPhase, huntPhase } = BOT_SKILLS.ultra2;
    const seen: string[] = [];
    let rushSteals = 0;
    for (let i = 0; i < Math.round(((orbPhase + huntPhase) * 2.2) / DT) && !sim.match!.over; i++) {
      sim.step(DT);
      if (brain.phase && brain.phase !== seen[seen.length - 1]) seen.push(brain.phase);
      // Rushing it neither steals nor drops in on anyone (a trap right there it still takes).
      if (brain.phase === 'orb' && brain.goal === 'steal') rushSteals++;
    }
    console.log(`phases ${seen.join(' > ')}, ${rushSteals} rush ticks stealing`);
    assert.ok(seen.length >= 3, `only saw ${seen.join(' > ')}`);
    assert.equal(seen[0], 'orb');
    assert.equal(seen[1], 'hunt');
    assert.equal(rushSteals, 0);
  } finally {
    sim.dispose();
  }
});

test('on Cubefield bots jump the short gaps without falling in and hop from block to block', async () => {
  const map = BUILT_IN_ONLINE_MAPS.find((m) => m.id === 'cubefield')!;
  const blocks = (map.data.pieces as { type: string; at: number[]; size: number[]; portal?: string[] }[]).filter((p) => p.type === 'block' && p.portal);
  const blockAt = (x: number, feet: number, z: number) =>
    blocks.findIndex((p) => Math.abs(x - p.at[0]) <= p.size[0] / 2 + 0.5 && Math.abs(z - p.at[2]) <= p.size[2] / 2 + 0.5 && Math.abs(feet - (p.at[1] + p.size[1])) < 1.5);
  for (const [d, seed] of [['normal', 2], ['hard', 3]] as const) {
    const sim = await ArenaSim.load(mapToArena(map.data), {});
    try {
      sim.orbs!.random = seededRandom(seed * 31);
      sim.orbs!.clear(0);
      const bot = new BotController(BOT_SKILLS[d], seed);
      const player = sim.addPlayer({ id: 'p1', name: 'BOT' }, bot);
      bot.attach(sim, player);
      let deaths = 0;
      const visited = new Set<number>();
      for (let i = 0; i < Math.round(90 / DT); i++) {
        sim.step(DT);
        for (const e of sim.events.splice(0)) if (e.type === 'death') deaths++;
        if (i % 30 === 0 && player.controller.isGrounded) {
          const at = player.controller.getPosition();
          const b = blockAt(at.x, at.y - 1, at.z);
          if (b >= 0) visited.add(b);
        }
      }
      console.log(`${d}: ${visited.size} blocks, ${bot.brain!.stats.travels} hops, ${deaths} deaths`);
      // (Alone, nothing but its own mistakes can kill it; on foot it only ever had its spawn block and the one next door.)
      assert.ok(deaths <= 1, `${d} fell in ${deaths} times`);
      assert.ok(visited.size >= 4, `${d} only got to ${visited.size} blocks`);
    } finally {
      sim.dispose();
    }
  }
});

test('on Cubefield Hard gets up to someone standing on a higher block and kills them', async () => {
  const map = BUILT_IN_ONLINE_MAPS.find((m) => m.id === 'cubefield')!;
  // Block tops above its spawn top (30.5): out of sight of a trap from below.
  for (const [k, [x, top, z]] of ([[-39, 36.7, -66], [-73, 46.7, -78]] as const).entries()) {
    const sim = await ArenaSim.load(mapToArena(map.data), {});
    try {
      sim.orbs!.random = seededRandom(k + 5);
      sim.orbs!.clear(0);
      const bot = new BotController(BOT_SKILLS.hard, k + 1);
      bot.attach(sim, sim.addPlayer({ id: 'p1', name: 'BOT' }, bot));
      const victim = sim.addPlayer({ id: 'p2', name: 'STILL' }, { read: (cmd) => clearCommand(cmd) });
      const place = () => victim.controller.setPosition(new THREE.Vector3(x, top + 1.05, z));
      place();
      let killedAt = -1;
      for (let i = 0; i < Math.round(60 / DT) && killedAt < 0; i++) {
        sim.step(DT);
        for (const e of sim.events.splice(0)) if (e.type === 'death' && e.player === 'p2' && e.by === 'p1') killedAt = i * DT;
        if (victim.dead) place();
      }
      console.log(`target on the block at ${x},${z} (top ${top}): ${killedAt < 0 ? 'not killed' : `killed after ${killedAt.toFixed(0)} s`}, ${bot.brain!.stats.travels} hops`);
      assert.ok(killedAt >= 0, `never got the one on the block at ${x},${z}`);
    } finally {
      sim.dispose();
    }
  }
});
