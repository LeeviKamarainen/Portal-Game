import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session, SessionEvent } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { ArenaDef } from '../world/ArenaBuilder';
import { ARENAS, PVP_ARENA } from '../world/arenas';
import { LAYER_WORLD } from '../core/RenderLayers';
import { clearCommand, type CommandSource, type PlayerCommand } from '../player/PlayerCommand';
import type { PortalColor } from '../portals/Portal';

/**
 * Milestones 1-2 of the bot plan (docs/bot-opponents-plan.md): more than one player in an
 * arena, and stealing each other's portals. The PvP arena's dummy opponent stands in for a bot: it has its own portal pair in
 * its own colours, hazards act on it, kills on it are credited through portals, it respawns
 * on its own, and it acts only through the same commands the keyboard produces.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

type Internals = {
  state: string;
  load(def: ArenaDef, mode: string, index: number): Promise<void>;
};

const internals = (game: Game) => game as unknown as Internals;
const stateOf = (game: Game) => internals(game).state;

/** A command source a test steers by hand. */
class Scripted implements CommandSource {
  next: Partial<PlayerCommand> = {};
  read(cmd: PlayerCommand): void {
    clearCommand(cmd);
    Object.assign(cmd, this.next);
    this.next = {};
  }
}

function settle(game: Game, seconds: number): void {
  game.input.setScriptedKeys([]);
  for (let t = 0; t < seconds; t += DT) game.step(DT);
}

/** Records every session event (Game drains them each step). */
function recordEvents(s: Session): SessionEvent[] {
  const seen: SessionEvent[] = [];
  const push = s.events.push.bind(s.events);
  s.events.push = (...items) => {
    seen.push(...items);
    return push(...items);
  };
  return seen;
}

function place(s: Session, who: ArenaPlayer, p: THREE.Vector3, yaw = 0, pitch = 0): void {
  who.controller.setPosition(p);
  who.controller.setVelocity(new THREE.Vector3());
  who.controller.setLook(yaw, pitch);
  s.system.resync(who.controller);
}

function shoot(who: ArenaPlayer, color: PortalColor, eye: THREE.Vector3, at: THREE.Vector3) {
  return who.gun.fire(color, eye, at.clone().sub(eye).normalize());
}

async function loadPvp(game: Game, def: ArenaDef = PVP_ARENA, index = 0): Promise<Session> {
  await internals(game).load(def, 'pvp', index);
  settle(game, 0.5);
  const s = game.session!;
  s.orbs?.clear(Infinity);
  return s;
}

