/**
 * What the server keeps between runs: accounts, login sessions and players' saved maps. The
 * rooms never touch this - they only see a user once the login layer has identified them - so
 * the match code stays free of storage. `SqliteStore` is the one implementation.
 *
 * Every call is synchronous (SQLite is), so keep them off the 60 Hz path: a few at login, at
 * map save, at match end - never one per tick.
 */
import type { MapSummary, Right, Role, Visibility } from '../../src/net/accounts';

export {
  MAPS_PER_USER,
  MAP_NAME_MAX,
  RIGHTS,
  ROLES,
  USER_NAME_MAX,
  USER_NAME_MIN,
  VISIBILITIES,
  hasRight,
  userNameProblem,
} from '../../src/net/accounts';
export type { MapSummary, Right, Role, Visibility } from '../../src/net/accounts';

export interface User {
  id: number;
  name: string;
  role: Role;
  /** The rights granted on top of the role; see `hasRight`. */
  rights: Right[];
  /** A disabled account cannot log in and has no sessions. */
  disabled: boolean;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface UserWithSecret extends User {
  /** The salted hash (see the login layer); never the password. */
  passwordHash: string;
}

export interface MapRecord extends MapSummary {
  /** The map file as JSON text, exactly as saved. The store does not judge it: run it through `checkMap` first. */
  json: string;
}

export type GenerationStatus = 'running' | 'ok' | 'partial' | 'failed' | 'cancelled' | 'interrupted';

/** One run of the map generator: kept for the daily quota and so spend can be audited. */
export interface GenerationRecord {
  id: string;
  userId: number;
  prompt: string;
  kind: string;
  status: GenerationStatus;
  attempts: number;
  /** Input tokens, including prompt-cache reads and writes. */
  tokensIn: number;
  tokensOut: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export type StoreErrorCode = 'bad-name' | 'name-taken' | 'bad-map-name' | 'map-too-big' | 'map-limit' | 'no-such-user';

export class StoreError extends Error {
  readonly code: StoreErrorCode;
  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Store {
  // --- accounts ---
  /** Throws StoreError `bad-name` or `name-taken` (names are unique ignoring case). */
  createUser(name: string, passwordHash: string, role?: Role): User;
  getUser(id: number): User | null;
  /** The account for a login attempt (name ignoring case), with its hash to check. */
  findUserForLogin(name: string): UserWithSecret | null;
  listUsers(): User[];
  /** Throws `no-such-user`. Ends all of the user's sessions - this is also the admin's password reset. */
  setPasswordHash(id: number, passwordHash: string): void;
  setRole(id: number, role: Role): void;
  setRights(id: number, rights: readonly Right[]): void;
  /** Disabling ends all of the user's sessions. */
  setDisabled(id: number, disabled: boolean): void;
  recordLogin(id: number): void;
  /** Removes the account with its sessions and maps. */
  deleteUser(id: number): void;

  // --- sessions: the caller makes the token and hands over only its hash ---
  createSession(userId: number, tokenHash: string, ttlMs: number): void;
  /** The user a live session belongs to, or null (unknown, expired, or disabled account). */
  userForSession(tokenHash: string): User | null;
  deleteSession(tokenHash: string): void;
  purgeExpiredSessions(): number;

  // --- maps ---
  /** Throws `bad-map-name`, `map-too-big` or `map-limit`. */
  saveMap(ownerId: number, name: string, json: string, visibility?: Visibility): MapRecord;
  getMap(id: string): MapRecord | null;
  /** Only the owner's map changes; null if it isn't theirs (or doesn't exist). */
  updateMap(id: string, ownerId: number, changes: { name?: string; json?: string; visibility?: Visibility }): MapRecord | null;
  deleteMap(id: string, ownerId: number): boolean;
  /** Newest first. */
  listMapsOf(ownerId: number): MapSummary[];
  /** Public maps, newest first. */
  listPublicMaps(limit: number, offset?: number): MapSummary[];

  // --- the map generator (docs/llm-map-generation-plan.md) ---
  startGeneration(userId: number, id: string, prompt: string, kind: string): void;
  finishGeneration(id: string, result: { status: GenerationStatus; attempts: number; tokensIn: number; tokensOut: number; error?: string | null }): void;
  /**
   * Generations that count against a user's quota since `sinceMs`: running ones, and finished
   * ones that spent tokens. A run that failed before costing anything, or was lost to a restart, is free.
   */
  countGenerationsSince(userId: number, sinceMs: number): number;
  /** Tokens spent by everyone since `sinceMs`, for the global daily ceiling. */
  tokensUsedSince(sinceMs: number): number;
  /** Marks runs that were still going when the server stopped; returns how many. */
  interruptRunningGenerations(): number;
  recentGenerations(userId: number, limit: number): GenerationRecord[];

  close(): void;
}
