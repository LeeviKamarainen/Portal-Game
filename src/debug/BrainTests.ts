import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session, SessionEvent } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { ArenaDef } from '../world/ArenaBuilder';
import { ARENAS, PVP_ARENA } from '../world/arenas';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS, seededRandom, type BotSkill } from '../bots/BotSkill';
import { TrapSpots } from '../bots/TrapSpots';
import { Crusher } from '../world/hazards/Crusher';
import { IdleCommands } from '../player/PlayerCommand';

/**
 * Milestone 5 of the bot plan: the first playable bot. It goes for orbs it can see, looks
 * for them when it can't, gets out from under hazards, sidesteps when aimed at, and sets
 * floor-portal traps on someone standing in the open - but only someone it has noticed -
 * and in a match against someone who just stands there it wins without dying itself.
 * Milestone 6 added: Hard keeps moving while it lines up its shots, and bots steal a trap
 * exit they see and make it their own. Then Hard got a few cheats and tricks: it knows where
 * you are through walls, hops as it runs, and portals itself up to you on high ground -
 * setting a trap on you on the way down.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

type Internals = { state: string; load(def: ArenaDef, mode: string, index: number): Promise<void> };

interface Setup {
  s: Session;
  you: ArenaPlayer;
  bot: ArenaPlayer;
  brain: BotController;
  events: SessionEvent[];
}

/** A match with a fresh, seeded bot; orbs held back; the local player out of play unless placed. */
async function setup(game: Game, def: ArenaDef, index: number, seed = 5, skill: BotSkill = BOT_SKILLS.normal): Promise<Setup> {
  await (game as unknown as Internals).load(def, 'pvp', index);
  game.input.setScriptedKeys([]);
  for (let i = 0; i < 10; i++) game.step(DT);
  const s = game.session!;
  // Orbs (when a test lets them come) turn up in the same places every run.
  if (s.orbs) s.orbs.random = seededRandom(seed * 31 + 7);
  s.orbs?.clear(Infinity);
  const [you, bot] = s.players;
  const brain = new BotController(skill, seed);
  bot.controller.commands = brain;
  brain.attach(s, bot);
  const events: SessionEvent[] = [];
  const push = s.events.push.bind(s.events);
  s.events.push = (...items) => {
    events.push(...items);
    return push(...items);
  };
  return { s, you, bot, brain, events };
}

/** The local player off the board (so the bot has no one to see). */
function bench(you: ArenaPlayer): void {
  you.controller.setPosition(V(0, -50, 0));
  you.dead = true;
  you.deadFor = -1e9;
}

function place(s: Session, who: ArenaPlayer, p: THREE.Vector3, yaw = 0, pitch = 0): void {
  who.controller.setPosition(p);
  who.controller.setVelocity(new THREE.Vector3());
  who.controller.setLook(yaw, pitch);
  s.system.resync(who.controller);
}

function showOrb(s: Session, i: number, p: THREE.Vector3): void {
  const o = s.orbs!.orbs[i];
  o.pos.copy(p);
  o.active = true;
  o.timer = 10;
  o.group.position.copy(p);
  o.group.visible = true;
}

