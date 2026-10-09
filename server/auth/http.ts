/** What the JSON endpoints (accounts, maps) have in common. */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A refusal with its status; `handleApi` turns it into `{ error: { code, message } }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/** The request's JSON body (an object), refused past `max` bytes. */
export async function readJsonBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new ApiError(413, 'too-big', 'That request is too big.');
    chunks.push(chunk as Buffer);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'invalid', 'Send JSON.');
}

/**
 * A browser sends Origin on every cross-site POST; it has to be the game's own (SameSite=Lax
 * already keeps the cookie off such requests - this refuses them outright). No Origin means
 * not a browser page: curl, tests, the admin's scripts.
 */
export function originOk(req: IncomingMessage, allowedOrigins: readonly string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (allowedOrigins.length > 0) return allowedOrigins.includes(origin);
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Runs `route`, answering an `ApiError` as JSON and any other failure as a 500 (logged, never thrown into the server). */
export async function handleApi(req: IncomingMessage, res: ServerResponse, log: (line: string) => void, route: () => Promise<void>): Promise<void> {
  try {
    await route();
  } catch (e) {
    if (e instanceof ApiError) return sendJson(res, e.status, { error: { code: e.code, message: e.message } }, e.headers);
    log(`${req.method} ${req.url} failed: ${(e as Error).stack ?? e}`);
    if (!res.headersSent) sendJson(res, 500, { error: { code: 'server', message: 'Something went wrong on the server.' } });
  }
}
