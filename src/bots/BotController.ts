import * as THREE from 'three';
import type { Session } from '../game/Session';
import type { ArenaPlayer } from '../game/ArenaPlayer';
import { clearCommand, type CommandSource, type PlayerCommand } from '../player/PlayerCommand';
import { BOT_SKILLS, seededRandom, type BotSkill } from './BotSkill';
import { Perception, type KnownEnemy } from './Perception';
import { LookController } from './LookController';
import { NavGraph } from './NavGraph';
import { PathFollower, type FollowStatus } from './PathFollower';
import { TrapSpots } from './TrapSpots';
import { BotBrain } from './BotBrain';

/** While idle it glances somewhere new every this many seconds (randomised up to double). */
const SCAN_INTERVAL = 2.2;
/** How far either side of its current heading an idle glance may go. */
const SCAN_SPREAD = Math.PI * 0.6;
/** Aim at the chest. */
const CHEST = 0.3;
/** Keeps watching where an enemy it lost was for this long (longer only while hunting them). */
const WATCH_LOST = 2.5;
/** Walking, it glances to one side every so often (randomised up to double), for this long. */
const GLANCE_EVERY = 3;
const GLANCE_TIME = 1.1;
const GLANCE_ANGLE = Math.PI * 0.4;

const _eye = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * A computer player. It steers its body only through the PlayerCommand it fills in each
 * step - the same one the keyboard fills in for a person - and knows only what its
 * Perception has seen or heard.
 *
 * Each step: perceive, let the brain decide (BotBrain: escape, trap, steal, orbs, hunt,
 * explore), walk (PathFollower), then turn the head (LookController) - toward a shot it
 * means to take, else an enemy in sight (or just lost, or hunted), else where it is going
 * with the odd glance aside, else a look around - and fire if a shot is lined up.
 */
export class BotController implements CommandSource {
  readonly skill: BotSkill;
  readonly random: () => number;
  perception: Perception | null = null;
  nav: NavGraph | null = null;
  follower: PathFollower | null = null;
  brain: BotBrain | null = null;
  readonly look: LookController;
  /** Decides for itself (false: only goTo and watching, for tests). */
  autonomous = true;
  /** Glance around while idle (tests turn it off to hold the gaze still). */
  scan = true;
  private session: Session | null = null;
  /** The body it drives (set by attach). */
  self: ArenaPlayer | null = null;
  private nextScan = 0;
  private scans = 0;
  private nextGlance = 0;
  private glanceUntil = 0;
  private glanceSide = 1;

  constructor(skill: BotSkill = BOT_SKILLS.normal, seed = (Math.random() * 2 ** 32) >>> 0) {
    this.skill = skill;
    this.random = seededRandom(seed);
    this.look = new LookController(skill, this.random);
  }

  /** Hooks it up to the body it drives (after Session.addPlayer). Builds the arena's nav graph and trap spots if needed. */
  attach(session: Session, self: ArenaPlayer): void {
    this.session = session;
    this.self = self;
    this.perception = new Perception(session, self, this.skill, this.random);
    this.nav = NavGraph.for(session, session.arena, session.physics);
    this.follower = new PathFollower(this.nav, self.controller);
    const traps = TrapSpots.for(session, session.arena, session.level, session.physics);
    this.brain = new BotBrain({
      session,
      self,
      skill: this.skill,
      random: this.random,
      perception: this.perception,
      nav: this.nav,
      follower: this.follower,
      look: this.look,
      traps,
    });
  }

  /** Walk to `point` (a body-centre position). */
  goTo(point: THREE.Vector3): FollowStatus {
    return this.follower?.goTo(point) ?? 'no-path';
  }

  /** The enemy it is most sure about, preferring ones in sight. */
  focus(): KnownEnemy | null {
    let best: KnownEnemy | null = null;
    for (const e of this.perception?.enemies.values() ?? []) {
      const score = e.confidence + (e.visible ? 1 : 0);
      if (!best || score > best.confidence + (best.visible ? 1 : 0)) best = e;
    }
    return best;
  }

  /**
   * Walking: look where it's going (the same key all along: no reaction delay for each
   * step), with a glance off to one side now and then - that's how it spots orbs on the way.
   */
  private walkingLook(now: number, ahead: THREE.Vector3): void {
    if (this.scan && now >= this.nextGlance) {
      this.nextGlance = now + GLANCE_EVERY * (1 + this.random());
      this.glanceUntil = now + GLANCE_TIME;
      this.glanceSide = this.random() < 0.5 ? -1 : 1;
      this.scans++;
    }
    if (now >= this.glanceUntil || !this.perception) {
      this.look.lookAt('path', ahead, now);
      return;
    }
    this.perception.eye(_eye);
    const a = GLANCE_ANGLE * this.glanceSide;
    const dx = ahead.x - _eye.x;
    const dz = ahead.z - _eye.z;
    _p.set(_eye.x + dx * Math.cos(a) + dz * Math.sin(a), ahead.y - 0.3, _eye.z - dx * Math.sin(a) + dz * Math.cos(a));
    this.look.lookAt(`glance:${this.scans}`, _p, now);
  }

  read(cmd: PlayerCommand, dt: number): void {
    clearCommand(cmd);
    const { session, self, perception, follower, brain } = this;
    if (!session || !self || !perception || self.dead) return;
    const now = session.time;
    perception.update(dt);

    const c = self.controller;
    if (this.autonomous) brain?.think(now);
    follower?.update(dt, cmd, c.lookYaw);
    if (this.autonomous) brain?.act(cmd, now);

    const aim = this.autonomous ? brain?.aim : null;
    const target = this.focus();
    // An enemy out of sight is watched for only a moment, unless it's being hunted: staring at
    // where someone was while walking somewhere else, it would never see anything new.
    const watch = target && (target.visible || now - target.sensedAt < WATCH_LOST || brain?.goal === 'hunt');
    if (aim) {
      this.look.lookAt(aim.key, aim.point, now);
    } else if (target && watch) {
      _p.copy(target.position).setY(target.position.y + CHEST);
      this.look.lookAt(`enemy:${target.id}`, _p, now);
    } else if (follower?.hasLookPoint) {
      this.walkingLook(now, follower.lookPoint);
      this.nextScan = now + SCAN_INTERVAL;
    } else if (this.scan && now >= this.nextScan) {
      // Idle: glance somewhere else, roughly level.
      const yaw = c.lookYaw + (this.random() * 2 - 1) * SCAN_SPREAD;
      perception.eye(_eye);
      _p.set(_eye.x - Math.sin(yaw) * 10, _eye.y - 0.5, _eye.z - Math.cos(yaw) * 10);
      this.look.lookAt(`scan:${this.scans++}`, _p, now);
      this.nextScan = now + SCAN_INTERVAL * (1 + this.random());
    }

    perception.eye(_eye);
    if (this.autonomous) brain?.fire(cmd, now, _eye, c.lookYaw, c.lookPitch);
    const turn = this.look.update(dt, now, _eye, c.lookYaw, c.lookPitch);
    cmd.yaw = turn.yaw;
    cmd.pitch = turn.pitch;
  }
}
