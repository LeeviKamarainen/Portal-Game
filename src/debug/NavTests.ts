import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { ArenaDef } from '../world/ArenaBuilder';
import { ARENAS, PVP_ARENA } from '../world/arenas';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS } from '../bots/BotSkill';
import type { NavGraph, NavLink, NavNode } from '../bots/NavGraph';
import type { FollowStatus } from '../bots/PathFollower';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';
import { Crusher } from '../world/hazards/Crusher';

/**
 * Milestone 4 of the bot plan: bots find their way. The navigation graph covers every tier
 * of an arena and nothing deadly; a bot walks routes - stairs, drops, jumps - only by
 * pressing the same keys a person would; it waits for crushers instead of walking under
 * them; and routes that need portals (the tutorial exits) are correctly not found yet.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

type Internals = { load(def: ArenaDef, mode: string, index: number): Promise<void> };

async function setup(game: Game, def: ArenaDef, index: number): Promise<{ s: Session; you: ArenaPlayer; bot: ArenaPlayer; brain: BotController; nav: NavGraph }> {
  await (game as unknown as Internals).load(def, 'pvp', index);
  game.input.setScriptedKeys([]);
  for (let i = 0; i < 10; i++) game.step(DT);
  const s = game.session!;
  s.orbs?.clear(Infinity);
  const [you, bot] = s.players;
  // Out of the way and out of sight, so the bot isn't distracted watching.
  you.controller.setPosition(V(you.controller.getPosition().x, -50, you.controller.getPosition().z));
  you.dead = true;
  you.deadFor = -1e9;
  const brain = new BotController(BOT_SKILLS.normal, 11);
  brain.autonomous = false;
  brain.scan = false;
  bot.controller.commands = brain;
  brain.attach(s, bot);
  return { s, you, bot, brain, nav: brain.nav! };
}

function place(s: Session, who: ArenaPlayer, p: THREE.Vector3, yaw = 0): void {
  who.controller.setPosition(p);
  who.controller.setVelocity(new THREE.Vector3());
  who.controller.setLook(yaw, 0);
  s.system.resync(who.controller);
}

interface Walk {
  status: FollowStatus;
  time: number;
  died: boolean;
  waited: number;
  minHealth: number;
  kinds: Set<string>;
  end: THREE.Vector3;
}

/** Steps until the bot arrives (or gives up / dies / runs out of time). */
function walk(game: Game, _s: Session, bot: ArenaPlayer, brain: BotController, to: THREE.Vector3, seconds: number): Walk {
  const status0 = brain.goTo(to);
  const kinds = new Set(brain.follower!.path?.links.map((l) => l.kind) ?? []);
  const w: Walk = { status: status0, time: 0, died: false, waited: 0, minHealth: bot.controller.health.value, kinds, end: new THREE.Vector3() };
  if (status0 === 'no-path') return w;
  for (let t = 0; t < seconds; t += DT) {
    game.step(DT);
    w.time = t + DT;
    w.minHealth = Math.min(w.minHealth, bot.controller.health.value);
    if (bot.dead) {
      w.died = true;
      break;
    }
    const st = brain.follower!.status;
    if (st === 'waiting') w.waited += DT;
    if (st === 'arrived' || st === 'stuck' || st === 'no-path') break;
  }
  w.status = brain.follower!.status;
  w.end.copy(bot.controller.getPosition());
  return w;
}

const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

