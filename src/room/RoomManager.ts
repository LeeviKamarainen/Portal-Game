import {
  BOT_DIFFICULTIES,
  CODE_LENGTH,
  CODE_LETTERS,
  PROTOCOL_VERSION,
  cleanName,
  cleanSkin,
  normalizeCode,
  type BotDifficulty,
  type ClientMessage,
  type MapChoice,
} from '../net/protocol';
import { checkMap } from './mapCheck';
import { Room, RoomError, type Conn, type Member } from './Room';

interface Seat {
  room: Room;
  member: Member;
}

/**
 * Every room on the server, and who is in which. Takes each client's messages, checks them
 * (anything a client sends may be malformed or malicious) and turns them into room changes.
 */
export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private readonly seats = new Map<Conn, Seat>();
  private readonly greeted = new WeakSet<Conn>();
  /** Clients with a slow request (a map being built) in flight: one at a time each. */
  private readonly busy = new WeakSet<Conn>();
  private readonly log: (line: string) => void;

  constructor(log: (line: string) => void = () => {}) {
    this.log = log;
  }

  /** A message from `conn` (already parsed from JSON, otherwise unchecked). */
  async handle(conn: Conn, raw: unknown): Promise<void> {
    const msg = raw as ClientMessage;
    try {
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') throw new RoomError('bad-message', 'Unreadable message.');
      if (msg.type === 'hello') {
        if (msg.version !== PROTOCOL_VERSION) {
          throw new RoomError('version', 'The game has been updated - reload the page to play online.');
        }
        this.greeted.add(conn);
        conn.send({ type: 'welcome', version: PROTOCOL_VERSION });
        return;
      }
      if (!this.greeted.has(conn)) throw new RoomError('version', 'Say hello first.');
      if (msg.type === 'ping') {
        conn.send({ type: 'pong', t: Number(msg.t) || 0 });
        return;
      }
      if (this.busy.has(conn)) throw new RoomError('busy', 'Still working on your last request.');
      this.busy.add(conn);
      try {
        await this.dispatch(conn, msg);
      } finally {
        this.busy.delete(conn);
      }
    } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      conn.send({ type: 'error', code: e.code, message: e.message });
    }
  }

  private async dispatch(conn: Conn, msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case 'create': {
        this.disconnect(conn);
        const map = await checkMap({ kind: 'builtin', id: 'highwire' });
        if (typeof map === 'string') throw new Error(map);
        const room = new Room(this.newCode(), map, this.log);
        this.rooms.set(room.code, room);
        this.log(`room ${room.code}: created`);
        this.seat(conn, room, conn.user?.name ?? cleanName(msg.name), cleanSkin(msg.skin));
        return;
      }
      case 'join': {
        const code = normalizeCode(String(msg.code ?? ''));
        const room = code ? this.rooms.get(code) : undefined;
        if (!room) throw new RoomError('no-room', `There is no room ${code ?? String(msg.code ?? '').slice(0, 8)}. Check the code.`);
        const seat = this.seats.get(conn);
        if (seat?.room === room) return;
        this.disconnect(conn);
        // Coming back (a dropped connection, a reloaded page): the same place, mid-match too.
        const back = room.memberByToken(msg.token);
        if (back) {
          for (const [c, s] of this.seats) if (s.member === back) this.seats.delete(c);
          room.rejoin(back, conn);
          this.seats.set(conn, { room, member: back });
          conn.send({ type: 'joined', token: back.token, lobby: room.lobbyFor(back) });
          room.broadcast();
          room.welcome(back);
          return;
        }
        this.seat(conn, room, conn.user?.name ?? cleanName(msg.name), cleanSkin(msg.skin));
        return;
      }
      case 'leave':
        this.disconnect(conn);
        return;
      case 'setMap': {
        const seat = this.seatOf(conn);
        if (seat.member !== seat.room.host) throw new RoomError('not-host', 'Only the host can change the map.');
        const choice = msg.map as MapChoice;
        if (!choice || (choice.kind !== 'builtin' && choice.kind !== 'custom')) throw new RoomError('bad-message', 'No map in that message.');
        const map = await checkMap(choice);
        if (typeof map === 'string') throw new RoomError('bad-map', map);
        // Left (or lost the host) while it built.
        if (this.seats.get(conn) !== seat) return;
        seat.room.setMap(seat.member, map);
        seat.room.broadcast();
        return;
      }
      case 'setBots': {
        const seat = this.seatOf(conn);
        const difficulty: BotDifficulty = BOT_DIFFICULTIES.includes(msg.difficulty) ? msg.difficulty : 'normal';
        seat.room.setBots(seat.member, Number(msg.count) || 0, difficulty);
        seat.room.broadcast();
        return;
      }
      case 'start': {
        const seat = this.seatOf(conn);
        await seat.room.start(seat.member);
        return;
      }
      case 'loaded': {
        const seat = this.seatOf(conn);
        seat.room.loaded(seat.member);
        return;
      }
      default:
        throw new RoomError('bad-message', 'Unknown message.');
    }
  }

  /** A binary message from `conn`: a player's commands (unchecked bytes). */
  handleBinary(conn: Conn, data: Uint8Array): void {
    const seat = this.seats.get(conn);
    if (seat) seat.room.input(seat.member, data);
  }

  /** One simulation step for every room. */
  tick(dt: number): void {
    for (const room of [...this.rooms.values()]) {
      try {
        room.tick(dt);
        // Everyone who lost their connection stayed away too long.
        if (room.empty) this.close(room);
      } catch (e) {
        // One broken match must not stop every other room.
        this.log(`room ${room.code}: step failed, closing it: ${(e as Error).stack ?? e}`);
        for (const m of [...room.members]) {
          m.conn.send({ type: 'error', code: 'bad-message', message: 'The match stopped on the server.' });
          this.disconnect(m.conn);
        }
      }
    }
  }

  private seat(conn: Conn, room: Room, name: string, skin: string): void {
    const member = room.add(conn, name, skin);
    this.seats.set(conn, { room, member });
    conn.send({ type: 'joined', token: member.token, lobby: room.lobbyFor(member) });
    room.broadcast();
    room.welcome(member);
  }

  private seatOf(conn: Conn): Seat {
    const seat = this.seats.get(conn);
    if (!seat) throw new RoomError('not-in-room', "You're not in a room.");
    return seat;
  }

  /** `conn` leaves whatever room it is in for good (closing the room if it was the last one there). */
  disconnect(conn: Conn): void {
    const seat = this.seats.get(conn);
    if (!seat) return;
    this.seats.delete(conn);
    seat.room.remove(seat.member);
    this.afterLeaving(seat.room);
  }

  /** `conn`'s connection is gone: mid-match its player keeps their place a while (Room.drop). */
  connectionLost(conn: Conn): void {
    const seat = this.seats.get(conn);
    if (!seat) return;
    this.seats.delete(conn);
    seat.room.drop(seat.member);
    this.afterLeaving(seat.room);
  }

  private afterLeaving(room: Room): void {
    if (room.empty) this.close(room);
    else room.broadcast();
  }

  private close(room: Room): void {
    room.dispose();
    this.rooms.delete(room.code);
    this.log(`room ${room.code}: closed`);
  }

  private newCode(): string {
    const bytes = new Uint8Array(CODE_LENGTH);
    for (;;) {
      globalThis.crypto.getRandomValues(bytes);
      const code = Array.from(bytes, (b) => CODE_LETTERS[b % CODE_LETTERS.length]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }

  dispose(): void {
    for (const room of this.rooms.values()) room.dispose();
    this.rooms.clear();
    this.seats.clear();
  }
}
