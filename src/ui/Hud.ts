const CSS = `
.hud { position:absolute; inset:0; pointer-events:none; font-family: "Segoe UI", system-ui, sans-serif; color:#e8edf5; user-select:none; }
.hud .shadow { text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
.hud .xhair { position:absolute; left:50%; top:50%; width:46px; height:46px; margin:-23px; }
.hud .xhair .dot { position:absolute; left:50%; top:50%; width:4px; height:4px; margin:-2px; border-radius:50%; background:rgba(255,255,255,0.9); }
.hud .xhair .br { position:absolute; top:6px; width:12px; height:34px; border:3px solid; box-sizing:border-box; opacity:0.55; }
.hud .xhair .br.l { left:2px; border-right:none; border-radius:18px 0 0 18px; border-color:#ff7a1a; }
.hud .xhair .br.r { right:2px; border-left:none; border-radius:0 18px 18px 0; border-color:#2ab8ff; }
.hud .xhair .br.on { opacity:1; }
.hud .xhair .br.l.on { background:rgba(255,122,26,0.35); }
.hud .xhair .br.r.on { background:rgba(42,184,255,0.35); }
.hud .bars { position:absolute; left:22px; bottom:22px; width:230px; }
.hud .label { font-size:11px; letter-spacing:0.12em; opacity:0.85; margin-bottom:4px; }
.hud .bar { width:100%; height:14px; background:rgba(20,22,28,0.75); border:1px solid rgba(255,255,255,0.15); border-radius:3px; overflow:hidden; }
.hud .bar > div { height:100%; transition: width 0.12s; }
.hud .title { position:absolute; left:22px; top:18px; max-width:52vw; }
.hud .title .name { font-size:22px; font-weight:600; letter-spacing:0.04em; }
.hud .title .step { font-size:11px; letter-spacing:0.2em; opacity:0.7; }
.hud .title .hint { font-size:14px; margin-top:6px; opacity:0.92; line-height:1.4; transition: opacity 1.2s; }
.hud .corner { position:absolute; right:18px; top:16px; display:flex; gap:10px; align-items:center; }
.hud .btn { pointer-events:auto; cursor:pointer; background:rgba(20,22,28,0.7); border:1px solid rgba(255,255,255,0.2);
  color:#e8edf5; border-radius:6px; padding:5px 10px; font-size:13px; }
.hud .btn:hover { background:rgba(40,44,56,0.9); }
.hud .fps { font: 11px ui-monospace, monospace; opacity:0.7; }
.hud .net { position:absolute; right:0; top:30px; white-space:nowrap; font: 11px ui-monospace, monospace; opacity:0.85; }
.hud .keys { position:absolute; right:18px; bottom:16px; font-size:12px; opacity:0.6; text-align:right; line-height:1.6; }
.hud .center { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); text-align:center; }
.hud .banner { font-size:34px; font-weight:700; letter-spacing:0.08em; }
.hud .sub { font-size:15px; opacity:0.85; margin-top:8px; }
.hud .effect { position:absolute; left:50%; top:16%; transform:translateX(-50%); font-size:16px; font-weight:700; letter-spacing:0.14em;
  padding:6px 14px; border-radius:6px; background:rgba(16,18,40,0.6); border:1px solid rgba(120,140,255,0.5); color:#c8d2ff; display:none; }
.hud .score { position:absolute; left:50%; top:14px; transform:translateX(-50%); min-width:240px; display:none;
  padding:8px 14px 10px; border-radius:8px; background:rgba(12,14,20,0.62); border:1px solid rgba(255,210,58,0.35); }
.hud .score .to { font-size:11px; letter-spacing:0.18em; opacity:0.75; text-align:center; margin-bottom:6px; }
.hud .score .row { display:flex; align-items:center; gap:10px; font-size:14px; font-weight:600; letter-spacing:0.06em; margin-top:3px; }
.hud .score .row .who { width:44px; }
.hud .score .row .pts { width:34px; text-align:right; font-variant-numeric:tabular-nums; }
.hud .score .row .bar { flex:1; height:8px; }
.hud .score .row .bar > div { background:linear-gradient(90deg,#c89a1a,#ffd23a); }
.hud .score .row.you .who { color:#ffd23a; }
.hud .toasts { position:absolute; left:50%; top:58%; transform:translateX(-50%); display:flex; flex-direction:column; align-items:center; gap:4px; }
.hud .toast { font-size:20px; font-weight:700; letter-spacing:0.1em; color:#ffd23a; animation: hud-toast 1.8s ease-out forwards; }
@keyframes hud-toast { 0% { opacity:0; transform:translateY(10px) scale(0.9); } 12% { opacity:1; transform:none; } 70% { opacity:1; } 100% { opacity:0; transform:translateY(-14px); } }
.hud .click { position:absolute; left:50%; top:62%; transform:translateX(-50%); font-size:15px; padding:8px 16px;
  background:rgba(10,12,18,0.7); border:1px solid rgba(255,255,255,0.2); border-radius:6px; }
`;

export interface HudState {
  health: number;
  immunity: number;
  orange: boolean;
  blue: boolean;
  locked: boolean;
}