export async function runBrainTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const run = (seconds: number, until?: () => boolean): number | null => {
    for (let t = 0; t < seconds; t += DT) {
      game.step(DT);
      if (until?.()) return t + DT;
    }
    return null;
  };

  // --- Trap spots on the PvP map --------------------------------------------------------
  let { s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0);
  const traps = TrapSpots.for(s, s.arena, s.level, s.physics);
  const sideways = traps.spots.every((t) => Math.abs(t.normal.y) < 0.5 || t.normal.y < -0.5);
  add('finds deadly portal exits on the PvP map', traps.spots.length >= 20 && sideways, `${traps.spots.length} exits that drop whoever comes out into the acid, found in ${traps.buildMs.toFixed(0)} ms`);

  // --- Goes for an orb it can see ---------------------------------------------------------
  bench(you);
  place(s, bot, V(-14, 1.02, 18), Math.PI);
  showOrb(s, 0, V(-14, 1.1, 26));
  const got = run(10, () => s.match!.player(bot.id)!.score > 0);
  add('goes for an orb it can see', got !== null, got !== null ? `collected it after ${got.toFixed(1)} s` : `score still ${s.match!.player(bot.id)!.score}, goal ${brain.brain!.goal}`);

  // --- Looks for orbs it can't see ---------------------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 9));
  bench(you);
  place(s, bot, V(-14, 1.02, 18), Math.PI);
  // Behind it and round the corner of the spawn platform, out of sight.
  showOrb(s, 0, V(16, 1.1, -14));
  const unseenAtStart = brain.perception!.orbs.length === 0;
  const found = run(60, () => s.match!.player(bot.id)!.score > 0);
  const goals = new Set(brain.brain!.log.filter((r) => r.what.startsWith('goal:')).map((r) => r.what.slice(5)));
  add(
    "explores to find an orb it couldn't see",
    unseenAtStart && found !== null && goals.has('explore'),
    `orb out of sight at the start: ${unseenAtStart}; collected after ${found?.toFixed(1)} s; goals ${[...goals].join(' → ')}`,
  );

  // --- Gets out from under a crusher ------------------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, ARENAS[2], 2));
  bench(you);
  const crushers = s.arena.hazards.filter((h): h is Crusher => h instanceof Crusher);
  const crusher = crushers[1];
  place(s, bot, V(0, 1.02, 8), 0);
  // Held still under it until the warning starts, then left to itself.
  brain.autonomous = false;
  run(10, () => crusher.phaseName === 'up' && crusher.timeInPhase < 0.1);
  run(10, () => crusher.phaseName === 'warn');
  place(s, bot, V(0, 1.02, 8), 0);
  brain.autonomous = true;
  const slam = run(4, () => crusher.phaseName === 'slam');
  const p = bot.controller.getPosition();
  const outFrom = Math.abs(p.z - 8);
  add(
    "steps out from under a crusher when it starts its warning",
    slam !== null && !bot.dead && outFrom > 1.6,
    `${outFrom.toFixed(1)} m clear of its centre when it slammed; alive ${!bot.dead}`,
  );

  // --- Traps: only someone it has noticed --------------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 3));
  place(s, bot, V(0, 9.02, 30), 0);
  // Right behind its back, keeping still and quiet.
  place(s, you, V(0, 9.02, 37), Math.PI);
  run(6);
  const noticed = brain.perception!.log.find((r) => r.what === 'enemy' && r.id === you.id)?.time ?? Infinity;
  const starts = brain.brain!.log.filter((r) => r.what.startsWith('trap:start')).map((r) => r.time);
  add(
    "never goes for someone before it has noticed them",
    starts.every((t) => t >= noticed),
    `noticed you at ${noticed === Infinity ? 'never' : `${noticed.toFixed(1)} s`} (it has to turn round); trap attempts at ${starts.map((t) => t.toFixed(1)).join(', ') || 'none'}`,
  );

  // --- ...and traps someone standing in the open ----------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 3));
  place(s, bot, V(0, 9.02, 30), 0);
  place(s, you, V(-3, 1.02, 14), Math.PI);
  const killed = run(15, () => events.some((e) => e.type === 'death' && e.player === you.id));
  const death = events.find((e) => e.type === 'death' && e.player === you.id) as Extract<SessionEvent, { type: 'death' }> | undefined;
  const steps = brain.brain!.log.filter((r) => r.what.startsWith('trap:') || r.what.startsWith('shot:')).map((r) => `${r.time.toFixed(1)} ${r.what}`);
  const noticedAt = brain.perception!.log.find((r) => r.what === 'enemy' && r.id === you.id)?.time ?? Infinity;
  const firstShot = brain.brain!.log.find((r) => r.what.startsWith('shot:'))?.time ?? Infinity;
  add(
    'sets a portal trap on someone standing in the open',
    killed !== null && death?.cause === 'acid' && death.by === bot.id && firstShot >= noticedAt,
    `${killed !== null ? `killed after ${killed.toFixed(1)} s (${death?.cause}, credited to ${death?.by})` : 'no kill'}; noticed at ${noticedAt.toFixed(1)} s, first shot at ${firstShot.toFixed(1)} s; ${steps.join(', ')}`,
  );

  // --- Hard does the same on the move ------------------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 3, BOT_SKILLS.hard));
  place(s, bot, V(0, 9.02, 30), 0);
  place(s, you, V(-3, 1.02, 14), Math.PI);
  const shotSpeeds: number[] = [];
  const hardKill = run(15, () => {
    if (bot.controller.command.fire) shotSpeeds.push(bot.controller.horizontalSpeed());
    return events.some((e) => e.type === 'death' && e.player === you.id);
  });
  const hardDeath = events.find((e) => e.type === 'death' && e.player === you.id) as Extract<SessionEvent, { type: 'death' }> | undefined;
  add(
    'Hard sets the same trap without stopping to aim',
    hardKill !== null && hardDeath?.by === bot.id && shotSpeeds.length > 0 && shotSpeeds.every((v) => v >= 1.5),
    `${hardKill !== null ? `killed after ${hardKill.toFixed(1)} s (${hardDeath?.cause}, credited to ${hardDeath?.by})` : 'no kill'}; moving at ${shotSpeeds.map((v) => v.toFixed(1)).join(', ') || '-'} m/s when it fired`,
  );

  // --- Steals a trap exit it sees ----------------------------------------------------------
  // (Normal goes for 70% of the portals it sees; this one always does.)
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 6, { ...BOT_SKILLS.normal, stealChance: 1 }));
  place(s, bot, V(0, 9.02, 30), 0);
  bench(you);
  run(DT); // (its eyes see from where it stands)
  // Your exit, on a deadly spot the bot can see from where it stands.
  const eye = bot.controller.getPosition().setY(bot.controller.getPosition().y + 0.8);
  const exitSpot = traps.spots
    .filter((t) => t.normal.dot(eye.clone().sub(t.point)) > 0.3 * eye.distanceTo(t.point) && brain.perception!.lineOfSight(t.point.clone().addScaledVector(t.normal, 0.05)))
    .sort((a, b) => a.point.distanceTo(eye) - b.point.distanceTo(eye))[0];
  // (Shot from just outside the bot's body, along its line of sight.)
  const toSpot = exitSpot ? exitSpot.point.clone().sub(eye).normalize() : V(0, 0, -1);
  const placedExit = !!exitSpot && you.gun.fire('blue', eye.clone().addScaledVector(toSpot, 0.8), toSpot).placed;
  const yours = you.portals.blue;
  const stolen = placedExit ? run(8, () => brain.brain!.log.some((r) => r.what === 'steal:done')) : null;
  const theft = events.find((e) => e.type === 'steal') as Extract<SessionEvent, { type: 'steal' }> | undefined;
  add(
    "steals someone's trap exit and makes it its own",
    stolen !== null && theft?.thief === bot.id && yours.owner === bot.id && bot.portals.blue === yours && brain.brain!.exitSpot !== null,
    placedExit
      ? `${stolen !== null ? `stole it after ${stolen.toFixed(1)} s` : 'never stole it'}; portal now ${yours.owner}'s ${yours.color}; its trap exit ${brain.brain!.exitSpot ? 'set' : 'not set'}; ${brain.brain!.log.filter((r) => r.what.startsWith('steal')).map((r) => `${r.time.toFixed(1)} ${r.what}`).join(', ')}`
      : 'could not place your exit for the test',
  );

  // --- Hard knows where you are; Normal doesn't ----------------------------------------------
  const knows: Record<string, boolean> = {};
  for (const [label, skill] of [['Hard', BOT_SKILLS.hard], ['Normal', BOT_SKILLS.normal]] as const) {
    ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 2, skill));
    brain.autonomous = false;
    brain.scan = false;
    place(s, bot, V(-14, 1.02, -12), 0);
    // Far behind it, up on the north platform, out of sight.
    place(s, you, V(10, 9.02, 31), Math.PI);
    run(0.5);
    knows[label] = !!brain.perception!.enemies.get(you.id)?.visible;
  }
  add('Hard knows where you are wherever you are; Normal only once it sees or hears you', knows.Hard && !knows.Normal, `Hard: ${knows.Hard ? 'knows' : "doesn't know"}; Normal: ${knows.Normal ? 'knows' : "doesn't know"}`);

  // --- Hard portals itself up to you, and traps you on the way down --------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 7, BOT_SKILLS.hard));
  place(s, bot, V(-14, 1.02, -12), 0);
  place(s, you, V(10, 9.02, 31), Math.PI);
  const airShots: string[] = [];
  const climbed = run(15, () => {
    if (bot.controller.command.fire && !bot.controller.isGrounded) airShots.push(`${bot.controller.command.fire} at ${bot.controller.getPosition().y.toFixed(0)} m`);
    return events.some((e) => e.type === 'death' && e.player === you.id);
  });
  const climbDeath = events.find((e) => e.type === 'death' && e.player === you.id) as Extract<SessionEvent, { type: 'death' }> | undefined;
  const climbLog = brain.brain!.log.filter((r) => /^(climb:|trap:start|shot:|flash)/.test(r.what)).map((r) => `${r.time.toFixed(1)} ${r.what}`);
  const through = brain.brain!.log.some((r) => r.what === 'climb:through');
  add(
    'Hard climbs by portal to you on high ground and traps you on the way down',
    climbed !== null && climbDeath?.by === bot.id && through && airShots.length > 0 && !bot.dead,
    `${climbed !== null ? `you died after ${climbed.toFixed(1)} s (${climbDeath?.cause}, credited to ${climbDeath?.by})` : 'no kill'}; shots in mid-air: ${airShots.join(', ') || 'none'}; ${climbLog.join(', ')}`,
  );

  // --- Hard drops in on you from a ceiling (same level as it, or not) -------------------------
  // (Always rolling for it here; in play it's a chance every few seconds.)
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 7, { ...BOT_SKILLS.hard, comboChance: 1 }));
  place(s, bot, V(-8, 1.02, 10), 0);
  place(s, you, V(8, 1.02, 18), Math.PI);
  const dropShots: string[] = [];
  const dropped = run(15, () => {
    if (bot.controller.command.fire && !bot.controller.isGrounded) dropShots.push(`${bot.controller.command.fire} at ${bot.controller.getPosition().y.toFixed(0)} m`);
    return events.some((e) => e.type === 'death' && e.player === you.id);
  });
  const dropDeath = events.find((e) => e.type === 'death' && e.player === you.id) as Extract<SessionEvent, { type: 'death' }> | undefined;
  const dropLog = brain.brain!.log.filter((r) => /^(climb:|combo:|trap:start|shot:|flash)/.test(r.what)).map((r) => `${r.time.toFixed(1)} ${r.what}${r.detail ? ` (${r.detail})` : ''}`);
  add(
    'Hard drops in on you through a ceiling portal and traps you as it falls',
    dropped !== null && dropDeath?.by === bot.id && brain.brain!.stats.dropIns > 0 && dropShots.length > 0 && !bot.dead,
    `${dropped !== null ? `you died after ${dropped.toFixed(1)} s (${dropDeath?.cause}, credited to ${dropDeath?.by})` : 'no kill'}; shots in mid-air: ${dropShots.join(', ') || 'none'}; ${dropLog.join(', ')}`,
  );

  // --- More than one enemy: nearest against leading -----------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 3, BOT_SKILLS.hard));
  const third = s.addPlayer({ id: 'p3', name: 'THIRD' }, new IdleCommands());
  brain.autonomous = false;
  brain.scan = false;
  place(s, bot, V(-14, 1.02, -12), 0);
  place(s, you, V(-6, 1.02, -12), 0);
  place(s, third, V(10, 1.02, 20), 0);
  run(0.3);
  const pick = () => {
    const known = [...brain.perception!.enemies.values()];
    return known.reduce((a, b) => (brain.brain!.priority(b) > brain.brain!.priority(a) ? b : a)).id;
  };
  const evenPick = pick();
  s.match!.award(third.id, 70);
  const leaderPick = pick();
  s.match!.award(you.id, 40);
  const closeScorerPick = pick();
  add(
    'with more than one enemy, it goes after a balance of nearest and leading',
    evenPick === you.id && leaderPick === third.id && closeScorerPick === you.id,
    `level scores: ${evenPick} (you, 8 m away; the other 40 m); the far one on 70: ${leaderPick}; you on 40 to their 70: ${closeScorerPick}`,
  );

  // --- Hard hops as it runs, and never off an edge --------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 12, BOT_SKILLS.hard));
  bench(you);
  s.orbs!.clear(0);
  let hops = 0;
  run(40, () => {
    if (bot.controller.command.jump) hops++;
    return false;
  });
  const hopDeaths = events.filter((e): e is Extract<SessionEvent, { type: 'death' }> => e.type === 'death' && e.player === bot.id);
  add(
    'Hard hops as it runs, and never off an edge',
    hops >= 5 && hopDeaths.length === 0,
    `${hops} hops in 40 s of collecting orbs, ${hopDeaths.length} deaths${hopDeaths.map((d) => ` (${d.cause})`).join('')}, ${s.match!.player(bot.id)!.score} points`,
  );

  // --- Sidesteps when aimed at -------------------------------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 4));
  place(s, bot, V(-14, 1.02, 14), Math.PI);
  place(s, you, V(-14, 1.02, 24), 0);
  // You keep your crosshair on the floor at its feet, as if about to open a portal there.
  const dodged = run(4, () => {
    const b = bot.controller.getPosition();
    const e = you.controller.getPosition();
    const d = b.clone().setY(b.y - 1).sub(e.setY(e.y + 0.8));
    you.controller.setLook(Math.atan2(-d.x, -d.z), Math.asin(d.y / d.length()));
    return brain.brain!.log.some((r) => r.what === 'dodge');
  });
  add('sidesteps when someone it sees aims at the floor under it', dodged !== null, dodged !== null ? `dodged ${dodged.toFixed(2)} s after you started aiming` : 'never dodged');

  // --- A match against someone who just stands there ----------------------------------------
  ({ s, you, bot, brain, events } = await setup(game, PVP_ARENA, 0, 21));
  s.orbs!.clear(0);
  place(s, you, V(-14, 1.02, 18), Math.PI);
  run(150, () => !!s.match!.winner);
  const botDeaths = events.filter((e) => e.type === 'death' && e.player === bot.id).length;
  const kills = events.filter((e) => e.type === 'score' && e.player === bot.id && e.reason === 'kill').length;
  const orbs = events.filter((e) => e.type === 'score' && e.player === bot.id && e.reason === 'orb').length;
  add(
    'wins a match against someone who stands still, without dying',
    s.match!.winner?.id === bot.id && botDeaths === 0,
    `${s.match!.winner ? `${s.match!.winner.name} won` : 'no winner'} at ${s.time.toFixed(0)} s: ${orbs} orbs, ${kills} trap kills, bot deaths ${botDeaths}; turn peak ${((brain.look.peakRate * 180) / Math.PI).toFixed(0)}°/s`,
  );

  const passed = results.filter((r) => r.pass).length;
  const text = [`Bot brain: ${passed}/${results.length} passed`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`)].join('\n');
  return { text, results };
}
