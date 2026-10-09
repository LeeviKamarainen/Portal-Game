import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { MAP_JSON_MAX } from '../../src/net/protocol';
import {
  MAPS_PER_USER,
  MAP_NAME_MAX,
  RIGHTS,
  StoreError,
  userNameProblem,
  type GenerationRecord,
  type GenerationStatus,
  type MapRecord,
  type MapSummary,
  type Right,
  type Role,
  type Store,
  type User,
  type UserWithSecret,
  type Visibility,
} from './Store';

/**
 * Each entry takes the database from version i to i+1 (`PRAGMA user_version`). Add to the end
 * and never edit one that has shipped - a live database has already run it.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );
  CREATE TABLE user_rights (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    right_name TEXT NOT NULL,
    PRIMARY KEY (user_id, right_name)
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE maps (
    id         TEXT PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    visibility TEXT NOT NULL CHECK (visibility IN ('private', 'unlisted', 'public')),
    json       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX maps_owner ON maps(owner_id, updated_at DESC);
  CREATE INDEX maps_public ON maps(visibility, updated_at DESC);
  `,
  `
  CREATE TABLE generation_jobs (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt      TEXT NOT NULL,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed', 'cancelled', 'interrupted')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    tokens_in   INTEGER NOT NULL DEFAULT 0,
    tokens_out  INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX generation_user ON generation_jobs(user_id, created_at DESC);
  CREATE INDEX generation_time ON generation_jobs(created_at);
  `,
];

export interface SqliteStoreOptions {
  /** The clock, in ms; tests move it to expire sessions. */
  now?: () => number;
}

