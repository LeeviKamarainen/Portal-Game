/**
 * How good a bot is. Difficulty changes these numbers and a few abilities - it always drives
 * the same PlayerCommand a keyboard does. Easy and Normal know only what they see and hear
 * (see Perception); Hard is `omniscient` by design. Harder bots also run a little faster
 * than a person (`moveSpeed`).
 */
export interface BotSkill {
  readonly name: string;
  /** Half-angles of the view cone, radians (horizontal, vertical). */
  readonly fovH: number;
  readonly fovV: number;
  /** How far it can make anyone out, metres (also capped by the arena's fog). */
  readonly viewRange: number;
  /** Someone has to stay in sight this long before the bot notices them, seconds. */
  readonly acquireTime: number;
  /** Hearing range multiplier (1 = the sound's own radius). */
  readonly hearing: number;
  /** How long an enemy it lost track of stays in mind, seconds. */
  readonly memory: number;
  /** Delay before it starts turning toward something new, seconds. */
  readonly reaction: number;
  /** Fastest turn, rad/s, and how quickly it gets there, rad/s². */
  readonly turnRate: number;
  readonly turnAccel: number;
  /** Aim error when it first locks on, radians; shrinks while it keeps tracking. */
  readonly aimError: number;
  /** Time constant of that shrink, seconds. */
  readonly aimSettle: number;
  /** A hand never holds perfectly still: residual wobble while tracking, radians. */
  readonly aimWobble: number;
  /** Braking late: 1 = stops exactly on target, more = overshoots a little. */
  readonly overshoot: number;
  /** How often it reconsiders what to do, seconds. */
  readonly thinkInterval: number;
  /** Least time between two shots, seconds. */
  readonly shotCooldown: number;
  /** Fires once its view is this close to the mark, radians. */
  readonly aimTolerance: number;
  /** Chance it goes for a portal trap when one is on (re-rolled every few seconds). */
  readonly trapChance: number;
  /** Traps someone up to this far away, metres. */
  readonly trapRange: number;
  /** Chance it shoots an enemy portal it sees to steal it (decided once per portal). */
  readonly stealChance: number;
  /** Sidesteps when it sees someone aiming at it. */
  readonly dodges: boolean;
  /** Keeps moving (strafing, or on along its route) while it lines up a shot. */
  readonly moveWhileAiming: boolean;
  /**
   * Knows where everyone, every orb and every portal is, all the time (a deliberate cheat
   * for the top difficulty). It still turns at its turn rate and needs a clear line to shoot.
   */
  readonly omniscient: boolean;
  /** Hops as it runs (on flat, safe ground) - harder to trap. */
  readonly hops: boolean;
  /**
   * Portals itself up to someone on higher ground (an exit on a wall or ceiling up there, a
   * portal on the floor beside it), sets a trap on them on the way down, and flashes
   * immunity before a hard landing.
   */
  readonly portalClimb: boolean;
  /**
   * Chance, rolled every `comboEvery` seconds, that it drops in on someone from a ceiling for the fun
   * of it (high ground or not): exit in the ceiling, a portal beside itself, in, and a trap
   * on them while it falls. Needs `portalClimb`.
   */
  readonly comboChance: number;
  /** Top running speed, times a person's (harder bots are a little quicker on their feet). */
  readonly moveSpeed: number;
  /**
   * How long it waits after springing (or giving up) a trap, a portal climb, before the
   * next one, seconds - and how often it rolls for a drop-in.
   */
  readonly trapCooldown: number;
  readonly climbCooldown: number;
  readonly comboEvery: number;
  /** Looks at where a shot it fired landed this soon after it, seconds. */
  readonly checkDelay: number;
  /**
   * Its trap and steal shots are ones it decided on itself, not something it has to react
   * to: it turns to them with no reaction delay (as climb shots always do).
   */
  readonly decisive: boolean;
  /**
   * Sets up a trap exit in a deadly spot it can see while it is still looking for someone
   * to use it on, so the trap itself is one shot when they turn up.
   */
  readonly anticipate: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;

export const BOT_SKILLS = {
  easy: {
    name: 'Easy',
    fovH: deg(48),
    fovV: deg(38),
    viewRange: 45,
    acquireTime: 0.38,
    hearing: 0.8,
    memory: 4.5,
    reaction: 0.34,
    turnRate: deg(220),
    turnAccel: deg(1000),
    aimError: deg(5),
    aimSettle: 1,
    aimWobble: deg(0.6),
    overshoot: 1.22,
    thinkInterval: 0.3,
    shotCooldown: 0.7,
    aimTolerance: deg(2.2),
    trapChance: 0.6,
    trapRange: 30,
    stealChance: 0.3,
    dodges: false,
    moveWhileAiming: false,
    omniscient: false,
    hops: false,
    portalClimb: false,
    comboChance: 0,
    moveSpeed: 1,
    trapCooldown: 3,
    climbCooldown: 6,
    comboEvery: 3,
    checkDelay: 0.15,
    decisive: false,
    anticipate: false,
  },
  normal: {
    name: 'Normal',
    fovH: deg(52),
    fovV: deg(41),
    viewRange: 60,
    acquireTime: 0.25,
    hearing: 1.05,
    memory: 5.5,
    reaction: 0.24,
    turnRate: deg(330),
    turnAccel: deg(2000),
    aimError: deg(3),
    aimSettle: 0.55,
    aimWobble: deg(0.35),
    overshoot: 1.12,
    thinkInterval: 0.16,
    shotCooldown: 0.45,
    aimTolerance: deg(1.5),
    trapChance: 1,
    trapRange: 38,
    stealChance: 0.7,
    dodges: true,
    moveWhileAiming: false,
    omniscient: false,
    hops: false,
    portalClimb: false,
    comboChance: 0,
    moveSpeed: 1.1,
    trapCooldown: 2.4,
    climbCooldown: 6,
    comboEvery: 3,
    checkDelay: 0.15,
    decisive: false,
    anticipate: false,
  },
  hard: {
    name: 'Hard',
    fovH: deg(58),
    fovV: deg(45),
    viewRange: 80,
    acquireTime: 0.1,
    hearing: 1.25,
    memory: 7,
    reaction: 0.06,
    turnRate: deg(900),
    turnAccel: deg(9000),
    aimError: deg(0.8),
    aimSettle: 0.15,
    aimWobble: deg(0.15),
    overshoot: 1.03,
    thinkInterval: 0.04,
    shotCooldown: 0.12,
    aimTolerance: deg(1),
    trapChance: 1,
    trapRange: 45,
    stealChance: 1,
    dodges: true,
    moveWhileAiming: true,
    omniscient: true,
    hops: true,
    portalClimb: true,
    comboChance: 0.6,
    moveSpeed: 1.3,
    trapCooldown: 0.5,
    climbCooldown: 2.5,
    comboEvery: 1.2,
    checkDelay: 0.05,
    decisive: true,
    anticipate: true,
  },
} satisfies Record<string, BotSkill>;

export type BotDifficulty = keyof typeof BOT_SKILLS;

/** Small fast seeded generator (mulberry32), so bot runs are repeatable in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
