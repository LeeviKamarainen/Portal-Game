import { ARENAS, PVP_ARENA } from '../world/arenas';
import { DEFAULT_SETTINGS, MAX_BOTS, SKINS, saveSettings, type Settings } from '../core/Settings';
import { SkinPreview } from './SkinPreview';
import { DEFAULT_RULES } from '../game/Match';
import { mapKind, type MapData } from '../world/maps/MapFormat';
import { readEditorDraft } from '../editor/draft';
import { BOT_DIFFICULTIES, BUILT_IN_ONLINE_MAPS, CODE_LENGTH, NAME_MAX, REJOIN_SECONDS, type BotDifficulty, type MapChoice } from '../net/protocol';
import type { OnlineView } from '../net/OnlineLobby';
import type { AccountClient } from '../net/AccountClient';
import { ACCOUNT_CSS, AccountUi } from './AccountUi';

/**
 * The main menu (tutorial stages, PvP, settings) and the pause menu, drawn as HTML over the
 * running game. The game decides what each choice does through `MenuHandlers`.
 */

export interface MenuHandlers {
  playStage(index: number): void;
  playPvp(): void;
  resume(): void;
  restart(): void;
  mainMenu(): void;
  openEditor(): void;
  backToEditor(): void;
  /** The map editor, opened on a map from the player's account (`id`: Save updates it; null: a copy). */
  editAccountMap(data: MapData, id: string | null): void;
  settingsChanged(settings: Settings): void;
  toggleMute(): void;
  /** Online rooms (see net/OnlineLobby): the menu shows what `setOnline` gives it. */
  createRoom(name: string): void;
  joinRoom(code: string, name: string): void;
  leaveRoom(): void;
  setRoomMap(map: MapChoice): void;
  setRoomBots(count: number, difficulty: BotDifficulty): void;
  startMatch(): void;
  /** A problem with something picked on this side (a map file), for the lobby to show. */
  onlineError(message: string): void;
}

type Page = 'main' | 'pause' | 'tutorial' | 'pvp' | 'settings' | 'online' | 'lobby' | 'account' | 'maps';
type SettingsTab = 'character' | 'graphics' | 'lighting' | 'controls';

