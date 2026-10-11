import { FLAGS } from './Flags';

/** Look radians per dragged pixel, relative to the mouse: a thumb covers less screen than a wrist. */
const TOUCH_LOOK_SCALE = 3;

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
  /**
   * On-screen controls (ui/TouchControls) write here; the keyboard source (PlayerCommand)
   * adds them to the keys. Move axes are analog, -1..1.
   */
  touchForward = 0;
  touchRight = 0;
  touchJump = false;
  touchImmunity = false;
  /** Touch devices have no pointer lock: "locked" is just "the game has the touches". */
  private readonly virtualLock = FLAGS.touch;
  /** Radians of look to add to the next step's pitch (the on-screen "look down" button). */
  private pitchNudge = 0;

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

    // Esc-to-pause has no touch equivalent for a page that goes to the background.
    document.addEventListener('visibilitychange', () => {
      if (this.virtualLock && document.hidden && this.locked) {
        this.dropVirtualLock();
        this.onLockChange?.(false);
      }
    });
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
    if (this.virtualLock) {
      this.locked = true;
      this.onLockChange?.(true);
      return;
    }
    // Browsers refuse a re-lock for a moment after Esc released it; the click-to-play
    // prompt covers that case.
    Promise.resolve(this.domElement.requestPointerLock()).catch(() => {});
  }

  releaseLock(): void {
    if (this.virtualLock) this.dropVirtualLock();
    else if (this.locked) document.exitPointerLock();
  }

  private dropVirtualLock(): void {
    this.locked = false;
    this.keys.clear();
    this.releaseTouch();
  }

  /** A thumb dragged the view by this many pixels. */
  touchLook(dx: number, dy: number): void {
    if (!this.locked) return;
    this.mouseDeltaX += dx * TOUCH_LOOK_SCALE;
    this.mouseDeltaY += dy * TOUCH_LOOK_SCALE;
  }

  /** Turn the view up (positive) or down by this much on the next step, on top of any drag. */
  nudgePitch(radians: number): void {
    if (this.locked) this.pitchNudge += radians;
  }

  consumePitchNudge(): number {
    const v = this.pitchNudge;
    this.pitchNudge = 0;
    return v;
  }

  /** A portal button was tapped (orange = the left mouse button, blue = the right). */
  touchFire(color: 'orange' | 'blue'): void {
    if (!this.locked) return;
    if (color === 'orange') this.firePrimaryQueued = true;
    else this.fireSecondaryQueued = true;
  }

  /** Every finger is up: nothing is held. */
  releaseTouch(): void {
    this.touchForward = this.touchRight = 0;
    this.touchJump = this.touchImmunity = false;
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
    this.pitchNudge = 0;
  }
}
