/**
 * Players' saved maps over HTTP. Saving takes any map file the editor can make - a map still
 * being worked on may not be playable yet, so only its shape and size are judged here; a room
 * checks it properly (`checkMap`) when it is picked.
 *
 *   GET    /api/maps              your maps (log in)
 *   GET    /api/maps/public       everyone's public maps: ?limit=&offset=
 *   GET    /api/maps/:id          one map with its file; private ones only for their owner
 *   POST   /api/maps              { data, visibility? }  saves a new map
 *   PUT    /api/maps/:id          { data?, visibility? } (owner only)
 *   DELETE /api/maps/:id          (owner only)
 *
 * A map's name is the name inside its file. Errors are `{ error: { code, message } }`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MAP_NAME_MAX, VISIBILITIES, type MapListing, type MapSummary, type Visibility } from '../../src/net/accounts';
import { MAP_JSON_MAX } from '../../src/net/protocol';
import { mapProblem } from '../../src/room/mapCheck';
import { StoreError, type MapRecord, type Store, type User } from '../store/Store';
import { ApiError, handleApi, originOk, readJsonBody, sendJson } from './http';
import { RateLimiter } from './RateLimiter';

const ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const PUBLIC_PAGE = 50;

export interface MapApiOptions {
  store: Store;
  allowedOrigins: string[];
  /** The logged-in user behind a request, if any. */
  userFor(req: IncomingMessage): User | null;
  log(line: string): void;
}

function summaryOf(record: MapRecord): MapSummary {
  const { json: _json, ...summary } = record;
  return summary;
}

export class MapApi {
  private readonly opts: MapApiOptions;
  private readonly store: Store;
  private readonly writes = new RateLimiter(60, 60_000);

  constructor(options: MapApiOptions) {
    this.opts = options;
    this.store = options.store;
  }

  sweep(): void {
    this.writes.sweep();
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleApi(req, res, this.opts.log, () => this.route(req, res, url));
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const rest = url.pathname.slice('/api/maps'.length).replace(/^\//, '');
    if (rest.includes('/')) throw new ApiError(404, 'not-found', 'No such endpoint.');

    if (method !== 'GET' && !originOk(req, this.opts.allowedOrigins)) throw new ApiError(403, 'origin', 'Requests must come from the game page.');

    if (rest === '' || rest === 'public') {
      if (rest === '' && method === 'POST') return this.create(req, res);
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      if (rest === 'public') return this.listPublic(res, url);
      return sendJson(res, 200, { maps: this.store.listMapsOf(this.login(req).id) });
    }
    if (!ID_PATTERN.test(rest)) throw new ApiError(404, 'no-such-map', 'There is no such map.');
    switch (method) {
      case 'GET':
        return this.get(req, res, rest);
      case 'PUT':
        return this.update(req, res, rest);
      case 'DELETE':
        return this.remove(req, res, rest);
      default:
        throw new ApiError(405, 'method', 'Use GET, PUT or DELETE.');
    }
  }

  private login(req: IncomingMessage): User {
    const user = this.opts.userFor(req);
    if (!user) throw new ApiError(401, 'not-logged-in', 'Log in first.');
    return user;
  }

  private listPublic(res: ServerResponse, url: URL): void {
    const limit = Math.min(PUBLIC_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || PUBLIC_PAGE));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    sendJson(res, 200, { maps: this.store.listPublicMaps(limit, offset) });
  }

  private get(req: IncomingMessage, res: ServerResponse, id: string): void {
    const record = this.store.getMap(id);
    // A private map doesn't admit it exists.
    if (!record || (record.visibility === 'private' && record.ownerId !== this.opts.userFor(req)?.id)) {
      throw new ApiError(404, 'no-such-map', 'There is no such map.');
    }
    const listing: MapListing = { ...summaryOf(record), data: JSON.parse(record.json) };
    sendJson(res, 200, { map: listing });
  }

  private async create(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = this.login(req);
    const body = await this.body(req, user);
    const { json, name } = this.fileOf(body.data);
    const record = this.saving(() => this.store.saveMap(user.id, name, json, this.visibilityOf(body.visibility) ?? 'private'));
    sendJson(res, 201, { map: summaryOf(record) });
  }

  private async update(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const user = this.login(req);
    const body = await this.body(req, user);
    const changes: { name?: string; json?: string; visibility?: Visibility } = {};
    if (body.data !== undefined) Object.assign(changes, this.fileOf(body.data));
    const visibility = this.visibilityOf(body.visibility);
    if (visibility) changes.visibility = visibility;
    const record = this.saving(() => this.store.updateMap(id, user.id, changes));
    if (!record) throw new ApiError(404, 'no-such-map', 'There is no such map.');
    sendJson(res, 200, { map: summaryOf(record) });
  }

  private remove(req: IncomingMessage, res: ServerResponse, id: string): void {
    const user = this.login(req);
    if (!this.store.deleteMap(id, user.id)) throw new ApiError(404, 'no-such-map', 'There is no such map.');
    sendJson(res, 200, { ok: true });
  }

  /** The JSON body of a write, from a user who has not saved too much too fast. */
  private async body(req: IncomingMessage, user: User): Promise<Record<string, unknown>> {
    if (!this.writes.allow(String(user.id))) throw new ApiError(429, 'rate-limited', 'Too many saves - wait a minute.', { 'retry-after': '60' });
    return readJsonBody(req, MAP_JSON_MAX + 4096);
  }

  /** The map file as stored text, and the name it goes by. */
  private fileOf(data: unknown): { json: string; name: string } {
    const problem = mapProblem(data);
    if (problem) throw new ApiError(400, 'bad-map', problem);
    const name = String((data as { name: string }).name).trim().slice(0, MAP_NAME_MAX) || 'Untitled map';
    return { json: JSON.stringify(data), name };
  }

  private visibilityOf(raw: unknown): Visibility | null {
    if (raw === undefined) return null;
    if (!VISIBILITIES.includes(raw as Visibility)) throw new ApiError(400, 'invalid', `Visibility is one of: ${VISIBILITIES.join(', ')}.`);
    return raw as Visibility;
  }

  private saving<T>(write: () => T): T {
    try {
      return write();
    } catch (e) {
      if (e instanceof StoreError) throw new ApiError(e.code === 'map-limit' ? 409 : 400, e.code, e.message);
      throw e;
    }
  }
}
