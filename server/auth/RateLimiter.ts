/** At most `max` events per key in any `windowMs`. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** Counts an event for `key` and says whether it is within the limit (events over it are not counted). */
  allow(key: string): boolean {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    const ok = recent.length < this.max;
    if (ok) recent.push(now);
    if (recent.length > 0) this.hits.set(key, recent);
    else this.hits.delete(key);
    return ok;
  }

  /** Forgets keys with nothing recent, so the map doesn't grow with every address ever seen. */
  sweep(): void {
    const now = Date.now();
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
