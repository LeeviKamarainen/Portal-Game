import type { MapData } from '../world/maps/MapFormat';
import { blankMap, blankPuzzle } from './templates';
import { GEN_PROMPT_MAX, GEN_PROMPT_MIN, type ChatMessage, type GenKind, type GenQuota, type GenSize, type GenStartRequest, type JobEvent, type PublicOutcome } from '../net/generate';

/**
 * The editor's map assistant: a chat drawer in the bottom-right corner. You say what you want
 * ("a puzzle that needs two portal hops", "make the bridge longer", "put acid under it"), the
 * model changes the map in the editor with its tools, and the pieces it touches are redrawn as
 * it works - nothing else is. Each answer is one undo step. The conversation is kept in this
 * panel and sent back with every message, so "make it bigger" means what it should.
 */

/** What the panel needs from the page: the generator on the server. */
export interface GeneratorService {
  /** The logged-in user has the right. */
  allowed(): boolean;
  quota(): Promise<GenQuota>;
  start(request: GenStartRequest): Promise<{ jobId: string; quota: GenQuota }>;
  watch(jobId: string, onEvent: (event: JobEvent) => void, onLost: (message: string) => void): () => void;
  cancel(jobId: string): Promise<void>;
}

/** What the panel needs from the editor. */
export interface GenerateHost {
  /** The map being edited: what the next message is about. */
  currentMap(): MapData;
  /** Editing is locked from here until `end`. */
  begin(): void;
  /** The map after one of the assistant's edits: the pieces that differ are redrawn. */
  liveMap(map: MapData, ok: boolean): void;
  /** Editing is unlocked. `map` becomes the editor's (undoable); null puts back what was there. */
  end(map: MapData | null, options: { keepSavedLink: boolean }): void;
  status(text: string, error?: boolean): void;
}

const NEW_EXAMPLES = [
  'A puzzle that needs at least two portal hops, with a laser and a locked door',
  'PvP arena with big height differences and acid under floating platforms',
  'A small symmetric arena with a deep central pit and portal walls on both sides',
];
const EDIT_EXAMPLES = ['Make the height differences bigger', 'Add acid under the bridge', 'Why can\'t I reach the exit?', 'Add more portal walls'];

const SIZE_KEY = 'portal.assistant.size';
const HISTORY_KEY = 'portal.assistant.history';
const DEFAULT_SIZE = { w: 400, h: 540 };
const MIN_SIZE = { w: 320, h: 260 };

