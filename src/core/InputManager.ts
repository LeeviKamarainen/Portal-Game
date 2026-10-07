export class InputManager {
  private keys = new Set<string>();
  private presses = new Set<string>();
  private mouseDeltaX = 0;
  private mouseDeltaY = 0;
  private locked = false;
  private firePrimaryQueued = false;
  private fireSecondaryQueued = false;
  /** Scripted input (tests): replaces the keyboard entirely while set. */
  private scripted: Set<string> | null = null;
  private readonly domElement: HTMLElement;
  /** Look speed multiplier and vertical inversion, from the settings menu. */
  sensitivity = 1;
  invertY = false;
  /** Called when the mouse is captured or released (Esc releases it). */
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Off while the map editor owns the mouse: clicking the view must not capture it. */
  lockEnabled = true;

  constructor(domElement: HTMLElement) {
    this.domElement = domElement;
    domElement.addEventListener('click', () => {
      if (this.lockEnabled) this.requestLock();
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === domElement;
      if (!this.locked) this.keys.clear();
      this.onLockChange?.(this.locked);
    });

    window.addEventListener('keydown', (e) => {
      if (!e.repeat) this.presses.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDeltaX += e.movementX;
      this.mouseDeltaY += e.movementY;
    });

    domElement.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) this.firePrimaryQueued = true;
      if (e.button === 2) this.fireSecondaryQueued = true;
    });

    domElement.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  isDown(code: string): boolean {
    return (this.scripted ?? this.keys).has(code);
  }

  /** True once per physical key press (no auto-repeat). */
  consumePress(code: string): boolean {
    const had = this.presses.has(code);
    this.presses.delete(code);
    return had;
  }

  setScriptedKeys(keys: string[] | null): void {
    this.scripted = keys ? new Set(keys) : null;
  }

  isPointerLocked(): boolean {
    return this.locked;
  }

  /** Captures the mouse; must run inside a click or key handler. */
  requestLock(): void {
    if (this.locked) return;
    // Browsers refuse a re-lock for a moment after Esc released it; the click-to-play
    // prompt covers that case.
    Promise.resolve(this.domElement.requestPointerLock()).catch(() => {});
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  consumeMouseDelta(): { x: number; y: number } {
    const d = {
      x: this.mouseDeltaX * this.sensitivity,
      y: this.mouseDeltaY * this.sensitivity * (this.invertY ? -1 : 1),
    };
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return d;
  }

  consumeFirePrimary(): boolean {
    const v = this.firePrimaryQueued;
    this.firePrimaryQueued = false;
    return v;
  }

  consumeFireSecondary(): boolean {
    const v = this.fireSecondaryQueued;
    this.fireSecondaryQueued = false;
    return v;
  }

  /** Drop anything queued, e.g. across a respawn or level change. */
  flush(): void {
    this.presses.clear();
    this.firePrimaryQueued = false;
    this.fireSecondaryQueued = false;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
  }
}
