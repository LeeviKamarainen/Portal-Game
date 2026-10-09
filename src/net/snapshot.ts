import * as THREE from 'three';
import { ByteReader, ByteWriter } from './codec';
import { BIN_SNAPSHOT } from './commands';
import type { ArenaSim } from '../sim/ArenaSim';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import type { PortalColor } from '../portals/Portal';
import type { ShotOutcome, SimShot, SimSound, SoundName } from '../sim/SimEvents';

/**
 * The game server's snapshot of a match, written for one player: everyone's bodies (your
 * own in full precision, for prediction), the crates, scores, and the shots and sounds
 * since the last one; every few - and around any change - every portal and orb, and the
 * hazard timers. Nothing depends on an earlier one having arrived: what one leaves out
 * comes again in a later one.
 */

/** Remote positions and speeds: 1/128 m (or m/s) steps, ±256 m. */
const POS_SCALE = 128;
const YAW_SCALE = 65536 / (Math.PI * 2);
const PITCH_SCALE = 32767 / (Math.PI / 2);

const SOUND_IDS: readonly SoundName[] = [
  'shootOrange', 'shootBlue', 'portalOpen', 'fizzle', 'teleport', 'hurt', 'death', 'respawn',
  'goal', 'slam', 'warn', 'door', 'sizzle', 'orb', 'steal', 'land', 'click',
];

const OUTCOMES: readonly ShotOutcome[] = ['fizzle', 'placed', 'stolen', 'switch'];

/** A sound nobody in particular made. */
const NO_SLOT = 255;

const DEAD = 1;
const GROUNDED = 2;
const IMMUNE = 4;
const OWN = 8;

export interface NetPlayer {
  slot: number;
  dead: boolean;
  grounded: boolean;
  immune: boolean;
  health: number;
  score: number;
  /** Counts up on every portal trip and respawn (mod 256): a jump nobody should be drawn sliding through. */
  warp: number;
  /** Counts up on every respawn (mod 256). */
  respawns: number;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  yaw: number;
  pitch: number;
  /** Only for the player the snapshot is for. */
  own: { passing: number; immuneFor: number; readyIn: number } | null;
}

export interface NetPortal {
  netId: number;
  ownerSlot: number;
  color: PortalColor;
  /** Null when it isn't open anywhere. */
  placement: { face: number; center: THREE.Vector3; up: THREE.Vector3 } | null;
}

export interface NetShot {
  slot: number;
  color: PortalColor;
  from: THREE.Vector3;
  to: THREE.Vector3;
  outcome: ShotOutcome;
  normal: THREE.Vector3 | null;
}

export interface NetSound {
  name: SoundName;
  volume: number;
  at: THREE.Vector3 | null;
  radius: number;
  /** The player who made it (by slot), or null for none in particular. */
  slot: number | null;
}

export interface NetProp {
  visible: boolean;
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  /** The portal it is halfway through (net id), or -1. */
  passing: number;
  /** Counts up on every portal trip (mod 256): a jump nobody should see it slide across. */
  warp: number;
}

export interface Snapshot {
  tick: number;
  /** Your latest command the server has used, steps since then, and how many are waiting. */
  ack: number;
  idle: number;
  queued: number;
  /** The gravity multiplier and the steps it lasts after this one (see ArenaSim.gravity). */
  gravity: { factor: number; steps: number };
  players: NetPlayer[];
  /** Every portal and orb - in the snapshots around a change, and every few (see SnapshotFor.world). */
  portals: NetPortal[] | null;
  orbs: (THREE.Vector3 | null)[] | null;
  props: NetProp[];
  /** Every hazard's state, in arena order - in every few snapshots only (they run on their own between). */
  hazards: number[][] | null;
  shots: NetShot[];
  sounds: NetSound[];
}

