/**
 * The admin page's API: the player list, and which players may generate maps. Admins only -
 * the rest get a 403, guests a 401.
 *
 *   GET /api/admin/users                 { users: AdminUser[] }
 *   PUT /api/admin/users/:id/rights      { rights: Right[] }  -> { user: AdminUser }
 *
 * `rights` replaces the list of rights a player has on top of their role (see `hasRight`).
 * Errors are `{ error: { code, message } }` like the rest of /api.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RIGHTS, type AdminUser, type Right } from '../../src/net/accounts';
import type { Store, User } from '../store/Store';
import { publicUser } from './AuthApi';
import { ApiError, handleApi, originOk, readJsonBody, sendJson } from './http';

const DAY_MS = 24 * 3600 * 1000;
const BODY_MAX = 2048;

export interface AdminApiOptions {
  store: Store;
  allowedOrigins: string[];
  userFor(req: IncomingMessage): User | null;
  log(line: string): void;
}

export class AdminApi {
  private readonly opts: AdminApiOptions;

  constructor(options: AdminApiOptions) {
    this.opts = options;
  }

  /** Answers `/api/admin/...` requests. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleApi(req, res, this.opts.log, () => this.route(req, res, url));
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.slice('/api/admin/'.length).split('/').filter(Boolean);
    if (method !== 'GET' && !originOk(req, this.opts.allowedOrigins)) throw new ApiError(403, 'origin', 'Requests must come from the game page.');
    const admin = this.login(req);

    if (parts.length === 1 && parts[0] === 'users') {
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      return sendJson(res, 200, { users: this.opts.store.listUsers().map((u) => this.adminUser(u)) });
    }
    if (parts.length === 3 && parts[0] === 'users' && parts[2] === 'rights') {
      if (method !== 'PUT') throw new ApiError(405, 'method', 'Use PUT.');
      const id = Number(parts[1]);
      const body = await readJsonBody(req, BODY_MAX);
      const rights = rightsIn(body.rights);
      const target = Number.isInteger(id) ? this.opts.store.getUser(id) : null;
      if (!target) throw new ApiError(404, 'no-such-user', 'No such player.');
      this.opts.store.setRights(target.id, rights);
      this.opts.log(`${admin.name} set the rights of ${target.name} to: ${rights.join(', ') || 'none'}`);
      return sendJson(res, 200, { user: this.adminUser(this.opts.store.getUser(target.id)!) });
    }
    throw new ApiError(404, 'not-found', 'No such endpoint.');
  }

  private login(req: IncomingMessage): User {
    const user = this.opts.userFor(req);
    if (!user) throw new ApiError(401, 'not-logged-in', 'Log in first.');
    if (user.role !== 'admin') throw new ApiError(403, 'forbidden', 'Only admins can do that.');
    return user;
  }

  private adminUser(user: User): AdminUser {
    return {
      ...publicUser(user),
      disabled: user.disabled,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
      generationsToday: this.opts.store.countGenerationsSince(user.id, Date.now() - DAY_MS),
    };
  }
}

/** The rights in a request body: a list of known right names, each once. */
function rightsIn(value: unknown): Right[] {
  if (!Array.isArray(value) || value.some((r) => !RIGHTS.includes(r as Right))) {
    throw new ApiError(400, 'invalid', `Rights are a list of: ${RIGHTS.join(', ')}.`);
  }
  return [...new Set(value as Right[])];
}
