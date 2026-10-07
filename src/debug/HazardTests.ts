import * as THREE from 'three';
import type { Game } from '../game/Game';
import { Crusher } from '../world/hazards/Crusher';
import { LaserEmitter, LaserReceiver } from '../world/hazards/Laser';
import { MovingPlatform } from '../world/hazards/MovingPlatform';
import { Dropper } from '../world/hazards/Dropper';
import { Ram } from '../world/hazards/Ram';
import { Spikes } from '../world/hazards/Spikes';
import { Trapdoor } from '../world/hazards/Trapdoor';
import { Switch } from '../world/hazards/Switch';

/**
 * Each hazard does what its tell promises, and death costs under a second. Arenas are
 * 1-based indices into ARENAS.
 */

const DT = 1 / 60;
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Result {
  name: string;
  pass: boolean;
  detail: string;
}

type GameState = { state: string };

function stateOf(game: Game): string {
  return (game as unknown as GameState).state;
}

async function load(game: Game, arena: number): Promise<void> {
  await game.loadArena(arena - 1);
  for (let i = 0; i < 30; i++) game.step(DT);
}

function place(game: Game, p: THREE.Vector3, yaw = 0): void {
  const s = game.session!;
  s.player.setPosition(p);
  s.player.setLook(yaw, 0);
  s.system.resync(s.player);
}

/** Steps until the player dies or the time runs out; returns the death time or null. */
function runUntilDeath(game: Game, seconds: number, keys: string[] = []): number | null {
  game.input.setScriptedKeys(keys);
  for (let t = 0; t < seconds; t += DT) {
    game.step(DT);
    if (stateOf(game) === 'dying') return t;
  }
  return null;
}

/** From the moment of death to the player standing at spawn with control back. */
function respawnTime(game: Game): number {
  game.input.setScriptedKeys([]);
  let t = 0;
  while (stateOf(game) !== 'playing' && t < 5) {
    game.step(DT);
    t += DT;
  }
  return t;
}

