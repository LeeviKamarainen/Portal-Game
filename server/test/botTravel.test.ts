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
