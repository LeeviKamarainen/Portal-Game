/**
 * The game server: serves the built game (dist/), answers /healthz, and runs the rooms over
 * a WebSocket on /ws (docs/online-multiplayer-plan.md).
 *
 *   npm run server          dev, restarts on changes (the Vite dev server proxies /ws here)
 *   PORT=8787               port to listen on
 *   ALLOWED_ORIGINS=a,b     pages allowed to connect (default: any - fine for dev)
 *   DB_PATH=data/game.db    accounts and saved maps (a SQLite file; its folder is created)
 *   COOKIE_SECURE=1         mark the login cookie Secure: set it when the site is served over https
 *   TRUST_PROXY=1           behind one reverse proxy (Caddy): take the client address from X-Forwarded-For
 *   REGISTRATION=closed     no new accounts (the admin tool still makes them)
 *   ANTHROPIC_API_KEY=...   turns on the AI map generator (/api/generate); without it the endpoint answers 503
 *                           (limits and model ids: server/gen/config.ts, GEN_* variables)
 *
 * Accounts: /api/... (server/auth/AuthApi.ts), saved maps: /api/maps (MapApi.ts), the map generator:
 * /api/generate (server/gen/GenerateApi.ts); the admin tool is server/admin.ts.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomManager } from '../src/room/RoomManager';
import type { Conn } from '../src/room/Room';
import { MAP_JSON_MAX, TICK_RATE, WS_PATH, type ServerMessage } from '../src/net/protocol';
import { TickLoop } from './TickLoop';
import { AuthApi } from './auth/AuthApi';
import { MapApi } from './auth/MapApi';
import { SqliteStore } from './store/SqliteStore';
import type { Store } from './store/Store';
import { CheckWorker } from './gen/checkPool';
import { loadConfig, type GenConfig } from './gen/config';
import { GenerateApi } from './gen/GenerateApi';
import { JobManager } from './gen/JobManager';
import { AnthropicLlm, type Llm } from './gen/llm';

/** Rooms created or joined per address per minute. */
const JOIN_LIMIT = 30;
/** Dead connections are dropped after missing a heartbeat. */
const HEARTBEAT_MS = 15000;
/** How often busy rooms report their bandwidth and step time to the log. */
const STATS_MS = 30000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

export interface ServerOptions {
  port?: number;
  /** Where the built game is (default: dist/ next to the project root); missing = API only. */
  staticDir?: string;
  /** Page origins allowed to open a WebSocket; empty = any. */
  allowedOrigins?: string[];
  /** The SQLite file for accounts and maps (default ':memory:': gone when the server stops). */
  dbPath?: string;
  /** Mark the login cookie Secure (the site is https). */
  secureCookies?: boolean;
  /** Believe X-Forwarded-For (one proxy in front). */
  trustProxy?: boolean;
  /** Whether new accounts may register (default true). */
  registrationOpen?: boolean;
  /**
   * The AI map generator. `llm` makes the model client for one generation (null or absent: the
   * generator is off); tests pass a fake. `check` replaces the worker-thread map check.
   */
  generator?: { llm: (() => Llm) | null; config?: GenConfig; check?: JobManagerCheck };
  log?: (line: string) => void;
}

type JobManagerCheck = NonNullable<ConstructorParameters<typeof JobManager>[0]['check']>;

