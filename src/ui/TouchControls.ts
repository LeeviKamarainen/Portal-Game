import type { InputManager } from '../core/InputManager';

/**
 * On-screen controls for phones and tablets (landscape): a floating move stick under the
 * left thumb, look by dragging anywhere else, jump and flash immunity buttons, and the two
 * portals - by tapping where you want one (once: orange, twice: blue; the view stays put) or
 * with buttons. They write into the InputManager, so the rest of the game sees the same
 * commands it gets from a keyboard and mouse.
 *
 * A touch that hasn't moved yet is undecided: it becomes the stick (left side) or a look drag
 * once it travels past TAP_SLOP, and a quick lift before that is a tap.
 *
 * Shown and hidden with the HUD (see Hud.onVisibleChange): in play, not in a menu.
 */

const CSS = `
.touch-controls { position:absolute; inset:0; z-index:5; touch-action:none; user-select:none; -webkit-user-select:none;
  -webkit-touch-callout:none; -webkit-tap-highlight-color:transparent; font-family:"Segoe UI", system-ui, sans-serif; }
.touch-controls.hidden { display:none; }
.touch-controls .stick, .touch-controls .ghost { position:absolute; width:120px; height:120px; margin:-60px 0 0 -60px; border-radius:50%;
  border:2px solid rgba(255,255,255,0.35); background:rgba(255,255,255,0.06); pointer-events:none; }
.touch-controls .ghost { opacity:0.5; }
.touch-controls .stick { display:none; }
.touch-controls .stick .knob { position:absolute; left:50%; top:50%; width:52px; height:52px; margin:-26px 0 0 -26px; border-radius:50%;
  background:rgba(255,255,255,0.32); border:2px solid rgba(255,255,255,0.55); }
.touch-controls .tbtn { position:absolute; border-radius:50%; display:flex; align-items:center; justify-content:center;
  color:#fff; font-weight:700; font-size:12px; letter-spacing:0.08em; text-shadow:0 1px 3px rgba(0,0,0,0.9);
  background:rgba(20,22,28,0.45); border:2px solid rgba(255,255,255,0.4); box-sizing:border-box; touch-action:none; }
.touch-controls .tbtn.down { background:rgba(255,255,255,0.28); }
.touch-controls .tbtn.orange { width:84px; height:84px; right:max(24px, env(safe-area-inset-right)); bottom:max(24px, env(safe-area-inset-bottom));
  border-color:#ff7a1a; background:rgba(255,122,26,0.32); }
.touch-controls .tbtn.orange.down { background:rgba(255,122,26,0.65); }
.touch-controls .tbtn.blue { width:72px; height:72px; right:max(30px, env(safe-area-inset-right)); bottom:calc(max(24px, env(safe-area-inset-bottom)) + 96px);
  border-color:#2ab8ff; background:rgba(42,184,255,0.32); }
.touch-controls .tbtn.blue.down { background:rgba(42,184,255,0.65); }
.touch-controls .tbtn.jump { width:72px; height:72px; right:calc(max(24px, env(safe-area-inset-right)) + 96px); bottom:max(30px, env(safe-area-inset-bottom)); }
.touch-controls .tbtn.flash { width:56px; height:56px; right:calc(max(24px, env(safe-area-inset-right)) + 112px);
  bottom:calc(max(24px, env(safe-area-inset-bottom)) + 100px); border-color:#4ca8ff; font-size:10px; }
.touch-controls .tbtn.floor { width:60px; height:60px; right:calc(max(24px, env(safe-area-inset-right)) + 204px);
  bottom:max(36px, env(safe-area-inset-bottom)); flex-direction:column; font-size:10px; line-height:1.1; text-align:center; }
.touch-controls .tbtn.pause { width:44px; height:44px; right:max(12px, env(safe-area-inset-right)); top:max(10px, env(safe-area-inset-top));
  border-radius:10px; font-size:18px; letter-spacing:0; }
.touch-controls.tap-fire .tbtn.orange, .touch-controls.tap-fire .tbtn.blue { display:none; }
.touch-controls .swatch { display:none; position:absolute; left:50%; bottom:58px; width:34px; height:34px; margin-left:-17px;
  border-radius:50%; border:3px solid #ff7a1a; background:rgba(255,122,26,0.4); box-sizing:border-box; }
.touch-controls .swatch.blue { border-color:#2ab8ff; background:rgba(42,184,255,0.4); }
.touch-controls.alternate .swatch { display:block; }
.touch-controls .tapfx { position:absolute; width:56px; height:56px; margin:-28px 0 0 -28px; border-radius:50%; pointer-events:none;
  border:3px solid; animation: tc-tap 0.45s ease-out forwards; }
.touch-controls .tapfx.orange { border-color:#ff7a1a; background:rgba(255,122,26,0.25); }
.touch-controls .tapfx.blue { border-color:#2ab8ff; background:rgba(42,184,255,0.25); }
@keyframes tc-tap { from { opacity:1; transform:scale(0.5); } to { opacity:0; transform:scale(1.5); } }
.touch-controls .rotate { position:absolute; inset:0; display:none; align-items:center; justify-content:center; text-align:center;
  background:rgba(8,10,16,0.96); color:#e8edf5; font-size:18px; line-height:1.5; padding:24px; }
@media (orientation: portrait) { .touch-controls .rotate { display:flex; } }
`;

