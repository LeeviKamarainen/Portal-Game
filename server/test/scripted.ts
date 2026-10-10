/**
 * A scripted player on a headless arena: aims, walks and shoots through its own commands,
 * the way a person's keyboard and mouse would, so a test can play a map.
 */
import * as THREE from 'three';
import { ArenaSim } from '../../src/sim/ArenaSim';
import { mapToArena, type MapData } from '../../src/world/maps/MapFormat';
import { BufferedCommands } from '../../src/player/PlayerCommand';

export const DT = 1 / 60;
export const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A scripted player on a loaded arena. */
export async function scripted(data: MapData) {
  const sim = await ArenaSim.load(mapToArena(data), null);
  const commands = new BufferedCommands();
  const me = sim.addPlayer({ id: 'p1', name: 'TESTER' }, commands, null, { local: true });
  // The player fires through its own command, as a bot does.
  me.autopilot = true;
  const body = me.controller;
  const events: string[] = [];

  /** One step, with the given look turned toward `point` and an optional shot. */
  const stepTo = (point: THREE.Vector3 | null, fire: 'orange' | 'blue' | null = null) => {
    const c = commands.next;
    c.fire = fire;
    if (point) {
      const eye = V(0, 0, 0);
      body.viewPose(eye, new THREE.Quaternion());
      const d = point.clone().sub(eye);
      const yaw = Math.atan2(-d.x, -d.z);
      const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      const s = body.saveMove();
      let dy = yaw - s.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      c.yaw = dy;
      c.pitch = pitch - s.pitch;
    } else c.yaw = c.pitch = 0;
    sim.step(DT);
    c.fire = null;
    c.yaw = c.pitch = 0;
    for (const e of sim.events.splice(0)) {
      events.push(e.type);
      if (e.type === 'death') console.log(`  died (${e.cause}) at t=${sim.time.toFixed(2)}`, body.getPosition().toArray().map((n) => n.toFixed(2)).join(', '));
    }
  };
  const idle = (seconds: number) => {
    commands.next.forward = 0;
    for (let i = 0; i < seconds / DT; i++) stepTo(null);
  };
  const shoot = (color: 'orange' | 'blue', at: THREE.Vector3) => {
    commands.next.forward = 0;
    stepTo(at, color);
  };
  /** Walks (flat) toward x,z until within `tol`, for at most `max` seconds. Returns whether it got there. */
  const walk = (x: number, z: number, tol = 0.35, max = 12, until?: () => boolean) => {
    for (let t = 0; t < max; t += DT) {
      const p = body.getPosition();
      if (Math.hypot(p.x - x, p.z - z) < tol || until?.()) {
        commands.next.forward = 0;
        return true;
      }
      commands.next.forward = 1;
      stepTo(V(x, p.y, z));
    }
    commands.next.forward = 0;
    return false;
  };
  return { sim, me, body, commands, events, stepTo, idle, shoot, walk };
}

export const hazards = <T>(sim: ArenaSim, kind: new (...a: never[]) => T): T[] => sim.arena.hazards.filter((h): h is T & typeof h => h instanceof kind) as T[];