export interface RunningServer {
  port: number;
  rooms: RoomManager;
  store: Store;
  close(): Promise<void>;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`));
  const staticDir = resolve(options.staticDir ?? fileURLToPath(new URL('../dist', import.meta.url)));
  const origins = options.allowedOrigins ?? [];
  const rooms = new RoomManager(log);
  const joins = new Map<string, number[]>();
  const store = new SqliteStore(options.dbPath ?? ':memory:');

  /** Who is asking: the socket's peer, or the proxy's last hop when we sit behind one. */
  function addressOf(req: IncomingMessage): string {
    if (options.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',');
      const last = forwarded[forwarded.length - 1].trim();
      if (last) return last;
    }
    return req.socket.remoteAddress ?? '?';
  }

  const auth = new AuthApi({
    store,
    allowedOrigins: origins,
    secureCookies: options.secureCookies ?? false,
    registrationOpen: options.registrationOpen ?? true,
    addressOf,
    log,
  });
  const maps = new MapApi({ store, allowedOrigins: origins, userFor: (req) => auth.userFor(req), log });
  // Generated maps are built to check them, which takes up to ~100 ms: on a worker thread, not the one stepping the rooms.
  const checker = options.generator?.check ? null : new CheckWorker(log);
  const jobs = new JobManager({
    store,
    llm: options.generator?.llm ?? null,
    config: options.generator?.config ?? loadConfig(),
    check: options.generator?.check ?? checker!.check,
    log,
  });
  const generate = new GenerateApi({ jobs, allowedOrigins: origins, userFor: (req) => auth.userFor(req), log });
  const housekeeping = setInterval(() => {
    auth.sweep();
    maps.sweep();
    jobs.sweep();
  }, 600_000);

  const http: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size }));
        return;
      }
      if (url.pathname === '/api/maps' || url.pathname.startsWith('/api/maps/')) {
        await maps.handle(req, res, url);
        return;
      }
      if (url.pathname === '/api/generate' || url.pathname.startsWith('/api/generate/')) {
        await generate.handle(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await auth.handle(req, res, url.pathname);
        return;
      }
      // The built game, for a single-origin deploy; anything unknown falls back to the page.
      let file = normalize(join(staticDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(staticDir + sep) && file !== staticDir) {
        res.writeHead(403).end();
        return;
      }
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        try {
          const body = await readFile(join(staticDir, 'index.html'));
          res.writeHead(200, { 'content-type': TYPES['.html'] }).end(body);
        } catch {
          res.writeHead(404, { 'content-type': 'text/plain' }).end('Portal Arena game server. Build the game (npm run build) to serve it from here.');
        }
      }
    })();
  });

  // Custom maps travel in a message, so frames may be up to a map's size.
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAP_JSON_MAX + 4096 });
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin ?? '';
    if (url.pathname !== WS_PATH || (origins.length > 0 && !origins.includes(origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    // A cookie that doesn't check out just makes a guest: rooms stay open to everyone.
    const user = auth.userFor(req);
    wss.handleUpgrade(req, socket, head, (ws) => connected(ws, req, user ? { id: user.id, name: user.name } : undefined));
  });

  const loop = new TickLoop(1 / TICK_RATE, (dt) => rooms.tick(dt));
  loop.start();
  let statsAt = performance.now();
  const stats = setInterval(() => {
    const now = performance.now();
    const seconds = (now - statsAt) / 1000;
    statsAt = now;
    for (const room of rooms.rooms.values()) {
      if (room.bytesOut === 0) continue;
      const perPlayer = room.bytesOut / seconds / Math.max(1, room.members.length) / 1024;
      log(`room ${room.code}: ${perPlayer.toFixed(1)} KB/s to each player · ${loop.msPerStep.toFixed(2)} ms a step for all rooms`);
      room.bytesOut = 0;
    }
  }, STATS_MS);

  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  /** Whether `address` may create or join another room right now. */
  function allowJoin(address: string): boolean {
    const now = Date.now();
    const recent = (joins.get(address) ?? []).filter((t) => now - t < 60000);
    if (recent.length >= JOIN_LIMIT) return false;
    recent.push(now);
    joins.set(address, recent);
    return true;
  }

  function connected(ws: WebSocket, req: IncomingMessage, user: Conn['user']): void {
    const address = addressOf(req);
    log(`connection from ${user ? `account ${user.name}` : 'a guest'}`);
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    const conn: Conn = {
      user,
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      sendBinary: (data: Uint8Array) => {
        if (ws.readyState === ws.OPEN) ws.send(data, { binary: true });
      },
      close: () => ws.close(),
    };
    // One message at a time per client, in order.
    let queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // Commands, many a second: straight to the room, not through the queue below.
        const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
        if (bytes.length <= 256) rooms.handleBinary(conn, new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length));
        return;
      }
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        conn.send({ type: 'error', code: 'bad-message', message: 'Unreadable message.' });
        return;
      }
      const type = (msg as { type?: unknown })?.type;
      if ((type === 'create' || type === 'join') && !allowJoin(address)) {
        conn.send({ type: 'error', code: 'busy', message: 'Too many rooms joined - wait a minute.' });
        return;
      }
      queue = queue.then(() => rooms.handle(conn, msg)).catch((e) => log(`error handling ${String(type)}: ${(e as Error).stack ?? e}`));
    });
    ws.on('close', () => {
      queue = queue.then(() => rooms.connectionLost(conn));
    });
  }

  await new Promise<void>((done) => http.listen(options.port ?? 8787, done));
  const address = http.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 8787);
  log(`game server on http://localhost:${port} (rooms on ${WS_PATH})`);

  return {
    port,
    rooms,
    store,
    close: async () => {
      clearInterval(heartbeat);
      clearInterval(stats);
      clearInterval(housekeeping);
      await jobs.shutdown();
      await checker?.dispose();
      loop.stop();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      rooms.dispose();
      await new Promise<void>((done) => http.close(() => done()));
      store.close();
    },
  };
}

// Run directly (not imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const origins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  void startServer({
    port: Number(process.env.PORT) || 8787,
    allowedOrigins: origins,
    dbPath: process.env.DB_PATH || fileURLToPath(new URL('../data/game.db', import.meta.url)),
    secureCookies: process.env.COOKIE_SECURE === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
    registrationOpen: process.env.REGISTRATION !== 'closed',
    generator: { llm: process.env.ANTHROPIC_API_KEY ? () => new AnthropicLlm() : null },
  });
}
