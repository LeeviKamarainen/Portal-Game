/**
 * Win conditions for a PvP match: points come from point orbs and from hazard kills, and
 * the first player to `scoreToWin` takes the match.
 *
 * Kill credit follows portals. A player killed by a hazard is credited to whoever owns the
 * portal they last came out of (their own portals don't count). A player killed by an
 * object - a laser beam, a flying crate - is credited to whoever owns the portal that
 * object last came out of; if it never went through one, the victim's own portal trip
 * decides. Credit runs out `creditWindow` seconds after the trip.
 */
export interface MatchRules {
  /** First to this many points wins. */
  scoreToWin: number;
  /** Points for picking up an orb. */
  orbPoints: number;
  /** Orbs in the arena at once. */
  orbCount: number;
  /** Seconds before a collected orb turns up somewhere else. */
  orbRespawn: number;
  /** No portal may open within this distance of an orb's centre (m). */
  orbNoPortalRadius: number;
  /** Points for a kill credited to you. */
  killPoints: number;
  /** How long a portal trip keeps someone (or something) credited to the portal's owner (s). */
  creditWindow: number;
}

export const DEFAULT_RULES: MatchRules = {
  scoreToWin: 100,
  orbPoints: 10,
  orbCount: 3,
  orbRespawn: 4,
  orbNoPortalRadius: 4,
  killPoints: 25,
  creditWindow: 10,
};

/** The last portal something came out of, and when. */
export interface PortalTrip {
  owner: string;
  time: number;
}

export interface MatchPlayer {
  readonly id: string;
  name: string;
  score: number;
}

export class Match {
  readonly rules: MatchRules;
  readonly players: MatchPlayer[] = [];
  winner: MatchPlayer | null = null;

  constructor(rules: Partial<MatchRules> = {}) {
    this.rules = { ...DEFAULT_RULES, ...rules };
  }

  addPlayer(id: string, name: string): MatchPlayer {
    const existing = this.player(id);
    if (existing) return existing;
    const p: MatchPlayer = { id, name, score: 0 };
    this.players.push(p);
    return p;
  }

  player(id: string): MatchPlayer | undefined {
    return this.players.find((p) => p.id === id);
  }

  get over(): boolean {
    return this.winner !== null;
  }

  /** Adds points; false (and nothing changes) once the match is decided or for an unknown player. */
  award(id: string, points: number): boolean {
    const p = this.player(id);
    if (!p || this.winner) return false;
    p.score += points;
    if (p.score >= this.rules.scoreToWin) this.winner = p;
    return true;
  }

  /** Whose trip is still fresh at `now`, or null. */
  creditOf(trip: PortalTrip | null, now: number): string | null {
    return trip && now - trip.time <= this.rules.creditWindow ? trip.owner : null;
  }
}