export async function runHazardTests(game: Game): Promise<{ text: string; results: Result[] }> {
  const results: Result[] = [];
  const add = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

  // Acid: walking off the moat edge is fatal.
  await load(game, 2);
  place(game, V(4, 1.02, 7), 0);
  const acidT = runUntilDeath(game, 3, ['KeyW']);
  add('acid kills on contact', acidT !== null, acidT !== null ? `dead ${acidT.toFixed(2)} s after stepping off` : 'survived');
  const acidRespawn = respawnTime(game);
  const spawnDist = game.session!.player.getPosition().distanceTo(game.session!.arena.spawn);
  add('respawn is quick', acidRespawn < 1 && spawnDist < 0.5, `control back ${acidRespawn.toFixed(2)} s after death, at spawn (${spawnDist.toFixed(2)} m)`);

  // Moving platform: carries a standing player across.
  const platform = game.session!.arena.hazards.find((h) => h instanceof MovingPlatform) as MovingPlatform;
  const platPos = () => (platform as unknown as { pos: THREE.Vector3 }).pos;
  game.input.setScriptedKeys([]);
  for (let t = 0; t < 8 && !(Math.abs(platPos().z - 4.45) < 0.05 && platform.delta.lengthSq() < 1e-8); t += DT) game.step(DT);
  place(game, V(-7, 1.02, 4.45), 0);
  for (let t = 0; t < 8 && platPos().z > -4.4; t += DT) game.step(DT);
  const rode = game.session!.player.getPosition();
  add('moving platform carries the player', rode.z < -3.5 && Math.abs(rode.x + 7) < 1 && stateOf(game) === 'playing', `player at z ${rode.z.toFixed(2)} as platform docks at ${platPos().z.toFixed(2)}`);

  // Crusher: standing in its footprint is fatal within one cycle; its tell comes first.
  await load(game, 3);
  const crusher = game.session!.arena.hazards.find((h) => h instanceof Crusher) as Crusher;
  place(game, V(0, 1.02, 12.2), 0);
  let warned = false;
  game.input.setScriptedKeys([]);
  let crushT: number | null = null;
  for (let t = 0; t < 6; t += DT) {
    game.step(DT);
    if (crusher.phaseName === 'warn') warned = true;
    if (stateOf(game) === 'dying') {
      crushT = t;
      break;
    }
  }
  add('crusher kills, after a warning', crushT !== null && warned, crushT !== null ? `crushed at ${crushT.toFixed(2)} s, warning shown first: ${warned}` : 'survived');
  respawnTime(game);

  // Laser: standing in the beam burns, fast but not instantly.
  place(game, V(-4, 1.02, -10), 0);
  const startHp = game.session!.player.health.value;
  game.step(DT);
  const hpAfterOne = game.session!.player.health.value;
  const laserT = runUntilDeath(game, 3);
  add('laser burns the player', hpAfterOne < startHp && laserT !== null && laserT > 0.3, `-${(startHp - hpAfterOne).toFixed(1)} hp first step, dead after ${laserT?.toFixed(2)} s`);
  respawnTime(game);

  // Laser through portals into the receiver opens the door.
  const s = game.session!;
  const eye = V(0, 1.82, -2);
  const shoot = (c: 'orange' | 'blue', p: THREE.Vector3) => s.gun.fire(c, eye, p.clone().sub(eye).normalize()).placed;
  place(game, V(0, 1.02, -2), Math.PI);
  const placed = shoot('orange', V(-4, 1.45, 2)) && shoot('blue', V(4, 1.45, 2));
  const receiver = s.arena.hazards.find((h) => h instanceof LaserReceiver) as LaserReceiver;
  const laser = s.arena.lasers[0] as LaserEmitter;
  game.input.setScriptedKeys([]);
  for (let t = 0; t < 2 && !receiver.powered; t += DT) game.step(DT);
  add('laser relays through a portal pair', placed && receiver.powered, `portals ${placed ? 'placed' : 'NOT placed'}, beam segments ${laser.segments.length}, receiver ${receiver.powered ? 'powered' : 'dark'}`);
  // Something in the way breaks the beam: stand in the relayed segment.
  place(game, V(4, 1.02, -12), Math.PI);
  for (let t = 0; t < 1.5; t += DT) {
    game.step(DT);
    if (stateOf(game) === 'dying') break;
  }
  add('player blocks the relayed beam', !receiver.powered || stateOf(game) === 'dying', `receiver ${receiver.powered ? 'still powered' : 'lost power'}`);
  respawnTime(game);

  // Dropper: the crate hurts on impact.
  await load(game, 4);
  const dropper = game.session!.arena.hazards.find((h) => h instanceof Dropper) as Dropper;
  const drop = dropper.box.getPosition();
  const before = game.session!.player.health.value;
  place(game, V(drop.x, 1.02, drop.z), 0);
  game.input.setScriptedKeys([]);
  let hurt = false;
  for (let t = 0; t < 6; t += DT) {
    game.step(DT);
    if (game.session!.player.health.value < before || stateOf(game) === 'dying') {
      hurt = true;
      break;
    }
  }
  add('dropped crate hurts', hurt, hurt ? `health ${before} -> ${game.session!.player.health.value.toFixed(0)}` : 'no damage');

  // Ram (PvP map): warns, then throws a player standing in front of it off the high
  // gallery; the fall is what hurts. Someone just beside the head is left alone.
  await game.loadPvp();
  for (let i = 0; i < 30; i++) game.step(DT);
  const rams = game.session!.arena.hazards.filter((h): h is Ram => h instanceof Ram);
  const galleryRam = rams.find((r) => r.pushDirection.x < -0.9 && Math.abs(r.front.z - 6) < 0.1)!;
  const ramRun = (p: THREE.Vector3) => {
    game.session!.respawn();
    for (const h of game.session!.arena.hazards) h.reset?.();
    place(game, p, Math.PI / 2);
    game.input.setScriptedKeys([]);
    let sawWarn = false;
    let warnedFirst = false;
    let thrown = false;
    let minY = p.y;
    // One full cycle (offset + rest + warning) and the fall after it.
    for (let t = 0; t < 10; t += DT) {
      game.step(DT);
      if (galleryRam.phaseName === 'warn') sawWarn = true;
      const v = game.session!.player.getVelocity();
      if (!thrown && Math.hypot(v.x, v.z) > 6) {
        thrown = true;
        warnedFirst = sawWarn;
      }
      minY = Math.min(minY, game.session!.player.getPosition().y);
      if (stateOf(game) === 'dying' || (thrown && game.session!.player.isGrounded)) break;
    }
    return { thrown, warnedFirst, minY, hp: game.session!.player.health.value, dead: stateOf(game) === 'dying' };
  };
  const hit = ramRun(V(23, 17.02, 6));
  const fell = hit.minY < 10;
  add(
    'ram throws the player off the high ground',
    hit.thrown && hit.warnedFirst && fell && (hit.hp < 100 || hit.dead),
    `thrown ${hit.thrown} after its warning, fell to y ${hit.minY.toFixed(1)}, health ${hit.dead ? 'dead' : hit.hp.toFixed(0)}`,
  );
  const beside = ramRun(V(23, 17.02, 8.3));
  add('ram leaves a player beside it alone', !beside.thrown && beside.minY > 16.5, `thrown ${beside.thrown}, lowest y ${beside.minY.toFixed(1)}`);

  // Spikes (PvP map, foot of the ground stairs): rise after a warning and kill.
  const hz = () => game.session!.arena.hazards;
  const freshPvp = () => {
    game.session!.respawn();
    for (const h of hz()) h.reset?.();
  };
  freshPvp();
  const spikes = hz().find((h): h is Spikes => h instanceof Spikes && h.phaseName === 'down')!;
  place(game, V(-24, 1.02, 6), 0);
  let spikeWarned = false;
  let spikeDeath: number | null = null;
  for (let t = 0; t < 8; t += DT) {
    game.step(DT);
    if (spikes.phaseName === 'warn') spikeWarned = true;
    if (stateOf(game) === 'dying') {
      spikeDeath = t;
      break;
    }
  }
  add('spikes kill, after a warning', spikeWarned && spikeDeath !== null, spikeDeath !== null ? `spiked at ${spikeDeath.toFixed(2)} s, warning shown first: ${spikeWarned}` : 'survived');
  respawnTime(game);

  // Switches: aim the camera at one and fire the gun, as a player would.
  const shootAt = (from: THREE.Vector3, target: THREE.Vector3, color: 'orange' | 'blue' = 'orange') => {
    place(game, from, 0);
    const eye = game.engine.camera.position.clone();
    const d = target.clone().sub(eye);
    game.session!.player.setLook(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
    return game.session!.fire(color);
  };
  const switchAt = (x: number, z: number) => hz().find((h): h is Switch => h instanceof Switch && Math.abs((h as unknown as { mount: THREE.Vector3 }).mount.x - x) < 0.1 && Math.abs((h as unknown as { mount: THREE.Vector3 }).mount.z - z) < 0.1)!;

  // Trap switch: standing on the catwalk trapdoor and shooting its switch drops you onto the spikes below.
  freshPvp();
  const trap = hz().find((h): h is Trapdoor => h instanceof Trapdoor && Math.abs((h as unknown as { center: THREE.Vector3 }).center.z - 16) < 0.1)!;
  const placedPortal = shootAt(V(20, 9.02, 16), V(4, 10, 2.4));
  let opened = false;
  let fellTo = 99;
  let trapDeath = false;
  for (let t = 0; t < 4; t += DT) {
    game.step(DT);
    if (trap.isOpen) opened = true;
    fellTo = Math.min(fellTo, game.session!.player.getPosition().y);
    if (stateOf(game) === 'dying') {
      trapDeath = true;
      break;
    }
  }
  add('trap switch drops the floor', !placedPortal && opened && fellTo < 4, `no portal ${!placedPortal}, trapdoor opened ${opened}, fell to y ${fellTo.toFixed(1)}, ${trapDeath ? 'killed by the spikes below' : 'survived'}`);
  respawnTime(game);

  // Portal switch: closes every portal; on cooldown, a second shot does nothing.
  freshPvp();
  const purge = switchAt(-12, 38);
  const s2 = game.session!;
  const placedA = shootAt(V(-16, 1.02, 18), V(-19, 4, 28), 'orange');
  const placedB = shootAt(V(-16, 1.02, 18), V(-13, 4, 28), 'blue');
  shootAt(V(-12, 9.02, 30), V(-12, 13, 38));
  game.step(DT);
  const cleared = !s2.portals.orange.placed && !s2.portals.blue.placed;
  shootAt(V(-16, 1.02, 18), V(-19, 4, 28), 'orange');
  shootAt(V(-12, 9.02, 30), V(-12, 13, 38));
  game.step(DT);
  add(
    'portal switch closes every portal',
    placedA && placedB && cleared && s2.portals.orange.placed && !purge.isReady,
    `portals placed ${placedA && placedB}, closed by the switch ${cleared}, second shot during cooldown left them ${s2.portals.orange.placed ? 'open' : 'closed'}`,
  );

  // Gravity switch on the spire: heavier gravity for its duration, then back to normal.
  freshPvp();
  shootAt(V(0, 9.02, 30), V(0, 12, 4));
  game.step(DT);
  const heavy = game.session!.player.gravityScale;
  const label = game.session!.effectText;
  for (let t = 0; t < 8.5; t += DT) game.step(DT);
  add(
    'gravity switch makes gravity heavier for a while',
    heavy > 1.5 && label.includes('GRAVITY') && game.session!.player.gravityScale === 1,
    `gravity x${heavy.toFixed(1)} ("${label}"), back to x${game.session!.player.gravityScale} after 8.5 s`,
  );

  game.input.setScriptedKeys(null);
  const lines = [`Hazard tests: ${results.filter((r) => r.pass).length}/${results.length} pass`];
  for (const r of results) lines.push(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  return { text: lines.join('\n'), results };
}
