/** A lost packet on a real connection costs about this much (TCP resends it), in ms. */
const LOSS_PENALTY = 200;

export interface LineQuality {
  /** Round trip, ms. */
  lag: number;
  /** Give or take, ms. */
  jitter: number;
  /** Percent of messages held back by a resend. */
  loss: number;
}

/**
 * One direction of a pretend bad connection (`?lag=150&jitter=30&loss=2`, and the tests):
 * every message is held back by half the round trip, give or take the jitter, and `loss`%
 * of them by a resend on top - and they come out in the order they went in, as over TCP.
 */
export class DelayLine {
  private readonly q: LineQuality;
  private readonly queue: { at: number; deliver: () => void }[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(quality: LineQuality) {
    this.q = quality;
  }

  get active(): boolean {
    return this.q.lag > 0 || this.q.jitter > 0 || this.q.loss > 0;
  }

  send(deliver: () => void): void {
    if (!this.active) {
      deliver();
      return;
    }
    const now = performance.now();
    let ms = this.q.lag / 2 + (Math.random() - 0.5) * this.q.jitter;
    if (Math.random() * 100 < this.q.loss) ms += LOSS_PENALTY;
    const last = this.queue[this.queue.length - 1];
    // Nothing overtakes: a message held back holds back everything behind it.
    this.queue.push({ at: Math.max(last?.at ?? 0, now + Math.max(0, ms)), deliver });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = performance.now();
      while (this.queue.length > 0 && this.queue[0].at <= now + 0.5) this.queue.shift()!.deliver();
      this.schedule();
    }, Math.max(0, this.queue[0].at - performance.now()));
  }
}
