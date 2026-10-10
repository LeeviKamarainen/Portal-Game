import { hasRight, type MapListing, type MapSummary, type PublicUser, type Visibility } from './accounts';
import { isTerminalEvent, type GenQuota, type GenStartRequest, type JobEvent } from './generate';

/** Something the server (or the network) refused, in words for the player. */
export class AccountError extends Error {
  /** The server's error code, or 'offline' when there was no game server to ask. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The game page's side of /api/...: who is logged in, logging in and out, and the player's
 * saved maps. The login itself is a cookie the browser keeps, so this only remembers who the
 * server last said we are. `onChange` says when that changed.
 */
export class AccountClient {
  onChange: () => void = () => {};
  /** The logged-in user, or null (a guest, or nobody has asked the server yet). */
  user: PublicUser | null = null;
  /** False once a request found no game server (the page is hosted without one, or it is down). */
  available = true;

  /** Asks the server who we are (call at start-up, and after anything that might have changed it). */
  async refresh(): Promise<void> {
    try {
      const reply = await this.request('GET', '/api/me');
      this.set((reply.user as PublicUser | null) ?? null);
    } catch {
      this.set(null);
    }
  }

  async register(name: string, password: string): Promise<void> {
    this.set(((await this.request('POST', '/api/register', { name, password })).user as PublicUser) ?? null);
  }

  async login(name: string, password: string): Promise<void> {
    this.set(((await this.request('POST', '/api/login', { name, password })).user as PublicUser) ?? null);
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/api/logout');
    } finally {
      this.set(null);
    }
  }

  async changePassword(current: string, next: string): Promise<void> {
    await this.request('POST', '/api/password', { current, next });
  }

  async listMine(): Promise<MapSummary[]> {
    return (await this.request('GET', '/api/maps')).maps as MapSummary[];
  }

  async listPublic(): Promise<MapSummary[]> {
    return (await this.request('GET', '/api/maps/public')).maps as MapSummary[];
  }

  async getMap(id: string): Promise<MapListing> {
    return (await this.request('GET', `/api/maps/${encodeURIComponent(id)}`)).map as MapListing;
  }

  async saveMap(data: unknown, visibility?: Visibility): Promise<MapSummary> {
    return (await this.request('POST', '/api/maps', { data, visibility })).map as MapSummary;
  }

  async updateMap(id: string, changes: { data?: unknown; visibility?: Visibility }): Promise<MapSummary> {
    return (await this.request('PUT', `/api/maps/${encodeURIComponent(id)}`, changes)).map as MapSummary;
  }

  async deleteMap(id: string): Promise<void> {
    await this.request('DELETE', `/api/maps/${encodeURIComponent(id)}`);
  }

  // ---- the map generator (server/gen/, src/net/generate.ts)

  /** The logged-in user has the map generator right (the server decides again on every request). */
  get canGenerate(): boolean {
    return this.user !== null && hasRight(this.user, 'generate-maps');
  }

  async generationQuota(): Promise<GenQuota> {
    return (await this.request('GET', '/api/generate/quota')) as GenQuota;
  }

  /** Starts a generation; watch it with `watchGeneration`. */
  async startGeneration(body: GenStartRequest): Promise<{ jobId: string; quota: GenQuota }> {
    return (await this.request('POST', '/api/generate', body)) as { jobId: string; quota: GenQuota };
  }

  async cancelGeneration(jobId: string): Promise<void> {
    await this.request('DELETE', `/api/generate/${encodeURIComponent(jobId)}`);
  }

  /**
   * Delivers a generation's events in order (everything so far first, then live) until it
   * ends. The browser reconnects by itself after a dropped connection and the server resumes
   * from the last event it was sent. `onLost` is called when the stream cannot be had at all
   * (the job is gone, or the server is). Returns the way to stop watching.
   */
  watchGeneration(jobId: string, onEvent: (event: JobEvent) => void, onLost: (message: string) => void): () => void {
    const source = new EventSource(`/api/generate/${encodeURIComponent(jobId)}/events`);
    let closed = false;
    const close = () => {
      closed = true;
      source.close();
    };
    for (const type of ['step', 'start', 'piece', 'map', 'done', 'error'] as const) {
      source.addEventListener(type, (m) => {
        let event: JobEvent;
        try {
          event = JSON.parse((m as MessageEvent<string>).data) as JobEvent;
        } catch {
          // The browser's own connection-error event is also called "error" and has no data.
          return;
        }
        if (closed) return;
        if (isTerminalEvent(event)) close();
        onEvent(event);
      });
    }
    source.onerror = () => {
      if (closed || source.readyState !== EventSource.CLOSED) return;
      close();
      onLost('Lost the connection to the map generator.');
    };
    return close;
  }

  private set(user: PublicUser | null): void {
    this.user = user;
    this.onChange();
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      this.available = false;
      throw new AccountError('offline', "Can't reach the game server.");
    }
    let reply: Record<string, any> | null = null;
    try {
      reply = (await res.json()) as Record<string, any>;
    } catch {
      // Not JSON: a static host answering with its own page, or a proxy with nothing behind it.
    }
    if (!reply) {
      this.available = false;
      throw new AccountError('offline', "There's no game server here: accounts need one.");
    }
    this.available = true;
    if (!res.ok) throw new AccountError(reply.error?.code ?? 'error', reply.error?.message ?? 'Something went wrong.');
    return reply;
  }
}
