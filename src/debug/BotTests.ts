import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { ArenaDef } from '../world/ArenaBuilder';
import { ARENAS, PVP_ARENA } from '../world/arenas';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS } from '../bots/BotSkill';

/**
 * Bots play fair (docs/bot-opponents-plan.md, milestone 3): they notice someone only after
 * seeing them for a moment, never through walls or behind their backs, hear noises only
 * roughly, forget what they lost track of, and turn no faster than their skill allows -
 * starting only after their reaction time.
 *
 * Calibration (arena 1) is the test room: a 3.2 m wall across the middle (z = 0), the bot
 * on one side at z = 6 looking at it, the "enemy" (the local player) moved around by hand.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const SKILL = BOT_SKILLS.normal;
const deg = (r: number) => (r * 180) / Math.PI;

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

type Internals = {
  load(def: ArenaDef, mode: string, index: number): Promise<void>;
};

function place(s: Session, who: ArenaPlayer, p: THREE.Vector3, yaw = 0, pitch = 0): void {
  who.controller.setPosition(p);
  who.controller.setVelocity(new THREE.Vector3());
  who.controller.setLook(yaw, pitch);
  s.system.resync(who.controller);
}

/** A fresh bot (nothing known yet) driving `who`. */
function freshBot(s: Session, who: ArenaPlayer, scan = false, seed = 7): BotController {
  const bot = new BotController(SKILL, seed);
  bot.autonomous = false;
  bot.scan = scan;
  who.controller.commands = bot;
  bot.attach(s, who);
  return bot;
}

async function setup(game: Game, def: ArenaDef = ARENAS[0], index = 0): Promise<{ s: Session; you: ArenaPlayer; bot: ArenaPlayer }> {
  await (game as unknown as Internals).load(def, 'pvp', index);
  game.input.setScriptedKeys([]);
  for (let i = 0; i < 30; i++) game.step(DT);
  const s = game.session!;
  s.orbs?.clear(Infinity);
  return { s, you: s.players[0], bot: s.players[1] };
}

