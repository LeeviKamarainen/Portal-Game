export const FIXED_DT = 1 / 60;
const MAX_STEPS_PER_FRAME = 5;

/** Fixed-step simulation with a render per animation frame (which gets the real frame time). */
export class Loop {
  private readonly step: (dt: number) => void;
  private readonly render: (frameDt: number) => void;
  private accumulator = 0;
  private running = false;
  private generation = 0;

  constructor(step: (dt: number) => void, render: (frameDt: number) => void) {
    this.step = step;
    this.render = render;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const gen = ++this.generation;
    let last = performance.now();

    const tick = (now: number) => {
      if (!this.running || gen !== this.generation) return;
      // Schedule first: an exception in one frame must not stop the game for good.
      requestAnimationFrame(tick);
      const frameDt = Math.min((now - last) / 1000, 0.25);
      last = now;
      this.accumulator += frameDt;

      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      // Never let a hitch queue up a burst of catch-up steps.
      if (steps === MAX_STEPS_PER_FRAME) this.accumulator = 0;

      this.render(frameDt);
    };

    requestAnimationFrame(tick);
  }

  stop(): void {
    this.running = false;
  }
}