type Row = Record<string, unknown>;

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  /** `path` is a file (its folder is created) or ':memory:'. */
  constructor(path: string, options: SqliteStoreOptions = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.now = options.now ?? Date.now;
    // WAL: readers don't block the writer, and a crash can't tear the file.
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    // The admin tool opens the same file while the server runs: wait for its write instead of failing.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    const from = Number(row.user_version);
    if (from > MIGRATIONS.length) throw new Error(`The database is version ${from}, newer than this server (${MIGRATIONS.length}).`);
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  private transaction<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private one(sql: string, ...args: SQLInputValue[]): Row | null {
    return (this.db.prepare(sql).get(...args) as Row | undefined) ?? null;
  }

  private run(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...args).changes);
  }

  // --- accounts ---

  createUser(name: string, passwordHash: string, role: Role = 'user'): User {
    const problem = userNameProblem(name);
    if (problem) throw new StoreError('bad-name', problem);
    if (this.one('SELECT 1 FROM users WHERE name = ?', name)) throw new StoreError('name-taken', 'That name is taken.');
    const id = Number(this.db.prepare('INSERT INTO users (name, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(name, passwordHash, role, this.now()).lastInsertRowid);
    return this.getUser(id)!;
  }

  getUser(id: number): User | null {
    const row = this.one('SELECT * FROM users WHERE id = ?', id);
    return row ? this.userOf(row) : null;
  }

  findUserForLogin(name: string): UserWithSecret | null {
    const row = this.one('SELECT * FROM users WHERE name = ?', name);
    return row ? { ...this.userOf(row), passwordHash: String(row.password_hash) } : null;
  }

  listUsers(): User[] {
    return this.all('SELECT * FROM users ORDER BY id').map((row) => this.userOf(row));
  }

  setPasswordHash(id: number, passwordHash: string): void {
    this.transaction(() => {
      this.expectUser(this.run('UPDATE users SET password_hash = ? WHERE id = ?', passwordHash, id));
      this.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
  }

  setRole(id: number, role: Role): void {
    this.expectUser(this.run('UPDATE users SET role = ? WHERE id = ?', role, id));
  }

  setRights(id: number, rights: readonly Right[]): void {
    this.transaction(() => {
      if (!this.one('SELECT 1 FROM users WHERE id = ?', id)) throw new StoreError('no-such-user', 'No such user.');
      this.run('DELETE FROM user_rights WHERE user_id = ?', id);
      for (const right of new Set(rights)) {
        if (!RIGHTS.includes(right)) throw new Error(`Unknown right "${String(right)}".`);
        this.run('INSERT INTO user_rights (user_id, right_name) VALUES (?, ?)', id, right);
      }
    });
  }

  setDisabled(id: number, disabled: boolean): void {
    this.transaction(() => {
      this.expectUser(this.run('UPDATE users SET disabled = ? WHERE id = ?', disabled ? 1 : 0, id));
      if (disabled) this.run('DELETE FROM sessions WHERE user_id = ?', id);
    });
  }

  recordLogin(id: number): void {
    this.run('UPDATE users SET last_login_at = ? WHERE id = ?', this.now(), id);
  }

  deleteUser(id: number): void {
    this.run('DELETE FROM users WHERE id = ?', id);
  }

  private expectUser(changes: number): void {
    if (changes === 0) throw new StoreError('no-such-user', 'No such user.');
  }

  private userOf(row: Row): User {
    const rights = this.all('SELECT right_name FROM user_rights WHERE user_id = ? ORDER BY right_name', Number(row.id)).map((r) => String(r.right_name) as Right);
    return {
      id: Number(row.id),
      name: String(row.name),
      role: String(row.role) as Role,
      rights,
      disabled: Number(row.disabled) === 1,
      createdAt: Number(row.created_at),
      lastLoginAt: row.last_login_at === null ? null : Number(row.last_login_at),
    };
  }

  // --- sessions ---

  createSession(userId: number, tokenHash: string, ttlMs: number): void {
    const now = this.now();
    this.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', tokenHash, userId, now, now + ttlMs);
  }

  userForSession(tokenHash: string): User | null {
    const row = this.one(
      'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0',
      tokenHash,
      this.now(),
    );
    return row ? this.userOf(row) : null;
  }

  deleteSession(tokenHash: string): void {
    this.run('DELETE FROM sessions WHERE token_hash = ?', tokenHash);
  }

  purgeExpiredSessions(): number {
    return this.run('DELETE FROM sessions WHERE expires_at <= ?', this.now());
  }

  // --- maps ---

  saveMap(ownerId: number, name: string, json: string, visibility: Visibility = 'private'): MapRecord {
    const clean = this.mapName(name);
    this.mapSize(json);
    return this.transaction(() => {
      if (!this.one('SELECT 1 FROM users WHERE id = ?', ownerId)) throw new StoreError('no-such-user', 'No such user.');
      const count = Number(this.one('SELECT COUNT(*) AS n FROM maps WHERE owner_id = ?', ownerId)!.n);
      if (count >= MAPS_PER_USER) throw new StoreError('map-limit', `You can keep ${MAPS_PER_USER} maps; delete one first.`);
      const id = randomBytes(9).toString('base64url');
      const now = this.now();
      this.run('INSERT INTO maps (id, owner_id, name, visibility, json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ownerId, clean, visibility, json, now, now);
      return this.getMap(id)!;
    });
  }

  getMap(id: string): MapRecord | null {
    const row = this.one('SELECT m.*, u.name AS owner_name FROM maps m JOIN users u ON u.id = m.owner_id WHERE m.id = ?', id);
    return row ? { ...this.summaryOf(row), json: String(row.json) } : null;
  }

  updateMap(id: string, ownerId: number, changes: { name?: string; json?: string; visibility?: Visibility }): MapRecord | null {
    const name = changes.name === undefined ? undefined : this.mapName(changes.name);
    if (changes.json !== undefined) this.mapSize(changes.json);
    const owned = this.one('SELECT name, json, visibility FROM maps WHERE id = ? AND owner_id = ?', id, ownerId);
    if (!owned) return null;
    this.run(
      'UPDATE maps SET name = ?, json = ?, visibility = ?, updated_at = ? WHERE id = ?',
      name ?? String(owned.name),
      changes.json ?? String(owned.json),
      changes.visibility ?? String(owned.visibility),
      this.now(),
      id,
    );
    return this.getMap(id);
  }

  deleteMap(id: string, ownerId: number): boolean {
    return this.run('DELETE FROM maps WHERE id = ? AND owner_id = ?', id, ownerId) > 0;
  }

  listMapsOf(ownerId: number): MapSummary[] {
    return this.all(
      'SELECT m.id, m.owner_id, m.name, m.visibility, m.created_at, m.updated_at, u.name AS owner_name FROM maps m JOIN users u ON u.id = m.owner_id WHERE m.owner_id = ? ORDER BY m.updated_at DESC, m.rowid DESC',
      ownerId,
    ).map((row) => this.summaryOf(row));
  }

  listPublicMaps(limit: number, offset = 0): MapSummary[] {
    return this.all(
      "SELECT m.id, m.owner_id, m.name, m.visibility, m.created_at, m.updated_at, u.name AS owner_name FROM maps m JOIN users u ON u.id = m.owner_id WHERE m.visibility = 'public' AND u.disabled = 0 ORDER BY m.updated_at DESC, m.rowid DESC LIMIT ? OFFSET ?",
      Math.max(0, Math.floor(limit)),
      Math.max(0, Math.floor(offset)),
    ).map((row) => this.summaryOf(row));
  }

  private mapName(name: string): string {
    const clean = name.trim();
    if (clean.length === 0 || clean.length > MAP_NAME_MAX) throw new StoreError('bad-map-name', `Map names are 1-${MAP_NAME_MAX} characters.`);
    return clean;
  }

  private mapSize(json: string): void {
    if (json.length > MAP_JSON_MAX) throw new StoreError('map-too-big', `The map is too big (over ${MAP_JSON_MAX / 1024} KB).`);
  }

  private summaryOf(row: Row): MapSummary {
    return {
      id: String(row.id),
      ownerId: Number(row.owner_id),
      ownerName: String(row.owner_name),
      name: String(row.name),
      visibility: String(row.visibility) as Visibility,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  // --- the map generator ---

  startGeneration(userId: number, id: string, prompt: string, kind: string): void {
    this.run("INSERT INTO generation_jobs (id, user_id, prompt, kind, status, created_at) VALUES (?, ?, ?, ?, 'running', ?)", id, userId, prompt, kind, this.now());
  }

  finishGeneration(id: string, r: { status: GenerationStatus; attempts: number; tokensIn: number; tokensOut: number; error?: string | null }): void {
    this.run(
      'UPDATE generation_jobs SET status = ?, attempts = ?, tokens_in = ?, tokens_out = ?, error = ?, finished_at = ? WHERE id = ?',
      r.status,
      r.attempts,
      r.tokensIn,
      r.tokensOut,
      r.error ?? null,
      this.now(),
      id,
    );
  }

  countGenerationsSince(userId: number, sinceMs: number): number {
    return Number(
      this.one(
        "SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ? AND created_at >= ? AND status != 'interrupted' AND (status = 'running' OR tokens_in + tokens_out > 0)",
        userId,
        sinceMs,
      )!.n,
    );
  }

  tokensUsedSince(sinceMs: number): number {
    return Number(this.one('SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS n FROM generation_jobs WHERE created_at >= ?', sinceMs)!.n);
  }

  interruptRunningGenerations(): number {
    return this.run("UPDATE generation_jobs SET status = 'interrupted', finished_at = ? WHERE status = 'running'", this.now());
  }

  recentGenerations(userId: number, limit: number): GenerationRecord[] {
    return this.all('SELECT * FROM generation_jobs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', userId, Math.max(1, Math.floor(limit))).map((row) => ({
      id: String(row.id),
      userId: Number(row.user_id),
      prompt: String(row.prompt),
      kind: String(row.kind),
      status: String(row.status) as GenerationStatus,
      attempts: Number(row.attempts),
      tokensIn: Number(row.tokens_in),
      tokensOut: Number(row.tokens_out),
      error: row.error === null ? null : String(row.error),
      createdAt: Number(row.created_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}
