import type { MapData } from '../world/maps/MapFormat';
import type { MatchRules } from '../game/Match';
import type { SessionEvent } from '../sim/SimEvents';
import highwire from '../world/maps/highwire.json';

/**
 * What the game client and the game server say to each other (see
 * docs/online-multiplayer-plan.md). Lobby and control messages are JSON text frames; the
 * per-tick inputs and snapshots are binary (net/commands, net/snapshot).
 */

/** Bumped whenever a message changes shape: an old client gets told to reload. */
export const PROTOCOL_VERSION = 3;
/** Simulation steps a second, on the server and every client. */
export const TICK_RATE = 60;
/** A snapshot goes to each player every this many steps (30 a second). */
export const SNAPSHOT_EVERY = 2;
/** Seconds from everyone having loaded to the match starting. */
export const COUNTDOWN_SECONDS = 3;
/** A player whose connection drops mid-match keeps their place (and score) this long. */
export const REJOIN_SECONDS = 20;
/** The result stays up this long before the room goes back to its lobby (for a rematch). */
export const RESULTS_SECONDS = 8;
/** Most players in one room (humans and bots), whatever the map's spawn count. */
export const MAX_SLOTS = 4;
export const NAME_MAX = 16;
/** A custom map's JSON may be at most this long, with at most this many pieces. */
export const MAP_JSON_MAX = 256 * 1024;
export const MAP_PIECES_MAX = 2000;
/** The WebSocket path on the game server (the dev server proxies it, see vite.config.ts). */
export const WS_PATH = '/ws';

/** Combat maps that ship with the game, playable online by id. */
export const BUILT_IN_ONLINE_MAPS: readonly { id: string; data: MapData }[] = [{ id: 'highwire', data: highwire as MapData }];

export type BotDifficulty = 'easy' | 'normal' | 'hard';
export const BOT_DIFFICULTIES: readonly BotDifficulty[] = ['easy', 'normal', 'hard'];

/** The map a room plays: one that ships with the game, or one the host made in the editor. */
export type MapChoice = { kind: 'builtin'; id: string } | { kind: 'custom'; data: MapData };

export interface LobbyMember {
  id: string;
  name: string;
  skin: string;
  host: boolean;
  /** Lost the connection mid-match: their place is kept for REJOIN_SECONDS. */
  away: boolean;
}

export type RoomPhase = 'lobby' | 'loading' | 'countdown' | 'playing' | 'finished';

export interface LobbyState {
  code: string;
  phase: RoomPhase;
  /** Humans, in join order (which is also slot order when the match starts). */
  members: LobbyMember[];
  /** Which member is you. */
  you: string;
  bots: number;
  difficulty: BotDifficulty;
  map: {
    name: string;
    /** Built-in id, or null for the host's own map. */
    builtin: string | null;
    /** Players the map has room for: min(MAX_SLOTS, its spawn pads). */
    slots: number;
  };
}

export interface RosterEntry {
  /** Player id in the match (`p1`...), which also owns their portals. */
  id: string;
  name: string;
  skin: string;
  slot: number;
  bot: boolean;
}

export type ClientMessage =
  | { type: 'hello'; version: number }
  | { type: 'create'; name: string; skin: string }
  | { type: 'join'; code: string; name: string; skin: string; token?: string }
  | { type: 'leave' }
  | { type: 'setMap'; map: MapChoice }
  | { type: 'setBots'; count: number; difficulty: BotDifficulty }
  | { type: 'start' }
  /** The match arena is built and drawn on this screen: ready for the countdown. */
  | { type: 'loaded' }
  | { type: 'ping'; t: number };

export type ErrorCode =
  | 'version'
  | 'bad-message'
  | 'no-room'
  | 'full'
  | 'in-progress'
  | 'not-host'
  | 'bad-map'
  | 'too-many'
  | 'not-enough'
  | 'not-in-room'
  | 'busy';

export type ServerMessage =
  | { type: 'welcome'; version: number }
  | { type: 'error'; code: ErrorCode; message: string }
  /** You are in a room; keep `token` to come back to it after a dropped connection. */
  | { type: 'joined'; token: string; lobby: LobbyState }
  | { type: 'lobby'; lobby: LobbyState }
  /**
   * The match is being built. `map` is the built-in id or the custom map itself, so every
   * client builds the same arena; `mode` leaves room for puzzle race/co-op later.
   */
  | {
      type: 'matchStart';
      mode: 'combat';
      map: { builtin: string } | { custom: MapData };
      roster: RosterEntry[];
      /** Your player id, or null if you are only watching. */
      you: string | null;
      rules: MatchRules;
      /** The scoreboard so far, in order (a match joined in progress; players who left included). */
      scores: { id: string; name: string; score: number }[];
    }
  /** Someone joined the match in progress (they were not in your `matchStart` roster). */
  | { type: 'playerJoined'; player: RosterEntry }
  /** Everyone has loaded (or the wait ran out): the match starts in `seconds`. */
  | { type: 'countdown'; seconds: number }
  /** The match is on: start sending commands. */
  | { type: 'go' }
  /** Deaths, scores, steals and the win, as they happen (after the snapshot that shows them). */
  | { type: 'events'; events: SessionEvent[] }
  /** An arena-wide message for the HUD (a switch closed every portal). */
  | { type: 'notice'; text: string; seconds: number }
  | { type: 'pong'; t: number };

/** Room codes: 5 letters from 20 consonants (3.2 million codes, and no accidental words). */
export const CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
export const CODE_LENGTH = 5;

/** A code as typed (any case, stray spaces) in canonical form, or null if it can't be one. */
export function normalizeCode(raw: string): string | null {
  const code = raw.replace(/\s+/g, '').toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CODE_LETTERS.includes(c)) return null;
  return code;
}

/** Character skins (the Blocky Characters pack, see core/Settings.SKINS). */
export function cleanSkin(raw: unknown): string {
  return typeof raw === 'string' && /^[a-r]$/.test(raw) ? raw : 'a';
}

/** A display name as anyone will see it: letters, digits, space, _ and -, at most NAME_MAX. */
export function cleanName(raw: unknown): string {
  const name = (typeof raw === 'string' ? raw : '')
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();
  return name || 'PLAYER';
}