/** Pixels of finger travel from the stick's centre for full speed. */
const STICK_RADIUS = 56;
const DEAD_ZONE = 0.12;
/** The left part of the screen starts the move stick; the rest looks. */
const STICK_ZONE = 0.42;

/** A touch that moves less than this many pixels is still a tap candidate; past it, it drags. */
const TAP_SLOP = 10;
/** Longest a touch can last and still be a tap (ms). */
const TAP_MAX_MS = 280;
/** A second tap within this time (ms) and distance (px) of the first is a double tap. A single tap waits this long to be sure. */
const DOUBLE_TAP_MS = 240;
const DOUBLE_TAP_DIST = 70;
/** Holding a touch still this long (ms) asks for blue, in hold mode. */
const HOLD_MS = 220;

interface Pending {
  x: number;
  y: number;
  t: number;
  /** Hold mode: the timer that turns this touch into a blue shot. */
  timer: number | null;
  /** It already shot (a hold): lifting it is not a tap. */
  fired: boolean;
}

export interface TouchHandlers {
  /** The pause button, or the device turned upright: stop playing and open the pause menu. */
  pause(): void;
  /** The floor button: snap the view straight down (for a portal under your feet), or back to where it was. */
  lookDown(): void;
}

/**
 * A drag's speed (px per ms) up to which the view turns at the base rate, and the speed at which
 * the extra turn is fully in: slow drags stay precise for aiming, a flick spins the view round.
 */
const LOOK_SLOW = 0.4;
const LOOK_FAST = 2;
const LOOK_BOOST = 0.9;

export class TouchControls {
  private readonly root: HTMLDivElement;
  private readonly stick: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private readonly ghost: HTMLDivElement;
  /** Touches that have not yet moved far enough to be a drag (and might be a tap). */
  private readonly pending = new Map<number, Pending>();
  private fireMode: 'tap' | 'buttons' = 'tap';
  private blueMode: 'hold' | 'double' | 'alternate' = 'hold';
  /** Alternate mode: the colour the next tap places. */
  private nextColor: 'orange' | 'blue' = 'orange';
  /** A single tap waiting out the double-tap window: where it was and its timer. */
  private tapTimer: number | null = null;
  private tapX = 0;
  private tapY = 0;
  private stickId: number | null = null;
  private lookId: number | null = null;
  private stickX = 0;
  private stickY = 0;
  private lookX = 0;
  private lookY = 0;
  private lookTime = 0;
  private visible = true;
  private triedFullscreen = false;
  /** Which button each finger holds, so lifting it lets go of that button. */
  private readonly heldButtons = new Map<number, HTMLElement>();

  private readonly input: InputManager;
  private readonly handlers: TouchHandlers;

  constructor(container: HTMLElement, input: InputManager, handlers: TouchHandlers) {
    this.input = input;
    this.handlers = handlers;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'touch-controls';
    this.root.innerHTML = `
      <div class="ghost"></div>
      <div class="stick"><div class="knob"></div></div>
      <div class="tbtn blue" data-btn="blue">BLUE</div>
      <div class="tbtn orange" data-btn="orange">ORANGE</div>
      <div class="tbtn jump" data-btn="jump">JUMP</div>
      <div class="tbtn flash" data-btn="flash">FLASH</div>
      <div class="tbtn floor" data-btn="down">&#8595;<br>FLOOR</div>
      <div class="tbtn pause" data-btn="pause">&#9776;</div>
      <div class="swatch" data-btn="swatch"></div>
      <div class="rotate">Turn your device sideways to play.</div>
    `;
    container.appendChild(this.root);
    this.stick = this.root.querySelector('.stick')!;
    this.knob = this.root.querySelector('.knob')!;
    this.ghost = this.root.querySelector('.ghost')!;
    this.placeGhost();
    this.setFireMode(this.fireMode, this.blueMode);

    this.root.addEventListener('pointerdown', (e) => this.onDown(e));
    this.root.addEventListener('pointermove', (e) => this.onMove(e));
    this.root.addEventListener('pointerup', (e) => this.onUp(e));
    this.root.addEventListener('pointercancel', (e) => this.onUp(e));
    this.root.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('resize', () => this.placeGhost());

    // Turning the device upright mid-game: stop, the screen asks for landscape.
    matchMedia('(orientation: portrait)').addEventListener('change', (e) => {
      if (e.matches && this.visible && this.input.isPointerLocked()) this.handlers.pause();
    });
  }

