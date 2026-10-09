export class Health {
  private current: number;
  readonly max: number;

  constructor(max = 100) {
    this.max = max;
    this.current = max;
  }

  get value(): number {
    return this.current;
  }

  get isDead(): boolean {
    return this.current <= 0;
  }

  damage(amount: number): void {
    this.current = Math.max(0, this.current - amount);
  }

  /** Exactly this much (online: the game server's figure). */
  set(value: number): void {
    this.current = Math.max(0, Math.min(this.max, value));
  }

  reset(): void {
    this.current = this.max;
  }
}
