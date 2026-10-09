import { NetClient } from './NetClient';
import { REJOIN_SECONDS, normalizeCode, type BotDifficulty, type LobbyState, type MapChoice, type ServerMessage } from './protocol';

/** What the Online and Lobby pages show. */
export interface OnlineView {
  /**
   * idle: not connected; busy: connecting or waiting on the server; room: in a room;
   * reconnecting: the connection dropped and we are trying to get our place back.
   */
  status: 'idle' | 'busy' | 'room' | 'reconnecting';
  lobby: LobbyState | null;
  /** The last thing that went wrong, in words, or ''. */
  error: string;
  /** Round trip to the server in ms, once measured. */
  ping: number | null;
  /** The host started: what to load. */
  match: Extract<ServerMessage, { type: 'matchStart' }> | null;
}

const TOKEN_KEY = 'portal-arena.room-token';
const PING_EVERY = 2000;
/** After a dropped connection, a fresh try this often (ms) until the server's grace runs out. */
const RECONNECT_EVERY = 2000;

/**
 * The client side of online rooms: connects to the game server when you create or join one,
 * keeps the lobby the server sends, and passes the host's choices on. The menu draws
 * `view()`; `onChange` says when to redraw.
 */
export class OnlineLobby {
  onChange: () => void = () => {};
  /** The host started a match: load it (then call `loaded`). */
  onMatch: (msg: Extract<ServerMessage, { type: 'matchStart' }>) => void = () => {};
  /** Messages about the match in play (countdown, go, events, notices) and its snapshots. */
  onMatchMessage: (msg: ServerMessage) => void = () => {};
  onSnapshot: (data: ArrayBuffer) => void = () => {};
  private readonly client = new NetClient();
  private state: OnlineView = { status: 'idle', lobby: null, error: '', ping: null, match: null };
  private pinger: ReturnType<typeof setInterval> | null = null;
  /** Who we are in rooms (for coming back after a dropped connection). */
  private name = '';
  private skin = 'a';
  /** Bumped to call off a reconnect in progress. */
  private reconnects = 0;

  constructor() {
    this.client.onMessage = (msg) => this.receive(msg);
    this.client.onBinary = (data) => this.onSnapshot(data);
    this.client.onClose = (reason) => {
      this.stopPinging();
      if (this.state.status === 'room' && this.state.lobby) void this.reconnect(this.state.lobby.code, reason);
      else this.update({ status: 'idle', lobby: null, match: null, error: reason });
    };
  }

  view(): OnlineView {
    return this.state;
  }

  async create(name: string, skin: string): Promise<void> {
    this.name = name;
    this.skin = skin;
    if (await this.ensureConnected()) this.client.send({ type: 'create', name, skin });
  }

  async join(code: string, name: string, skin: string): Promise<void> {
    if (!code.trim()) {
      this.update({ error: 'Type the room code first.' });
      return;
    }
    this.name = name;
    this.skin = skin;
    // Back to a room this tab was in (a reloaded page): the server keeps our place a while.
    if (await this.ensureConnected()) this.client.send({ type: 'join', code, name, skin, token: this.tokenFor(code) });
  }

  /** The token this tab was given for room `code`, if any. */
  private tokenFor(code: string): string | undefined {
    try {
      const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as { code: string; token: string } | null;
      return saved && saved.code === normalizeCode(code) ? saved.token : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The connection dropped while in room `code`: keep trying to get back in (with our token,
   * so a match in progress keeps our place and score) until the server would have given it
   * away. `reason` is shown if that fails.
   */
  private async reconnect(code: string, reason: string): Promise<void> {
    const ticket = ++this.reconnects;
    this.update({ status: 'reconnecting', error: '' });
    const until = performance.now() + REJOIN_SECONDS * 1000;
    while (performance.now() < until) {
      try {
        await this.client.connect();
        if (ticket !== this.reconnects) return;
        this.startPinging();
        // 'joined' (or an error) takes it from here.
        this.client.send({ type: 'join', code, name: this.name, skin: this.skin, token: this.tokenFor(code) });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, RECONNECT_EVERY));
        if (ticket !== this.reconnects) return;
      }
    }
    this.update({ status: 'idle', lobby: null, match: null, error: reason });
  }

  leave(): void {
    this.reconnects++;
    this.stopPinging();
    this.client.close();
    this.update({ status: 'idle', lobby: null, match: null, error: '', ping: null });
  }

  setMap(map: MapChoice): void {
    this.update({ error: '' });
    this.client.send({ type: 'setMap', map });
  }

  setBots(count: number, difficulty: BotDifficulty): void {
    this.client.send({ type: 'setBots', count, difficulty });
  }

  start(): void {
    this.update({ error: '' });
    this.client.send({ type: 'start' });
  }

  /** This screen has the match loaded and drawn: ready for the countdown. */
  loaded(): void {
    this.client.send({ type: 'loaded' });
  }

  /** This step's commands for the server. */
  sendBinary(data: Uint8Array<ArrayBuffer>): void {
    this.client.sendBinary(data);
  }

  /** Shows a problem found on this side (a map file that can't be used). */
  showError(error: string): void {
    this.update({ error });
  }

  private async ensureConnected(): Promise<boolean> {
    if (this.client.connected) {
      this.update({ error: '' });
      return true;
    }
    this.update({ status: 'busy', error: '' });
    try {
      await this.client.connect();
    } catch (e) {
      this.update({ status: 'idle', error: (e as Error).message });
      return false;
    }
    this.startPinging();
    return true;
  }

  private receive(msg: ServerMessage): void {
    switch (msg.type) {
      case 'joined':
        try {
          sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ code: msg.lobby.code, token: msg.token }));
        } catch {
          // No storage: a reloaded page can't get its place back (a dropped connection still can, see reconnect).
        }
        this.update({ status: 'room', lobby: msg.lobby, error: '', match: null });
        break;
      case 'lobby':
        this.update({ lobby: msg.lobby, match: msg.lobby.phase === 'lobby' ? null : this.state.match });
        break;
      case 'matchStart':
        this.update({ match: msg });
        this.onMatch(msg);
        break;
      case 'countdown':
      case 'go':
      case 'events':
      case 'notice':
      case 'playerJoined':
        this.onMatchMessage(msg);
        break;
      case 'error':
        // Couldn't get back in (the room has gone): out, saying why.
        if (this.state.status === 'reconnecting') {
          this.reconnects++;
          this.leaveQuietly();
          this.update({ status: 'idle', lobby: null, match: null, error: msg.message });
          break;
        }
        // Before you're in a room, a refusal leaves you where you were.
        this.update({ error: msg.message, status: this.state.lobby ? 'room' : 'idle' });
        if (!this.state.lobby) this.leaveQuietly();
        break;
      case 'pong':
        this.update({ ping: Math.round(performance.now() - msg.t) });
        break;
      default:
        break;
    }
  }

  /** Drops a connection that never made it into a room, keeping the error on show. */
  private leaveQuietly(): void {
    this.stopPinging();
    this.client.close();
  }

  private startPinging(): void {
    this.stopPinging();
    const ping = () => this.client.send({ type: 'ping', t: performance.now() });
    ping();
    this.pinger = setInterval(ping, PING_EVERY);
  }

  private stopPinging(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }

  private update(patch: Partial<OnlineView>): void {
    this.state = { ...this.state, ...patch };
    this.onChange();
  }
}