  /** Tap the screen to shoot there (and how blue is asked for), or use the portal buttons. */
  setFireMode(mode: 'tap' | 'buttons', blue: 'hold' | 'double' | 'alternate'): void {
    this.fireMode = mode;
    this.blueMode = blue;
    this.root.classList.toggle('tap-fire', mode === 'tap');
    this.root.classList.toggle('alternate', mode === 'tap' && blue === 'alternate');
    this.cancelTap();
  }

  private setNext(color: 'orange' | 'blue'): void {
    this.nextColor = color;
    this.root.querySelector('.swatch')!.classList.toggle('blue', color === 'blue');
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.classList.toggle('hidden', !visible);
    if (!visible) this.reset();
  }

  /** Fullscreen and landscape where the browser allows them (Android Chrome; not iPhone Safari). Needs a gesture. */
  enterFullscreen(): void {
    if (this.triedFullscreen || document.fullscreenElement) return;
    this.triedFullscreen = true;
    const el = document.documentElement;
    if (!el.requestFullscreen) return;
    el.requestFullscreen({ navigationUI: 'hide' })
      .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
      .catch(() => {});
  }

  private placeGhost(): void {
    this.ghost.style.left = `${Math.min(110, window.innerWidth * 0.14)}px`;
    this.ghost.style.top = `${window.innerHeight - Math.min(110, window.innerHeight * 0.3)}px`;
  }

