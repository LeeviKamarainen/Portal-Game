/**
 * Accounts over HTTP: register, log in and out, who am I, change password. A login is a random
 * token in an HttpOnly cookie; the store keeps only its hash, so a leaked database can't be
 * replayed as sessions. The game page and /ws share an origin, so the browser sends the same
 * cookie on the WebSocket upgrade and the server knows who connected.
 *
 *   GET  /api/me         { user: PublicUser | null }
 *   POST /api/register   { name, password }
 *   POST /api/login      { name, password }
 *   POST /api/logout
 *   POST /api/password   { current, next }  (ends every other session)
 *
 * Errors are `{ error: { code, message } }` with a fitting status.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RIGHTS, passwordProblem, userNameProblem, type PublicUser } from '../../src/net/accounts';
import { StoreError, type Store, type User } from '../store/Store';
import { ApiError, handleApi, originOk, readJsonBody, sendJson } from './http';
import { decoyHash, hashPassword, verifyPassword } from './password';
import { RateLimiter } from './RateLimiter';

export type { PublicUser };

export const SESSION_COOKIE = 'portal_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const BODY_MAX = 4096;

export interface AuthOptions {
  store: Store;
  /** Page origins allowed to make requests; empty = same host only. */
  allowedOrigins: string[];
  /** Mark the cookie Secure (when the public site is https, whatever the proxy in front says). */
  secureCookies: boolean;
  registrationOpen: boolean;
  addressOf(req: IncomingMessage): string;
  log(line: string): void;
}

export function publicUser(user: User): PublicUser {
  return { id: user.id, name: user.name, role: user.role, rights: user.role === 'admin' ? [...RIGHTS] : [...user.rights] };
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export class AuthApi {
  private readonly store: Store;
  private readonly opts: AuthOptions;
  private readonly registrations = new RateLimiter(5, 3600_000);
  private readonly loginsByAddress = new RateLimiter(30, 600_000);
  private readonly loginsByName = new RateLimiter(10, 600_000);

  constructor(options: AuthOptions) {
    this.store = options.store;
    this.opts = options;
  }

  /** The logged-in user behind a request's cookie, or null (a guest). */
  userFor(req: IncomingMessage): User | null {
    const token = cookieOf(req, SESSION_COOKIE);
    return token ? this.store.userForSession(hashToken(token)) : null;
  }

  /** Housekeeping, now and then: expired sessions and stale rate-limit entries. */
  sweep(): void {
    this.store.purgeExpiredSessions();
    for (const limiter of [this.registrations, this.loginsByAddress, this.loginsByName]) limiter.sweep();
  }

  /** Answers `/api/...` requests (all but /api/maps). */
  handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    return handleApi(req, res, this.opts.log, () => this.route(req, res, path));
  }

  private async route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const method = req.method ?? 'GET';
    if (path === '/api/me') {
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      const user = this.userFor(req);
      return sendJson(res, 200, { user: user ? publicUser(user) : null });
    }
    const handlers: Record<string, () => Promise<void>> = {
      '/api/register': () => this.register(req, res),
      '/api/login': () => this.login(req, res),
      '/api/logout': () => this.logout(req, res),
      '/api/password': () => this.changePassword(req, res),
    };
    const handler = handlers[path];
    if (!handler) throw new ApiError(404, 'not-found', 'No such endpoint.');
    if (method !== 'POST') throw new ApiError(405, 'method', 'Use POST.');
    if (!originOk(req, this.opts.allowedOrigins)) throw new ApiError(403, 'origin', 'Requests must come from the game page.');
    await handler();
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.opts.registrationOpen) throw new ApiError(403, 'registration-closed', 'Registration is closed.');
    const { name, password } = await this.credentials(req);
    this.limit(this.registrations, this.opts.addressOf(req), 'Too many accounts from here - try again later.');
    const problem = userNameProblem(name) ?? passwordProblem(password);
    if (problem) throw new ApiError(400, 'invalid', problem);
    const passwordHash = await hashPassword(password);
    let user: User;
    try {
      user = this.store.createUser(name, passwordHash);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'name-taken') throw new ApiError(409, 'name-taken', e.message);
      throw e;
    }
    sendJson(res, 200, { user: publicUser(user) }, { 'set-cookie': this.startSession(user) });
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { name, password } = await this.credentials(req);
    this.limit(this.loginsByAddress, this.opts.addressOf(req), 'Too many login attempts - wait a few minutes.');
    this.limit(this.loginsByName, name.toLowerCase(), 'Too many login attempts for that name - wait a few minutes.');
    const found = this.store.findUserForLogin(name);
    // An unknown name costs the same time as a wrong password, so names can't be probed.
    const good = await verifyPassword(password, found?.passwordHash ?? (await decoyHash()));
    if (!found || !good) throw new ApiError(401, 'bad-login', 'Wrong name or password.');
    if (found.disabled) throw new ApiError(403, 'disabled', 'This account is disabled.');
    this.store.recordLogin(found.id);
    sendJson(res, 200, { user: publicUser(found) }, { 'set-cookie': this.startSession(found) });
  }

  private async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = cookieOf(req, SESSION_COOKIE);
    if (token) this.store.deleteSession(hashToken(token));
    sendJson(res, 200, { ok: true }, { 'set-cookie': this.cookie('', 0) });
  }

  private async changePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = this.userFor(req);
    if (!user) throw new ApiError(401, 'not-logged-in', 'Log in first.');
    const body = await readJsonBody(req, BODY_MAX);
    const current = typeof body.current === 'string' ? body.current : '';
    const next = body.next;
    this.limit(this.loginsByName, user.name.toLowerCase(), 'Too many attempts - wait a few minutes.');
    const stored = this.store.findUserForLogin(user.name);
    if (!stored || !(await verifyPassword(current, stored.passwordHash))) throw new ApiError(401, 'bad-login', 'Your current password is wrong.');
    const problem = passwordProblem(next);
    if (problem) throw new ApiError(400, 'invalid', problem);
    // Every session ends - including a thief's - then this browser gets a fresh one.
    this.store.setPasswordHash(user.id, await hashPassword(next as string));
    sendJson(res, 200, { user: publicUser(user) }, { 'set-cookie': this.startSession(user) });
  }

  /** Opens a session for `user` and returns the cookie that carries it. */
  private startSession(user: User): string {
    const token = newToken();
    this.store.createSession(user.id, hashToken(token), SESSION_TTL_MS);
    return this.cookie(token, SESSION_TTL_MS / 1000);
  }

  private cookie(value: string, maxAgeSeconds: number): string {
    return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSeconds)}${this.opts.secureCookies ? '; Secure' : ''}`;
  }

  private limit(limiter: RateLimiter, key: string, message: string): void {
    if (!limiter.allow(key)) throw new ApiError(429, 'rate-limited', message, { 'retry-after': '60' });
  }

  private async credentials(req: IncomingMessage): Promise<{ name: string; password: string }> {
    const body = await readJsonBody(req, BODY_MAX);
    if (typeof body.name !== 'string' || typeof body.password !== 'string') throw new ApiError(400, 'invalid', 'Send a name and a password.');
    return { name: body.name.trim(), password: body.password };
  }
}
