/**
 * The simulation runs in Node with no browser: a whole free-for-all between four bots on
 * the built-in combat map and on the editor's blank combat template.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { simEnv } from '../../src/sim/env';
import { PVP_ARENA } from '../../src/world/arenas';
import { mapToArena } from '../../src/world/maps/MapFormat';
import { blankMap } from '../../src/editor/templates';
import { BotController } from '../../src/bots/BotController';
import { BOT_SKILLS, seededRandom, type BotDifficulty } from '../../src/bots/BotSkill';
import type { ArenaDef } from '../../src/world/ArenaBuilder';

const DT = 1 / 60;
const DIFFICULTIES: BotDifficulty[] = ['hard', 'normal', 'normal', 'easy'];

async function botMatch(def: ArenaDef, seconds: number, seed: number) {
  const sim = await ArenaSim.load(def, {});
  try {
    sim.orbs!.random = seededRandom(seed);
    sim.orbs!.clear(0);
    const started = performance.now();
    DIFFICULTIES.forEach((d, i) => {
      const bot = new BotController(BOT_SKILLS[d], seed * 4 + i);
      bot.attach(sim, sim.addPlayer({ id: `p${i + 1}`, name: `BOT ${i + 1}` }, bot));
    });
    const setupMs = performance.now() - started;

    const ticks = Math.round(seconds / DT);
    let deaths = 0;
    let steps = 0;
    const t0 = performance.now();
    for (; steps < ticks && !sim.match!.over; steps++) {
      sim.step(DT);
      for (const e of sim.events.splice(0)) if (e.type === 'death') deaths++;
      for (const p of sim.players) {
        const at = p.controller.getPosition();
        assert.ok(Number.isFinite(at.x + at.y + at.z), `${p.id} at a NaN position on tick ${steps}`);
      }
    }
    const msPerTick = (performance.now() - t0) / steps;
    return { sim, setupMs, msPerTick, steps, deaths, scores: sim.match!.players.map((p) => p.score) };
  } catch (e) {
    sim.dispose();
    throw e;
  }
}

test('runs without a DOM', () => {
  assert.equal(simEnv.headless, true);
});

for (const [name, def] of [
  ['Highwire', PVP_ARENA],
  ['blank combat template', mapToArena(blankMap())],
] as const) {
  test(`4 bots play ${name} headless`, async () => {
    const r = await botMatch(def, 120, 7);
    console.log(
      `${name}: ${r.steps} ticks (${(r.steps * DT).toFixed(0)} s game time), ${r.msPerTick.toFixed(2)} ms/tick, ` +
        `bots ready in ${r.setupMs.toFixed(0)} ms, scores ${r.scores.join('/')}, ${r.deaths} deaths, sounds last tick ${r.sim.sounds.length}`,
    );
    assert.equal(r.sim.players.length, 4);
    // Highwire has orbs to fight over; the blank template is an empty room, so only check it ran.
    if (def === PVP_ARENA) assert.ok(r.scores.some((s) => s > 0), 'nobody scored in two minutes');
    r.sim.dispose();
  });
}

test('a player can leave mid-match', async () => {
  const sim = await ArenaSim.load(PVP_ARENA, {});
  const join = (id: string, seed: number) => {
    const bot = new BotController(BOT_SKILLS.normal, seed);
    const player = sim.addPlayer({ id, name: id.toUpperCase() }, bot);
    bot.attach(sim, player);
    return player;
  };
  ['p1', 'p2', 'p3'].forEach(join);
  for (let i = 0; i < 300; i++) sim.step(DT);
  const portalsBefore = sim.system.portals.length;
  sim.removePlayer('p2');
  assert.equal(sim.players.length, 2);
  assert.equal(sim.system.portals.length, portalsBefore - 2);
  // The free slot is reused, with the same portal net ids.
  const joiner = join('p4', 4);
  assert.equal(joiner.slot, 1);
  assert.deepEqual([joiner.portals.orange.netId, joiner.portals.blue.netId], [2, 3]);
  for (let i = 0; i < 300; i++) sim.step(DT);
  assert.equal(sim.match!.players.length, 4, 'the leaver keeps a scoreboard row');
  sim.dispose();
});