export async function runNavTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // --- The PvP map's graph -------------------------------------------------------------
  let { s, bot, brain, nav } = await setup(game, PVP_ARENA, 0);
  const kinds = { walk: 0, drop: 0, jump: 0 };
  for (const n of nav.nodes) for (const l of n.links) kinds[l.kind]++;
  const tiers = new Set(nav.nodes.map((n) => Math.round(n.y / 4))).size;
  const unsafe = nav.nodes.filter((n) => s.arena.hazards.some((h) => h.covers?.(V(n.x, n.y, n.z)) && !h.dangerNow));
  add(
    'the PvP map is mapped: every tier, nothing deadly',
    nav.nodes.length > 3000 && tiers >= 4 && kinds.drop > 0 && kinds.jump > 0 && unsafe.length === 0 && nav.buildMs < 1000,
    `${nav.nodes.length} floor points over ${tiers} height bands, links ${JSON.stringify(kinds)}, ${unsafe.length} over acid, built in ${nav.buildMs.toFixed(0)} ms`,
  );

  // --- Spawn to spawn on foot: stairs, ground floor, round the acid, up the far stairs ------
  const far = s.spawnFor(1).position.clone();
  place(s, bot, s.spawnFor(0).position.clone(), Math.PI);
  game.step(DT);
  const across = walk(game, s, bot, brain, far, 60);
  add(
    'walks from one spawn to the other (stairs, floor, stairs)',
    across.status === 'arrived' && !across.died && across.end.distanceTo(far) < 1.2 && across.minHealth >= 90,
    `${across.status} after ${across.time.toFixed(1)} s at ${fmt(across.end)} (goal ${fmt(far)}), route ${[...across.kinds].join('/')}, lowest health ${across.minHealth.toFixed(0)}`,
  );
  add('turns no faster than its skill allows while walking', brain.look.peakRate <= BOT_SKILLS.normal.turnRate * 1.0001, `peak turn ${((brain.look.peakRate * 180) / Math.PI).toFixed(0)}°/s (cap ${((BOT_SKILLS.normal.turnRate * 180) / Math.PI).toFixed(0)}°/s)`);

  // --- Jumps: every jump link it might take on this map, a few of them tried for real ----
  const jumps: Array<[NavNode, NavLink]> = [];
  for (const n of nav.nodes) for (const l of n.links) if (l.kind === 'jump') jumps.push([n, l]);
  // Up to three jumps up onto something, and two across gaps.
  const isUp = ([from, l]: [NavNode, NavLink]) => nav.nodes[l.to].y > from.y + 0.5;
  const ups = jumps.filter(isUp);
  const gaps = jumps.filter((j) => !isUp(j));
  const spread = <T,>(list: T[], n: number) => list.filter((_, i) => i % Math.max(1, Math.floor(list.length / n)) === 0).slice(0, n);
  const tries = [...spread(ups, 3), ...spread(gaps, 2)];
  const jumpResults: string[] = [];
  let jumpOk = 0;
  for (const [from, link] of tries) {
    const to = nav.nodes[link.to];
    place(s, bot, nav.standAt(from), 0);
    game.step(DT);
    const w = walk(game, s, bot, brain, nav.standAt(to), 6);
    const feet = w.end.y - PLAYER_FEET_OFFSET;
    const ok = w.status === 'arrived' && Math.abs(feet - to.y) < 0.4 && !w.died;
    if (ok) jumpOk++;
    jumpResults.push(`${fmt(V(from.x, from.y, from.z))}→${fmt(V(to.x, to.y, to.z))} ${ok ? 'ok' : `${w.status} at ${fmt(w.end)}`}`);
  }
  add('takes jumps (up onto ledges, across gaps)', tries.length > 0 && jumpOk === tries.length, `${jumpOk}/${tries.length}: ${jumpResults.join('; ')}`);

  // --- A drop: off the Calibration divider (3.2 m, no fall damage) ------------------------
  ({ s, bot, brain, nav } = await setup(game, ARENAS[0], 0));
  place(s, bot, V(0.5, 3.2 + PLAYER_FEET_OFFSET + 0.05, 0), 0);
  game.step(DT);
  const down = walk(game, s, bot, brain, V(0.5, 1.02, 8.5), 10);
  add(
    'drops off a ledge it can safely fall from',
    down.status === 'arrived' && down.kinds.has('drop') && down.minHealth === 100,
    `${down.status} after ${down.time.toFixed(1)} s via ${[...down.kinds].join('/')}, health ${down.minHealth.toFixed(0)}`,
  );

  // --- Exits that need portals are not reachable on foot ---------------------------------
  const exitPath = (sess: Session, n: NavGraph) => {
    const g = sess.arena.goal!.position;
    return n.findPath(sess.spawnFor(0).position, V(g.x, g.y + 1.02, g.z));
  };
  const calib = exitPath(s, nav);
  ({ s, bot, brain, nav } = await setup(game, ARENAS[3], 3));
  const proving = exitPath(s, nav);
  add("doesn't invent routes: tutorial exits that need portals have none on foot", !calib && !proving, `Calibration exit route: ${!!calib}, Proving Grounds exit route: ${!!proving}`);

  // --- Crushers: waits for each, never walks under one coming down ------------------------
  ({ s, bot, brain, nav } = await setup(game, ARENAS[2], 2));
  place(s, bot, V(0, 1.02, 15.5), 0);
  // Set off just as the first crusher starts its warning, so there is something to wait for.
  const first = s.arena.hazards.find((h): h is Crusher => h instanceof Crusher)!;
  for (let t = 0; t < 10 && first.phaseName !== 'warn'; t += DT) game.step(DT);
  const gallery = walk(game, s, bot, brain, V(0, 1.02, -1), 40);
  add(
    'waits for a crusher that is about to come down, and gets through alive',
    gallery.status === 'arrived' && !gallery.died && gallery.waited > 0.2,
    `${gallery.status} after ${gallery.time.toFixed(1)} s, waited ${gallery.waited.toFixed(1)} s for crushers, died ${gallery.died}`,
  );

  const passed = results.filter((r) => r.pass).length;
  const text = [`Navigation: ${passed}/${results.length} passed`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`)].join('\n');
  return { text, results };
}
