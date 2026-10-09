/** Steps that may be run back to back to catch up after a stall; anything more is dropped. */
const MAX_CATCH_UP = 5;

/**
 * The server's one fixed-step loop for every room: `step(dt)` runs `1 / dt` times a second,
 * on average, however the timers fire. Behind schedule it catches up a few steps at once;
 * further behind (a long stall), it lets the missed time go.
 */
export class TickLoop {
  /** Recent average time one step of every room took (ms). */
  msPerStep = 0;
  private readonly dt: number;
  private readonly step: (dt: number) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next = 0;

  constructor(dt: number, step: (dt: number) => void) {
    this.dt = dt;
    this.step = step;
  }

  start(): void {
    if (this.timer) return;
    this.next = performance.now();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.run(), Math.max(0, this.next - performance.now()));
  }

  private run(): void {
    const stepMs = this.dt * 1000;
    let steps = 0;
    while (performance.now() >= this.next && steps < MAX_CATCH_UP) {
      const t0 = performance.now();
      this.step(this.dt);
      this.msPerStep += (performance.now() - t0 - this.msPerStep) * 0.02;
      this.next += stepMs;
      steps++;
    }
    if (performance.now() - this.next > stepMs * MAX_CATCH_UP) this.next = performance.now();
    this.schedule();
  }
}