/** Who the snapshot is for and how their commands stand. */
export interface SnapshotFor {
  tick: number;
  you: ArenaPlayer | null;
  ack: number;
  idle: number;
  queued: number;
  /** Include the hazards' state this time. */
  hazards: boolean;
  /**
   * The portals and orbs (writeWorld), or null to leave them out this time. They seldom
   * change, so the server sends them in the few snapshots after a change (one may be lost
   * on the way), after any shot (the shooter learns how it turned out), and every few.
   */
  world: Uint8Array | null;
}

/** A hazard's state has at most this many numbers (a bit each says how it is written). */
const MAX_HAZARD_STATE = 8;

/** A number that goes as one byte, exactly. */
function smallWhole(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255 && !Object.is(v, -0);
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();

export function writeSnapshot(sim: ArenaSim, to: SnapshotFor, shots: readonly SimShot[], sounds: readonly SimSound[]): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(640);
  w.u8(BIN_SNAPSHOT).u32(to.tick).u16(to.ack).u8(Math.min(255, to.idle)).u8(Math.min(255, to.queued));
  const g = sim.gravity;
  // Exactly: a player's own movement depends on it.
  if (g.factor === 1) w.u8(0);
  else w.u8(1).f64(g.factor).u16(g.steps);

  w.u8(sim.players.length);
  for (const p of sim.players) {
    const c = p.controller;
    const own = p === to.you;
    w.u8(p.slot);
    w.u8((p.dead ? DEAD : 0) | (c.isGrounded ? GROUNDED : 0) | (c.isImmune() ? IMMUNE : 0) | (own ? OWN : 0));
    w.u8(Math.round(c.health.value));
    w.u16(Math.min(65535, sim.match?.player(p.id)?.score ?? 0));
    w.u8((sim.system.teleportCount(c) + p.respawns) & 255);
    w.u8(p.respawns & 255);
    const pos = c.getPosition();
    const vel = c.getVelocity();
    if (own) {
      // Exactly as the server has it (positions are 32-bit inside the physics engine; speed and
      // look are full doubles): a screen restored from this goes on exactly as the server does.
      w.f32(pos.x).f32(pos.y).f32(pos.z).f64(vel.x).f64(vel.y).f64(vel.z).f64(c.lookYaw).f64(c.lookPitch);
      const t = c.immunityTimes;
      w.i8(c.passing ? c.passing.netId : -1).u16(Math.min(65535, Math.round(t.immuneFor * 1000))).u16(Math.min(65535, Math.round(t.readyIn * 1000)));
    } else {
      w.i16(pos.x * POS_SCALE).i16(pos.y * POS_SCALE).i16(pos.z * POS_SCALE);
      w.i16(vel.x * POS_SCALE).i16(vel.y * POS_SCALE).i16(vel.z * POS_SCALE);
      w.u16(Math.round(wrapAngle(c.lookYaw) * YAW_SCALE) & 0xffff).i16(c.lookPitch * PITCH_SCALE);
    }
  }

  if (to.world) w.u8(1).raw(to.world);
  else w.u8(0);

  const props = sim.arena.props;
  w.u8(props.length);
  for (const prop of props) {
    w.u8(prop.visible ? 1 : 0).i8(prop.passing ? prop.passing.netId : -1).u8(sim.system.teleportCount(prop) & 255);
    const pos = prop.getPosition();
    const r = prop.getRotation(_q);
    w.f32(pos.x).f32(pos.y).f32(pos.z).i16(r.x * 32767).i16(r.y * 32767).i16(r.z * 32767).i16(r.w * 32767);
  }

  const hazards = to.hazards ? sim.arena.hazards.filter((h) => h.netState) : [];
  w.u8(to.hazards ? 1 : 0);
  if (to.hazards) {
    w.u8(hazards.length);
    for (const h of hazards) {
      const s = h.netState!();
      if (s.length > MAX_HAZARD_STATE) throw new Error(`a hazard state of ${s.length} numbers`);
      // Phases, flags and resting values are whole numbers and go as a byte; the rest at full
      // precision - a timer a hair short of its threshold has to stay short of it here too.
      w.u8(s.length).u8(s.reduce((bits, v, i) => (smallWhole(v) ? bits | (1 << i) : bits), 0));
      for (const v of s) {
        if (smallWhole(v)) w.u8(v);
        else w.f64(v);
      }
    }
  }

  w.u8(Math.min(255, shots.length));
  for (const s of shots.slice(0, 255)) {
    const slot = sim.playerById(s.player)?.slot ?? 0;
    w.u8((slot << 3) | (OUTCOMES.indexOf(s.outcome) << 1) | (s.color === 'blue' ? 1 : 0));
    w.i16(s.from.x * POS_SCALE).i16(s.from.y * POS_SCALE).i16(s.from.z * POS_SCALE);
    w.i16(s.to.x * POS_SCALE).i16(s.to.y * POS_SCALE).i16(s.to.z * POS_SCALE);
    const n = s.normal ?? _v.set(0, 0, 0);
    w.i8(n.x * 127).i8(n.y * 127).i8(n.z * 127);
  }

  w.u8(Math.min(255, sounds.length));
  for (const s of sounds.slice(0, 255)) {
    const by = s.source && s.source !== 'hazard' ? sim.playerById(s.source) : undefined;
    w.u8(SOUND_IDS.indexOf(s.name)).u8(Math.round(Math.min(1, s.volume) * 255)).u8(Math.min(255, Math.round(s.radius))).u8(by ? by.slot : NO_SLOT);
    if (s.at) w.u8(1).i16(s.at.x * POS_SCALE).i16(s.at.y * POS_SCALE).i16(s.at.z * POS_SCALE);
    else w.u8(0);
  }
  return w.bytes();
}

