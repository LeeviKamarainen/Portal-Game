import type { NetSession } from '../net/NetSession';
import { SNAPSHOT_EVERY, TICK_RATE } from '../net/protocol';

const CSS = `
.netpanel { position:absolute; right:18px; top:62px; padding:8px 10px 9px; border-radius:6px; pointer-events:none;
  background:rgba(10,12,18,0.72); border:1px solid rgba(255,255,255,0.14); color:#e8edf5;
  font: 11px/1.5 ui-monospace, monospace; white-space:pre; display:none; }
.netpanel canvas { display:block; margin-top:6px; }
.netpanel .why { opacity:0.7; }
`;

/** Graph size, CSS pixels: one bar per snapshot in the session's trace. */
const WIDTH = 240;
const HEIGHT = 48;
/** Arrival gaps this long fill the graph (ms). */
const GRAPH_MS = 150;
/** Redrawn this often (s): numbers that flicker every frame can't be read. */
const REFRESH = 0.1;

/**
 * `?net=1` online: how the connection is doing, under the ping in the corner - bandwidth,
 * how far behind everyone else is drawn, your clock and command queue, corrections and
 * what set off the latest ones, and a graph of the snapshots' arrival gaps (a bar a
 * snapshot, the line at the server's send interval, red marks where your player was
 * corrected).
 */
export class NetOverlay {
  private readonly root: HTMLDivElement;
  private readonly text: HTMLDivElement;
  private readonly why: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private wait = 0;
  /** When each correction was counted (ms), over the last minute. */
  private readonly fixes: number[] = [];
  private counted = 0;
  private session: NetSession | null = null;

  constructor(container: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'netpanel shadow';
    this.text = document.createElement('div');
    this.why = document.createElement('div');
    this.why.className = 'why';
    this.canvas = document.createElement('canvas');
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = WIDTH * ratio;
    this.canvas.height = HEIGHT * ratio;
    this.canvas.style.width = `${WIDTH}px`;
    this.canvas.style.height = `${HEIGHT}px`;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(ratio, ratio);
    this.root.append(this.text, this.canvas, this.why);
    container.appendChild(this.root);
  }

  /** Each frame of an online match (`net` null outside one: hidden). */
  update(dt: number, net: NetSession | null, ping: number | null): void {
    this.root.style.display = net ? 'block' : 'none';
    if (!net) {
      this.session = null;
      return;
    }
    if (net !== this.session) {
      this.session = net;
      this.fixes.length = 0;
      this.counted = net.stats.corrections;
      this.wait = 0;
    }
    this.wait -= dt;
    if (this.wait > 0) return;
    this.wait = REFRESH;

    const s = net.stats;
    const now = performance.now();
    for (; this.counted < s.corrections; this.counted++) this.fixes.push(now);
    while (this.fixes.length > 0 && now - this.fixes[0] > 60_000) this.fixes.shift();
    const trace = net.trace;
    const size = trace.length > 0 ? trace.reduce((a, t) => a + t.bytes, 0) / trace.length : 0;
    const step = 1000 / TICK_RATE;
    this.text.textContent = [
      `PING   ${ping === null ? '…' : `${ping} ms`}`,
      `DOWN   ${(s.rateIn / 1024).toFixed(1)} KB/s · ${size.toFixed(0)} B a snapshot`,
      `UP     ${(s.rateOut / 1024).toFixed(1)} KB/s`,
      `DRAWN  ${(s.delay * step).toFixed(0)} ms behind · ${s.late} late`,
      `QUEUE  ${s.queue.toFixed(1)} on server · clock ×${s.timeScale.toFixed(3)}`,
      `FIXES  ${s.corrections} (${this.fixes.length} last min) · ${s.shotMisses} shot misses`,
    ].join('\n');
    this.why.textContent = net.why.slice(-3).join('\n');
    this.draw(net, step * SNAPSHOT_EVERY);
  }

  private draw(net: NetSession, interval: number): void {
    const g = this.ctx;
    g.clearRect(0, 0, WIDTH, HEIGHT);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, 0, WIDTH, HEIGHT);
    const trace = net.trace;
    const bar = WIDTH / 120;
    const x0 = WIDTH - trace.length * bar;
    trace.forEach((t, i) => {
      const h = Math.min(1, t.gap / GRAPH_MS) * (HEIGHT - 4);
      g.fillStyle = t.gap > interval * 3 ? '#ff6a4a' : t.gap > interval * 1.6 ? '#ffd23a' : '#7fa8d8';
      g.fillRect(x0 + i * bar, HEIGHT - h, Math.max(1, bar - 0.5), h);
      if (t.fixed) {
        g.fillStyle = '#ff3a6a';
        g.fillRect(x0 + i * bar, 0, Math.max(1, bar - 0.5), 4);
      }
    });
    const y = HEIGHT - (interval / GRAPH_MS) * (HEIGHT - 4);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, Math.round(y), WIDTH, 1);
  }
}