  private onDown(e: PointerEvent): void {
    e.preventDefault();
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-btn]')?.dataset.btn;
    if (btn === 'pause') {
      this.handlers.pause();
      return;
    }
    // The first touch after a pause (or a match starting) only takes the controls back.
    if (!this.input.isPointerLocked()) {
      this.enterFullscreen();
      this.input.requestLock();
      return;
    }
    try {
      // Keeps the finger's events coming when it slides off the button it started on.
      this.root.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (a synthesized event): carry on without capture.
    }
    if (btn) {
      this.press(btn, e.target as HTMLElement, e.pointerId);
      return;
    }
    // Stick, look or tap: decided once it moves, or lifts.
    const touch: Pending = { x: e.clientX, y: e.clientY, t: e.timeStamp, timer: null, fired: false };
    // Hold mode: a still finger is blue - unless it is on the stick's side with the stick free,
    // where a thumb resting before it pushes is more likely than a shot.
    const mightBeStick = e.clientX < this.root.clientWidth * STICK_ZONE && this.stickId === null;
    if (this.fireMode === 'tap' && this.blueMode === 'hold' && !mightBeStick) {
      touch.timer = window.setTimeout(() => {
        touch.timer = null;
        touch.fired = true;
        this.shoot('blue', touch.x, touch.y);
      }, HOLD_MS);
    }
    this.pending.set(e.pointerId, touch);
  }

  private startStick(id: number, x: number, y: number): void {
    this.stickId = id;
    this.stickX = x;
    this.stickY = y;
    this.stick.style.display = 'block';
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.ghost.style.display = 'none';
    this.knob.style.transform = '';
  }

  /** A tap at (x, y), by the blue-portal setting. The view doesn't turn. */
  private tap(x: number, y: number): void {
    if (this.fireMode !== 'tap') return;
    if (this.blueMode === 'hold') {
      this.shoot('orange', x, y);
      return;
    }
    if (this.blueMode === 'alternate') {
      this.shoot(this.nextColor, x, y);
      this.setNext(this.nextColor === 'orange' ? 'blue' : 'orange');
      return;
    }
    // Double tap: once is orange, twice (close together, quickly) is blue.
    if (this.tapTimer !== null && Math.hypot(x - this.tapX, y - this.tapY) <= DOUBLE_TAP_DIST) {
      clearTimeout(this.tapTimer);
      this.tapTimer = null;
      this.shoot('blue', x, y);
      return;
    }
    // A single tap elsewhere is settled: it was a single.
    this.flushTap();
    this.tapX = x;
    this.tapY = y;
    this.tapTimer = window.setTimeout(() => {
      this.tapTimer = null;
      this.shoot('orange', x, y);
    }, DOUBLE_TAP_MS);
  }

  private flushTap(): void {
    if (this.tapTimer === null) return;
    clearTimeout(this.tapTimer);
    this.tapTimer = null;
    this.shoot('orange', this.tapX, this.tapY);
  }

  private cancelTap(): void {
    if (this.tapTimer !== null) clearTimeout(this.tapTimer);
    this.tapTimer = null;
  }

  private shoot(color: 'orange' | 'blue', x: number, y: number): void {
    if (!this.visible || !this.input.isPointerLocked()) return;
    const r = this.root.getBoundingClientRect();
    this.input.touchFire(color, ((x - r.left) / r.width) * 2 - 1, -(((y - r.top) / r.height) * 2 - 1));
    const fx = document.createElement('div');
    fx.className = `tapfx ${color}`;
    fx.style.left = `${x - r.left}px`;
    fx.style.top = `${y - r.top}px`;
    fx.addEventListener('animationend', () => fx.remove());
    this.root.appendChild(fx);
  }

  private press(btn: string, el: HTMLElement, pointerId: number): void {
    switch (btn) {
      case 'orange':
        this.input.touchFire('orange');
        break;
      case 'blue':
        this.input.touchFire('blue');
        break;
      case 'jump':
        this.input.touchJump = true;
        break;
      case 'flash':
        this.input.touchImmunity = true;
        break;
      case 'down':
        this.handlers.lookDown();
        break;
      case 'swatch':
        this.setNext(this.nextColor === 'orange' ? 'blue' : 'orange');
        return;
    }
    const button = el.closest<HTMLElement>('[data-btn]')!;
    button.classList.add('down');
    this.heldButtons.set(pointerId, button);
  }

  private onMove(e: PointerEvent): void {
    const p = this.pending.get(e.pointerId);
    if (p) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < TAP_SLOP) return;
      if (p.timer !== null) clearTimeout(p.timer);
      this.pending.delete(e.pointerId);
      if (p.x < this.root.clientWidth * STICK_ZONE && this.stickId === null) {
        this.startStick(e.pointerId, p.x, p.y);
      } else if (this.lookId === null) {
        this.lookId = e.pointerId;
        this.lookX = e.clientX;
        this.lookY = e.clientY;
        this.lookTime = e.timeStamp;
        return;
      } else {
        return;
      }
    }
    if (e.pointerId === this.stickId) {
      let dx = e.clientX - this.stickX;
      let dy = e.clientY - this.stickY;
      const len = Math.hypot(dx, dy);
      if (len > STICK_RADIUS) {
        dx = (dx / len) * STICK_RADIUS;
        dy = (dy / len) * STICK_RADIUS;
      }
      this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const ax = dx / STICK_RADIUS;
      const ay = dy / STICK_RADIUS;
      const mag = Math.hypot(ax, ay);
      // Dead zone, then rescale so the edge of it is a standstill rather than a jump to speed.
      const scale = mag < DEAD_ZONE ? 0 : (mag - DEAD_ZONE) / (1 - DEAD_ZONE) / mag;
      this.input.touchRight = ax * scale;
      this.input.touchForward = -ay * scale;
    } else if (e.pointerId === this.lookId) {
      const dx = e.clientX - this.lookX;
      const dy = e.clientY - this.lookY;
      const speed = Math.hypot(dx, dy) / Math.max(1, e.timeStamp - this.lookTime);
      const gain = 1 + LOOK_BOOST * Math.min(1, Math.max(0, (speed - LOOK_SLOW) / (LOOK_FAST - LOOK_SLOW)));
      this.input.touchLook(dx * gain, dy * gain);
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      this.lookTime = e.timeStamp;
    }
  }

  private onUp(e: PointerEvent): void {
    const p = this.pending.get(e.pointerId);
    if (p) {
      if (p.timer !== null) clearTimeout(p.timer);
      this.pending.delete(e.pointerId);
      if (!p.fired && e.type === 'pointerup' && e.timeStamp - p.t <= TAP_MAX_MS) this.tap(e.clientX, e.clientY);
      return;
    }
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.input.touchForward = this.input.touchRight = 0;
      this.stick.style.display = 'none';
      this.ghost.style.display = '';
    } else if (e.pointerId === this.lookId) {
      this.lookId = null;
    }
    const held = this.heldButtons.get(e.pointerId);
    if (held) {
      this.heldButtons.delete(e.pointerId);
      held.classList.remove('down');
      if (held.dataset.btn === 'jump') this.input.touchJump = false;
      if (held.dataset.btn === 'flash') this.input.touchImmunity = false;
    }
  }

  /** Everything let go (the controls were hidden, or the pause menu opened). */
  private reset(): void {
    this.stickId = this.lookId = null;
    for (const p of this.pending.values()) if (p.timer !== null) clearTimeout(p.timer);
    this.pending.clear();
    this.cancelTap();
    this.heldButtons.clear();
    this.root.querySelectorAll('.down').forEach((b) => b.classList.remove('down'));
    this.stick.style.display = 'none';
    this.ghost.style.display = '';
    this.input.releaseTouch();
  }
}
