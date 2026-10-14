import * as THREE from 'three';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { BufferedCommands } from '../../src/player/PlayerCommand';
import { PLAYER_FEET_OFFSET } from '../../src/player/PlayerController';
import { Door } from '../../src/world/hazards/Door';
import { FloorButton } from '../../src/world/hazards/FloorButton';
import { LaserReceiver } from '../../src/world/hazards/Laser';
import { mapToArena, withDefaults, type MapData } from '../../src/world/maps/MapFormat';
import { pieceAt } from './routes';

/**
 * A scripted playtest of the real game simulation: the model says where the player stands, where
 * they shoot, and where they walk, and gets back what happened - which portals were placed, who
 * went through them, what lit and what opened, whether the exit was reached. This is how the
 * mechanics the route analysis cannot see (a beam bent through portals, a crate dropped through
 * one) are checked: by playing them.
 *
 * It is a person's inputs, nothing more: walking is a straight line toward a point (with a
 * jump when something is in the way), so a route has to be given as the points to walk to.
 */

export type PlayStep =
  | { do: 'stand'; at: [number, number, number] }
  | { do: 'shoot'; color: 'blue' | 'orange'; at: [number, number, number] }
  | { do: 'walk'; to: number[]; seconds?: number }
  | { do: 'wait'; seconds: number };

export interface PlayReport {
  /** The exit was reached during the run. */
  goal: boolean;
  /** The player died (and the run stopped there). */
  died: string | null;
  /** The whole report, for the model. */
  text: string;
  seconds: number;
}

const DT = 1 / 60;
const MAX_STEPS = 30;
/** Game time one playtest may take, seconds. */
const MAX_SECONDS = 90;
const WALK_DEFAULT = 8;
const WALK_MAX = 25;
/** A jump in position bigger than this in one step is a trip through a portal. */
const TELEPORT = 2.2;

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (v: { x: number; y: number; z: number }) => `[${r1(v.x)}, ${r1(v.y)}, ${r1(v.z)}]`;
/** Where the player's feet are (the body's centre is above them). */
const feet = (v: { x: number; y: number; z: number }) => new THREE.Vector3(v.x, v.y - PLAYER_FEET_OFFSET, v.z);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

function vec(v: unknown, where: string): THREE.Vector3 {
  const a = Array.isArray(v) ? v.map(num) : [];
  if (a.length !== 3 || a.some(Number.isNaN)) throw new Error(`${where}: "at" must be three numbers [x, y, z].`);
  return new THREE.Vector3(a[0], a[1], a[2]);
}

