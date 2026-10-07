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

  reset(): void {
    this.current = this.max;
  }
}
