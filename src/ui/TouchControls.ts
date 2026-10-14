import type { InputManager } from '../core/InputManager';

/**
 * On-screen controls for phones and tablets (landscape): a floating move stick under the
 * left thumb, look by dragging anywhere else, and buttons for the two portals, jump and
 * flash immunity. They write into the InputManager, so the rest of the game sees the same
 * commands it gets from a keyboard and mouse.
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
.touch-controls .rotate { position:absolute; inset:0; display:none; align-items:center; justify-content:center; text-align:center;
  background:rgba(8,10,16,0.96); color:#e8edf5; font-size:18px; line-height:1.5; padding:24px; }
@media (orientation: portrait) { .touch-controls .rotate { display:flex; } }
`;

/** Pixels of finger travel from the stick's centre for full speed. */
const STICK_RADIUS = 56;
const DEAD_ZONE = 0.12;
/** The left part of the screen starts the move stick; the rest looks. */
const STICK_ZONE = 0.42;

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
      <div class="rotate">Turn your device sideways to play.</div>
    `;
    container.appendChild(this.root);
    this.stick = this.root.querySelector('.stick')!;
    this.knob = this.root.querySelector('.knob')!;
    this.ghost = this.root.querySelector('.ghost')!;
    this.placeGhost();

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
    if (e.clientX < window.innerWidth * STICK_ZONE && this.stickId === null) {
      this.stickId = e.pointerId;
      this.stickX = e.clientX;
      this.stickY = e.clientY;
      this.stick.style.display = 'block';
      this.stick.style.left = `${e.clientX}px`;
      this.stick.style.top = `${e.clientY}px`;
      this.ghost.style.display = 'none';
      this.knob.style.transform = '';
    } else if (this.lookId === null) {
      this.lookId = e.pointerId;
      this.lookX = e.clientX;
      this.lookY = e.clientY;
      this.lookTime = e.timeStamp;
    }
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
    }
    const button = el.closest<HTMLElement>('[data-btn]')!;
    button.classList.add('down');
    this.heldButtons.set(pointerId, button);
  }

  private onMove(e: PointerEvent): void {
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
    this.heldButtons.clear();
    this.root.querySelectorAll('.down').forEach((b) => b.classList.remove('down'));
    this.stick.style.display = 'none';
    this.ghost.style.display = '';
    this.input.releaseTouch();
  }
}