const previewUrls = import.meta.glob('../assets/players/Previews/*.png', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function previewUrl(skin: string): string {
  const key = Object.keys(previewUrls).find((k) => k.endsWith(`/character-${skin}.png`));
  return key ? previewUrls[key] : '';
}

const CSS = `
.menu { --text:#e8edf5; --muted:#97a3b6; --line:rgba(255,255,255,0.12); --panel:rgba(14,17,24,0.88);
  --orange:#ff7a1a; --blue:#2ab8ff; --hover:rgba(255,255,255,0.06);
  position:absolute; inset:0; z-index:10; color:var(--text); font-family:"Segoe UI", system-ui, sans-serif;
  user-select:none; display:none; overflow:auto; }
.menu.open { display:block; }
.menu .shade { position:fixed; inset:0; pointer-events:none;
  background:linear-gradient(90deg, rgba(5,7,11,0.92) 0%, rgba(5,7,11,0.7) 42%, rgba(5,7,11,0.25) 100%); }
.menu.dim .shade { background:rgba(5,7,11,0.78); backdrop-filter:blur(3px); }
/* Lighting and graphics: keep the arena visible so changes can be judged live. */
.menu.dim.peek .shade { background:linear-gradient(90deg, rgba(5,7,11,0.9) 0%, rgba(5,7,11,0.75) 50%, rgba(5,7,11,0.1) 78%); backdrop-filter:none; }
.menu .page { position:relative; min-height:100%; box-sizing:border-box; padding:64px 72px 40px; display:flex; flex-direction:column; }
.menu .eyebrow { font-size:12px; letter-spacing:0.28em; color:var(--muted); text-transform:uppercase; }
.menu h1 { margin:6px 0 0; font-size:56px; line-height:1; font-weight:700; letter-spacing:0.06em; }
.menu h1 .o { color:var(--orange); } .menu h1 .b { color:var(--blue); }
.menu h2 { margin:6px 0 0; font-size:34px; font-weight:650; letter-spacing:0.03em; display:flex; align-items:center; gap:12px; }
.menu .tagline { margin-top:12px; color:var(--muted); font-size:15px; }
.menu .stack { margin-top:44px; display:flex; flex-direction:column; gap:6px; width:min(420px, 100%); }
.menu button { font:inherit; color:inherit; cursor:pointer; background:none; border:none; text-align:left; }
.menu button:focus-visible { outline:2px solid var(--blue); outline-offset:2px; }
.menu .item { position:relative; padding:14px 18px 14px 22px; border-radius:6px; transition:background 0.12s; }
.menu .item::before { content:""; position:absolute; left:0; top:12px; bottom:12px; width:3px; border-radius:2px;
  background:var(--orange); transform:scaleY(0); transition:transform 0.15s; }
.menu .item:hover, .menu .item:focus-visible { background:var(--hover); }
.menu .item:hover::before, .menu .item:focus-visible::before { transform:scaleY(1); }
.menu .item .t { font-size:22px; font-weight:600; letter-spacing:0.03em; display:flex; align-items:center; gap:10px; }
.menu .item .d { font-size:13px; color:var(--muted); margin-top:3px; }
.menu .chip { font-size:11px; font-weight:700; letter-spacing:0.12em; padding:3px 7px; border-radius:4px;
  border:1px solid currentColor; color:var(--orange); }
.menu .chip.done { color:#58d68d; }
.menu .chip.idle { color:var(--muted); }
.menu .foot { margin-top:auto; padding-top:32px; display:flex; gap:10px; align-items:center; color:var(--muted); font-size:12px; flex-wrap:wrap; }
.menu .btn { padding:8px 14px; border:1px solid var(--line); border-radius:6px; background:rgba(20,24,32,0.7); font-size:14px; }
.menu .btn:hover { background:rgba(40,46,60,0.9); }
.menu .btn.primary { background:var(--orange); border-color:var(--orange); color:#140a02; font-weight:650; }
.menu .btn.primary:hover { background:#ff8f3d; }
.menu .back { color:var(--muted); font-size:14px; padding:4px 0; margin-bottom:18px; align-self:flex-start; }
.menu .back:hover { color:var(--text); }
.menu .stages { margin-top:32px; display:grid; grid-template-columns:repeat(auto-fill, minmax(250px, 1fr)); gap:14px; max-width:1100px; }
.menu .stage { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; display:flex; flex-direction:column; gap:8px;
  transition:border-color 0.12s, transform 0.12s; }
.menu .stage:hover, .menu .stage:focus-visible { border-color:var(--orange); transform:translateY(-2px); }
.menu .stage .n { font-size:13px; color:var(--muted); letter-spacing:0.2em; display:flex; justify-content:space-between; align-items:center; }
.menu .stage .t { font-size:20px; font-weight:650; }
.menu .stage .d { font-size:13px; color:var(--muted); line-height:1.45; }
.menu .note { margin-top:18px; color:var(--muted); font-size:13px; max-width:640px; line-height:1.5; }
.menu .card { margin-top:28px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:22px 24px; max-width:560px; }
.menu .card .t { font-size:22px; font-weight:650; }
.menu .card .d { margin-top:6px; color:var(--muted); font-size:14px; line-height:1.5; }
.menu .card ul { list-style:none; padding:0; margin:16px 0 20px; display:flex; flex-direction:column; gap:7px; font-size:14px; }
.menu .card li::before { content:"\\25CB"; color:var(--muted); margin-right:10px; }
.menu .card li.ok::before { content:"\\2713"; color:#58d68d; }
.menu .settings { margin-top:24px; display:flex; gap:28px; max-width:980px; align-items:flex-start; }
.menu.peek .settings { max-width:820px; }
.menu .tabs { display:flex; flex-direction:column; gap:4px; min-width:170px; }
.menu .tab { padding:10px 14px; border-radius:6px; font-size:15px; color:var(--muted); }
.menu .tab:hover { background:var(--hover); color:var(--text); }
.menu .tab.on { background:var(--hover); color:var(--text); box-shadow:inset 3px 0 0 var(--orange); }
.menu .pane { flex:1; min-width:0; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 22px; }
.menu .row { display:flex; align-items:center; justify-content:space-between; gap:20px; padding:14px 0; border-bottom:1px solid var(--line); }
.menu .row:last-child { border-bottom:none; }
.menu .row .lbl { font-size:15px; }
.menu .row .sub { font-size:12px; color:var(--muted); margin-top:2px; }
.menu .seg { display:flex; border:1px solid var(--line); border-radius:6px; overflow:hidden; flex-shrink:0; }
.menu .seg button { padding:7px 13px; font-size:13px; color:var(--muted); border-left:1px solid var(--line); }
.menu .seg button:first-child { border-left:none; }
.menu .seg button:hover { color:var(--text); background:var(--hover); }
.menu .seg button.on { background:var(--blue); color:#04121c; font-weight:650; }
.menu .slider { display:flex; align-items:center; gap:12px; flex-shrink:0; }
.menu .slider input { width:180px; accent-color:var(--blue); }
.menu .slider output { width:46px; text-align:right; font-variant-numeric:tabular-nums; font-size:13px; color:var(--muted); }
.menu .skin { display:flex; gap:22px; padding:16px 0; align-items:flex-start; flex-wrap:wrap; }
.menu .skin canvas { width:220px; height:300px; border-radius:8px; flex-shrink:0;
  background:radial-gradient(circle at 50% 35%, rgba(42,184,255,0.18), rgba(255,255,255,0.02) 70%); border:1px solid var(--line); }
.menu .skins { flex:1; min-width:240px; }
.menu .skins .name { font-size:18px; font-weight:650; }
.menu .grid { margin-top:12px; display:grid; grid-template-columns:repeat(auto-fill, 60px); gap:8px; }
.menu .grid button { width:60px; height:60px; border-radius:6px; border:2px solid transparent; background:rgba(255,255,255,0.04); padding:0; overflow:hidden; }
.menu .grid button:hover { border-color:rgba(255,255,255,0.35); }
.menu .grid button.on { border-color:var(--orange); background:rgba(255,122,26,0.12); }
.menu .grid img { width:100%; height:100%; display:block; }
.menu .actions { margin-top:18px; display:flex; gap:10px; }
.menu input.text { font:inherit; font-size:16px; color:var(--text); background:rgba(0,0,0,0.35); border:1px solid var(--line); border-radius:6px;
  padding:9px 12px; width:220px; user-select:text; }
.menu input.text:focus { outline:none; border-color:var(--blue); }
.menu input.code { width:130px; letter-spacing:0.3em; text-transform:uppercase; font-weight:650; }
.menu .line { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.menu .err { margin-top:14px; color:#ff8a6a; font-size:14px; min-height:1em; }
.menu .code-big { font-size:34px; font-weight:700; letter-spacing:0.25em; color:var(--orange); }
.menu .card ul.slots { margin:14px 0 4px; gap:6px; }
.menu .card ul.slots li { display:flex; align-items:center; gap:12px; padding:8px 12px; border:1px solid var(--line); border-radius:6px; font-size:15px; }
.menu .card ul.slots li::before { content:none; }
.menu .card ul.slots li.empty { color:var(--muted); border-style:dashed; }
.menu .slots img { width:28px; height:28px; border-radius:4px; background:rgba(255,255,255,0.05); }
.menu .slots .tag { margin-left:auto; font-size:11px; letter-spacing:0.12em; color:var(--muted); }
.menu .btn:disabled { opacity:0.45; cursor:default; }
.menu .card .d.small { font-size:12px; }
@media (max-width: 760px) {
  .menu .page { padding:32px 16px 24px; }
  .menu h1 { font-size:40px; }
  .menu .settings { flex-direction:column; }
  .menu .tabs { flex-direction:row; flex-wrap:wrap; min-width:0; }
  .menu .row { flex-direction:column; align-items:flex-start; }
  .menu .slider input { width:150px; }
}
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class Menu {
  private readonly root: HTMLDivElement;
  private readonly handlers: MenuHandlers;
  private readonly settings: Settings;
  private progress = new Set<string>();
  private muted = true;
  private page: Page = 'main';
  /** Where Back from a sub-page goes: the main menu or the pause menu. */
  private home: 'main' | 'pause' = 'main';
  private tab: SettingsTab = 'character';
  private preview: SkinPreview | null = null;
  private openedAt = 0;
  private context = '';
  /** The pause menu offers a way back to the map editor (during a playtest). */
  private fromEditor = false;
  /** The pause menu is over an online match: it goes on underneath, and can't be restarted. */
  private inMatch = false;
  private online: OnlineView = { status: 'idle', lobby: null, error: '', ping: null, match: null };
  /** What is typed on the Online page (kept across redraws). */
  private nameField: string;
  private codeField = '';
  private readonly accounts: AccountClient;
  private readonly ui: AccountUi;

  constructor(container: HTMLElement, settings: Settings, handlers: MenuHandlers, accounts: AccountClient) {
    this.settings = settings;
    this.handlers = handlers;
    this.accounts = accounts;
    this.nameField = settings.playerName;
    this.ui = new AccountUi(accounts, {
      redraw: () => {
        if (this.isOpen && (this.page === 'account' || this.page === 'maps' || this.page === 'lobby')) this.show(this.page);
      },
      edit: (data, id) => this.handlers.editAccountMap(data, id),
      useInRoom: (data) => this.handlers.setRoomMap({ kind: 'custom', data }),
      lobbyError: (message) => this.handlers.onlineError(message),
    });
    const style = document.createElement('style');
    style.textContent = CSS + ACCOUNT_CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'menu';
    container.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => this.onFile(e));
    this.root.addEventListener('submit', (e) => {
      e.preventDefault();
      const form = (e.target as HTMLElement).dataset.acctForm;
      if (form) this.ui.submit(form);
    });
    this.root.addEventListener('keydown', (e) => {
      const field = (e.target as HTMLElement).dataset?.field;
      if (e.key !== 'Enter' || !field) return;
      if (field === 'code') this.handlers.joinRoom(this.codeField, this.playerName());
      else this.handlers.createRoom(this.playerName());
    });
    window.addEventListener('keydown', (e) => {
      // The Esc that released the mouse can arrive just after the pause menu opened.
      if (e.code !== 'Escape' || !this.isOpen || performance.now() - this.openedAt < 350) return;
      e.preventDefault();
      this.back();
    });
  }

  get isOpen(): boolean {
    return this.root.classList.contains('open');
  }

  /** `context` is shown on the pause menu: the arena being played. `online`: over an online match. */
  open(home: 'main' | 'pause', context = '', fromEditor = false, online = false): void {
    this.home = home;
    this.context = context;
    this.fromEditor = fromEditor;
    this.inMatch = online;
    this.openedAt = performance.now();
    this.root.classList.add('open');
    this.show(home);
  }

  close(): void {
    this.root.classList.remove('open');
    this.preview?.stop();
  }

  setProgress(done: Set<string>): void {
    this.progress = done;
    if (this.isOpen && (this.page === 'main' || this.page === 'tutorial')) this.show(this.page);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const b = this.root.querySelector('[data-action="mute"]');
    if (b) b.textContent = this.muteLabel();
  }

  /** The Online page, ready to join `code` (an invite link). */
  openOnline(code = ''): void {
    this.codeField = code;
    this.open('main');
    this.show(this.inRoom ? 'lobby' : 'online');
  }

  /** In a room (or getting back into one): the Lobby page rather than the Online page. */
  private get inRoom(): boolean {
    return (this.online.status === 'room' || this.online.status === 'reconnecting') && this.online.lobby !== null;
  }

  /** The latest state of online play: switches between the Online and Lobby pages as it changes. */
  setOnline(view: OnlineView): void {
    const prev = this.online;
    this.online = view;
    if (!this.isOpen || (this.page !== 'online' && this.page !== 'lobby')) return;
    const page: Page = this.inRoom ? 'lobby' : 'online';
    // A new ping reading alone just updates its number (no redraw under the mouse).
    const same = prev.lobby === view.lobby && prev.error === view.error && prev.status === view.status && prev.match === view.match;
    if (page === this.page && same) {
      const ping = this.root.querySelector('[data-el="ping"]');
      if (ping) ping.textContent = this.pingText();
      return;
    }
    this.show(page);
  }

  /** The server said who is logged in (or that nobody is): the pages that show it redraw. */
  setAccount(): void {
    this.ui.userChanged();
    if (this.isOpen && (this.page === 'main' || this.page === 'account' || this.page === 'online' || this.page === 'maps')) this.show(this.page);
  }

  /** The name to play under: the account's, when logged in. */
  private playerName(): string {
    return this.accounts.user?.name ?? this.nameField;
  }

  /** Esc: one page back, or out of the pause menu. */
  back(): void {
    if (this.page === 'lobby') {
      this.handlers.leaveRoom();
      this.show('online');
      return;
    }
    if (this.page === this.home) {
      if (this.home === 'pause') this.handlers.resume();
      return;
    }
    this.show(this.home);
  }

  private muteLabel(): string {
    return this.muted ? '\u{1F507} Sound off' : '\u{1F50A} Sound on';
  }

  private show(page: Page): void {
    if (this.page === 'account' && page !== 'account') this.ui.leftPage();
    this.page = page;
    if (page === 'maps') void this.ui.loadMaps(true);
    this.root.classList.toggle('dim', page !== 'main');
    this.root.classList.toggle('peek', page === 'settings' && (this.tab === 'lighting' || this.tab === 'graphics'));
    if (page !== 'settings' || this.tab !== 'character') this.preview?.stop();
    this.root.innerHTML = `<div class="shade"></div><div class="page">${this.render(page)}</div>`;
    if (page === 'settings' && this.tab === 'character') this.mountPreview();
  }

  private render(page: Page): string {
    const back = `<button class="back" data-action="back">‹ Back</button>`;
    const foot = `<div class="foot"><button class="btn" data-action="mute">${this.muteLabel()}</button>
      <span>M toggles sound in game &middot; Esc opens this menu</span></div>`;
    switch (page) {
      case 'main': {
        const done = ARENAS.filter((a) => this.progress.has(a.id)).length;
        return `
          <div class="eyebrow">Two portals. Every wall a door.</div>
          <h1>P<span class="o">O</span>RTAL ARE<span class="b">N</span>A</h1>
          <div class="stack">
            ${this.item('tutorial', 'Tutorial', `${ARENAS.length} stages &middot; ${done} completed`)}
            ${this.item('pvp', 'PvP Arena <span class="chip">WIP</span>', `${PVP_ARENA.name} &middot; walk the map solo for now`)}
            ${this.item('online', 'Online <span class="chip">WIP</span>', 'Play with friends: create a room or join one with a code')}
            ${this.item('settings', 'Settings', 'Character, graphics, lighting, controls')}
            ${this.item('editor', 'Map editor', 'Build arenas from blocks, hazards and switches')}
            ${this.accounts.user ? this.item('maps', 'My maps', 'Maps you saved online, and the ones players share') : ''}
            ${this.item('account', this.accounts.user ? `Account <span class="chip idle">${esc(this.accounts.user.name)}</span>` : 'Log in', this.accounts.user ? 'Your name, password and saved maps' : 'Register or log in to keep maps online')}
          </div>${foot}`;
      }
      case 'pause':
        return `
          <div class="eyebrow">${esc(this.context)}</div>
          <h2>${this.inMatch ? 'Menu' : 'Paused'}</h2>
          ${this.inMatch ? `<div class="note">The match goes on while this menu is open.</div>` : ''}
          <div class="stack">
            ${this.item('resume', 'Resume', 'Back to the arena')}
            ${this.inMatch ? '' : this.item('restart', 'Restart arena', 'Start this arena again from the spawn')}
            ${this.fromEditor ? this.item('back-editor', 'Back to editor', 'Keep working on this map') : ''}
            ${this.item('settings', 'Settings', 'Character, graphics, lighting, controls')}
            ${this.inMatch ? this.item('main-menu', 'Leave match', 'Back to the main menu (you leave the room)') : this.item('main-menu', 'Main menu', 'Leave this arena')}
          </div>${foot}`;
      case 'tutorial':
        return `${back}
          <div class="eyebrow">Tutorial</div>
          <h2>Choose a stage</h2>
          <div class="stages">
            ${ARENAS.map((a, i) => {
              const done = this.progress.has(a.id);
              return `<button class="stage" data-action="stage" data-index="${i}">
                <div class="n">STAGE ${String(i + 1).padStart(2, '0')}
                  <span class="chip ${done ? 'done' : 'idle'}">${done ? 'COMPLETED' : 'NOT DONE'}</span></div>
                <div class="t">${esc(a.name)}</div>
                <div class="d">${esc(a.blurb ?? '')}</div>
              </button>`;
            }).join('')}
          </div>
          <div class="note">Stages get harder in order, and finishing one carries straight on to the next. Every stage can be played at any time.</div>
          ${foot}`;
      case 'pvp':
        return `${back}
          <div class="eyebrow">Player versus player</div>
          <h2>PvP Arena <span class="chip">${this.settings.botCount === 1 ? '1 v 1 VS BOT' : `FREE FOR ALL &middot; ${this.settings.botCount} BOTS`}</span></h2>
          <div class="card">
            <div class="t">${esc(PVP_ARENA.name)}</div>
            <div class="d">${esc(PVP_ARENA.blurb ?? '')}</div>
            <ul>
              <li class="ok">Scoring: point orbs, portal kill credit, first to ${DEFAULT_RULES.scoreToWin} wins</li>
              <li class="ok">Bot opponents: collect orbs, dodge, set portal traps and go after whoever is nearest or winning. Easy and Normal see and hear no more than you; Hard knows where everyone is</li>
              <li class="ok">Shoot an opponent's portal to steal it</li>
              <li>Online opponents</li>
            </ul>
            <div class="d" style="margin-top:10px">Bots</div>
            <div class="seg" style="margin-top:6px">
              ${Array.from({ length: MAX_BOTS }, (_, i) => i + 1)
                .map((n) => `<button class="${this.settings.botCount === n ? 'on' : ''}" data-action="bot-count" data-count="${n}">${n === 1 ? '1 (1 v 1)' : `${n} (free for all)`}</button>`)
                .join('')}
            </div>
            <div class="d" style="margin-top:10px">Bot difficulty</div>
            <div style="display:flex; gap:8px; margin-top:6px; flex-wrap:wrap">
              ${(['easy', 'normal', 'hard'] as const)
                .map(
                  (d) =>
                    `<button class="btn ${this.settings.botDifficulty === d ? 'primary' : ''}" data-action="pvp-play" data-difficulty="${d}">Play vs ${this.settings.botCount === 1 ? '' : `${this.settings.botCount} `}${d[0].toUpperCase()}${d.slice(1)} bot${this.settings.botCount === 1 ? '' : 's'}</button>`,
                )
                .join('')}
            </div>
          </div>${foot}`;
      case 'online':
        return `${back}${this.renderOnline()}${foot}`;
      case 'lobby':
        return `<button class="back" data-action="back">‹ Leave room</button>${this.renderLobby()}${foot}`;
      case 'account':
        return `${back}${this.ui.renderAccount()}${foot}`;
      case 'maps':
        return `${back}${this.ui.renderMaps()}${foot}`;
      case 'settings':
        return `${back}
          <div class="eyebrow">Options</div>
          <h2>Settings</h2>
          <div class="settings">
            <div class="tabs">
              ${(
                [
                  ['character', 'Character'],
                  ['graphics', 'Graphics'],
                  ['lighting', 'Lighting'],
                  ['controls', 'Controls & sound'],
                ] as const
              )
                .map(([t, label]) => `<button class="tab ${this.tab === t ? 'on' : ''}" data-action="tab" data-tab="${t}">${label}</button>`)
                .join('')}
            </div>
            <div class="pane">${this.renderTab()}</div>
          </div>
          <div class="actions">
            <button class="btn" data-action="reset">Reset ${this.tab === 'controls' ? 'controls' : this.tab} to defaults</button>
          </div>`;
    }
  }

  private pingText(): string {
    return this.online.ping === null ? '' : `ping ${this.online.ping} ms`;
  }

  private renderOnline(): string {
    const busy = this.online.status === 'busy';
    return `
      <div class="eyebrow">Play with friends</div>
      <h2>Online</h2>
      <div class="card">
        ${
          this.accounts.user
            ? `<div class="d">Playing as</div>
        <div class="line"><span class="code-big" style="font-size:24px; letter-spacing:0.08em">${esc(this.accounts.user.name)}</span><button class="btn small" data-action="account">Account</button></div>`
            : `<div class="d">Your name</div>
        <div class="line"><input class="text" data-field="name" maxlength="${NAME_MAX}" placeholder="PLAYER" value="${esc(this.nameField)}" aria-label="Your name">
          <button class="btn small" data-action="account" title="Log in to use your account name and saved maps">Log in</button></div>`
        }
        <div class="t" style="margin-top:22px">Create a room</div>
        <div class="d">You get a code to share. Friends join with it; you pick the map and press Start.</div>
        <div class="line"><button class="btn primary" data-action="create-room" ${busy ? 'disabled' : ''}>Create room</button></div>
        <div class="t" style="margin-top:22px">Join a room</div>
        <div class="line">
          <input class="text code" data-field="code" maxlength="${CODE_LENGTH + 2}" placeholder="CODE" value="${esc(this.codeField)}" aria-label="Room code">
          <button class="btn" data-action="join-room" ${busy ? 'disabled' : ''}>Join</button>
        </div>
        <div class="err">${busy ? '<span style="color:var(--muted)">Connecting…</span>' : esc(this.online.error)}</div>
      </div>
      <div class="note">2-4 players on a combat map, everyone for themselves; bots can fill the empty places. Friends can join a match in progress, and if your connection drops you have ${REJOIN_SECONDS} s to come back to your place.</div>`;
  }

  private renderLobby(): string {
    const lobby = this.online.lobby!;
    const you = lobby.members.find((m) => m.id === lobby.you);
    const host = lobby.members.find((m) => m.host);
    const free = lobby.map.slots - lobby.members.length - lobby.bots;
    const rows: string[] = lobby.members.map((m) => {
      const tags = [m.host ? 'HOST' : '', m.id === lobby.you ? 'YOU' : '', m.away ? 'RECONNECTING' : ''].filter(Boolean).join(' · ');
      return `<li><img src="${previewUrl(m.skin)}" alt="">${esc(m.name)}<span class="tag">${tags}</span></li>`;
    });
    for (let i = 0; i < lobby.bots; i++) rows.push(`<li>${lobby.bots === 1 ? 'BOT' : `BOT ${i + 1}`}<span class="tag">${lobby.difficulty.toUpperCase()} BOT</span></li>`);
    for (let i = 0; i < free; i++) rows.push('<li class="empty">Open slot</li>');

    let controls: string;
    if (this.online.status === 'reconnecting') {
      controls = `<div class="t" style="margin-top:18px">Reconnecting…</div>
        <div class="d">The connection to the game server dropped. Your place is kept for ${REJOIN_SECONDS} s.</div>`;
    } else if (lobby.phase === 'finished') {
      controls = `<div class="t" style="margin-top:18px">Match over</div>
        <div class="d">Everyone comes back here in a moment, and then ${esc(host?.name ?? 'the host')} can start the next one.</div>`;
    } else if (lobby.phase !== 'lobby') {
      controls = `<div class="t" style="margin-top:18px">Match in progress</div>
        <div class="d">On ${esc(lobby.map.name)}. Loading it…</div>`;
    } else if (you?.host) {
      const draft = readEditorDraft();
      const draftPuzzle = draft !== null && mapKind(draft) === 'puzzle';
      const maxBots = lobby.map.slots - lobby.members.length;
      controls = `
        <div class="d" style="margin-top:18px">Map</div>
        <div class="line">
          ${BUILT_IN_ONLINE_MAPS.map((m) => `<button class="btn ${lobby.map.builtin === m.id ? 'primary' : ''}" data-action="room-map" data-map="${m.id}">${esc(m.data.name)}</button>`).join('')}
          ${
            draft
              ? `<button class="btn ${lobby.map.builtin === null && lobby.map.name === draft.name ? 'primary' : ''}" data-action="room-map" data-map="draft" ${draftPuzzle ? 'disabled title="Puzzle maps are single-player"' : ''}>Editor map: ${esc(draft.name)}</button>`
              : ''
          }
          <button class="btn" data-action="room-file">Load .json…</button>
          <input type="file" accept=".json,application/json" data-el="map-file" hidden>
        </div>
        <div style="margin-top:8px">${this.ui.renderPicker()}</div>
        ${draftPuzzle ? '<div class="d small">Your editor map is a puzzle, and puzzle maps are single-player.</div>' : ''}
        <div class="d" style="margin-top:14px">Bots</div>
        <div class="seg" style="margin-top:6px; display:inline-flex">
          ${Array.from({ length: maxBots + 1 }, (_, n) => `<button class="${lobby.bots === n ? 'on' : ''}" data-action="room-bots" data-count="${n}">${n}</button>`).join('')}
        </div>
        <div class="d" style="margin-top:14px">Bot difficulty</div>
        <div class="seg" style="margin-top:6px; display:inline-flex">
          ${BOT_DIFFICULTIES.map((d) => `<button class="${lobby.difficulty === d ? 'on' : ''}" data-action="room-difficulty" data-difficulty="${d}">${d[0].toUpperCase()}${d.slice(1)}</button>`).join('')}
        </div>
        <div class="line" style="margin-top:20px">
          <button class="btn primary" data-action="room-start" ${lobby.members.length + lobby.bots < 2 ? 'disabled title="Add a bot or wait for a friend"' : ''}>Start match</button>
        </div>`;
    } else {
      controls = `<div class="d" style="margin-top:18px">Waiting for ${esc(host?.name ?? 'the host')} to start the match.</div>`;
    }
    return `
      <div class="eyebrow">Online room &middot; <span data-el="ping">${this.pingText()}</span></div>
      <h2><span class="code-big">${esc(lobby.code)}</span><button class="btn" data-action="copy-invite">Copy invite link</button></h2>
      <div class="card">
        <div class="t">${esc(lobby.map.name)}${lobby.map.builtin === null ? ' <span class="chip idle">CUSTOM MAP</span>' : ''}</div>
        <div class="d">${lobby.members.length + lobby.bots} / ${lobby.map.slots} players${free > 0 && lobby.phase === 'lobby' ? ' &middot; share the code to fill the open slots' : ''}</div>
        <ul class="slots">${rows.join('')}</ul>
        ${controls}
        <div class="err">${esc(this.online.error)}</div>
      </div>`;
  }

  /** A map file picked in the lobby: refused here if it's plainly unusable, else sent to the server to check. */
  private onFile(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.dataset.el === 'map-file' ? input.files?.[0] : undefined;
    if (!file) return;
    void file.text().then((text) => {
      let data: MapData | null = null;
      try {
        data = JSON.parse(text) as MapData;
      } catch {
        // Reported below.
      }
      if (!data || !Array.isArray(data.pieces)) this.handlers.onlineError("That file isn't a map.");
      else if (mapKind(data) === 'puzzle') this.handlers.onlineError('Puzzle maps are single-player; online rooms play combat maps.');
      else this.handlers.setRoomMap({ kind: 'custom', data });
    });
  }

  private item(action: string, title: string, desc: string): string {
    return `<button class="item" data-action="${action}"><div class="t">${title}</div><div class="d">${desc}</div></button>`;
  }

  private renderTab(): string {
    const s = this.settings;
    switch (this.tab) {
      case 'character':
        return `<div class="skin">
            <canvas></canvas>
            <div class="skins">
              <div class="name">Character ${s.skin.toUpperCase()}</div>
              <div class="sub" style="color:var(--muted);font-size:13px;margin-top:4px">You see yourself through your own portals.</div>
              <div class="grid">
                ${SKINS.map((k) => `<button class="${k === s.skin ? 'on' : ''}" data-action="skin" data-skin="${k}" title="Character ${k.toUpperCase()}" aria-label="Character ${k.toUpperCase()}"><img src="${previewUrl(k)}" alt=""></button>`).join('')}
              </div>
            </div>
          </div>`;
      case 'graphics':
        return [
          this.segRow('quality', 'Quality', 'Auto lowers resolution and effects to hold the frame rate.', [
            ['auto', 'Auto'],
            ['low', 'Low'],
            ['medium', 'Medium'],
            ['high', 'High'],
          ]),
          this.sliderRow('fov', 'Field of view', 'Vertical, in degrees.', 60, 100, 1, (v) => `${v}°`),
        ].join('');
      case 'lighting':
        return [
          this.sliderRow('brightness', 'Brightness', 'Overall exposure.', 0.5, 1.5, 0.05, pct),
          this.sliderRow('ambient', 'Ambient light', 'Fill light in shadowed areas.', 0, 2, 0.05, pct),
          this.sliderRow('glow', 'Glow', 'Bloom around lasers, acid, portals and lamps.', 0, 2, 0.05, pct),
          this.segRow('shadows', 'Shadows', 'Low uses a coarser shadow map.', [
            ['off', 'Off'],
            ['low', 'Low'],
            ['high', 'High'],
          ]),
        ].join('');
      case 'controls':
        return [
          this.sliderRow('sensitivity', 'Mouse sensitivity', '', 0.2, 3, 0.05, (v) => `${v.toFixed(2)}×`),
          this.segRow('invertY', 'Invert mouse Y', '', [
            ['false', 'Off'],
            ['true', 'On'],
          ]),
          `<div class="row"><div><div class="lbl">Sound</div><div class="sub">Also M in game.</div></div>
            <button class="btn" data-action="mute">${this.muteLabel()}</button></div>`,
        ].join('');
    }
  }

  private segRow(key: keyof Settings, label: string, sub: string, options: ReadonlyArray<readonly [string, string]>): string {
    const current = String(this.settings[key]);
    return `<div class="row"><div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <div class="seg">${options.map(([v, l]) => `<button class="${v === current ? 'on' : ''}" data-action="set" data-key="${key}" data-value="${v}">${l}</button>`).join('')}</div></div>`;
  }

  private readonly formats = new Map<string, (v: number) => string>();

  private sliderRow(key: keyof Settings, label: string, sub: string, min: number, max: number, step: number, format: (v: number) => string): string {
    this.formats.set(key, format);
    const v = this.settings[key] as number;
    return `<div class="row"><div><div class="lbl">${label}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <div class="slider"><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" data-key="${key}" aria-label="${label}"><output>${format(v)}</output></div></div>`;
  }

  private mountPreview(): void {
    const slot = this.root.querySelector('.skin canvas');
    if (!slot) return;
    this.preview ??= new SkinPreview();
    slot.replaceWith(this.preview.element);
    void this.preview.show(this.settings.skin);
    this.preview.start();
  }

  private changed(): void {
    saveSettings(this.settings);
    this.handlers.settingsChanged(this.settings);
  }

  private onInput(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.dataset.acct) {
      this.ui.input(input.dataset.acct, input.value);
      return;
    }
    if (input.dataset.field === 'name') {
      this.nameField = input.value;
      return;
    }
    if (input.dataset.field === 'code') {
      this.codeField = input.value;
      return;
    }
    const key = input.dataset.key as keyof Settings | undefined;
    if (!key) return;
    const v = parseFloat(input.value);
    (this.settings as unknown as Record<string, number>)[key] = v;
    const out = input.parentElement?.querySelector('output');
    if (out) out.textContent = this.formats.get(key)?.(v) ?? String(v);
    this.changed();
  }

  private onClick(e: MouseEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!el) return;
    const a = el.dataset.action!;
    if (a.startsWith('acct-')) {
      this.ui.click(a, el);
      return;
    }
    switch (a) {
      case 'account':
      case 'maps':
        this.show(a);
        break;
      case 'back':
        this.back();
        break;
      case 'tutorial':
      case 'pvp':
      case 'settings':
        this.show(a);
        break;
      case 'online':
        this.show(this.inRoom ? 'lobby' : 'online');
        break;
      case 'create-room':
        this.handlers.createRoom(this.playerName());
        break;
      case 'join-room':
        this.handlers.joinRoom(this.codeField, this.playerName());
        break;
      case 'copy-invite': {
        const code = this.online.lobby?.code;
        if (!code) break;
        const link = `${location.origin}${location.pathname}?room=${code}`;
        navigator.clipboard?.writeText(link).then(
          () => (el.textContent = 'Link copied'),
          () => this.handlers.onlineError(`Couldn't copy it - the link is ${link}`),
        );
        break;
      }
      case 'room-map': {
        const id = el.dataset.map!;
        const draft = id === 'draft' ? readEditorDraft() : null;
        if (draft) this.handlers.setRoomMap({ kind: 'custom', data: draft });
        else if (id !== 'draft') this.handlers.setRoomMap({ kind: 'builtin', id });
        break;
      }
      case 'room-file':
        this.root.querySelector<HTMLInputElement>('[data-el="map-file"]')?.click();
        break;
      case 'room-bots':
        if (this.online.lobby) this.handlers.setRoomBots(Number(el.dataset.count), this.online.lobby.difficulty);
        break;
      case 'room-difficulty':
        if (this.online.lobby) this.handlers.setRoomBots(this.online.lobby.bots, el.dataset.difficulty as BotDifficulty);
        break;
      case 'room-start':
        this.handlers.startMatch();
        break;
      case 'stage':
        this.handlers.playStage(Number(el.dataset.index));
        break;
      case 'pvp-play': {
        const d = el.dataset.difficulty;
        if (d === 'easy' || d === 'normal' || d === 'hard') {
          this.settings.botDifficulty = d;
          saveSettings(this.settings);
        }
        this.handlers.playPvp();
        break;
      }
      case 'bot-count': {
        const n = Number(el.dataset.count);
        if (n >= 1 && n <= MAX_BOTS) {
          this.settings.botCount = n;
          saveSettings(this.settings);
        }
        this.show('pvp');
        break;
      }
      case 'resume':
        this.handlers.resume();
        break;
      case 'restart':
        this.handlers.restart();
        break;
      case 'main-menu':
        this.handlers.mainMenu();
        break;
      case 'editor':
        this.handlers.openEditor();
        break;
      case 'back-editor':
        this.handlers.backToEditor();
        break;
      case 'mute':
        this.handlers.toggleMute();
        break;
      case 'tab':
        this.tab = el.dataset.tab as SettingsTab;
        this.show('settings');
        break;
      case 'skin':
        this.settings.skin = el.dataset.skin!;
        this.changed();
        this.root.querySelectorAll('.grid button').forEach((b) => b.classList.toggle('on', b === el));
        this.root.querySelector('.skins .name')!.textContent = `Character ${this.settings.skin.toUpperCase()}`;
        void this.preview?.show(this.settings.skin);
        break;
      case 'set': {
        const key = el.dataset.key as keyof Settings;
        const raw = el.dataset.value!;
        (this.settings as unknown as Record<string, unknown>)[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
        this.changed();
        el.parentElement!.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === el));
        break;
      }
      case 'reset': {
        const keys: Record<SettingsTab, (keyof Settings)[]> = {
          character: ['skin'],
          graphics: ['quality', 'fov'],
          lighting: ['brightness', 'ambient', 'glow', 'shadows'],
          controls: ['sensitivity', 'invertY'],
        };
        for (const k of keys[this.tab]) (this.settings as unknown as Record<string, unknown>)[k] = DEFAULT_SETTINGS[k];
        this.changed();
        this.show('settings');
        break;
      }
    }
  }
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}
