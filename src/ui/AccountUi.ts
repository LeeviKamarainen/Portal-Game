import { AccountError, type AccountClient } from '../net/AccountClient';
import { passwordProblem, userNameProblem, USER_NAME_MAX, PASSWORD_MIN, type MapSummary, type Visibility } from '../net/accounts';
import { mapKind, type MapData } from '../world/maps/MapFormat';

/** What the account pages need from the menu around them. */
export interface AccountUiHost {
  /** Draw the current page again (after something loaded or changed). */
  redraw(): void;
  /** Open the map editor on `data`; `id` is the saved map it came from (so Save updates it), or null for a copy. */
  edit(data: MapData, id: string | null): void;
  /** The host of the online room picked this map. */
  useInRoom(data: MapData): void;
  /** Something went wrong with a pick made in the lobby. */
  lobbyError(message: string): void;
}

export const ACCOUNT_CSS = `
.menu .card.wide { max-width:760px; }
.menu .stack-v { display:flex; flex-direction:column; gap:10px; margin-top:12px; align-items:flex-start; }
.menu input.text.full { width:min(320px, 100%); box-sizing:border-box; }
.menu .who { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.menu .who .name { font-size:26px; font-weight:700; letter-spacing:0.04em; }
.menu .ok { margin-top:14px; color:#58d68d; font-size:14px; min-height:1em; }
.menu .maplist { list-style:none; padding:0; margin:14px 0 4px; display:flex; flex-direction:column; gap:6px; }
.menu .maplist li { display:flex; align-items:center; gap:12px; padding:9px 12px; border:1px solid var(--line); border-radius:6px; flex-wrap:wrap; }
.menu .card ul.maplist { margin:14px 0 4px; gap:6px; }
.menu .card .maplist li::before { content:none; }
.menu .maplist .mn { font-size:16px; font-weight:600; min-width:120px; flex:1; }
.menu .maplist .mn small { display:block; font-size:12px; font-weight:400; color:var(--muted); margin-top:2px; }
.menu .maplist .acts { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.menu .btn.small { padding:5px 10px; font-size:13px; }
.menu .btn.danger { border-color:#c0504a; color:#ff9a8f; }
.menu .btn.danger.armed { background:#c0504a; color:#fff; }
.menu .pill-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const RIGHT_LABELS: Record<string, string> = { 'generate-maps': 'MAP GENERATOR' };

function messageOf(e: unknown): string {
  return e instanceof AccountError ? e.message : (e as Error).message || 'Something went wrong.';
}

/**
 * The Account and My maps pages and the lobby's saved-map picker. It draws HTML for the menu
 * and handles the clicks and form submits the menu hands over (everything named `acct-...`).
 */
export class AccountUi {
  private readonly accounts: AccountClient;
  private readonly host: AccountUiHost;
  private mode: 'login' | 'register' = 'login';
  private fields = { name: '', password: '', again: '', current: '', next: '' };
  private busy = false;
  private error = '';
  private notice = '';

  private tab: 'mine' | 'public' = 'mine';
  private mine: MapSummary[] | null = null;
  private pub: MapSummary[] | null = null;
  private mapsError = '';
  private armed = '';
  private pickerOpen = false;

  constructor(accounts: AccountClient, host: AccountUiHost) {
    this.accounts = accounts;
    this.host = host;
  }

  // ---------------------------------------------------------------- the Account page

  /** The server said who we are (or that we are nobody): lists of maps from before are stale. */
  userChanged(): void {
    this.mine = null;
    this.pub = null;
    this.armed = '';
  }

  leftPage(): void {
    this.error = '';
    this.notice = '';
    this.armed = '';
  }

  renderAccount(): string {
    const user = this.accounts.user;
    let card: string;
    if (!this.accounts.available && !user) {
      card = `<div class="t">No game server</div>
        <div class="d">Accounts, saved maps and online rooms need the game server, and this page can't reach one. Start it with <b>npm run server</b>, or open the game from the server's address.</div>`;
    } else if (user) {
      card = `
        <div class="who"><span class="name">${esc(user.name)}</span>
          <span class="chip ${user.role === 'admin' ? '' : 'idle'}">${user.role === 'admin' ? 'ADMIN' : 'PLAYER'}</span>
          ${user.role === 'admin' ? '' : user.rights.map((r) => `<span class="chip">${RIGHT_LABELS[r] ?? esc(r)}</span>`).join('')}
        </div>
        <div class="d">Your name in online rooms, and your saved maps, belong to this account.</div>
        <div class="line" style="margin-top:14px">
          <button class="btn primary" data-action="maps">My maps</button>
          <button class="btn" data-action="acct-logout" ${this.busy ? 'disabled' : ''}>Log out</button>
        </div>
        <div class="t" style="margin-top:26px">Change password</div>
        <form data-acct-form="password" class="stack-v" autocomplete="off">
          <input class="text full" type="password" data-acct="current" placeholder="Current password" autocomplete="current-password" maxlength="128" value="${esc(this.fields.current)}" aria-label="Current password">
          <input class="text full" type="password" data-acct="next" placeholder="New password (${PASSWORD_MIN}+ characters)" autocomplete="new-password" maxlength="128" value="${esc(this.fields.next)}" aria-label="New password">
          <button class="btn" type="submit" ${this.busy ? 'disabled' : ''}>Change password</button>
        </form>`;
    } else {
      const register = this.mode === 'register';
      card = `
        <div class="seg" style="display:inline-flex">
          <button class="${register ? '' : 'on'}" data-action="acct-mode" data-mode="login">Log in</button>
          <button class="${register ? 'on' : ''}" data-action="acct-mode" data-mode="register">Register</button>
        </div>
        <div class="d" style="margin-top:12px">${
          register
            ? `Pick a name (${USER_NAME_MAX} characters at most) - it is what other players see in rooms.`
            : 'Log in to use your name in rooms and to keep maps online.'
        }</div>
        <form data-acct-form="${register ? 'register' : 'login'}" class="stack-v">
          <input class="text full" type="text" data-acct="name" placeholder="Name" autocomplete="username" maxlength="${USER_NAME_MAX}" value="${esc(this.fields.name)}" aria-label="Name">
          <input class="text full" type="password" data-acct="password" placeholder="Password" autocomplete="${register ? 'new-password' : 'current-password'}" maxlength="128" value="${esc(this.fields.password)}" aria-label="Password">
          ${register ? `<input class="text full" type="password" data-acct="again" placeholder="Password again" autocomplete="new-password" maxlength="128" value="${esc(this.fields.again)}" aria-label="Password again">` : ''}
          <button class="btn primary" type="submit" ${this.busy ? 'disabled' : ''}>${register ? 'Create account' : 'Log in'}</button>
        </form>`;
    }
    return `
      <div class="eyebrow">Your account</div>
      <h2>Account</h2>
      <div class="card">
        ${card}
        <div class="err">${esc(this.error)}</div>
        <div class="ok">${esc(this.notice)}</div>
      </div>
      <div class="note">Playing online works without an account. An account keeps your name to yourself and lets you save maps online, to open from any computer or share with everyone.</div>`;
  }

  // ---------------------------------------------------------------- the My maps page

  /** Fetches the lists the page and the lobby picker show. */
  async loadMaps(force = false): Promise<void> {
    if (!force && this.pub !== null && (this.mine !== null || !this.accounts.user)) return;
    this.mapsError = '';
    try {
      const [mine, pub] = await Promise.all([this.accounts.user ? this.accounts.listMine() : Promise.resolve([]), this.accounts.listPublic()]);
      this.mine = mine;
      this.pub = pub;
    } catch (e) {
      this.mine = this.mine ?? [];
      this.pub = this.pub ?? [];
      this.mapsError = messageOf(e);
    }
    this.host.redraw();
  }

  renderMaps(): string {
    const user = this.accounts.user;
    const list = this.tab === 'mine' ? this.mine : this.pub;
    let body: string;
    if (this.tab === 'mine' && !user) {
      body = `<div class="d">Log in to save maps online and find them again here.</div>
        <div class="line"><button class="btn primary" data-action="account">Log in or register</button></div>`;
    } else if (list === null) {
      body = '<div class="d">Loading…</div>';
    } else if (list.length === 0) {
      body =
        this.tab === 'mine'
          ? '<div class="d">No saved maps yet. In the map editor, press <b>Save online</b>.</div>'
          : '<div class="d">Nobody has shared a map yet.</div>';
    } else {
      body = `<ul class="maplist">${list.map((m) => this.row(m, this.tab === 'mine')).join('')}</ul>`;
    }
    return `
      <div class="eyebrow">Saved online</div>
      <h2>Maps</h2>
      <div class="card wide">
        <div class="seg" style="display:inline-flex">
          <button class="${this.tab === 'mine' ? 'on' : ''}" data-action="acct-tab" data-tab="mine">My maps</button>
          <button class="${this.tab === 'public' ? 'on' : ''}" data-action="acct-tab" data-tab="public">Shared by players</button>
        </div>
        ${body}
        <div class="err">${esc(this.mapsError)}</div>
      </div>
      <div class="note">Open a map in the editor to change it; pick it as the map of an online room from the room's lobby. Shared maps open as a copy of your own.</div>`;
  }

  private row(m: MapSummary, mine: boolean): string {
    const when = new Date(m.updatedAt).toLocaleDateString();
    const sub = mine ? `updated ${when}` : `by ${esc(m.ownerName)} &middot; ${when}`;
    const actions = mine
      ? `<div class="seg">
           ${(['private', 'public'] as const)
             .map((v) => `<button class="${m.visibility === v ? 'on' : ''}" data-action="acct-vis" data-id="${m.id}" data-vis="${v}" title="${v === 'public' ? 'Everyone can find and use it' : 'Only you'}">${v === 'public' ? 'Shared' : 'Private'}</button>`)
             .join('')}
         </div>
         <button class="btn small" data-action="acct-edit" data-id="${m.id}">Edit</button>
         <button class="btn small danger ${this.armed === m.id ? 'armed' : ''}" data-action="acct-delete" data-id="${m.id}">${this.armed === m.id ? 'Really delete?' : 'Delete'}</button>`
      : `<button class="btn small" data-action="acct-edit" data-id="${m.id}">Open copy in editor</button>`;
    return `<li><div class="mn">${esc(m.name)}<small>${sub}</small></div><div class="acts">${actions}</div></li>`;
  }

  // ---------------------------------------------------------------- the lobby's picker

  /** For the room host: a button that lists saved maps to play on. */
  renderPicker(): string {
    const button = `<button class="btn" data-action="acct-picker">${this.pickerOpen ? 'Hide saved maps' : 'Saved maps…'}</button>`;
    if (!this.pickerOpen) return button;
    const group = (title: string, list: MapSummary[] | null, empty: string, yours: boolean) =>
      `<div class="d" style="margin-top:10px">${title}</div>` +
      (list === null
        ? '<div class="d small">Loading…</div>'
        : list.length === 0
          ? `<div class="d small">${empty}</div>`
          : `<ul class="maplist">${list.map((m) => `<li><div class="mn">${esc(m.name)}<small>${yours ? 'yours' : `by ${esc(m.ownerName)}`}</small></div><div class="acts"><button class="btn small" data-action="acct-use" data-id="${m.id}">Use</button></div></li>`).join('')}</ul>`);
    const mineGroup = this.accounts.user ? group('Your maps', this.mine, 'You have no saved maps.', true) : '<div class="d small" style="margin-top:10px">Log in (main menu → Account) to use your own saved maps.</div>';
    return `${button}${mineGroup}${group('Shared by players', this.pub, 'Nobody has shared a map yet.', false)}<div class="err">${esc(this.mapsError)}</div>`;
  }

  // ---------------------------------------------------------------- input from the menu

  input(field: string, value: string): void {
    if (field in this.fields) this.fields[field as keyof typeof this.fields] = value;
  }

  /** A click on an `acct-...` action. */
  click(action: string, el: HTMLElement): void {
    switch (action) {
      case 'acct-mode':
        this.mode = el.dataset.mode === 'register' ? 'register' : 'login';
        this.error = '';
        this.host.redraw();
        break;
      case 'acct-logout':
        void this.run(async () => {
          await this.accounts.logout();
          this.mode = 'login';
          this.userChanged();
        });
        break;
      case 'acct-tab':
        this.tab = el.dataset.tab === 'public' ? 'public' : 'mine';
        this.armed = '';
        this.host.redraw();
        break;
      case 'acct-vis':
        void this.changeMap(async () => {
          await this.accounts.updateMap(el.dataset.id!, { visibility: el.dataset.vis as Visibility });
          await this.loadMaps(true);
        });
        break;
      case 'acct-delete': {
        const id = el.dataset.id!;
        if (this.armed !== id) {
          this.armed = id;
          this.host.redraw();
          break;
        }
        this.armed = '';
        void this.changeMap(async () => {
          await this.accounts.deleteMap(id);
          await this.loadMaps(true);
        });
        break;
      }
      case 'acct-edit':
        void this.changeMap(async () => {
          const map = await this.accounts.getMap(el.dataset.id!);
          this.host.edit(map.data as MapData, map.ownerId === this.accounts.user?.id ? map.id : null);
        });
        break;
      case 'acct-picker':
        this.pickerOpen = !this.pickerOpen;
        this.host.redraw();
        if (this.pickerOpen) void this.loadMaps(true);
        break;
      case 'acct-use':
        void this.useInRoom(el.dataset.id!);
        break;
    }
  }

  /** A form was submitted (Enter or its button). */
  submit(form: string): void {
    const f = this.fields;
    if (form === 'login') {
      if (!f.name.trim() || !f.password) return this.fail('Type your name and password.');
      void this.run(async () => {
        await this.accounts.login(f.name.trim(), f.password);
        this.signedIn('Logged in.');
      });
    } else if (form === 'register') {
      const problem = userNameProblem(f.name.trim()) ?? passwordProblem(f.password) ?? (f.password !== f.again ? 'The two passwords differ.' : null);
      if (problem) return this.fail(problem);
      void this.run(async () => {
        await this.accounts.register(f.name.trim(), f.password);
        this.signedIn('Account created - you are logged in.');
      });
    } else if (form === 'password') {
      const problem = f.current ? passwordProblem(f.next) : 'Type your current password.';
      if (problem) return this.fail(problem);
      void this.run(async () => {
        await this.accounts.changePassword(f.current, f.next);
        f.current = f.next = '';
        this.notice = 'Password changed. Your other logins have ended.';
      });
    }
  }

  private signedIn(notice: string): void {
    this.fields = { name: '', password: '', again: '', current: '', next: '' };
    this.userChanged();
    this.notice = notice;
  }

  private fail(message: string): void {
    this.error = message;
    this.notice = '';
    this.host.redraw();
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.error = '';
    this.notice = '';
    this.host.redraw();
    try {
      await task();
    } catch (e) {
      this.error = messageOf(e);
    } finally {
      this.busy = false;
      this.host.redraw();
    }
  }

  /** A map action on the My maps page: its failure shows under the list. */
  private async changeMap(task: () => Promise<void>): Promise<void> {
    this.mapsError = '';
    try {
      await task();
    } catch (e) {
      this.mapsError = messageOf(e);
      this.host.redraw();
    }
  }

  private async useInRoom(id: string): Promise<void> {
    try {
      const data = (await this.accounts.getMap(id)).data as MapData;
      if (mapKind(data) === 'puzzle') this.host.lobbyError('Puzzle maps are single-player; online rooms play combat maps.');
      else this.host.useInRoom(data);
    } catch (e) {
      this.host.lobbyError(messageOf(e));
    }
  }
}
