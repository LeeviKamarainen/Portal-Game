import * as THREE from 'three';

/**
 * Where an opponent just opened a portal, drawn over the HUD: a ring flashes at the spot while
 * it is on screen, and a chevron on the screen's edge points the way (with the distance) while
 * it is not. They fade within a couple of seconds. Opt-out in the settings (Controls).
 *
 * It tells you nothing the ears don't: pings only come for portals opened within the range the
 * portal's opening sound carries (Game passes `PING_RANGE`).
 */

/** Seconds a ping stays up. */
const LIFE = 2.6;
/** The most at once (a newer portal of the same player and colour replaces the older). */
const MAX_PINGS = 8;
/** Metres: how far a portal opening carries (the same as its sound, see ArenaSim.fireFrom). */
export const PING_RANGE = 35;
/** Distance of the edge arrows from the screen's edge (px). */
const EDGE_MARGIN = 78;
/** Inside this fraction of the half-screen a point counts as in view. */
const IN_VIEW = 0.92;

const CSS = `
.pings { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
.pings .ping { position:absolute; left:0; top:0; will-change:transform, opacity; }
.pings .ring { position:absolute; left:-24px; top:-24px; width:48px; height:48px; box-sizing:border-box; border-radius:50%;
  border:3px solid var(--c); box-shadow:0 0 14px var(--c), inset 0 0 10px var(--c); animation: ping-ring 0.7s ease-out forwards; }
.pings .ring.dot { animation:none; width:10px; height:10px; left:-5px; top:-5px; border:none; background:var(--c); box-shadow:0 0 10px var(--c); }
.pings .arrow { position:absolute; left:-20px; top:-20px; width:40px; height:40px; animation: ping-flash 0.28s ease-in-out 4 alternate; }
.pings .arrow svg { width:100%; height:100%; overflow:visible; filter:drop-shadow(0 0 5px var(--c)) drop-shadow(0 1px 2px rgba(0,0,0,0.9)); }
.pings .dist { position:absolute; left:-30px; width:60px; top:22px; text-align:center; font-size:11px; font-weight:700;
  letter-spacing:0.06em; color:var(--c); text-shadow:0 1px 3px rgba(0,0,0,0.95); }
@keyframes ping-ring { 0% { transform:scale(0.3); opacity:1; } 100% { transform:scale(1.7); opacity:0; } }
@keyframes ping-flash { from { opacity:1; } to { opacity:0.35; } }
`;

interface Ping {
  /** Whose portal, and which one: a new one replaces it. */
  key: string;
  point: THREE.Vector3;
  age: number;
  el: HTMLDivElement;
  ring: HTMLDivElement;
  arrow: HTMLDivElement;
  dist: HTMLDivElement;
}

const _p = new THREE.Vector3();
const _ndc = new THREE.Vector3();

export class PortalPings {
  private readonly root: HTMLDivElement;
  private pings: Ping[] = [];

  constructor(container: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'pings';
    container.appendChild(this.root);
  }

  /** `owner`/`color`: which portal this is (the player's id and 'orange' | 'blue'); `tint`: its colour, 0xRRGGBB. */
  add(owner: string, color: string, point: THREE.Vector3, tint: number): void {
    const key = `${owner}:${color}`;
    this.remove(this.pings.filter((p) => p.key === key));
    while (this.pings.length >= MAX_PINGS) this.remove([this.pings[0]]);

    const el = document.createElement('div');
    el.className = 'ping';
    el.style.setProperty('--c', `#${tint.toString(16).padStart(6, '0')}`);
    el.innerHTML = `
      <div class="ring"></div>
      <div class="arrow"><svg viewBox="-20 -20 40 40"><path d="M0 -15 L14 12 L0 5 L-14 12 Z" fill="var(--c)" stroke="rgba(255,255,255,0.85)" stroke-width="1.5" stroke-linejoin="round"/></svg></div>
      <div class="dist"></div>`;
    this.root.appendChild(el);
    this.pings.push({
      key,
      point: point.clone(),
      age: 0,
      el,
      ring: el.querySelector('.ring')!,
      arrow: el.querySelector('.arrow')!,
      dist: el.querySelector('.dist')!,
    });
  }

  /** All gone (a new arena, or the setting was turned off). */
  clear(): void {
    this.remove([...this.pings]);
  }

  /** Ages the pings and puts each where it belongs for `camera` (call after its matrices are up to date). */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (this.pings.length === 0) return;
    const w = this.root.clientWidth;
    const h = this.root.clientHeight;
    camera.updateMatrixWorld();
    const expired: Ping[] = [];
    for (const ping of this.pings) {
      ping.age += dt;
      if (ping.age >= LIFE) {
        expired.push(ping);
        continue;
      }
      const fade = Math.min(1, (LIFE - ping.age) / 0.8);
      ping.el.style.opacity = String(fade);

      // In camera space, -z is ahead; its x/y say which way to turn.
      _p.copy(ping.point).applyMatrix4(camera.matrixWorldInverse);
      const ahead = _p.z < 0;
      let onScreen = false;
      if (ahead) {
        _ndc.copy(ping.point).project(camera);
        onScreen = Math.abs(_ndc.x) <= IN_VIEW && Math.abs(_ndc.y) <= IN_VIEW;
      }
      let x: number;
      let y: number;
      if (onScreen) {
        x = (_ndc.x * 0.5 + 0.5) * w;
        y = (-_ndc.y * 0.5 + 0.5) * h;
        // The ring flashes where the portal is; once it has flashed, a dot stays until it fades.
        ping.ring.classList.toggle('dot', ping.age > 0.7);
        ping.arrow.style.display = 'none';
        ping.dist.style.display = 'none';
        ping.ring.style.display = '';
      } else {
        // Straight behind you has no side to prefer.
        let dx = _p.x;
        let dy = _p.y;
        if (Math.hypot(dx, dy) < 1e-3) dy = -1;
        const len = Math.hypot(dx, dy);
        dx /= len;
        dy /= len;
        const halfW = Math.max(1, w / 2 - EDGE_MARGIN);
        const halfH = Math.max(1, h / 2 - EDGE_MARGIN);
        const s = Math.min(halfW / Math.max(1e-3, Math.abs(dx)), halfH / Math.max(1e-3, Math.abs(dy)));
        x = w / 2 + dx * s;
        y = h / 2 - dy * s;
        ping.ring.style.display = 'none';
        ping.arrow.style.display = '';
        ping.arrow.style.transform = `rotate(${Math.atan2(dx, dy)}rad)`;
        ping.dist.style.display = '';
        ping.dist.textContent = `${Math.round(ping.point.distanceTo(camera.position))} m`;
      }
      ping.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    }
    if (expired.length) this.remove(expired);
  }

  private remove(gone: Ping[]): void {
    for (const p of gone) p.el.remove();
    this.pings = this.pings.filter((p) => !gone.includes(p));
  }
}