const CSS = `
.gen { position:absolute; right:316px; bottom:40px; width:400px; height:540px; display:none; box-sizing:border-box; flex-direction:column; z-index:6;
  background:var(--panel); border:1px solid var(--line); border-radius:10px; box-shadow:0 12px 36px rgba(0,0,0,0.5); overflow:hidden; }
.gen.on { display:flex; }
.gen .grip { position:absolute; left:0; top:0; width:18px; height:18px; cursor:nwse-resize; z-index:2; touch-action:none; }
.gen .grip::before { content:''; position:absolute; left:4px; top:4px; width:9px; height:9px; border-left:2px solid var(--muted); border-top:2px solid var(--muted); border-radius:2px 0 0 0; opacity:0.6; }
.gen .grip:hover::before { opacity:1; border-color:var(--text); }
.gen .head { display:flex; align-items:center; gap:8px; padding:9px 10px 8px 26px; border-bottom:1px solid var(--line); flex-shrink:0; }
.gen .head b { font-size:14px; white-space:nowrap; }
.gen .head .quota { color:var(--muted); font-size:11px; margin-left:auto; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.gen .head .quota.low { color:#ffcf70; }
.gen .head button { background:none; border:none; cursor:pointer; color:var(--muted); font-size:13px; padding:2px 6px; border-radius:4px; white-space:nowrap; }
.gen .head button:hover { color:var(--text); background:rgba(255,255,255,0.08); }
.gen .list { flex:1; overflow:auto; padding:10px 12px; display:flex; flex-direction:column; gap:8px; min-height:0; }
.gen .hello { color:var(--muted); line-height:1.5; }
.gen .msg { max-width:92%; padding:7px 10px; border-radius:10px; line-height:1.45; overflow-wrap:anywhere; }
.gen .msg.user { align-self:flex-end; background:rgba(42,184,255,0.18); border:1px solid rgba(42,184,255,0.35); white-space:pre-wrap; }
.gen .msg.ai { align-self:flex-start; background:rgba(255,255,255,0.06); border:1px solid var(--line); }
.gen .msg p { margin:0 0 6px; }
.gen .msg p:last-child, .gen .msg ul:last-child, .gen .msg ol:last-child { margin-bottom:0; }
.gen .msg ul, .gen .msg ol { margin:4px 0 6px; padding-left:20px; }
.gen .msg code { background:rgba(0,0,0,0.35); padding:0 4px; border-radius:3px; font-size:12px; }
.gen .msg h4 { margin:6px 0 4px; font-size:13px; }
.gen .act { align-self:flex-start; font-size:12px; color:var(--muted); padding-left:4px; max-width:96%; }
.gen .act .l { display:flex; gap:6px; }
.gen .act .l::before { content:'✓'; color:#8de0a8; flex-shrink:0; }
.gen .act.bad .l::before { content:'!'; color:#ffb060; }
.gen .act .why { display:block; color:#ffb3b3; font-size:11px; margin:1px 0 0 14px; overflow-wrap:anywhere; }
.gen .act details { margin:2px 0 0 14px; }
.gen .act summary { cursor:pointer; color:#7fdcff; font-size:11px; }
.gen .act pre { margin:3px 0 0; padding:5px 7px; max-height:150px; overflow:auto; background:rgba(0,0,0,0.3); border-radius:4px; font-size:11px; line-height:1.4; white-space:pre-wrap; color:#aeb8cb; }
.gen .note { align-self:stretch; font-size:12px; padding:6px 9px; border-radius:6px; background:rgba(255,255,255,0.05); line-height:1.4; }
.gen .note.warn { border-left:3px solid #ffb060; color:#ffe2bd; }
.gen .note.err { border-left:3px solid #ff6b6b; color:#ffd0d0; }
.gen .note.ok { border-left:3px solid #8de0a8; }
.gen .note ul { margin:3px 0 0; padding-left:18px; }
.gen .note .meta { color:var(--muted); font-size:11px; margin-top:3px; }
.gen .working { display:flex; align-items:center; gap:8px; color:var(--muted); font-size:12px; padding:0 2px; }
.gen .working i { width:8px; height:8px; border-radius:50%; background:var(--accent); animation:genpulse 0.9s infinite alternate; }
@keyframes genpulse { from { opacity:0.25; } to { opacity:1; } }
.gen .foot { border-top:1px solid var(--line); padding:8px 10px 10px; flex-shrink:0; }
.gen .try { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:7px; }
.gen .try button { text-align:left; background:none; border:1px solid var(--line); border-radius:12px; padding:3px 9px; color:var(--muted); cursor:pointer; font-size:11px; line-height:1.3; }
.gen .try button:hover { color:var(--text); border-color:#59a; }
.gen .opts { display:flex; gap:10px; margin-bottom:7px; color:#c4ccda; font-size:12px; }
.gen .opts label { display:flex; align-items:center; gap:5px; }
.gen .compose { display:flex; gap:7px; align-items:flex-end; }
.gen textarea { flex:1; min-height:38px; max-height:120px; resize:none; line-height:1.35; }
.gen .compose .b { height:38px; }
.gen .off { color:var(--muted); line-height:1.45; padding:2px 0; }
.editor.live .bar, .editor.live .side { pointer-events:none; opacity:0.55; }
.editor.live .bar [data-act="generate"] { pointer-events:auto; opacity:1; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** The little of markdown the model writes (bold, code, lists, headings) as safe HTML. */
export function renderMarkdown(text: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of text.split('\n')) {
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^\s*#{1,4}\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) {
        close();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
    } else if (heading) {
      close();
      out.push(`<h4>${inline(heading[1])}</h4>`);
    } else if (line.trim() === '') {
      close();
    } else {
      close();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  close();
  return out.join('');
}

export class GeneratePanel {
  private readonly service: GeneratorService;
  private readonly host: GenerateHost;
  private readonly root: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly foot: HTMLDivElement;
  private readonly quotaEl: HTMLSpanElement;
  private open = false;
  private quota: GenQuota | null = null;
  private kind: GenKind = 'auto';
  private size: GenSize = 'auto';
  /** What was said so far, as the server takes it back. */
  private history: ChatMessage[] = [];
  /** The running job's id, or '' between asking the server to start it and its answer. */
  private job: string | null = null;
  private stopWatching: (() => void) | null = null;
  private cancelling = false;
  private draft = '';
  /** The last thing the model said this turn: the answer that goes into the history. */
  private reply = '';
  private working: HTMLDivElement | null = null;
  private workingText: HTMLSpanElement | null = null;
  private startedAt = 0;
  private ticker: number | null = null;
  private stage = '';
  private turns: string[] = [];

  constructor(container: HTMLElement, service: GeneratorService, host: GenerateHost) {
    this.service = service;
    this.host = host;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'gen';
    this.root.innerHTML = `
      <div class="grip" title="Drag to resize"></div>
      <div class="head"><b>Map assistant</b><span class="quota"></span><button data-act="clear" title="Start a new conversation (the map stays)">New chat</button><button data-act="close" title="Hide">▾</button></div>
      <div class="list"></div>
      <div class="foot"></div>`;
    container.appendChild(this.root);
    this.list = this.root.querySelector('.list')!;
    this.foot = this.root.querySelector('.foot')!;
    this.quotaEl = this.root.querySelector('.quota')!;
    this.restoreSize();
    this.restoreHistory();
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    // (Not "change" on the text box: it fires when the box is replaced while it has focus, and would bring the sent text back.)
    this.root.addEventListener('change', (e) => (e.target as HTMLElement).tagName !== 'TEXTAREA' && this.onInput(e));
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.bindResize(this.root.querySelector('.grip')!);
    this.renderList();
    this.renderFoot();
  }

  get running(): boolean {
    return this.job !== null;
  }

  get isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) this.hide();
    else this.show();
  }

  show(): void {
    this.open = true;
    this.root.classList.add('on');
    this.fitToWindow();
    if (!this.running) void this.loadQuota();
    this.renderFoot();
    this.root.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }

  /** Hides the drawer; a running answer carries on and is there when it is shown again. */
  hide(): void {
    this.open = false;
    this.root.classList.remove('on');
  }

  /** The editor is closing: stop a running generation (it would otherwise be charged for nothing). */
  abandon(): void {
    const job = this.job;
    this.stopWatching?.();
    this.stopWatching = null;
    this.job = null;
    this.stopTicker();
    if (job) void this.service.cancel(job).catch(() => {});
    this.host.end(null, { keepSavedLink: true });
    this.working?.remove();
    this.working = null;
    this.hide();
  }

  // ---------------------------------------------------------------- what was said

  /** The conversation survives a reload of the page (this tab only): the model keeps its context. */
  private restoreHistory(): void {
    try {
      const saved = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]') as ChatMessage[];
      if (Array.isArray(saved)) this.history = saved.filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').slice(-24);
    } catch {
      /* no storage: a fresh conversation */
    }
  }

  private saveHistory(): void {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {
      /* no storage */
    }
  }

  // ---------------------------------------------------------------- size

  private restoreSize(): void {
    let w = DEFAULT_SIZE.w;
    let h = DEFAULT_SIZE.h;
    try {
      const saved = JSON.parse(localStorage.getItem(SIZE_KEY) ?? 'null') as { w?: number; h?: number } | null;
      if (saved && Number.isFinite(saved.w) && Number.isFinite(saved.h)) {
        w = saved.w!;
        h = saved.h!;
      }
    } catch {
      /* no storage: the default size */
    }
    this.setSize(w, h);
  }

  private maxSize(): { w: number; h: number } {
    // Left of the inspector (316 px) and below the top bar (46 px); never wider than most of the 3D view.
    return { w: Math.max(MIN_SIZE.w, window.innerWidth - 316 - 240), h: Math.max(MIN_SIZE.h, window.innerHeight - 40 - 46 - 16) };
  }

  private setSize(w: number, h: number): void {
    const max = this.maxSize();
    this.root.style.width = `${Math.round(Math.min(Math.max(w, MIN_SIZE.w), max.w))}px`;
    this.root.style.height = `${Math.round(Math.min(Math.max(h, MIN_SIZE.h), max.h))}px`;
  }

  private fitToWindow(): void {
    this.setSize(this.root.offsetWidth || DEFAULT_SIZE.w, this.root.offsetHeight || DEFAULT_SIZE.h);
  }

  /** Dragging the top-left corner resizes the drawer, which stays anchored bottom-right. */
  private bindResize(grip: HTMLElement): void {
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const w0 = this.root.offsetWidth;
      const h0 = this.root.offsetHeight;
      const move = (m: PointerEvent) => this.setSize(w0 + (startX - m.clientX), h0 + (startY - m.clientY));
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        try {
          localStorage.setItem(SIZE_KEY, JSON.stringify({ w: this.root.offsetWidth, h: this.root.offsetHeight }));
        } catch {
          /* no storage */
        }
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    window.addEventListener('resize', () => this.open && this.fitToWindow());
  }

  // ---------------------------------------------------------------- the conversation

  private async loadQuota(): Promise<void> {
    try {
      this.quota = await this.service.quota();
    } catch (e) {
      this.quota = null;
      this.note('err', esc((e as Error).message));
    }
    this.renderFoot();
  }

  private scrollDown(): void {
    this.list.scrollTop = this.list.scrollHeight;
  }

  private append(node: HTMLElement): void {
    this.working?.remove();
    this.list.querySelector('.hello')?.remove();
    this.list.appendChild(node);
    if (this.working && this.job !== null) this.list.appendChild(this.working);
    this.scrollDown();
  }

  private bubble(role: 'user' | 'ai', text: string): void {
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    if (role === 'user') el.textContent = text;
    else el.innerHTML = renderMarkdown(text);
    this.append(el);
  }

  private note(tone: 'ok' | 'warn' | 'err', html: string): void {
    const el = document.createElement('div');
    el.className = `note ${tone}`;
    el.innerHTML = html;
    this.append(el);
  }

  private activity(summary: string, ok: boolean, problems: string[] = [], detail: string[] = []): void {
    const el = document.createElement('div');
    el.className = `act ${ok ? '' : 'bad'}`;
    const why = problems.slice(0, 4).map((p) => `<span class="why">${esc(p)}</span>`).join('');
    const more = detail.length ? `<details><summary>details</summary><pre>${esc(detail.join('\n'))}</pre></details>` : '';
    el.innerHTML = `<div class="l"><span>${esc(summary)}</span></div>${why}${more}`;
    this.append(el);
  }

  private renderList(): void {
    this.list.innerHTML = '';
    if (this.history.length > 0 && !this.running) {
      const back = document.createElement('div');
      back.className = 'hello';
      const last = [...this.history].reverse().find((m) => m.role === 'assistant');
      back.innerHTML = `Earlier in this conversation (${Math.floor(this.history.length / 2)} message${this.history.length === 2 ? '' : 's'}) is remembered.${last ? `<br><br>${renderMarkdown(last.text.slice(0, 600))}` : ''}`;
      this.list.appendChild(back);
    } else if (this.history.length === 0 && !this.running) {
      const hello = document.createElement('div');
      hello.className = 'hello';
      hello.innerHTML = 'Tell me what to build or change. I edit the map in the editor with the tools the game gives me, check it builds, and (for puzzles) check that the exit can be reached. Ask for one small change and only that changes.';
      this.list.appendChild(hello);
    }
  }

  private async send(): Promise<void> {
    const text = this.draft.replace(/\s+/g, ' ').trim();
    if (this.running || text.length < GEN_PROMPT_MIN) return;
    if (!this.quota) await this.loadQuota();
    if (!this.canStart()) return;
    const request: GenStartRequest = { prompt: text.slice(0, GEN_PROMPT_MAX), mode: 'chat', baseMap: this.host.currentMap(), history: this.history.slice(-20) };
    if (this.history.length === 0) {
      request.kind = this.kind;
      request.size = this.size;
    }
    this.bubble('user', text);
    this.draft = '';
    this.reply = '';
    this.turns = [];
    this.cancelling = false;
    this.job = '';
    this.startWorking('Starting...');
    this.host.begin();
    this.host.status('Asking the assistant...');
    this.renderFoot();
    let jobId: string;
    try {
      const started = await this.service.start(request);
      jobId = started.jobId;
      this.quota = started.quota;
    } catch (e) {
      this.finishRun();
      this.host.end(null, { keepSavedLink: true });
      this.note('err', esc((e as Error).message));
      this.host.status((e as Error).message, true);
      this.renderFoot();
      return;
    }
    this.job = jobId;
    this.stopWatching = this.service.watch(
      jobId,
      (event) => this.onEvent(event, text),
      (message) => {
        this.finishRun();
        this.host.end(null, { keepSavedLink: true });
        this.note('err', `${esc(message)} The answer may still finish on the server and count towards today's limit.`);
        this.renderFoot();
      },
    );
    this.renderFoot();
  }

  private cancel(): void {
    if (!this.job || this.cancelling) return;
    this.cancelling = true;
    this.setWorking('Stopping...');
    this.renderFoot();
    void this.service.cancel(this.job).catch((e: Error) => {
      this.cancelling = false;
      this.host.status(`Could not stop: ${e.message}`, true);
      this.renderFoot();
    });
  }

  private finishRun(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.job = null;
    this.cancelling = false;
    this.stopTicker();
    this.working?.remove();
    this.working = null;
    this.workingText = null;
  }

  private startWorking(text: string): void {
    this.working?.remove();
    const el = document.createElement('div');
    el.className = 'working';
    el.innerHTML = '<i></i><span></span>';
    this.working = el;
    this.workingText = el.querySelector('span');
    this.stage = text;
    this.startedAt = Date.now();
    this.list.appendChild(el);
    this.setWorking(text);
    this.stopTicker();
    this.ticker = window.setInterval(() => this.setWorking(this.stage), 1000);
    this.scrollDown();
  }

  private setWorking(text: string): void {
    this.stage = text;
    if (this.workingText) this.workingText.textContent = `${text} ${Math.round((Date.now() - this.startedAt) / 1000)} s`;
  }

  private stopTicker(): void {
    if (this.ticker !== null) window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private onEvent(event: JobEvent, prompt: string): void {
    switch (event.type) {
      case 'turn':
        this.setWorking(event.n === 1 ? 'Thinking...' : `Working (step ${event.n})...`);
        break;
      case 'say':
        this.reply = event.text;
        this.bubble('ai', event.text);
        break;
      case 'tool':
        this.turns.push(event.summary);
        this.activity(event.summary, event.ok, event.problems, event.detail);
        this.host.status(event.summary);
        break;
      case 'map':
        this.host.liveMap(event.map, event.ok);
        break;
      case 'step':
        // The older plan-and-draft pipeline's progress, not used by the chat.
        this.host.status(event.message);
        break;
      case 'start':
      case 'piece':
        break;
      case 'done':
        this.finishRun();
        this.onDone(event.outcome, prompt);
        return;
      case 'error':
        this.finishRun();
        this.host.end(null, { keepSavedLink: true });
        if (event.status === 'cancelled') {
          this.note('warn', 'Stopped. The map is as it was.');
          this.host.status('Stopped.');
        } else {
          this.note('err', esc(event.message));
          this.host.status(event.message, true);
        }
        void this.loadQuota();
        break;
    }
  }

  private onDone(outcome: PublicOutcome, prompt: string): void {
    const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
    const meta = `${outcome.attempts} step${outcome.attempts === 1 ? '' : 's'} · ~$${outcome.costUsd.toFixed(3)}`;
    // What the model said and what it did, for the next message's context.
    const said = outcome.reply || this.reply;
    this.history.push({ role: 'user', text: prompt }, { role: 'assistant', text: said || (outcome.map ? 'I changed the map.' : 'Done.') });
    this.saveHistory();
    if (outcome.map) {
      this.host.end(outcome.map, { keepSavedLink: true });
      this.host.status(outcome.ok ? 'The map was changed. Undo restores the previous one.' : 'The map was changed, but it still has problems. Undo restores the previous one.', !outcome.ok);
    } else {
      this.host.end(null, { keepSavedLink: true });
    }
    const parts: string[] = [];
    if (outcome.map) parts.push(outcome.ok ? 'Done: the map is in the editor (Undo restores the previous one).' : 'The map is in the editor, but it does not pass every check:' + list(outcome.problems));
    for (const n of outcome.notes) parts.push(esc(n));
    if (outcome.fixes.length) parts.push(`<span class="meta">Tidied: ${esc(outcome.fixes.slice(0, 3).join('; '))}${outcome.fixes.length > 3 ? '...' : ''}</span>`);
    this.note(outcome.ok && outcome.notes.length === 0 ? 'ok' : 'warn', `${parts.join('<br>')}<div class="meta">${meta}</div>`);
    void this.loadQuota();
    this.renderFoot();
  }

  // ---------------------------------------------------------------- composer

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    switch (el.dataset.f) {
      case 'prompt':
        this.draft = el.value.slice(0, GEN_PROMPT_MAX);
        this.syncSend();
        break;
      case 'kind':
        this.kind = el.value as GenKind;
        break;
      case 'size':
        this.size = el.value as GenSize;
        break;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).dataset.f === 'prompt' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void this.send();
    }
    // Typing here is not an editor shortcut.
    e.stopPropagation();
  }

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'close':
        this.hide();
        break;
      case 'clear':
        if (this.running) break;
        this.history = [];
        this.reply = '';
        this.saveHistory();
        this.renderList();
        this.renderFoot();
        break;
      case 'send':
        void this.send();
        break;
      case 'stop':
        this.cancel();
        break;
      case 'example': {
        this.draft = btn.dataset.text ?? '';
        this.renderFoot();
        const area = this.root.querySelector<HTMLTextAreaElement>('textarea');
        area?.focus();
        break;
      }
    }
  }

  private canStart(): boolean {
    const q = this.quota;
    return !!q && q.enabled && q.allowed && q.used < q.limit;
  }

  private syncSend(): void {
    const send = this.root.querySelector<HTMLButtonElement>('[data-act="send"]');
    if (send) send.disabled = !this.canStart() || this.draft.trim().length < GEN_PROMPT_MIN;
  }

  private renderFoot(): void {
    const q = this.quota;
    const busy = this.running;
    const left = q ? Math.max(0, q.limit - q.used) : null;
    this.quotaEl.textContent = left === null ? '' : `${left} left today`;
    this.quotaEl.title = left === null ? '' : `${left} of ${q!.limit} messages left in the last 24 hours`;
    this.quotaEl.classList.toggle('low', left === 0);
    let blocked = '';
    if (q && !q.enabled) blocked = 'The map assistant is not set up on this server.';
    else if (q && !q.allowed) blocked = 'Your account has no map generator right. Ask the admin to grant it.';
    else if (left === 0) blocked = `You have used all ${q!.limit} messages for today.`;
    const opt = (v: string, cur: string, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const pieces = JSON.stringify(this.host.currentMap().pieces);
    const blank = [blankMap(), blankPuzzle()].some((t) => JSON.stringify(t.pieces) === pieces);
    const examples = this.history.length === 0 ? (blank ? NEW_EXAMPLES : EDIT_EXAMPLES) : [];
    this.foot.innerHTML = `
      ${blocked ? `<div class="off">${esc(blocked)}</div>` : ''}
      ${!busy && examples.length ? `<div class="try">${examples.map((t) => `<button data-act="example" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : ''}
      ${
        this.history.length === 0 && !busy
          ? `<div class="opts"><label>Type <select data-f="kind">${opt('auto', this.kind, 'Auto')}${opt('combat', this.kind, 'Combat')}${opt('puzzle', this.kind, 'Puzzle')}</select></label>
             <label>Size <select data-f="size">${opt('auto', this.size, 'Auto')}${opt('small', this.size, 'Small')}${opt('medium', this.size, 'Medium')}${opt('large', this.size, 'Large')}</select></label></div>`
          : ''
      }
      <div class="compose">
        <textarea data-f="prompt" maxlength="${GEN_PROMPT_MAX}" rows="1" ${busy || blocked ? 'disabled' : ''} placeholder="${busy ? 'Working...' : this.history.length ? 'Ask for a change...' : 'Describe a map, or a change to this one...'}">${esc(this.draft)}</textarea>
        ${
          busy
            ? `<button class="b danger" data-act="stop" ${this.cancelling ? 'disabled' : ''}>${this.cancelling ? 'Stopping' : 'Stop'}</button>`
            : `<button class="b primary" data-act="send" ${this.canStart() && this.draft.trim().length >= GEN_PROMPT_MIN ? '' : 'disabled'}>Send</button>`
        }
      </div>`;
    const area = this.root.querySelector<HTMLTextAreaElement>('textarea');
    if (area && !busy && this.open && document.activeElement !== area && !blocked) area.focus();
  }
}
