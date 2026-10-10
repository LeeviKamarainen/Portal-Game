import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session, SessionEvent } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { ArenaDef } from '../world/ArenaBuilder';
import { PVP_ARENA } from '../world/arenas';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS, seededRandom, type BotDifficulty } from '../bots/BotSkill';

/**
 * Milestone 6 of the bot plan: bots play whole matches against each other at a fixed
 * timestep, with nobody at the keyboard (a bot drives the local slot too). `?test=sim` plays
 * a handful - 1 v 1 and free-for-all - and checks they play the game properly and fairly;
 * `?test=balance` plays many 1 v 1s and reports win rates by difficulty.
 */

const DT = 1 / 60;
/** A match with no winner by then is called off. */
const MATCH_LIMIT = 300;
/** Standing still this long (not while lining up a shot) counts as stuck. */
const STUCK_LIMIT = 5;
/** Going this long without scoring means it is lost (or going in circles). */
const DROUGHT_LIMIT = 60;
/** Moving at least this fast when it fires counts as shooting on the move, m/s. */
const ON_THE_MOVE = 1.5;
/** A bot that scores nothing in a match this long (or longer) is lost. */
const SCORELESS_AFTER = 30;
/** Hard drops in from a ceiling at least once per this many seconds of match. */
const DROP_IN_EVERY = 45;
/** A free-for-all bot with this many traps set has had the chance to pick more than one target. */
const FFA_BUSY = 3;

type Internals = { load(def: ArenaDef, mode: string, index: number): Promise<void> };

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

export interface BotReport {
  id: string;
  difficulty: BotDifficulty;
  score: number;
  orbs: number;
  kills: number;
  deaths: number;
  /** Deaths nobody gets credit for: walked into a hazard or off an edge by itself. */
  ownGoals: string[];
  steals: number;
  /** Trap and steal shots (climb shots are left out), and how many were fired on the move. */
  shots: number;
  movingShots: number;
  /** Longest it stood still while not lining up a shot, seconds (and what it was doing). */
  longestStill: number;
  stillGoal: string;
  /** Longest it went without scoring, seconds (going in circles shows up here). */
  drought: number;
  peakTurn: number;
  turnCap: number;
  /** Trap or steal attempts started before it had ever noticed the enemy. */
  blindPlans: number;
  /** Portal climbs up to someone, and drop-ins from a ceiling, it came through. */
  climbs: number;
  combos: number;
  /** Who its traps went for (enemy id -> traps started on them). */
  trapsOn: Record<string, number>;
}

export interface MatchReport {
  seed: number;
  winner: string | null;
  time: number;
  bots: BotReport[];
}

interface Watch {
  player: ArenaPlayer;
  bot: BotController;
  report: BotReport;
  stillSince: number;
  stillAt: THREE.Vector3;
}

/** One bot-vs-bot match on the PvP map, played out at a fixed step. */
export async function simMatch(game: Game, a: BotDifficulty, b: BotDifficulty, seed: number): Promise<MatchReport> {
  return simGame(game, [a, b], seed);
}

