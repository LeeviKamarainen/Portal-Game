/**
 * How good a bot is. Difficulty changes these numbers and a few abilities - it always drives
 * the same PlayerCommand a keyboard does. Easy and Normal know only what they see and hear
 * (see Perception); Hard is `omniscient` by design. Harder bots also run a little faster
 * than a person (`moveSpeed`). Ultra hard is Hard with everything turned up a notch that
 * also gets about by portal (`portalTravel`).
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
  /**
   * Gets about by portal: on its way to an orb, an enemy or somewhere to explore, it puts an
   * exit it can see nearer to where it is going and a portal beside itself, and steps through
   * instead of walking the long way round. Needs `portalClimb` (it lands the same way).
   */
  readonly portalTravel: boolean;
  /**
   * Gets about by portal only when there is no way on foot at all - stranded on a block of
   * Cubefield, an island on Shaft: the same hop as `portalTravel` (no chains), to another
   * island that has a way on, or at least lands a good deal nearer.
   */
  readonly strandedTravel: boolean;
  /**
   * Chains portals in the air: out of one portal with time to fall, it shoots a new exit
   * nearer where it is going and a way in on what it is about to hit, and goes through that
   * too - link after link, off a ceiling or a wall, instead of landing and walking on. Needs
   * `portalTravel`.
   */
  readonly airChain: boolean;
  /**
   * Gets about by portal only while no enemy it knows of is this near, metres (0: always) -
   * a hop or a chain is a second or so in which it can set no trap, and near an enemy that
   * is a kill chance (25 points, an orb is 10) it hands over. A chain is held to
   * `chainEnemyClear` instead, if that is further.
   */
  readonly travelEnemyClear: number;
  readonly chainEnemyClear: number;
  /**
   * Alternates between two modes, each for this long, seconds (0: no alternating - it does
   * what suits it). Orb rush: it goes for points as fast as it can (no traps, steals or
   * drop-ins, and no handing over to a fight - it hops and chains whenever that saves time).
   * Hunt: it goes after the players (traps, climbs, steals, drop-ins) and takes orbs only
   * when it has no one to go after. Starts with the rush.
   */
  readonly orbPhase: number;
  readonly huntPhase: number;
  /** Rush: still takes a trap on someone who walks into one (a kill is 25 points). */
  readonly rushTraps: boolean;
  /**
   * An orb this near (metres of walk-ish: distance plus twice the height) that no enemy is much
   * closer to comes before anything optional - exit prep, traps that only hurt, climbs, drop-ins
   * for show, steals. A sure kill still does (0: off).
   */
  readonly orbFirst: number;
  /** What an orb close by puts off (see `orbFirst`). */
  readonly orbFirstSkips: readonly ('prep' | 'fall' | 'combo' | 'climb' | 'steal')[];
  /** Hunt: stays on the players even when it can't set a trap yet (else it takes orbs meanwhile). */
  readonly huntStays: boolean;
}

const deg = (d: number) => (d * Math.PI) / 180;

const ULTRA: BotSkill = {
  name: 'Ultra hard',
  fovH: deg(62),
  fovV: deg(48),
  viewRange: 90,
  acquireTime: 0.05,
  hearing: 1.4,
  memory: 8,
  reaction: 0.03,
  turnRate: deg(1200),
  turnAccel: deg(14000),
  aimError: deg(0.5),
  aimSettle: 0.1,
  aimWobble: deg(0.1),
  overshoot: 1.02,
  thinkInterval: 0.03,
  shotCooldown: 0.1,
  aimTolerance: deg(0.9),
  trapChance: 1,
  trapRange: 50,
  stealChance: 1,
  dodges: true,
  moveWhileAiming: true,
  omniscient: true,
  hops: true,
  portalClimb: true,
  comboChance: 0.75,
  moveSpeed: 1.5,
  trapCooldown: 0.35,
  climbCooldown: 1.8,
  comboEvery: 0.9,
  checkDelay: 0.04,
  decisive: true,
  anticipate: true,
  portalTravel: true,
  strandedTravel: true,
  airChain: true,
  travelEnemyClear: 30,
  chainEnemyClear: 30,
  orbPhase: 0,
  huntPhase: 0,
  rushTraps: false,
  huntStays: false,
  // (Measured against Hard: drop-ins for show and high-ground climbs with an orb in reach cost
  // orbs and nothing else; exit prep, steals and traps that hurt are where its kills come from.)
  orbFirst: 50,
  orbFirstSkips: ['combo', 'climb'],
};

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
    portalTravel: false,
    strandedTravel: false,
    airChain: false,
    travelEnemyClear: 0,
    chainEnemyClear: 0,
    orbPhase: 0,
    huntPhase: 0,
    rushTraps: false,
    huntStays: false,
    orbFirst: 0,
    orbFirstSkips: [],
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
    portalTravel: false,
    strandedTravel: true,
    airChain: false,
    travelEnemyClear: 0,
    chainEnemyClear: 0,
    orbPhase: 0,
    huntPhase: 0,
    rushTraps: false,
    huntStays: false,
    orbFirst: 0,
    orbFirstSkips: [],
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
    portalTravel: false,
    strandedTravel: true,
    airChain: false,
    travelEnemyClear: 0,
    chainEnemyClear: 0,
    orbPhase: 0,
    huntPhase: 0,
    rushTraps: false,
    huntStays: false,
    orbFirst: 0,
    orbFirstSkips: [],
  },
  ultra: ULTRA,
  /**
   * Ultra hard's skills, alternating a points rush with a hunt for the players (12 s each).
   * Not stronger than Ultra hard in head-to-heads (about 50% against Hard, Ultra hard 59%); it
   * is for variety: a bot that visibly commits to one thing at a time.
   */
  ultra2: { ...ULTRA, name: 'Ultra 2', orbPhase: 12, huntPhase: 12, rushTraps: true, huntStays: false, orbFirst: 0 },
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
