import * as THREE from 'three';
import type { Game } from '../game/Game';
import type { Session } from '../game/Session';
import type { ArenaDef } from '../world/ArenaBuilder';
import { ARENAS, PVP_ARENA, TEST_ARENA } from '../world/arenas';
import { distanceToOpening } from '../world/PointOrbs';
import { PLAYER_FEET_OFFSET } from '../player/PlayerController';
import type { PortalColor } from '../portals/Portal';

/**
 * The PvP win conditions: point orbs turn up on safe floor and score when touched, no
 * portal opens near one, hazard kills are credited through portals (the victim's own trip,
 * or a beam's or crate's), and the first to the target wins.
 *
 * The PvP opponent ("p2", a dummy for now) stands still, so here it is handed the local
 * player's portal pair to stand in for an opponent's portals.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const OPPONENT = 'p2';

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

function settle(game: Game, seconds = 0.5): void {
  game.input.setScriptedKeys([]);
  for (let t = 0; t < seconds; t += DT) game.step(DT);
}

/** A match on `def` with an opponent, the orbs held back so their zones don't get in the way. */
async function loadMatch(game: Game, def: ArenaDef, index = 0): Promise<Session> {
  await internals(game).load(def, 'pvp', index);
  settle(game);
  const s = game.session!;
  s.match!.addPlayer(OPPONENT, 'P2');
  s.orbs!.clear(Infinity);
  return s;
}

function place(s: Session, p: THREE.Vector3, yaw = 0): void {
  s.player.setPosition(p);
  s.player.setVelocity(new THREE.Vector3());
  s.player.setLook(yaw, 0);
  s.system.resync(s.player);
}

function shoot(s: Session, color: PortalColor, eye: THREE.Vector3, at: THREE.Vector3) {
  return s.gun.fire(color, eye, at.clone().sub(eye).normalize());
}

function setOwner(s: Session, owner: string): void {
  s.portals.orange.owner = s.portals.blue.owner = owner;
}

/** Steps until the player dies (returns the death event's credit) or the time runs out. */
function runUntilDeath(game: Game, seconds: number): { died: boolean; by: string | null } {
  game.input.setScriptedKeys([]);
  const s = game.session!;
  let by: string | null = null;
  const push = s.events.push.bind(s.events);
  s.events.push = (...items) => {
    for (const e of items) if (e.type === 'death') by = e.by;
    return push(...items);
  };
  try {
    for (let t = 0; t < seconds; t += DT) {
      game.step(DT);
      if (stateOf(game) === 'dying') return { died: true, by };
    }
    return { died: false, by };
  } finally {
    s.events.push = push;
  }
}

function waitForControl(game: Game): void {
  for (let t = 0; t < 5 && stateOf(game) !== 'playing'; t += DT) game.step(DT);
}

function score(s: Session, id: string): number {
  return s.match!.player(id)?.score ?? NaN;
}