export async function playtest(map: MapData, steps: PlayStep[]): Promise<PlayReport> {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('playtest needs "steps": a list of what the player does.');
  if (steps.length > MAX_STEPS) throw new Error(`A playtest has at most ${MAX_STEPS} steps.`);
  const sim = await ArenaSim.load(mapToArena(map), null);
  try {
    const commands = new BufferedCommands();
    const me = sim.addPlayer({ id: 'p1', name: 'TESTER' }, commands, null, { local: true });
    // It fires through its own command, like a bot; its shots land where they are aimed.
    me.autopilot = true;
    me.landingAssist = false;
    const body = me.controller;
    const lines: string[] = [];
    const events: string[] = [];
    let clock = 0;
    let died: string | null = null;
    let trips = 0;

    const look = (p: THREE.Vector3) => {
      const eye = new THREE.Vector3();
      body.viewPose(eye, new THREE.Quaternion());
      const d = p.clone().sub(eye);
      body.setLook(Math.atan2(-d.x, -d.z), Math.atan2(d.y, Math.hypot(d.x, d.z)));
    };
    /** One 1/60 s step; returns whether the body went through a portal during it. */
    const tick = (): boolean => {
      const before = body.getPosition();
      sim.step(DT);
      clock += DT;
      for (const e of sim.events.splice(0)) {
        events.push(e.type);
        if (e.type === 'death' && !died) died = String((e as { cause?: string }).cause ?? 'died');
      }
      const moved = body.getPosition().distanceTo(before);
      const through = moved > TELEPORT;
      if (through) trips++;
      return through;
    };
    const budget = () => clock < MAX_SECONDS && !died;

    for (const [i, raw] of steps.entries()) {
      if (!budget()) {
        lines.push(`${i + 1}. (not run: ${died ? 'the player died' : 'out of game time'})`);
        continue;
      }
      const s = raw as Record<string, unknown>;
      const n = `${i + 1}.`;
      switch (s.do) {
        case 'stand': {
          const at = vec(s.at, `step ${i + 1} (stand)`);
          body.setPosition(new THREE.Vector3(at.x, at.y + PLAYER_FEET_OFFSET + 0.02, at.z));
          body.setVelocity(new THREE.Vector3());
          for (let k = 0; k < 12; k++) tick();
          lines.push(`${n} stand at ${fmt(at)}: on ${pieceAt(map, at)}; now at ${fmt(feet(body.getPosition()))}`);
          break;
        }
        case 'shoot': {
          const color = s.color === 'orange' ? 'orange' : 'blue';
          if (s.color !== 'orange' && s.color !== 'blue') throw new Error(`step ${i + 1} (shoot): "color" is blue or orange.`);
          const at = vec(s.at, `step ${i + 1} (shoot)`);
          commands.next.forward = 0;
          look(at);
          commands.next.fire = color;
          // (The shot is taken in this step's `sim.step`; the look is set again so the step does not turn it.)
          tick();
          commands.next.fire = null;
          const shot = sim.shots[sim.shots.length - 1];
          const portal = me.portals[color];
          if (shot?.outcome === 'switch') lines.push(`${n} shoot ${color} at ${fmt(at)}: hit a switch at ${fmt(shot.to)} - it went off`);
          else if (shot?.outcome === 'placed' && portal.placed) lines.push(`${n} shoot ${color} at ${fmt(at)}: portal placed at ${fmt(portal.root.position)} on ${pieceAt(map, portal.root.position)}`);
          else if (shot)
            lines.push(`${n} shoot ${color} at ${fmt(at)}: NO portal - the shot ${shot.outcome === 'stolen' ? 'took over another portal' : `hit ${fmt(shot.to)} (${pieceAt(map, shot.to)}) and nothing opened there`}: that surface does not take portals, the opening does not fit, or the shot was blocked on the way (glass stops shots)`);
          else lines.push(`${n} shoot ${color} at ${fmt(at)}: the shot was not fired`);
          break;
        }
        case 'walk': {
          const to = Array.isArray(s.to) ? s.to.map(num) : [];
          if (to.length < 2 || to.some(Number.isNaN)) throw new Error(`step ${i + 1} (walk): "to" must be [x, z] (or [x, y, z]).`);
          const tx = to.length === 3 ? to[0] : to[0];
          const tz = to.length === 3 ? to[2] : to[1];
          const limit = Math.min(WALK_MAX, Math.max(0.5, num(s.seconds) || WALK_DEFAULT));
          let reached = false;
          let through = 0;
          let still = 0;
          let last = body.getPosition();
          let t = 0;
          for (; t < limit && budget() && !events.includes('goal'); t += DT) {
            const p = body.getPosition();
            if (Math.hypot(p.x - tx, p.z - tz) < 0.45) {
              reached = true;
              break;
            }
            const target = new THREE.Vector3(tx, p.y, tz);
            look(target);
            commands.next.forward = 1;
            // Something in the way: a ledge or a step; a jump gets over what a jump can.
            commands.next.jump = still > 0.25 && body.isGrounded;
            if (tick()) through++;
            const q = body.getPosition();
            still = Math.hypot(q.x - last.x, q.z - last.z) < 0.02 ? still + DT : 0;
            last = q;
            if (still > 2) break;
          }
          commands.next.forward = 0;
          commands.next.jump = false;
          const p = body.getPosition();
          const how = reached ? `reached it in ${r1(t)} s` : events.includes('goal') ? 'the exit was reached on the way' : died ? `the player died (${died})` : still > 2 ? `stuck at ${fmt(feet(p))}: something blocks the straight line (a wall, or a ledge too high to jump)` : `did not get there in ${r1(limit)} s (at ${fmt(feet(p))})`;
          lines.push(`${n} walk to [${r1(tx)}, ${r1(tz)}]: ${how}${through ? `; went through a portal ${through} time${through === 1 ? '' : 's'}, now at ${fmt(feet(p))}` : `; now at ${fmt(feet(p))}`}`);
          break;
        }
        case 'wait': {
          const seconds = Math.min(30, Math.max(0.1, num(s.seconds) || 1));
          commands.next.forward = 0;
          for (let t = 0; t < seconds && budget(); t += DT) tick();
          lines.push(`${n} wait ${r1(seconds)} s`);
          break;
        }
        default:
          throw new Error(`step ${i + 1}: "do" must be stand, shoot, walk or wait (got ${JSON.stringify(s.do)}).`);
      }
    }

    // ---- The state of the level at the end.
    const goal = events.includes('goal');
    const out: string[] = [];
    const pos = body.getPosition();
    out.push(`Playtest, ${r1(clock)} s of game time:`);
    out.push(...lines.map((l) => '  ' + l));
    out.push(
      `At the end: the player is at ${fmt(feet(pos))}, ${died ? `DEAD (${died})` : `alive with ${Math.round(body.health.value)} health`}; the exit was ${goal ? 'REACHED' : 'not reached'}${trips ? `; ${trips} trip${trips === 1 ? '' : 's'} through a portal` : ''}.`,
    );
    const receivers = sim.arena.hazards.filter((h): h is LaserReceiver => h instanceof LaserReceiver);
    const buttons = sim.arena.hazards.filter((h): h is FloorButton => h instanceof FloorButton);
    const doors = sim.arena.hazards.filter((h): h is Door => h instanceof Door);
    const piecesOf = (type: string) => map.pieces.map((p, i) => ({ p: withDefaults(p), i })).filter((x) => x.p.type === type);
    const describe = <T>(label: string, things: T[], pieces: { p: ReturnType<typeof withDefaults>; i: number }[], on: (t: T) => boolean, words: [string, string]) => {
      things.forEach((t, k) => {
        const piece = pieces[k];
        out.push(`  ${label} #${piece?.i ?? '?'}${piece?.p.id ? ` "${String(piece.p.id)}"` : ''}: ${on(t) ? words[0] : words[1]}`);
      });
    };
    // Where each beam goes, so a beam that misses its receiver can be seen missing it.
    const lasers = sim.arena.lasers;
    const laserPieces = piecesOf('laser');
    lasers.forEach((l, k) => {
      const piece = laserPieces[k];
      const segs = l.segments;
      if (segs.length === 0) {
        out.push(`  laser #${piece?.i ?? '?'}: no beam`);
        return;
      }
      const path = segs.slice(0, 6).map((s) => `${fmt(s.from)} -> ${fmt(s.to)}`);
      const end = segs[segs.length - 1].to;
      out.push(`  laser #${piece?.i ?? '?'} beam (${segs.length} segment${segs.length === 1 ? '' : 's'}; more than one means it went through a portal): ${path.join(' | ')}; ends on ${pieceAt(map, end)}`);
    });
    // Where the crates came to rest, and where the portals are.
    const props = sim.arena.props.filter((p) => p.visible).slice(0, 5);
    for (const c of props) out.push(`  crate at ${fmt(feet(c.getPosition()))}`);
    for (const color of ['blue', 'orange'] as const) {
      const portal = me.portals[color];
      out.push(`  ${color} portal: ${portal.placed ? `at ${fmt(portal.root.position)} on ${pieceAt(map, portal.root.position)}` : 'not placed'}`);
    }
    describe('receiver', receivers, piecesOf('receiver'), (r) => r.powered, ['LIT', 'dark']);
    describe('button', buttons, piecesOf('button'), (b) => b.powered, ['DOWN', 'up']);
    describe('door', doors, piecesOf('door'), (d) => d.isOpen, ['OPEN', 'shut']);
    return { goal, died, text: out.join('\n'), seconds: clock };
  } finally {
    sim.dispose();
  }
}
