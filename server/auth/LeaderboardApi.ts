/**
 * The speedrun leaderboards over HTTP: one board per built-in course, one entry per player
 * (their best run). Reading is open to everyone; submitting needs a login.
 *
 *   GET  /api/leaderboard            the courses that have a board
 *   GET  /api/leaderboard/:course    top runs: ?limit=&offset=; `you` is the caller's own entry
 *   POST /api/leaderboard/:course    { time, splits } a finished run (log in)
 *
 * The run is taken on trust, checked only for shape (see `runProblem`): the clock is the
 * page's. Proving a run by replaying its inputs on the server is the way to close that.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BOARD_PAGE, runProblem, type BoardReply, type CourseInfo, type SubmitReply } from '../../src/net/leaderboard';
import { SPEEDRUN_MAPS } from '../../src/world/arenas';
import type { Store, User } from '../store/Store';
import { ApiError, handleApi, originOk, readJsonBody, sendJson } from './http';
import { RateLimiter } from './RateLimiter';

/** The built-in speedrun courses, in menu order. */
export const COURSES: CourseInfo[] = SPEEDRUN_MAPS.map((m) => ({
  id: m.id,
  name: m.name,
  checkpoints: m.pieces.filter((p) => p.type === 'checkpoint').length,
}));

export interface LeaderboardApiOptions {
  store: Store;
  allowedOrigins: string[];
  /** The logged-in user behind a request, if any. */
  userFor(req: IncomingMessage): User | null;
  log(line: string): void;
}

export class LeaderboardApi {
  private readonly opts: LeaderboardApiOptions;
  private readonly store: Store;
  private readonly submits = new RateLimiter(20, 60_000);

  constructor(options: LeaderboardApiOptions) {
    this.opts = options;
    this.store = options.store;
  }

  sweep(): void {
    this.submits.sweep();
  }

  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    return handleApi(req, res, this.opts.log, () => this.route(req, res, url));
  }

  private async route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const rest = url.pathname.slice('/api/leaderboard'.length).replace(/^\//, '');
    if (rest.includes('/')) throw new ApiError(404, 'not-found', 'No such endpoint.');

    if (method !== 'GET' && !originOk(req, this.opts.allowedOrigins)) throw new ApiError(403, 'origin', 'Requests must come from the game page.');

    if (rest === '') {
      if (method !== 'GET') throw new ApiError(405, 'method', 'Use GET.');
      return sendJson(res, 200, { courses: COURSES });
    }
    const course = COURSES.find((c) => c.id === rest);
    if (!course) throw new ApiError(404, 'no-such-course', 'There is no such course.');
    if (method === 'GET') return this.board(req, res, url, course);
    if (method === 'POST') return this.submit(req, res, course);
    throw new ApiError(405, 'method', 'Use GET or POST.');
  }

  private board(req: IncomingMessage, res: ServerResponse, url: URL, course: CourseInfo): void {
    const limit = Math.min(BOARD_PAGE, Math.max(1, Number(url.searchParams.get('limit')) || BOARD_PAGE));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const user = this.opts.userFor(req);
    const reply: BoardReply = {
      course,
      total: this.store.boardTotal(course.id),
      entries: this.store.boardTop(course.id, limit, offset),
      you: user ? this.store.boardEntryOf(course.id, user.id) : null,
    };
    sendJson(res, 200, reply);
  }

  private async submit(req: IncomingMessage, res: ServerResponse, course: CourseInfo): Promise<void> {
    const user = this.opts.userFor(req);
    if (!user) throw new ApiError(401, 'not-logged-in', 'Log in to put your time on the leaderboard.');
    if (!this.submits.allow(String(user.id))) throw new ApiError(429, 'rate-limited', 'Too many runs - wait a minute.', { 'retry-after': '60' });
    const body = await readJsonBody(req, 4096);
    const problem = runProblem(course.checkpoints, body.time, body.splits);
    if (problem) throw new ApiError(400, 'bad-run', problem);
    // Milliseconds are plenty (the clock shows hundredths).
    const ms = (s: number) => Math.round(s * 1000) / 1000;
    const { improved, entry } = this.store.submitRun(user.id, course.id, ms(body.time as number), (body.splits as number[]).map(ms));
    const reply: SubmitReply = { improved, you: entry, total: this.store.boardTotal(course.id) };
    sendJson(res, 200, reply);
  }
}