export async function runPlayerTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

  // --- Two players on Highwire --------------------------------------------------------
  let s = await loadPvp(game);
  const [you, dummy] = s.players;
  const apart = you.controller.getPosition().distanceTo(dummy.controller.getPosition());
  const distinct = you.palette.orange !== dummy.palette.orange && you.palette.blue !== dummy.palette.blue;
  add(
    'PvP has you and an opponent, apart, in different colours',
    s.players.length === 2 && dummy.name === 'DUMMY' && apart > 30 && distinct && s.match!.players.length === 2,
    `${s.players.map((p) => `${p.name} at ${p.controller.getPosition().toArray().map((v) => v.toFixed(0)).join(',')} ${hex(p.palette.orange)}/${hex(p.palette.blue)}`).join('; ')}; ${apart.toFixed(1)} m apart`,
  );

  // The opponent's body arrives asynchronously, drawn by the main camera.
  for (let i = 0; i < 100 && !dummy.avatar; i++) await new Promise((r) => setTimeout(r, 30));
  settle(game, 0.1);
  let seen = false;
  dummy.avatar?.object.traverse((o) => (seen ||= (o as THREE.Mesh).isMesh && o.layers.isEnabled(LAYER_WORLD)));
  add('the opponent has a visible body', !!dummy.avatar && seen && dummy.avatar.object.visible, `avatar ${!!dummy.avatar}, on the world layer ${seen}`);

  // --- The opponent acts only through commands ------------------------------------------
  const script = new Scripted();
  dummy.controller.commands = script;
  place(s, dummy, V(-18, 1.02, 17), 0);
  const yaw0 = dummy.controller.lookYaw;
  script.next = { yaw: 0.2 };
  game.step(DT);
  const turned = dummy.controller.lookYaw - yaw0;
  const start = dummy.controller.getPosition();
  for (let t = 0; t < 0.5; t += DT) {
    script.next = { forward: 1 };
    game.step(DT);
  }
  const walked = dummy.controller.getPosition().distanceTo(start);
  place(s, dummy, V(-18, 1.02, 17), 0, -0.6);
  script.next = { fire: 'orange' };
  game.step(DT);
  const fired = dummy.portals.orange;
  add(
    'the opponent turns, walks and shoots through its command',
    Math.abs(turned - 0.2) < 1e-6 && walked > 2 && walked < 4 && fired.placed && fired.owner === dummy.id && fired.tint === dummy.palette.orange,
    `turned ${turned.toFixed(3)} rad, walked ${walked.toFixed(2)} m in 0.5 s, portal placed ${fired.placed} (owner ${fired.owner}, ${hex(fired.tint)})`,
  );
  fired.unplace();
  dummy.controller.commands = { read: clearCommand };

  // --- Two portal pairs at once ----------------------------------------------------------
  const eyeA = V(-18, 1.82, 17);
  place(s, you, V(-14, 1.02, 26));
  const dummyPair = shoot(dummy, 'orange', eyeA, V(-18, 0, 12)).placed && shoot(dummy, 'blue', eyeA, V(-18, 0, 23)).placed;
  const overlap = shoot(you, 'orange', eyeA, V(-18, 0, 12));
  const yourPair = shoot(you, 'orange', V(-3, 1.82, 15), V(-3, 0, 12)).placed && shoot(you, 'blue', V(-3, 1.82, 23), V(-3, 0, 26)).placed;
  add(
    'both pairs open at once; no portal on top of another player\'s',
    dummyPair && yourPair && !overlap.placed && s.system.portals.filter((p) => p.isOpen).length === 4,
    `dummy pair ${dummyPair}, your pair ${yourPair}, your shot onto the dummy's portal placed: ${overlap.placed}; ${s.system.portals.filter((p) => p.isOpen).length} open portals`,
  );

  // You travel through the opponent's pair: credit goes to them.
  const through = (who: ArenaPlayer, x: number) => {
    const n = s.system.teleportCount(who.controller);
    place(s, who, V(x, 2.6, 12.2));
    for (let t = 0; t < 2 && s.system.teleportCount(who.controller) === n; t += DT) game.step(DT);
    for (let t = 0; t < 1 && who.controller.getPosition().y < 1.6; t += DT) game.step(DT);
    return s.system.teleportCount(who.controller) > n;
  };
  const youWent = through(you, -18);
  const yourTrip = you.controller.lastTrip?.owner ?? null;
  add("you can travel through the opponent's portals", youWent && yourTrip === dummy.id, `teleported ${youWent}, credited to ${yourTrip}`);

  // Rendering: every visible open portal gets a view, within budget.
  place(s, you, V(-10, 1.02, 27), 0, -0.45);
  settle(game, 0.3);
  game.renderNow();
  const views = s.portalRenderer.stats.views;
  const budget = 2 * s.portalRenderer.maxDepth;
  add('four open portals render within the view budget', views >= 4 && views <= budget + 2, `${views} portal views (budget ${budget})`);

  // --- Hazards act on the opponent, and kills on it are credited through portals -------
  const events = recordEvents(s);
  for (const p of s.system.portals) p.unplace();
  const eyeB = V(-18, 1.82, 17);
  place(s, you, V(-14, 1.02, 26));
  shoot(you, 'orange', eyeB, V(-18, 0, 12));
  shoot(you, 'blue', eyeB, V(-18, 0, 23));
  const dummyWent = through(dummy, -18);
  you.portals.orange.unplace();
  you.portals.blue.unplace();
  settle(game, 0.8);
  const before = s.match!.player(you.id)!.score;
  place(s, dummy, V(6, 1.2, 0));
  for (let t = 0; t < 3 && !dummy.dead; t += DT) game.step(DT);
  const death = events.find((e) => e.type === 'death' && e.player === dummy.id) as Extract<SessionEvent, { type: 'death' }> | undefined;
  const gained = s.match!.player(you.id)!.score - before;
  add(
    'a portal trap on the opponent scores for you',
    dummyWent && dummy.dead && death?.cause === 'acid' && death.by === you.id && gained === s.match!.rules.killPoints && stateOf(game) === 'playing',
    `through your portal: ${dummyWent}; died ${dummy.dead} (${death?.cause}), credited to ${death?.by}, you +${gained}, your state ${stateOf(game)}`,
  );

  // It comes back on its own spawn, protected, portals closed.
  shoot(dummy, 'orange', eyeA, V(-18, 0, 12));
  const spawn = s.spawnFor(dummy.slot).position;
  let back = -1;
  for (let t = 0; t < 3; t += DT) {
    game.step(DT);
    if (!dummy.dead) {
      back = t;
      break;
    }
  }
  const atSpawn = dummy.controller.getPosition().distanceTo(spawn);
  add(
    'the opponent respawns by itself at its spawn',
    back > 1 && back < 2 && atSpawn < 0.6 && dummy.controller.isImmune() && !dummy.portals.orange.placed,
    `back after ${back.toFixed(2)} s, ${atSpawn.toFixed(2)} m from its spawn, protected ${dummy.controller.isImmune()}, portals closed ${!dummy.portals.orange.placed}`,
  );

  // Your death in a match doesn't reset the arena: the opponent's portals stay open.
  settle(game, 1.6);
  shoot(dummy, 'orange', eyeA, V(-18, 0, 12));
  shoot(dummy, 'blue', eyeA, V(-18, 0, 23));
  place(s, you, V(6, 1.2, 0));
  for (let t = 0; t < 3 && stateOf(game) !== 'dying'; t += DT) game.step(DT);
  for (let t = 0; t < 3 && stateOf(game) !== 'playing'; t += DT) game.step(DT);
  const kept = dummy.portals.orange.placed && dummy.portals.blue.placed;
  add(
    "your respawn in a match leaves everyone else's portals alone",
    kept && !s.isDead && you.controller.getPosition().distanceTo(s.spawnFor(0).position) < 0.6,
    `opponent's pair still open ${kept}, you back at your spawn ${!s.isDead}`,
  );

  // --- Portal stealing -----------------------------------------------------------------
  s = await loadPvp(game);
  const [thief, mark] = s.players;
  const log = recordEvents(s);
  const markScript = new Scripted();
  mark.controller.commands = markScript;
  const aim = (who: ArenaPlayer, at: THREE.Vector3) => {
    const d = at.clone().sub(who.controller.getPosition().setY(who.controller.getPosition().y + 0.8)).normalize();
    who.controller.setLook(Math.atan2(-d.x, -d.z), Math.asin(d.y));
  };
  const markEye = V(-18, 1.82, 17);
  shoot(mark, 'orange', markEye, V(-18, 0, 12));
  shoot(mark, 'blue', markEye, V(-18, 0, 23));
  shoot(thief, 'orange', V(-3, 1.82, 15), V(-3, 0, 12));
  const prize = mark.portals.orange;
  place(s, thief, V(-14, 1.02, 15));
  aim(thief, prize.surfaceCenter);
  const took = s.fire('blue');
  game.step(DT);
  const toast = document.querySelector('.hud .toasts')?.textContent ?? '';
  add(
    "shooting someone's portal steals it",
    took &&
      thief.portals.blue === prize &&
      prize.owner === thief.id &&
      prize.color === 'blue' &&
      prize.tint === thief.palette.blue &&
      prize.linked === thief.portals.orange &&
      prize.isOpen &&
      !mark.portals.orange.placed &&
      mark.portals.orange.tint === mark.palette.orange &&
      mark.portals.blue.placed &&
      !mark.portals.blue.isOpen &&
      log.some((e) => e.type === 'steal' && e.thief === thief.id) &&
      toast.includes("STOLE DUMMY'S PORTAL"),
    `now your ${prize.color} (${hex(prize.tint)}), linked to your orange: ${prize.linked === thief.portals.orange}; dummy's other portal open: ${mark.portals.blue.isOpen}; toast "${toast}"`,
  );

  // It works as the thief's portal: the dummy falls in and comes out of the thief's orange,
  // credited to the thief.
  place(s, mark, V(-18, 2.6, 12.2));
  const n0 = s.system.teleportCount(mark.controller);
  for (let t = 0; t < 2 && s.system.teleportCount(mark.controller) === n0; t += DT) game.step(DT);
  const out = mark.controller.getPosition();
  add(
    "a stolen portal leads to the thief's other portal",
    s.system.teleportCount(mark.controller) > n0 && Math.abs(out.x + 3) < 1.5 && mark.controller.lastTrip?.owner === thief.id,
    `came out at x ${out.x.toFixed(2)} (thief's orange at x -3), credited to ${mark.controller.lastTrip?.owner}`,
  );
  settle(game, 1.5);

  // The victim places a new portal and its pair works again; then steals back through its own commands.
  shoot(mark, 'orange', V(-14, 1.82, 20), V(-14, 0, 26));
  const relinked = mark.portals.blue.isOpen;
  place(s, mark, V(-14, 1.02, 15));
  aim(mark, prize.surfaceCenter);
  markScript.next = { fire: 'orange' };
  game.step(DT);
  const toast2 = document.querySelector('.hud .toasts')?.textContent ?? '';
  add(
    'the victim can re-pair, and steal it back',
    relinked && mark.portals.orange === prize && prize.owner === mark.id && prize.tint === mark.palette.orange && prize.isOpen && !thief.portals.blue.placed && toast2.includes('DUMMY STOLE YOUR PORTAL'),
    `re-paired ${relinked}; stolen back: owner ${prize.owner} (${hex(prize.tint)}), your blue slot empty ${!thief.portals.blue.placed}; toast "${toast2}"`,
  );

  // Mid-passage: you are falling into the dummy's portal when you steal it - you come out of yours.
  place(s, thief, V(-18, 3.2, 12.2));
  for (let t = 0; t < 1 && thief.controller.passing !== prize; t += DT) game.step(DT);
  const wasPassing = thief.controller.passing === prize;
  const r = shoot(thief, 'blue', V(-14, 1.82, 14), prize.surfaceCenter);
  const stoleMid = !!r.stolen && s.steal(thief, 'blue', r.stolen);
  const n1 = s.system.teleportCount(thief.controller);
  for (let t = 0; t < 2 && s.system.teleportCount(thief.controller) === n1; t += DT) game.step(DT);
  const exit = thief.controller.getPosition();
  add(
    'stealing a portal mid-passage sends you to the new partner',
    wasPassing && stoleMid && s.system.teleportCount(thief.controller) > n1 && Math.abs(exit.x + 3) < 1.5,
    `passing when stolen ${wasPassing}, stolen ${stoleMid}, came out at x ${exit.x.toFixed(2)} (your orange at x -3)`,
  );

  // Your own portals are not "stolen": shooting one just tries to move a portal.
  const steals = log.filter((e) => e.type === 'steal').length;
  shoot(thief, 'orange', V(-14, 1.82, 14), prize.surfaceCenter);
  add('shooting your own portal steals nothing', log.filter((e) => e.type === 'steal').length === steals && thief.portals.blue === prize, `steal events ${steals} -> ${log.filter((e) => e.type === 'steal').length}`);

  // --- A laser hits whoever stands in it ------------------------------------------------
  s = await loadPvp(game, ARENAS[2], 2);
  const laserDummy = s.players[1];
  place(s, laserDummy, V(-4, 1.02, -10));
  const hp0 = laserDummy.controller.health.value;
  game.step(DT);
  const burned = hp0 - laserDummy.controller.health.value;
  for (let t = 0; t < 3 && !laserDummy.dead; t += DT) game.step(DT);
  add('lasers burn the opponent too', burned > 0 && laserDummy.dead, `-${burned.toFixed(1)} hp the first step, dead ${laserDummy.dead}`);

  const passed = results.filter((r) => r.pass).length;
  const text = [`Players: ${passed}/${results.length} passed`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`)].join('\n');
  return { text, results };
}