export async function runScoringTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });
  const fmt = (v: THREE.Vector3) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;

  // --- Point orbs on the PvP map -------------------------------------------------------
  await game.loadPvp();
  settle(game, 1);
  let s = game.session!;
  const rules = s.match!.rules;
  const orbs = s.orbs!;
  const active = orbs.positions;
  const spaced = active.every((a, i) => active.every((b, j) => i === j || a.distanceTo(b) >= 5));
  add('orbs appear at the start', active.length === rules.orbCount && spaced, `${active.length} of ${rules.orbCount}: ${active.map(fmt).join(' ')}`);

  // Many draws: every spot inside the arena, over solid floor, off hazards, spread over tiers.
  const spots: THREE.Vector3[] = [];
  for (let i = 0; i < 300; i++) {
    const p = orbs.findSpot([], [], []);
    if (p) spots.push(p);
  }
  const b = s.arena.bounds;
  const bad = spots.filter((p) => !b.containsPoint(p) || p.y < s.arena.killY + 1 || s.arena.hazards.some((h) => h.covers?.(p.clone().setY(p.y - 1.1))));
  const tiers = new Set(spots.map((p) => Math.round(p.y))).size;
  add('orb spots are safe floor across the map', spots.length > 250 && bad.length === 0 && tiers >= 3, `${spots.length}/300 found, ${bad.length} bad${bad.length ? ` e.g. ${fmt(bad[0])}` : ''}, ${tiers} heights`);

  // Picking one up.
  const orb = active[0].clone();
  place(s, V(orb.x, orb.y - 1.1 + PLAYER_FEET_OFFSET + 0.02, orb.z));
  settle(game, 0.2);
  const afterPickup = score(s, s.player.id);
  const gone = !orbs.positions.some((p) => p.distanceTo(orb) < 0.01);
  add('touching an orb scores', afterPickup === rules.orbPoints && gone, `score ${afterPickup}, orb gone: ${gone}`);
  place(s, s.arena.spawn);
  settle(game, rules.orbRespawn + 0.5);
  add('a collected orb comes back elsewhere', orbs.positions.length === rules.orbCount, `${orbs.positions.length} orbs after ${rules.orbRespawn + 0.5} s: ${orbs.positions.map(fmt).join(' ')}`);

  // --- No-portal zones (test chamber: plain portalable walls) -------------------------
  s = await loadMatch(game, TEST_ARENA, -1);
  const zoneOrb = s.orbs!.orbs[0];
  const showOrb = (p: THREE.Vector3) => {
    zoneOrb.pos.copy(p);
    zoneOrb.active = true;
    zoneOrb.timer = 10;
  };
  place(s, V(-50, 1.02, -10), Math.PI / 2);
  const eye = V(-50, 1.82, -10);
  const wall = V(-60, 2, -10);
  showOrb(V(-58, 2, -10));
  const blocked = shoot(s, 'orange', eye, wall);
  const radius = rules.orbNoPortalRadius;
  showOrb(V(-60 + radius + 0.4, 2, -10));
  const edge = shoot(s, 'orange', eye, wall);
  const edgeDist = s.portals.orange.placed ? distanceToOpening(zoneOrb.pos, s.portals.orange.surfaceCenter, s.portals.orange.right, s.portals.orange.up) : NaN;
  add(
    'no portal inside an orb zone',
    !blocked.placed && !!blocked.noPortalZone && edge.placed && edgeDist >= radius,
    `orb 2 m off the wall: placed ${blocked.placed} (zone ${!!blocked.noPortalZone}); orb ${radius + 0.4} m off: placed ${edge.placed}, ${edgeDist.toFixed(2)} m from the opening`,
  );
  s.portals.orange.unplace();
  s.orbs!.clear(Infinity);

  // --- Kill credit on the PvP map: the victim's last trip through someone's portal -----
  const throughFloorPortal = (sess: Session): boolean => {
    const from = V(-18, 1.02, 17);
    place(sess, from);
    const e = from.clone().setY(1.82);
    const ok = shoot(sess, 'orange', e, V(-18, 0, 12)).placed && shoot(sess, 'blue', e, V(-18, 0, 23)).placed;
    if (!ok) return false;
    const n = sess.system.teleportCount(sess.player);
    place(sess, V(-18, 2.6, 12.2));
    game.input.setScriptedKeys([]);
    for (let t = 0; t < 2 && sess.system.teleportCount(sess.player) === n; t += DT) game.step(DT);
    const went = sess.system.teleportCount(sess.player) > n;
    // Out of the floor and on the way up: close the pair so the fall doesn't loop back in.
    for (let t = 0; t < 1 && sess.player.getPosition().y < 1.6; t += DT) game.step(DT);
    sess.portals.orange.unplace();
    sess.portals.blue.unplace();
    settle(game, 1.2);
    return went;
  };
  const intoAcid = (sess: Session) => {
    place(sess, V(6, 1.2, 0));
    return runUntilDeath(game, 3);
  };

  s = await loadMatch(game, PVP_ARENA, 0);
  setOwner(s, OPPONENT);
  const went = throughFloorPortal(s);
  const trip = s.player.lastTrip?.owner ?? null;
  const acid1 = intoAcid(s);
  add(
    "hazard kill credits the victim's last portal",
    went && trip === OPPONENT && acid1.died && acid1.by === OPPONENT && score(s, OPPONENT) === rules.killPoints,
    `through P2's portal: ${went}, trip owner ${trip}; acid death credited to ${acid1.by}, P2 score ${score(s, OPPONENT)}`,
  );
  waitForControl(game);

  setOwner(s, s.player.id);
  const went2 = throughFloorPortal(s);
  const acid2 = intoAcid(s);
  add("own portals earn nobody a kill", went2 && acid2.died && acid2.by === null && score(s, OPPONENT) === rules.killPoints, `through own portal: ${went2}; death credited to ${acid2.by}`);
  waitForControl(game);

  setOwner(s, OPPONENT);
  const went3 = throughFloorPortal(s);
  settle(game, rules.creditWindow + 0.5);
  const acid3 = intoAcid(s);
  add('credit runs out', went3 && acid3.died && acid3.by === null, `death ${rules.creditWindow + 0.5 + 1.2} s after the trip credited to ${acid3.by}`);
  waitForControl(game);

  // --- A beam relayed through someone's portals -----------------------------------------
  s = await loadMatch(game, ARENAS[2], 2);
  setOwner(s, OPPONENT);
  place(s, V(-4, 1.02, -10));
  const unrelayed = runUntilDeath(game, 3);
  waitForControl(game);
  place(s, V(0, 1.02, -2), Math.PI);
  const beamEye = V(0, 1.82, -2);
  const relayed = shoot(s, 'orange', beamEye, V(-4, 1.45, 2)).placed && shoot(s, 'blue', beamEye, V(4, 1.45, 2)).placed;
  place(s, V(4, 1.02, -12), Math.PI);
  const burned = runUntilDeath(game, 3);
  add(
    "a beam's kill goes to the owner of the portal it came out of",
    unrelayed.died && unrelayed.by === null && relayed && burned.died && burned.by === OPPONENT,
    `straight beam: credited to ${unrelayed.by}; relayed (${relayed}) beam: credited to ${burned.by}`,
  );
  waitForControl(game);

  // --- A crate that came out of someone's portal ----------------------------------------
  s = await loadMatch(game, TEST_ARENA, -1);
  const crate = s.arena.props[0];
  place(s, V(10, 1.02, -14));
  settle(game, 0.1);
  crate.setPosition(V(10, 1.0, -9));
  crate.setVelocity(V(0, 0, -40));
  crate.lastTrip = { owner: OPPONENT, time: s.time };
  s.system.resync(crate);
  const crushed = runUntilDeath(game, 1);
  add("a crate's kill goes to the owner of the portal it came out of", crushed.died && crushed.by === OPPONENT, `died: ${crushed.died}, credited to ${crushed.by}`);
  waitForControl(game);

  // --- First to the target wins ---------------------------------------------------------
  await game.loadPvp();
  settle(game, 1);
  s = game.session!;
  s.match!.addPlayer(OPPONENT, 'P2');
  s.match!.player(s.player.id)!.score = rules.scoreToWin - rules.orbPoints;
  const last = s.orbs!.positions[0];
  place(s, V(last.x, last.y - 1.1 + PLAYER_FEET_OFFSET + 0.02, last.z));
  settle(game, 0.3);
  game.renderNow();
  const banner = document.querySelector('.hud .banner')?.textContent ?? '';
  const board = document.querySelector('.hud .score')?.textContent ?? '';
  add(
    'reaching the target ends the match',
    s.match!.winner?.id === s.player.id && stateOf(game) === 'finished' && banner === 'YOU WIN' && board.includes(`FIRST TO ${rules.scoreToWin}`),
    `winner ${s.match!.winner?.name}, state ${stateOf(game)}, banner "${banner}", scoreboard "${board}"`,
  );
  const frozen = s.player.getPosition();
  game.input.setScriptedKeys(['KeyW']);
  for (let t = 0; t < 0.5; t += DT) game.step(DT);
  const moved = s.player.getPosition().distanceTo(frozen);
  add('play stops when the match is won', moved < 0.05 && score(s, s.player.id) === rules.scoreToWin, `moved ${moved.toFixed(3)} m holding W, score stays ${score(s, s.player.id)}`);

  game.restart();
  for (let i = 0; i < 100 && (!game.session || game.session === s); i++) await new Promise((r) => setTimeout(r, 20));
  settle(game, 0.5);
  const fresh = game.session!;
  add('R starts a rematch from zero', fresh !== s && !fresh.match!.winner && score(fresh, fresh.player.id) === 0 && stateOf(game) === 'playing', `new session ${fresh !== s}, score ${score(fresh, fresh.player.id)}, state ${stateOf(game)}`);

  // An opponent's kill can win it too, and the dead player sees the result.
  fresh.match!.addPlayer(OPPONENT, 'P2');
  fresh.orbs!.clear(Infinity);
  fresh.match!.player(OPPONENT)!.score = rules.scoreToWin - rules.killPoints;
  setOwner(fresh, OPPONENT);
  s = fresh;
  const went4 = throughFloorPortal(s);
  intoAcid(s);
  settle(game, 0.2);
  const banner2 = document.querySelector('.hud .banner')?.textContent ?? '';
  add(
    'a kill can win the match',
    went4 && s.match!.winner?.id === OPPONENT && stateOf(game) === 'finished' && banner2 === `${s.match!.winner.name} WINS` && !s.isDead,
    `winner ${s.match!.winner?.name}, state ${stateOf(game)}, banner "${banner2}", victim back on their feet: ${!s.isDead}`,
  );

  const passed = results.filter((r) => r.pass).length;
  const text = [`Scoring: ${passed}/${results.length} passed`, ...results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name} - ${r.detail}`)].join('\n');
  return { text, results };
}
