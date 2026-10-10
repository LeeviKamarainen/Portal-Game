/**
 * The map generator over HTTP (docs/llm-map-generation-plan.md). Logged-in users with the
 * `generate-maps` right describe a map and watch it being built:
 *
 *   POST   /api/generate              { prompt, kind?, size?, baseMap? }  -> 202 { jobId, quota }
 *                                     (baseMap: change that map instead of designing a new one)
 *   GET    /api/generate/quota        what you may do today: { used, limit, allowed, enabled }
 *   GET    /api/generate/:id          the job's state and, once finished, its outcome
 *   GET    /api/generate/:id/events   server-sent events: step, start, piece, map, then done or error.
 *                                     Reconnect with Last-Event-ID (or ?after=) to catch up.
 *   DELETE /api/generate/:id          cancel
 *
 * Errors are `{ error: { code, message } }` like the rest of /api.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from '../store/Store';
import { ApiError, handleApi, originOk, readJsonBody, sendJson } from '../auth/http';
import { isTerminal, type Job, type JobEvent, type JobManager, type StoredEvent } from './JobManager';

const ID_PATTERN = /^[A-Za-z0-9_-]{6,32}$/;
const HEARTBEAT_MS = 15_000;
/** A request is a short description, or with a refinement also the map being changed (150 pieces is about 30 KB). */
const BODY_MAX = 128 * 1024;

export interface GenerateApiOptions {
  jobs: JobManager;
  allowedOrigins: string[];
  userFor(req: IncomingMessage): User | null;
  log(line: string): void;
}

export class GenerateApi {
  private readonly opts: GenerateApiOptions;
  private readonly jobs: JobManager;

  constructor(options: GenerateApiOptions) {
    this.opts = options;
    this.jobs = options.jobs;
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleApi(req, res, this.opts.log, () => this.route(req, res, url));
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.slice('/api/generate'.length).split('/').filter(Boolean);
    if (method !== 'GET' && !originOk(req, this.opts.allowedOrigins)) throw new ApiError(403, 'origin', 'Requests must come from the game page.');
    const user = this.login(req);

    if (parts.length === 0) {
      if (method !== 'POST') throw new ApiError(405, 'method', 'Use POST.');
      const job = this.jobs.start(user, await readJsonBody(req, BODY_MAX));
      return sendJson(res, 202, { jobId: job.id, quota: this.jobs.quota(user) });
    }
    if (parts[0] === 'quota' && parts.length === 1) {
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      return sendJson(res, 200, this.jobs.quota(user));
    }
    const id = parts[0];
    if (!ID_PATTERN.test(id) || parts.length > 2) throw new ApiError(404, 'not-found', 'No such endpoint.');
    const job = this.jobs.find(user, id);
    if (parts[1] === 'events') {
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      return this.stream(req, res, url, job);
    }
    if (parts.length === 2) throw new ApiError(404, 'not-found', 'No such endpoint.');
    if (method === 'DELETE') {
      this.jobs.cancel(user, id);
      return sendJson(res, 200, { ok: true });
    }
    if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET or DELETE.');
    const last = job.events[job.events.length - 1]?.event;
    sendJson(res, 200, {
      id: job.id,
      status: job.status,
      prompt: job.request.prompt,
      outcome: last?.type === 'done' ? last.outcome : null,
      error: last?.type === 'error' ? { code: last.code, message: last.message } : null,
    });
  }

  private login(req: IncomingMessage): User {
    const user = this.opts.userFor(req);
    if (!user) throw new ApiError(401, 'not-logged-in', 'Log in first.');
    return user;
  }

  /** Server-sent events: everything so far (after `Last-Event-ID`), then live, ending after the last event. */
  private stream(req: IncomingMessage, res: ServerResponse, url: URL, job: Job): void {
    const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after')) || 0;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      // Tell a reverse proxy (Fly's, nginx) not to hold the stream back.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    let stop: (() => void) | null = null;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      stop?.();
      res.end();
    };
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const send = ({ seq, event }: StoredEvent) => {
      if (closed) return;
      res.write(`id: ${seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event satisfies JobEvent)}\n\n`);
      if (isTerminal(event)) finish();
    };
    stop = job.subscribe(after, send);
    // Already caught up on a finished job (a reconnect past its last event): nothing more will come.
    const last = job.events[job.events.length - 1];
    if (last && isTerminal(last.event)) finish();
    if (closed) stop();
    req.on('close', finish);
  }
}
