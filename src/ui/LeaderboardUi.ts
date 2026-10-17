import { AccountError, type AccountClient } from '../net/AccountClient';
import type { BoardEntry, BoardReply } from '../net/leaderboard';
import { formatDelta, formatTime } from '../sim/Speedrun';
import { SPEEDRUNS } from '../world/arenas';

/** The leaderboard page's menu: what it needs to draw itself again when its data arrives. */
export interface LeaderboardUiHost {
  redraw(): void;
}

export const LEADERBOARD_CSS = `
.menu .board { width:100%; border-collapse:collapse; margin-top:14px; font-variant-numeric:tabular-nums; }
.menu .board th { text-align:left; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; color:var(--muted); font-weight:600; padding:4px 10px; }
.menu .board td { padding:7px 10px; border-top:1px solid var(--line); font-size:15px; }
.menu .board .rk { width:44px; color:var(--muted); }
.menu .board .tm { text-align:right; font-weight:700; }
.menu .board .dl { text-align:right; color:var(--muted); font-size:13px; }
.menu .board tr.me td { background:rgba(255,255,255,0.07); }
.menu .board tr.gap td { text-align:center; color:var(--muted); padding:2px; border-top:none; letter-spacing:0.3em; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function messageOf(e: unknown): string {
  return e instanceof AccountError ? e.message : (e as Error).message || 'Something went wrong.';
}

/**
 * The Leaderboards page: the fastest run of each player on a speedrun course, one tab a course.
 * It handles the clicks the menu hands over (`board-...`).
 */
export class LeaderboardUi {
  private readonly accounts: AccountClient;
  private readonly host: LeaderboardUiHost;
  private course = SPEEDRUNS[0]?.id ?? '';
  private readonly boards = new Map<string, BoardReply>();
  private loading = false;
  private error = '';

  constructor(accounts: AccountClient, host: LeaderboardUiHost) {
    this.accounts = accounts;
    this.host = host;
  }

  /** Opens the page on a course (by id) if it is one of ours. */
  show(course?: string): void {
    if (course && SPEEDRUNS.some((a) => a.id === course)) this.course = course;
  }

  /** The server said who we are: the boards (and our row on them) are stale. */
  userChanged(): void {
    this.boards.clear();
    this.error = '';
  }

  /** Fetches the board shown (the page asks each time it is opened). */
  async load(): Promise<void> {
    const course = this.course;
    if (!course) return;
    this.loading = true;
    this.error = '';
    this.host.redraw();
    try {
      this.boards.set(course, await this.accounts.leaderboard(course));
    } catch (e) {
      this.error = messageOf(e);
    } finally {
      this.loading = false;
      this.host.redraw();
    }
  }

  render(): string {
    const tabs = SPEEDRUNS.map(
      (a) => `<button class="btn small ${a.id === this.course ? 'primary' : ''}" data-action="board-course" data-id="${esc(a.id)}">${esc(a.name)}</button>`,
    ).join('');
    const board = this.boards.get(this.course);
    let body: string;
    if (!board) body = `<div class="d" style="margin-top:14px">${this.loading ? 'Loading…' : ''}</div>`;
    else if (board.entries.length === 0) body = '<div class="d" style="margin-top:14px">Nobody has a time on this course yet.</div>';
    else body = this.table(board);
    const hint = this.accounts.user
      ? 'Your fastest run on each course is kept; finishing a faster one moves you up.'
      : 'Log in (main menu) and your finished runs are put on the boards.';
    return `
      <div class="eyebrow">Speedrun</div>
      <h2>Leaderboards</h2>
      <div class="card wide">
        <div class="pill-row" style="margin-top:0">${tabs}</div>
        <div class="line" style="margin-top:12px">
          <span class="d">${board ? `${board.total} runner${board.total === 1 ? '' : 's'}` : ''}</span>
          <button class="btn small" data-action="board-refresh" ${this.loading ? 'disabled' : ''}>Refresh</button>
        </div>
        ${body}
        <div class="err">${esc(this.error)}</div>
      </div>
      <div class="note">${hint}</div>`;
  }

  private table(board: BoardReply): string {
    const leader = board.entries[0].time;
    const mine = this.accounts.user?.id;
    const row = (e: BoardEntry) =>
      `<tr class="${e.userId === mine ? 'me' : ''}"><td class="rk">${e.rank}</td><td>${esc(e.name)}</td><td class="tm">${formatTime(e.time)}</td><td class="dl">${e.rank === 1 ? '' : formatDelta(e.time - leader)}</td></tr>`;
    const you = board.you && !board.entries.some((e) => e.userId === board.you!.userId) ? board.you : null;
    return `<table class="board"><thead><tr><th>#</th><th>Runner</th><th style="text-align:right">Time</th><th style="text-align:right">Behind</th></tr></thead><tbody>
      ${board.entries.map(row).join('')}
      ${you ? `<tr class="gap"><td colspan="4">&middot; &middot; &middot;</td></tr>${row(you)}` : ''}
    </tbody></table>`;
  }

  /** A click on a `board-...` action. */
  click(action: string, el: HTMLElement): void {
    if (action === 'board-refresh') {
      void this.load();
    } else if (action === 'board-course') {
      this.show(el.dataset.id);
      if (this.boards.has(this.course)) this.host.redraw();
      else void this.load();
    }
  }
}