/**
 * Every portal and orb, written once a round for all the snapshots that carry them (and
 * compared with the last round's to tell whether anything changed).
 */
export function writeWorld(sim: ArenaSim): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(256);
  const portals = [...sim.portalsByNetId.values()];
  w.u8(portals.length);
  for (const portal of portals) {
    const owner = sim.playerById(portal.owner);
    w.u8(portal.netId).u8(((owner?.slot ?? 0) << 1) | (portal.color === 'blue' ? 1 : 0));
    const face = portal.placed && portal.face ? sim.level.faces.indexOf(portal.face) : -1;
    if (face < 0) {
      w.u8(0);
      continue;
    }
    w.u8(1).u16(face);
    w.f32(portal.surfaceCenter.x).f32(portal.surfaceCenter.y).f32(portal.surfaceCenter.z);
    // Full precision: a trip through it must turn you exactly as it does on the server.
    w.f32(portal.up.x).f32(portal.up.y).f32(portal.up.z);
  }

  const orbs = sim.orbs?.netState() ?? [];
  w.u8(orbs.length);
  for (const o of orbs) {
    if (!o) {
      w.u8(0);
      continue;
    }
    w.u8(1).f32(o.x).f32(o.y).f32(o.z);
  }
  return w.bytes();
}

/** Whether two written blocks are the same. */
export function sameBytes(a: Uint8Array, b: Uint8Array | null): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Reads a snapshot (it comes from our own server, but a short one still throws). */
export function readSnapshot(data: ArrayBuffer | Uint8Array): Snapshot {
  const r = new ByteReader(data);
  if (r.u8() !== BIN_SNAPSHOT) throw new Error('not a snapshot');
  const tick = r.u32();
  const ack = r.u16();
  const idle = r.u8();
  const queued = r.u8();
  const gravity = r.u8() === 1 ? { factor: r.f64(), steps: r.u16() } : { factor: 1, steps: 0 };

  const players: NetPlayer[] = [];
  for (let i = r.u8(); i > 0; i--) {
    const slot = r.u8();
    const flags = r.u8();
    const health = r.u8();
    const score = r.u16();
    const warp = r.u8();
    const respawns = r.u8();
    const p: NetPlayer = {
      slot,
      dead: (flags & DEAD) !== 0,
      grounded: (flags & GROUNDED) !== 0,
      immune: (flags & IMMUNE) !== 0,
      health,
      score,
      warp,
      respawns,
      position: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      yaw: 0,
      pitch: 0,
      own: null,
    };
    if (flags & OWN) {
      p.position.set(r.f32(), r.f32(), r.f32());
      p.velocity.set(r.f64(), r.f64(), r.f64());
      p.yaw = r.f64();
      p.pitch = r.f64();
      p.own = { passing: r.i8(), immuneFor: r.u16() / 1000, readyIn: r.u16() / 1000 };
    } else {
      p.position.set(r.i16(), r.i16(), r.i16()).divideScalar(POS_SCALE);
      p.velocity.set(r.i16(), r.i16(), r.i16()).divideScalar(POS_SCALE);
      p.yaw = r.u16() / YAW_SCALE;
      p.pitch = r.i16() / PITCH_SCALE;
    }
    players.push(p);
  }

  let portals: NetPortal[] | null = null;
  let orbs: (THREE.Vector3 | null)[] | null = null;
  if (r.u8() === 1) {
    portals = [];
    for (let i = r.u8(); i > 0; i--) {
      const netId = r.u8();
      const owner = r.u8();
      const placed = r.u8() === 1;
      let placement: NetPortal['placement'] = null;
      if (placed) {
        const face = r.u16();
        const center = new THREE.Vector3(r.f32(), r.f32(), r.f32());
        const up = new THREE.Vector3(r.f32(), r.f32(), r.f32());
        placement = { face, center, up };
      }
      portals.push({ netId, ownerSlot: owner >> 1, color: owner & 1 ? 'blue' : 'orange', placement });
    }
    orbs = [];
    for (let i = r.u8(); i > 0; i--) orbs.push(r.u8() === 1 ? new THREE.Vector3(r.f32(), r.f32(), r.f32()) : null);
  }

  const props: NetProp[] = [];
  for (let i = r.u8(); i > 0; i--) {
    const visible = r.u8() === 1;
    const passing = r.i8();
    const warp = r.u8();
    const position = new THREE.Vector3(r.f32(), r.f32(), r.f32());
    const rotation = new THREE.Quaternion(r.i16(), r.i16(), r.i16(), r.i16()).normalize();
    props.push({ visible, position, rotation, passing, warp });
  }

  let hazards: number[][] | null = null;
  if (r.u8() === 1) {
    hazards = [];
    for (let i = r.u8(); i > 0; i--) {
      const s: number[] = [];
      const n = r.u8();
      const small = r.u8();
      for (let k = 0; k < n; k++) s.push(small & (1 << k) ? r.u8() : r.f64());
      hazards.push(s);
    }
  }

  const shots: NetShot[] = [];
  for (let i = r.u8(); i > 0; i--) {
    const b = r.u8();
    const from = new THREE.Vector3(r.i16(), r.i16(), r.i16()).divideScalar(POS_SCALE);
    const to = new THREE.Vector3(r.i16(), r.i16(), r.i16()).divideScalar(POS_SCALE);
    const n = new THREE.Vector3(r.i8(), r.i8(), r.i8());
    shots.push({
      slot: b >> 3,
      color: b & 1 ? 'blue' : 'orange',
      outcome: OUTCOMES[(b >> 1) & 3],
      from,
      to,
      normal: n.lengthSq() > 0 ? n.normalize() : null,
    });
  }

  const sounds: NetSound[] = [];
  for (let i = r.u8(); i > 0; i--) {
    const name = SOUND_IDS[r.u8()];
    const volume = r.u8() / 255;
    const radius = r.u8();
    const by = r.u8();
    const at = r.u8() === 1 ? new THREE.Vector3(r.i16(), r.i16(), r.i16()).divideScalar(POS_SCALE) : null;
    if (name) sounds.push({ name, volume, radius, at, slot: by === NO_SLOT ? null : by });
  }
  return { tick, ack, idle, queued, gravity, players, portals, orbs, props, hazards, shots, sounds };
}

function wrapAngle(a: number): number {
  const t = Math.PI * 2;
  return ((a % t) + t) % t;
}
