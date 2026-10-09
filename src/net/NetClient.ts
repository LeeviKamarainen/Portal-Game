import { FLAGS } from '../core/Flags';
import { PROTOCOL_VERSION, WS_PATH, type ClientMessage, type ServerMessage } from './protocol';
import { DelayLine } from './DelayLine';

/** Where the game server is: `?server=`, then VITE_SERVER_URL, else /ws on this page's own origin. */
export function serverUrl(): string {
  const configured = FLAGS.server ?? (import.meta.env.VITE_SERVER_URL as string | undefined);
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${WS_PATH}`;
}

/**
 * One connection to the game server: says hello (version check) and then passes messages
 * both ways. Lobby and control messages are JSON; commands and snapshots are binary.
 */
export class NetClient {
  onMessage: (msg: ServerMessage) => void = () => {};
  onBinary: (data: ArrayBuffer) => void = () => {};
  /** The connection ended (`reason` in words), after `connect` had succeeded. */
  onClose: (reason: string) => void = () => {};
  private ws: WebSocket | null = null;
  private closing = false;
  /** `?lag=&jitter=&loss=`: a pretend bad connection, each way. */
  private readonly incoming = new DelayLine(FLAGS);
  private readonly outgoing = new DelayLine(FLAGS);

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Opens the connection; resolves once the server has welcomed this version of the game. */
  connect(url = serverUrl()): Promise<void> {
    this.close();
    this.closing = false;
    return new Promise((resolve, reject) => {
      let welcomed = false;
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.addEventListener('open', () => this.send({ type: 'hello', version: PROTOCOL_VERSION }));
      ws.addEventListener('message', (e) => {
        this.incoming.send(() => this.ws === ws && arrive(e.data));
      });
      const arrive = (data: unknown): void => {
        if (typeof data !== 'string') {
          if (welcomed && data instanceof ArrayBuffer) this.onBinary(data);
          return;
        }
        let msg: ServerMessage;
        try {
          msg = JSON.parse(data) as ServerMessage;
        } catch {
          return;
        }
        if (!welcomed) {
          if (msg.type === 'welcome') {
            welcomed = true;
            resolve();
          } else if (msg.type === 'error') {
            reject(new Error(msg.message));
            ws.close();
          }
          return;
        }
        this.onMessage(msg);
      };
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null;
        if (!welcomed) reject(new Error("Couldn't reach the game server."));
        else if (!this.closing) this.onClose('Lost the connection to the game server.');
      });
    });
  }

  send(msg: ClientMessage): void {
    this.transmit(JSON.stringify(msg));
  }

  sendBinary(data: Uint8Array<ArrayBuffer>): void {
    this.transmit(data);
  }

  private transmit(data: string | Uint8Array<ArrayBuffer>): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    this.outgoing.send(() => ws.readyState === WebSocket.OPEN && ws.send(data));
  }

  close(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = null;
  }
}