export async function runBotTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const run = (seconds: number, each?: (t: number) => boolean | void) => {
    for (let t = 0; t < seconds; t += DT) {
      game.step(DT);
      if (each?.(t + DT)) return t + DT;
    }
    return null;
  };

  let { s, you, bot } = await setup(game);
  const BOT_AT = V(0, 1.02, 6);

  // --- Sight takes a moment -------------------------------------------------------------
  place(s, you, V(3, 1.02, 1), Math.PI);
  place(s, bot, BOT_AT, 0);
  let brain = freshBot(s, bot);
  const noticed = run(2, () => !!brain.perception!.enemies.get(you.id)?.visible);
  add(
    'notices someone in plain sight, after a moment',
    noticed !== null && noticed >= SKILL.acquireTime - 1e-6 && noticed <= SKILL.acquireTime + 3 * DT,
    `noticed after ${noticed?.toFixed(3)} s (noticing delay ${SKILL.acquireTime} s)`,
  );

  // --- Not through walls ---------------------------------------------------------------
  place(s, you, V(4, 1.02, -5), Math.PI);
  place(s, bot, BOT_AT, 0);
  brain = freshBot(s, bot);
  run(3);
  add("doesn't see through walls", !brain.perception!.enemies.has(you.id), `knows about you after 3 s with the wall between: ${brain.perception!.enemies.has(you.id)}`);

  // --- Not behind its back -------------------------------------------------------------
  place(s, you, V(0.5, 1.02, 11), Math.PI);
  place(s, bot, BOT_AT, 0);
  brain = freshBot(s, bot);
  run(3);
  const behindKnown = brain.perception!.enemies.has(you.id);
  add("doesn't see behind its back", !behindKnown, `knows about a silent player 5 m behind it after 3 s: ${behindKnown}`);

  // --- Hears a shot, turns at a human speed after its reaction time ------------------------
  const yawBefore = bot.controller.lookYaw;
  you.controller.setLook(Math.PI, 0);
  const shotAt = s.time;
  s.fire('orange');
  let firstMove: number | null = null;
  let peak = 0;
  let lastYaw = bot.controller.lookYaw;
  let facing: number | null = null;
  let sawAfterTurn: number | null = null;
  run(3, (t) => {
    const yaw = bot.controller.lookYaw;
    const rate = Math.abs(Math.atan2(Math.sin(yaw - lastYaw), Math.cos(yaw - lastYaw))) / DT;
    lastYaw = yaw;
    peak = Math.max(peak, rate);
    if (firstMove === null && rate > 1e-4) firstMove = t;
    const toYou = Math.atan2(-(you.controller.getPosition().x - BOT_AT.x), -(you.controller.getPosition().z - BOT_AT.z));
    if (facing === null && Math.abs(Math.atan2(Math.sin(toYou - yaw), Math.cos(toYou - yaw))) < (20 * Math.PI) / 180) facing = t;
    if (sawAfterTurn === null && brain.perception!.enemies.get(you.id)?.visible) sawAfterTurn = t;
  });
  const heard = brain.perception!.log.find((r) => r.id === you.id && r.how === 'sound' && r.time >= shotAt);
  const minTurnTime = Math.PI * 0.9 / SKILL.turnRate;
  add(
    'hears a shot behind it and turns round - no instant spin',
    !!heard && firstMove !== null && firstMove >= SKILL.reaction - DT && facing !== null && facing - firstMove >= minTurnTime * 0.9 && peak <= SKILL.turnRate * 1.0001 && sawAfterTurn !== null,
    `heard ${!!heard}; started turning after ${(firstMove as number | null)?.toFixed(2)} s (reaction ${SKILL.reaction} s), faced you ${(facing as number | null)?.toFixed(2)} s after the shot (from yaw ${deg(yawBefore).toFixed(0)}°), peak turn ${deg(peak).toFixed(0)}°/s (cap ${deg(SKILL.turnRate).toFixed(0)}°/s), saw you after ${(sawAfterTurn as number | null)?.toFixed(2)} s`,
  );

  // --- Aim settles while tracking -------------------------------------------------------
  run(1.5);
  const eye = brain.perception!.eye();
  const off = brain.look.offTarget(eye, bot.controller.lookYaw, bot.controller.lookPitch);
  add('keeps you in its sights, with a small and shrinking error', off < (1.5 * Math.PI) / 180 && brain.look.target === `enemy:${you.id}`, `${deg(off).toFixed(2)}° off you after tracking (first-lock error up to ${deg(SKILL.aimError).toFixed(1)}°)`);

  // --- Forgets what it lost ------------------------------------------------------------
  place(s, you, V(4, 1.02, -5), Math.PI);
  run(2);
  const entry = brain.perception!.enemies.get(you.id);
  const mid = entry && { visible: entry.visible, confidence: entry.confidence };
  run(SKILL.memory - 2 + 0.3);
  const gone = !brain.perception!.enemies.has(you.id);
  add(
    'remembers where it lost you for a while, then forgets',
    !!mid && !mid.visible && mid.confidence > 0.4 && mid.confidence < 0.8 && gone,
    `2 s after losing sight: remembered ${!!mid} (confidence ${mid?.confidence.toFixed(2)}); after ${SKILL.memory + 0.3} s: forgotten ${gone}`,
  );

  // --- Orbs: only the ones it has seen --------------------------------------------------
  place(s, bot, BOT_AT, 0);
  brain = freshBot(s, bot);
  const orbs = s.orbs!;
  const show = (i: number, p: THREE.Vector3) => {
    const o = orbs.orbs[i];
    o.pos.copy(p);
    o.active = true;
    o.timer = 10;
    o.group.position.copy(p);
    o.group.visible = true;
  };
  show(0, V(0, 2.1, 12.5));
  run(1);
  const behind = brain.perception!.orbs.length;
  show(1, V(5, 1.1, -8));
  run(0.2);
  const beyond = brain.perception!.orbs.length;
  add(
    'knows only the orbs it has seen (a light column over a wall counts)',
    behind === 0 && beyond === 1 && brain.perception!.orbs[0].distanceTo(V(5, 1.1, -8)) < 0.01,
    `orb behind it: known ${behind > 0}; orb beyond the wall (its column showing over it): known ${beyond > behind}`,
  );
  orbs.clear(Infinity);

  // --- The PvP opponent watches you -----------------------------------------------------
  ({ s, you, bot } = await setup(game, PVP_ARENA, 0));
  const pvpBrain = bot.controller.commands as BotController;
  // Just watching here (left to itself it might set a trap or come for you - see ?test=brain),
  // back on its spawn pad.
  pvpBrain.autonomous = false;
  pvpBrain.scan = false;
  pvpBrain.follower?.stop();
  pvpBrain.look.release();
  const spawn = s.spawnFor(bot.slot);
  place(s, bot, spawn.position, spawn.yaw);
  const dummyAt = spawn.position.clone();
  // On its spawn platform (which ends 6 m in front of it), off to one side.
  place(s, you, V(dummyAt.x + 2, dummyAt.y, dummyAt.z + 4.5), Math.PI);
  run(3);
  const sees = pvpBrain.perception?.enemies.get(you.id)?.visible ?? false;
  const offPvp = pvpBrain.look.offTarget(pvpBrain.perception!.eye(), bot.controller.lookYaw, bot.controller.lookPitch);
  add('the PvP opponent spots you and watches you', sees && offPvp < (3 * Math.PI) / 180, `sees you ${sees}, ${deg(offPvp).toFixed(1)}° off you`);

  const passed = results.filter((r) => r.pass).length;
  const text = [`Bots: ${passed}/${results.length} passed`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`)].join('\n');
  return { text, results };
}
