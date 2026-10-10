import { AccountError, type AccountClient } from '../net/AccountClient';
import { RIGHTS, type AdminUser, type Right } from '../net/accounts';

/** The admin page's menu: what it needs to draw itself again after a change. */
export interface AdminUiHost {
  redraw(): void;
}

const RIGHT_LABELS: Record<Right, string> = { 'generate-maps': 'Map generator' };
const RIGHT_HINTS: Record<Right, string> = {
  'generate-maps': 'Lets the player describe a map and have Claude build it (costs money, so it is limited per day)',
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function messageOf(e: unknown): string {
  return e instanceof AccountError ? e.message : (e as Error).message || 'Something went wrong.';
}

/**
 * The Admin page: the players, and which rights each one has. Only an admin gets here; the
 * server checks every request again. It handles the clicks the menu hands over (`admin-...`).
 */
export class AdminUi {
  private readonly accounts: AccountClient;
  private readonly host: AdminUiHost;
  private players: AdminUser[] | null = null;
  private error = '';
  private busy = false;

  constructor(accounts: AccountClient, host: AdminUiHost) {
    this.accounts = accounts;
    this.host = host;
  }

  /** The server said who we are: the list from before is stale. */
  userChanged(): void {
    this.players = null;
    this.error = '';
  }

  /** Fetches the player list (the page asks each time it is opened). */
  async load(): Promise<void> {
    if (!this.accounts.isAdmin) return;
    this.error = '';
    try {
      this.players = await this.accounts.listPlayers();
    } catch (e) {
      this.players = this.players ?? [];
      this.error = messageOf(e);
    }
    this.host.redraw();
  }

  render(): string {
    if (!this.accounts.isAdmin) {
      return `<div class="eyebrow">Administration</div>
        <h2>Admin</h2>
        <div class="card"><div class="d">Only admins can see this page. Log in with an admin account.</div></div>`;
    }
    const list = this.players;
    let body: string;
    if (list === null) body = '<div class="d">Loading…</div>';
    else if (list.length === 0) body = '<div class="d">No players yet.</div>';
    else body = `<ul class="maplist">${list.map((p) => this.row(p)).join('')}</ul>`;
    return `
      <div class="eyebrow">Administration</div>
      <h2>Players</h2>
      <div class="card wide">
        <div class="d">Give players the rights they need. Admins have every right, so there is nothing to set for them.</div>
        <div class="line" style="margin-top:12px">
          <button class="btn small" data-action="admin-refresh" ${this.busy ? 'disabled' : ''}>Refresh</button>
        </div>
        ${body}
        <div class="err">${esc(this.error)}</div>
      </div>
      <div class="note">${RIGHTS.map((r) => `<b>${RIGHT_LABELS[r]}</b>: ${RIGHT_HINTS[r]}.`).join(' ')} Players get the rights on top of their own role, and keep them until you take them away.</div>`;
  }

  private row(p: AdminUser): string {
    const seen = p.lastLoginAt === null ? 'never logged in' : `last login ${new Date(p.lastLoginAt).toLocaleDateString()}`;
    const today = `${p.generationsToday} map${p.generationsToday === 1 ? '' : 's'} generated in the last day`;
    const details = `${p.role === 'admin' ? 'admin' : 'player'} · ${seen}${p.disabled ? ' · DISABLED' : ''} · ${today}`;
    let actions: string;
    if (p.role === 'admin') {
      actions = '<span class="chip">ADMIN · ALL RIGHTS</span>';
    } else {
      actions = RIGHTS.map((r) => {
        const has = p.rights.includes(r);
        return `<button class="btn small ${has ? 'primary' : ''}" data-action="admin-right" data-id="${p.id}" data-right="${r}" title="${esc(RIGHT_HINTS[r])}" ${this.busy ? 'disabled' : ''}>${RIGHT_LABELS[r]}: ${has ? 'on' : 'off'}</button>`;
      }).join('');
    }
    return `<li><div class="mn">${esc(p.name)}<small>${details}</small></div><div class="acts">${actions}</div></li>`;
  }

  /** A click on an `admin-...` action. */
  click(action: string, el: HTMLElement): void {
    if (action === 'admin-refresh') {
      void this.load();
      return;
    }
    if (action === 'admin-right') {
      const id = Number(el.dataset.id);
      const right = el.dataset.right as Right;
      const player = this.players?.find((p) => p.id === id);
      if (player && RIGHTS.includes(right)) void this.setRight(player, right, !player.rights.includes(right));
    }
  }

  private async setRight(player: AdminUser, right: Right, on: boolean): Promise<void> {
    const rights = on ? [...player.rights, right] : player.rights.filter((r) => r !== right);
    this.busy = true;
    this.error = '';
    this.host.redraw();
    try {
      const updated = await this.accounts.setRights(player.id, rights);
      this.players = (this.players ?? []).map((p) => (p.id === updated.id ? updated : p));
    } catch (e) {
      this.error = messageOf(e);
    } finally {
      this.busy = false;
      this.host.redraw();
    }
  }
}