export interface ScoreLine {
  name: string;
  score: number;
  /** The local player. */
  you: boolean;
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly el: Record<string, HTMLElement> = {};
  private hintTimer = 0;
  private scoreKey = '';
  onMuteClick: (() => void) | null = null;

  constructor(container: HTMLElement) {
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="xhair"><div class="br l"></div><div class="dot"></div><div class="br r"></div></div>
      <div class="title shadow"><div class="step"></div><div class="name"></div><div class="hint"></div></div>
      <div class="corner shadow"><span class="net"></span><span class="fps"></span><button class="btn mute"></button></div>
      <div class="bars shadow">
        <div class="label">HEALTH</div>
        <div class="bar"><div class="health" style="width:100%; background:linear-gradient(90deg,#c8322a,#ff6a4a)"></div></div>
        <div class="label" style="margin-top:10px">FLASH IMMUNITY &middot; SHIFT</div>
        <div class="bar" style="height:8px"><div class="immunity" style="width:100%; background:#4ca8ff"></div></div>
      </div>
      <div class="keys shadow">WASD move &middot; Space jump &middot; LMB / RMB portals<br>R restart arena &middot; M sound &middot; Esc menu</div>
      <div class="center shadow"><div class="banner"></div><div class="sub"></div></div>
      <div class="effect shadow"></div>
      <div class="score shadow"><div class="to"></div><div class="rows"></div></div>
      <div class="toasts shadow"></div>
      <div class="click shadow">Click to play</div>
    `;
    container.appendChild(this.root);
    for (const cls of ['step', 'name', 'hint', 'fps', 'net', 'mute', 'health', 'immunity', 'banner', 'sub', 'click', 'effect', 'score', 'to', 'rows', 'toasts']) {
      this.el[cls] = this.root.querySelector(`.${cls}`)!;
    }
    this.el.l = this.root.querySelector('.br.l')!;
    this.el.r = this.root.querySelector('.br.r')!;
    this.el.mute.addEventListener('click', (e) => {
      e.stopPropagation();
      this.onMuteClick?.();
    });
  }

  /** `label` is the small line above the name, e.g. "ARENA 2 / 4". */
  setArena(label: string, name: string, hint: string): void {
    this.el.step.textContent = label;
    this.el.name.textContent = name;
    this.showHint(hint);
  }

  /** Hidden while a menu covers the screen. */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  showHint(hint: string): void {
    this.el.hint.textContent = hint;
    this.el.hint.style.opacity = '1';
    this.hintTimer = 14;
  }

  setMuted(muted: boolean): void {
    this.el.mute.textContent = muted ? '\u{1F507} Sound off (M)' : '\u{1F50A} Sound on (M)';
  }

  setBanner(title: string, sub = ''): void {
    this.el.banner.textContent = title;
    this.el.sub.textContent = sub;
  }

  /** An arena effect in force (heavy gravity...), or '' for none. */
  setEffect(text: string): void {
    if (this.el.effect.textContent !== text) this.el.effect.textContent = text;
    this.el.effect.style.display = text ? 'block' : 'none';
  }

  /** The match scoreboard, or null to hide it (no match). */
  setScores(scores: readonly ScoreLine[] | null, target = 0): void {
    const key = scores ? `${target}|${scores.map((s) => `${s.name}:${s.score}:${s.you}`).join(',')}` : '';
    if (key === this.scoreKey) return;
    this.scoreKey = key;
    this.el.score.style.display = scores ? 'block' : 'none';
    if (!scores) return;
    this.el.to.textContent = `FIRST TO ${target}`;
    this.el.rows.replaceChildren(
      ...scores.map((s) => {
        const row = document.createElement('div');
        row.className = s.you ? 'row you' : 'row';
        row.innerHTML = `<span class="who"></span><div class="bar"><div></div></div><span class="pts"></span>`;
        row.querySelector<HTMLElement>('.who')!.textContent = s.name;
        row.querySelector<HTMLElement>('.pts')!.textContent = String(s.score);
        row.querySelector<HTMLElement>('.bar > div')!.style.width = `${Math.min(1, s.score / Math.max(1, target)) * 100}%`;
        return row;
      }),
    );
  }

  /** A short line that pops up under the crosshair and fades ("+10 ORB"). */
  toast(text: string, color?: string): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    if (color) t.style.color = color;
    this.el.toasts.appendChild(t);
    while (this.el.toasts.childElementCount > 3) this.el.toasts.firstElementChild!.remove();
    t.addEventListener('animationend', () => t.remove());
  }

  /** Online: ping (and with ?net=1, more about the connection); null outside a match. */
  setNet(text: string | null): void {
    if (this.el.net.textContent !== (text ?? '')) this.el.net.textContent = text ?? '';
  }

  setFps(text: string | null): void {
    this.el.fps.textContent = text ?? '';
  }

  update(dt: number, s: HudState): void {
    this.el.health.style.width = `${Math.max(0, s.health) * 100}%`;
    this.el.immunity.style.width = `${Math.max(0, Math.min(1, s.immunity)) * 100}%`;
    this.el.l.classList.toggle('on', s.orange);
    this.el.r.classList.toggle('on', s.blue);
    this.el.click.style.display = s.locked ? 'none' : 'block';
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      if (this.hintTimer <= 0) this.el.hint.style.opacity = '0.35';
    }
  }
}