/** A match between one bot per entry of `difficulties` (more than two: everyone for themselves). */
export async function simGame(game: Game, difficulties: BotDifficulty[], seed: number): Promise<MatchReport> {
  await (game as unknown as Internals).load(PVP_ARENA, 'pvp', 0);
  const s: Session = game.session!;
  s.events.length = 0;
  // Orbs from the seed too (fresh ones, all at once), so the same seed plays the same match.
  s.orbs!.random = seededRandom(seed * 7919 + 1);
  s.orbs!.clear(0);
  const watches: Watch[] = difficulties.map((difficulty, i) => {
    const bot = new BotController(BOT_SKILLS[difficulty], seed * 2 + i);
    const player = s.players[i] ?? s.addPlayer({ id: `p${i + 1}`, name: `BOT ${i + 1}` }, bot);
    player.autopilot = true;
    player.controller.commands = bot;
    bot.attach(s, player);
    return {
      player,
      bot,
      stillSince: 0,
      stillAt: player.controller.getPosition().clone(),
      report: {
        id: player.id,
        difficulty,
        score: 0,
        orbs: 0,
        kills: 0,
        deaths: 0,
        ownGoals: [],
        steals: 0,
        shots: 0,
        movingShots: 0,
        longestStill: 0,
        stillGoal: '',
        drought: 0,
        peakTurn: 0,
        turnCap: BOT_SKILLS[difficulty].turnRate,
        blindPlans: 0,
        climbs: 0,
        combos: 0,
        trapsOn: {},
      },
    };
  });
  const byId = new Map(watches.map((w) => [w.player.id, w.report]));
  const lastScored = new Map(watches.map((w) => [w.report, 0]));

  while (s.time < MATCH_LIMIT && !s.match!.winner) {
    s.step(DT);
    for (const e of s.events.splice(0) as SessionEvent[]) {
      if (e.type === 'score') {
        const r = byId.get(e.player);
        if (r) lastScored.set(r, s.time);
        if (r && e.reason === 'orb') r.orbs++;
        if (r && e.reason === 'kill') r.kills++;
      } else if (e.type === 'death') {
        const r = byId.get(e.player);
        if (!r) continue;
        r.deaths++;
        if (!e.by) {
          const w = watches.find((x) => x.report === r)!;
          const trip = w.player.controller.lastTrip;
          const recent = w.bot.brain!.log.filter((l) => l.time > s.time - 3).map((l) => `${(l.time - s.time).toFixed(1)} ${l.what}`);
          r.ownGoals.push(`${e.cause}@${s.time.toFixed(0)}s${trip ? ` via ${trip.owner}'s portal` : ''}${recent.length ? ` {${recent.join('; ')}}` : ''}`);
        }
      } else if (e.type === 'steal') {
        const r = byId.get(e.thief);
        if (r) r.steals++;
      }
    }
    for (const w of watches) {
      const c = w.player.controller;
      const r = w.report;
      // (Climb shots are taken standing still on purpose - its way in goes right beside it.)
      if (!w.player.dead && c.command.fire && w.bot.brain?.goal !== 'climb') {
        r.shots++;
        if (c.horizontalSpeed() >= ON_THE_MOVE) r.movingShots++;
      }
      r.drought = Math.max(r.drought, s.time - lastScored.get(r)!);
      const goal = w.bot.brain?.goal ?? 'idle';
      const pos = c.getPosition();
      if (w.player.dead || goal === 'trap' || goal === 'steal' || pos.distanceTo(w.stillAt) > 0.5) {
        w.stillAt.copy(pos);
        w.stillSince = s.time;
      } else if (s.time - w.stillSince > r.longestStill) {
        r.longestStill = s.time - w.stillSince;
        r.stillGoal = `${goal}/${w.bot.follower?.status}`;
      }
    }
  }

  for (const w of watches) {
    const r = w.report;
    r.score = s.match!.player(w.player.id)?.score ?? 0;
    // (Up to the end too, for whoever never caught up.)
    r.drought = Math.max(r.drought, s.time - lastScored.get(r)!);
    r.peakTurn = w.bot.look.peakRate;
    // Every trap or steal began after it had noticed someone (or seen their portal).
    const firstSeen = Math.min(...w.bot.perception!.log.filter((p) => p.how === 'sight').map((p) => p.time));
    r.blindPlans = w.bot.brain!.log.filter((l) => (l.what === 'trap:start' || l.what === 'steal:start') && l.time < firstSeen).length;
    const stats = w.bot.brain!.stats;
    r.climbs = stats.climbs;
    r.combos = stats.dropIns;
    r.trapsOn = Object.fromEntries(stats.trapsOn);
  }
  return { seed, winner: s.match!.winner?.id ?? null, time: s.time, bots: watches.map((w) => w.report) };
}

const deg = (r: number) => ((r * 180) / Math.PI).toFixed(0);

function describe(m: MatchReport): string {
  const bots = m.bots
    .map(
      (r) =>
        `${r.id}(${r.difficulty}) ${r.score} pts [${r.orbs} orbs, ${r.kills} kills, ${r.deaths} deaths${r.ownGoals.length ? ` (own: ${r.ownGoals.join(' ')})` : ''}, ${r.steals} steals, ${r.climbs} climbs, ${r.combos} drop-ins, ${r.movingShots}/${r.shots} shots moving, still ${r.longestStill.toFixed(1)} s ${r.stillGoal}, drought ${r.drought.toFixed(0)} s, turn ${deg(r.peakTurn)}/${deg(r.turnCap)}°/s${Object.keys(r.trapsOn).length > 1 ? `, traps on ${Object.entries(r.trapsOn).map(([k, v]) => `${k}:${v}`).join(' ')}` : ''}]`,
    )
    .join(' vs ');
  return `seed ${m.seed}: ${m.winner ?? 'no winner'} at ${m.time.toFixed(0)} s - ${bots}`;
}

export async function runSimTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const started = performance.now();
  const setups: BotDifficulty[][] = [
    ['normal', 'normal'],
    ['normal', 'normal'],
    ['hard', 'normal'],
    ['easy', 'hard'],
    // Free for all.
    ['easy', 'normal', 'hard', 'normal'],
    ['hard', 'hard', 'normal'],
  ];
  const matches: MatchReport[] = [];
  for (let i = 0; i < setups.length; i++) matches.push(await simGame(game, setups[i], 100 + i));
  const all = matches.flatMap((m) => m.bots);
  const lines = matches.map(describe);

  add('every match is won within the time limit', matches.every((m) => m.winner), `${matches.map((m) => `${m.winner ?? '-'} ${m.time.toFixed(0)} s`).join(', ')}`);
  // (A Hard bot can end a free-for-all in under 20 s: someone who never got a look in then is
  // no sign of anything wrong - only a bot that scores nothing in a match that ran on is.)
  const scoreless = matches.flatMap((m) => m.bots.filter((r) => r.score === 0 && m.time >= SCORELESS_AFTER).map((r) => `${r.id}(${r.difficulty}) in ${m.time.toFixed(0)} s`));
  add(
    `every bot scores in every match that runs ${SCORELESS_AFTER}+ s`,
    scoreless.length === 0,
    `${all.map((r) => `${r.id}(${r.difficulty}) ${r.score}`).join(', ')}${scoreless.length ? ` - none: ${scoreless.join(', ')}` : ''}`,
  );
  const still = Math.max(...all.map((r) => r.longestStill));
  add(`nobody stands stuck more than ${STUCK_LIMIT} s`, still <= STUCK_LIMIT, `longest ${still.toFixed(1)} s (${all.find((r) => r.longestStill === still)?.stillGoal})`);
  const drought = Math.max(...all.map((r) => r.drought));
  add(`nobody goes ${DROUGHT_LIMIT} s without scoring`, drought <= DROUGHT_LIMIT, `longest ${drought.toFixed(0)} s`);
  const ownGoals = all.flatMap((r) => r.ownGoals);
  const deaths = all.reduce((n, r) => n + r.deaths, 0);
  add('hardly anyone dies to a hazard on their own', ownGoals.length <= matches.length, `${ownGoals.length} of ${deaths} deaths uncredited: ${ownGoals.join(', ') || 'none'}`);
  const kills = all.reduce((n, r) => n + r.kills, 0);
  const steals = all.reduce((n, r) => n + r.steals, 0);
  add('portal traps kill and portals get stolen', kills > 0 && steals > 0, `${kills} trap kills, ${steals} steals in ${matches.length} matches`);
  add(
    'fair: turns within the cap, no plans before noticing anyone',
    all.every((r) => r.peakTurn <= r.turnCap * 1.001 && r.blindPlans === 0),
    all.map((r) => `${r.id}(${r.difficulty}) ${deg(r.peakTurn)}/${deg(r.turnCap)}°/s, ${r.blindPlans} blind`).join(', '),
  );
  const hard = all.filter((r) => r.difficulty === 'hard');
  const hardMoving = hard.reduce((n, r) => n + r.movingShots, 0);
  const hardShots = hard.reduce((n, r) => n + r.shots, 0);
  const others = all.filter((r) => r.difficulty !== 'hard');
  const otherMoving = others.reduce((n, r) => n + r.movingShots, 0);
  const otherShots = others.reduce((n, r) => n + r.shots, 0);
  const hardDropIns = hard.reduce((n, r) => n + r.combos, 0);
  const hardMatches = matches.filter((m) => m.bots.some((r) => r.difficulty === 'hard')).length;
  // (A direct trap on someone in reach comes first and Hard's matches are short: about one a minute.)
  const hardSeconds = matches.filter((m) => m.bots.some((r) => r.difficulty === 'hard')).reduce((n, m) => n + m.time, 0);
  add(
    'Hard drops in from the ceiling, now and then',
    hardDropIns >= Math.floor(hardSeconds / DROP_IN_EVERY),
    `${hardDropIns} drop-ins (and ${hard.reduce((n, r) => n + r.climbs, 0)} climbs to high ground) by Hard in ${hardMatches} matches, ${hardSeconds.toFixed(0)} s`,
  );
  // (Of the bots that set a few traps at all: a match of 20 s has no time for a second target.)
  const ffa = matches.filter((m) => m.bots.length > 2).flatMap((m) => m.bots);
  const busy = ffa.filter((r) => Object.values(r.trapsOn).reduce((n, v) => n + v, 0) >= FFA_BUSY);
  const spread = busy.filter((r) => Object.keys(r.trapsOn).length > 1).length;
  add(
    'free for all: bots go after more than one opponent',
    busy.length > 0 && spread >= Math.ceil(busy.length / 2),
    `${spread} of ${busy.length} that set ${FFA_BUSY}+ traps set them on more than one: ${ffa.map((r) => `${r.id} ${Object.entries(r.trapsOn).map(([k, v]) => `${k}:${v}`).join(' ') || '-'}`).join(', ')}`,
  );
  add(
    'Hard shoots on the move; the others stop to aim',
    hardShots > 0 && hardMoving / hardShots >= 0.5 && otherMoving / Math.max(otherShots, 1) < 0.25,
    `Hard ${hardMoving}/${hardShots} shots at ${ON_THE_MOVE}+ m/s; Easy/Normal ${otherMoving}/${otherShots}`,
  );

  const passed = results.filter((r) => r.pass).length;
  const text = [
    `Bot sims: ${passed}/${results.length} passed (${((performance.now() - started) / 1000).toFixed(0)} s)`,
    ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`),
    '',
    ...lines,
  ].join('\n');
  return { text, results };
}

/** Win rates by difficulty: `n` matches per pairing (from `?n=`), sides swapped every other one. */
export async function runBalance(game: Game): Promise<{ text: string; results: unknown }> {
  const n = Number(new URLSearchParams(location.search).get('n')) || 50;
  const started = performance.now();
  const pairings: [BotDifficulty, BotDifficulty][] = [
    ['easy', 'normal'],
    ['normal', 'hard'],
    ['easy', 'hard'],
  ];
  const rows: string[] = [];
  const results: unknown[] = [];
  for (const [weak, strong] of pairings) {
    let strongWins = 0;
    let weakWins = 0;
    let time = 0;
    let margin = 0;
    for (let i = 0; i < n; i++) {
      const swap = i % 2 === 1;
      const m = await simMatch(game, swap ? strong : weak, swap ? weak : strong, 1000 + i);
      const s = m.bots.find((r) => r.difficulty === strong)!;
      const w = m.bots.find((r) => r.difficulty === weak)!;
      if (m.winner === s.id) strongWins++;
      else if (m.winner === w.id) weakWins++;
      time += m.time;
      margin += s.score - w.score;
      results.push(m);
    }
    rows.push(
      `${strong} vs ${weak}: ${strong} won ${strongWins}/${n} (${((100 * strongWins) / n).toFixed(0)}%), ${weak} ${weakWins}, unfinished ${n - strongWins - weakWins}; average ${(time / n).toFixed(0)} s, margin ${(margin / n).toFixed(0)} pts`,
    );
  }
  const text = [`Bot balance: ${n} matches per pairing (${((performance.now() - started) / 1000).toFixed(0)} s)`, ...rows].join('\n');
  return { text, results };
}
