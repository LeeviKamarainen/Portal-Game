/**
 * How good a bot is. Difficulty changes these numbers only - never what a bot is allowed
 * to know (see Perception) or do (it drives the same PlayerCommand a keyboard does).
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
    reaction: 0.38,
    turnRate: deg(170),
    turnAccel: deg(750),
    aimError: deg(5),
    aimSettle: 1,
    aimWobble: deg(0.6),
    overshoot: 1.22,
    thinkInterval: 0.35,
    shotCooldown: 0.75,
    aimTolerance: deg(2.2),
    trapChance: 0.6,
    trapRange: 30,
    stealChance: 0.3,
    dodges: false,
    moveWhileAiming: false,
  },
  normal: {
    name: 'Normal',
    fovH: deg(52),
    fovV: deg(41),
    viewRange: 60,
    acquireTime: 0.25,
    hearing: 1.05,
    memory: 5.5,
    reaction: 0.28,
    turnRate: deg(210),
    turnAccel: deg(1050),
    aimError: deg(3),
    aimSettle: 0.65,
    aimWobble: deg(0.35),
    overshoot: 1.12,
    thinkInterval: 0.2,
    shotCooldown: 0.5,
    aimTolerance: deg(1.5),
    trapChance: 1,
    trapRange: 38,
    stealChance: 0.7,
    dodges: true,
    moveWhileAiming: false,
  },
  hard: {
    name: 'Hard',
    fovH: deg(58),
    fovV: deg(45),
    viewRange: 80,
    acquireTime: 0.16,
    hearing: 1.25,
    memory: 7,
    reaction: 0.2,
    turnRate: deg(250),
    turnAccel: deg(1500),
    aimError: deg(1.5),
    aimSettle: 0.4,
    aimWobble: deg(0.2),
    overshoot: 1.06,
    thinkInterval: 0.12,
    shotCooldown: 0.35,
    aimTolerance: deg(1),
    trapChance: 1,
    trapRange: 45,
    stealChance: 1,
    dodges: true,
    moveWhileAiming: true,
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
