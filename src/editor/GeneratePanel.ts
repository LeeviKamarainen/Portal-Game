import type { MapData, Piece } from '../world/maps/MapFormat';
import { GEN_PROMPT_MAX, GEN_PROMPT_MIN, type GenKind, type GenQuota, type GenSize, type GenStartRequest, type JobEvent, type MapHead, type PublicOutcome } from '../net/generate';

/**
 * The editor's map generator: describe a map (or a change to the current one), watch the
 * server build it, and have the result land in the editor, where Undo brings back what was
 * there. Everything the server streams is shown as it arrives: the step list here, and the
 * level itself piece by piece in the editor's 3D view through the `GenerateHost`.
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
  /** The map being edited, for a refinement. */
  currentMap(): MapData;
  /** Editing is locked from here until `end`. */
  begin(): void;
  /** The model started writing a map (again): show an empty one. */
  liveStart(head: MapHead): void;
  livePiece(piece: Piece): void;
  /** The checked, tidied map, to show instead of the pieces so far. */
  liveMap(map: MapData, ok: boolean): void;
  /** Editing is unlocked. `map` becomes the editor's map (undoable); null leaves what was there. */
  end(map: MapData | null, options: { keepSavedLink: boolean }): void;
  status(text: string, error?: boolean): void;
}

const NEW_EXAMPLES = [
  'PvP map with big height differences, floating platforms with hazards on each platform',
  'Copy puzzle map from Portal 1 stage 1',
  'A small symmetric arena with a deep central pit and portal walls on both sides',
  'Puzzle: shoot a switch to open the door, then cross a room with acid to the exit',
];
const REFINE_EXAMPLES = ['Make the height differences bigger', 'Add hazards on every platform', 'Add more cover in the middle', 'Add more portal walls'];
/** Maps larger than this cannot be refined (the server rewrites the whole map in one answer). */
const REFINE_PIECES_MAX = 150;

const CSS = `
.gen { position:absolute; left:232px; top:58px; width:372px; max-height:calc(100% - 100px); overflow:auto; display:none; box-sizing:border-box;
  background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px 14px; box-shadow:0 10px 30px rgba(0,0,0,0.45); }
.gen.on { display:block; }
.gen .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.gen .head b { font-size:15px; }
.gen .x { background:none; border:none; cursor:pointer; color:var(--muted); font-size:16px; padding:2px 6px; }
.gen .x:disabled { visibility:hidden; }
.gen textarea { min-height:78px; }
.gen .count { text-align:right; font-size:11px; color:var(--muted); margin-top:2px; }
.gen .opts { display:flex; gap:10px; margin:8px 0; flex-wrap:wrap; }
.gen .opts label { display:flex; align-items:center; gap:5px; color:#c4ccda; }
.gen .refine { display:flex; align-items:center; gap:6px; margin:6px 0; color:#c4ccda; }
.gen .refine.off { color:var(--muted); }
.gen .try { display:flex; flex-wrap:wrap; gap:4px; margin:6px 0; }
.gen .try button { text-align:left; background:none; border:1px solid var(--line); border-radius:12px; padding:3px 9px; color:var(--muted); cursor:pointer; font-size:11px; line-height:1.3; }
.gen .try button:hover { color:var(--text); border-color:#59a; }
.gen .quota { color:var(--muted); font-size:12px; margin:8px 0; }
.gen .quota.low { color:#ffcf70; }
.gen .go { display:flex; gap:8px; align-items:center; margin-top:6px; }
.gen .steps { list-style:none; margin:10px 0 0; padding:0; font-size:12px; }
.gen .steps li { padding:3px 0 3px 18px; position:relative; color:var(--muted); line-height:1.35; }
.gen .steps li::before { content:'✓'; position:absolute; left:2px; color:#8de0a8; }
.gen .steps li.now { color:var(--text); }
.gen .steps li.now::before { content:'›'; color:var(--accent); animation:genpulse 0.9s infinite alternate; }
.gen .steps li.bad::before { content:'!'; color:#ffb060; }
.gen .steps li .why { display:block; color:#ffb3b3; font-size:11px; }
.gen .result { margin-top:10px; padding:8px 10px; border-radius:6px; background:rgba(255,255,255,0.05); line-height:1.4; }
.gen .result.ok { border-left:3px solid #8de0a8; }
.gen .result.warn { border-left:3px solid #ffb060; }
.gen .result.err { border-left:3px solid #ff6b6b; color:#ffd0d0; }
.gen .result ul { margin:4px 0 0; padding-left:18px; color:#c4ccda; }
.gen .result .meta { color:var(--muted); font-size:11px; margin-top:6px; }
@keyframes genpulse { from { opacity:0.3; } to { opacity:1; } }
.editor.live .bar, .editor.live .side { pointer-events:none; opacity:0.55; }
.editor.live .bar [data-act="generate"] { pointer-events:auto; opacity:1; }
`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

interface Step {
  text: string;
  problems: string[];
  bad: boolean;
}

export class GeneratePanel {
  private readonly service: GeneratorService;
  private readonly host: GenerateHost;
  private readonly root: HTMLDivElement;
  private open = false;
  private quota: GenQuota | null = null;
  private prompt = '';
  private kind: GenKind = 'auto';
  private size: GenSize = 'auto';
  private refine = false;
  /** The running job's id, or '' between asking the server to start it and its answer. */
  private job: string | null = null;
  private stopWatching: (() => void) | null = null;
  private cancelling = false;
  private steps: Step[] = [];
  private result: { tone: 'ok' | 'warn' | 'err'; html: string } | null = null;

  constructor(container: HTMLElement, service: GeneratorService, host: GenerateHost) {
    this.service = service;
    this.host = host;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    this.root = document.createElement('div');
    this.root.className = 'gen';
    container.appendChild(this.root);
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('input', (e) => this.onInput(e));
    this.root.addEventListener('change', (e) => this.onInput(e));
    // Keys typed in the prompt are not editor shortcuts (the editor already ignores textareas).
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
    this.render();
    if (!this.running) void this.loadQuota();
  }

  hide(): void {
    if (this.running) return;
    this.open = false;
    this.root.classList.remove('on');
  }

  /** The editor is closing: stop a running generation (it would otherwise be charged for nothing). */
  abandon(): void {
    const job = this.job;
    this.stopWatching?.();
    this.stopWatching = null;
    this.job = null;
    if (job) void this.service.cancel(job).catch(() => {});
    this.host.end(null, { keepSavedLink: true });
    this.hide();
  }

  // ---------------------------------------------------------------- actions

  private async loadQuota(): Promise<void> {
    try {
      this.quota = await this.service.quota();
    } catch (e) {
      this.quota = null;
      this.result = { tone: 'err', html: esc((e as Error).message) };
    }
    if (this.open) this.render();
  }

  private canRefine(): boolean {
    const n = this.host.currentMap().pieces.length;
    return n > 0 && n <= REFINE_PIECES_MAX;
  }

  private async start(): Promise<void> {
    const prompt = this.prompt.replace(/\s+/g, ' ').trim();
    if (prompt.length < GEN_PROMPT_MIN) return this.fail(`Describe the map in ${GEN_PROMPT_MIN}-${GEN_PROMPT_MAX} characters.`);
    const refine = this.refine && this.canRefine();
    const request: GenStartRequest = { prompt };
    if (refine) request.baseMap = this.host.currentMap();
    else {
      request.kind = this.kind;
      request.size = this.size;
    }
    this.steps = [];
    this.result = null;
    this.cancelling = false;
    this.job = '';
    this.host.begin();
    this.host.status(refine ? 'Changing the map...' : 'Generating a map...');
    this.render();
    let jobId: string;
    try {
      const started = await this.service.start(request);
      jobId = started.jobId;
      this.quota = started.quota;
    } catch (e) {
      this.job = null;
      this.host.end(null, { keepSavedLink: true });
      return this.fail((e as Error).message);
    }
    this.job = jobId;
    this.stopWatching = this.service.watch(
      jobId,
      (event) => this.onEvent(event, refine),
      (message) => {
        this.finishRun();
        this.host.end(null, { keepSavedLink: true });
        this.fail(`${message} The generation may still finish on the server and count towards today's limit.`);
      },
    );
    this.render();
  }

  private cancel(): void {
    if (!this.job || this.cancelling) return;
    this.cancelling = true;
    this.render();
    void this.service.cancel(this.job).catch((e: Error) => {
      this.cancelling = false;
      this.host.status(`Could not cancel: ${e.message}`, true);
      this.render();
    });
  }

  private finishRun(): void {
    this.stopWatching?.();
    this.stopWatching = null;
    this.job = null;
    this.cancelling = false;
  }

  private fail(message: string): void {
    this.result = { tone: 'err', html: esc(message) };
    this.host.status(message, true);
    this.render();
  }

  private onEvent(event: JobEvent, refine: boolean): void {
    switch (event.type) {
      case 'step': {
        const prev = this.steps[this.steps.length - 1];
        if (prev && prev.text === event.message) break;
        this.steps.push({ text: event.message, problems: event.problems ?? [], bad: (event.problems?.length ?? 0) > 0 });
        this.host.status(event.message);
        break;
      }
      case 'start':
        this.host.liveStart(event.head);
        break;
      case 'piece':
        this.host.livePiece(event.piece);
        break;
      case 'map':
        this.host.liveMap(event.map, event.ok);
        break;
      case 'done':
        this.finishRun();
        this.onDone(event.outcome, refine);
        return;
      case 'error':
        this.finishRun();
        this.host.end(null, { keepSavedLink: true });
        if (event.status === 'cancelled') {
          this.result = { tone: 'warn', html: 'Cancelled. Nothing was changed.' };
          this.host.status('Generation cancelled.');
        } else {
          this.result = { tone: 'err', html: esc(event.message) };
          this.host.status(event.message, true);
        }
        void this.loadQuota();
        break;
    }
    this.render();
  }

  private onDone(outcome: PublicOutcome, refine: boolean): void {
    const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
    const meta = `${outcome.attempts} draft${outcome.attempts === 1 ? '' : 's'} · ${(outcome.tokens.input + outcome.tokens.output).toLocaleString()} tokens · ~$${outcome.costUsd.toFixed(3)}`;
    if (!outcome.map) {
      this.host.end(null, { keepSavedLink: true });
      this.result = { tone: 'err', html: `The generator could not make a map from that.${list(outcome.problems)}<div class="meta">${meta}</div>` };
    } else {
      this.host.end(outcome.map, { keepSavedLink: refine });
      const name = esc(outcome.map.name);
      if (outcome.ok) {
        this.result = {
          tone: 'ok',
          html: `<b>${name}</b> is in the editor. Undo brings back what was there.${outcome.notes.length ? '<div class="meta">Worth knowing:</div>' + list(outcome.notes) : ''}${outcome.fixes.length ? '<div class="meta">Tidied automatically:</div>' + list(outcome.fixes.slice(0, 6)) : ''}<div class="meta">${meta}</div>`,
        };
        this.host.status(`Generated "${outcome.map.name}". Undo restores the previous map.`);
      } else {
        const why = outcome.stoppedBy === 'budget' ? 'the token budget ran out' : 'it ran out of attempts';
        this.result = {
          tone: 'warn',
          html: `<b>${name}</b> is in the editor, but ${why} before it passed every check, so it may not play. Still wrong:${list(outcome.problems)}${outcome.notes.length ? '<div class="meta">Worth knowing:</div>' + list(outcome.notes) : ''}<div class="meta">${meta}</div>`,
        };
        this.host.status(`Generated "${outcome.map.name}" with ${outcome.problems.length} problem${outcome.problems.length === 1 ? '' : 's'} left. Undo restores the previous map.`, true);
      }
    }
    void this.loadQuota();
    this.render();
  }

  // ---------------------------------------------------------------- view

  private onInput(e: Event): void {
    const el = e.target as HTMLInputElement;
    switch (el.dataset.f) {
      case 'prompt': {
        this.prompt = el.value.slice(0, GEN_PROMPT_MAX);
        const count = this.root.querySelector('.count');
        if (count) count.textContent = `${this.prompt.length} / ${GEN_PROMPT_MAX}`;
        this.syncGo();
        break;
      }
      case 'kind':
        this.kind = el.value as GenKind;
        break;
      case 'size':
        this.size = el.value as GenSize;
        break;
      case 'refine':
        this.refine = el.checked;
        this.render();
        break;
    }
  }

  private onClick(e: MouseEvent): void {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    switch (btn.dataset.act) {
      case 'close':
        this.hide();
        break;
      case 'go':
        void this.start();
        break;
      case 'cancel':
        this.cancel();
        break;
      case 'example':
        this.prompt = btn.dataset.text ?? '';
        this.render();
        break;
    }
  }

  /** Generate is only possible with a usable description and quota left. */
  private syncGo(): void {
    const go = this.root.querySelector<HTMLButtonElement>('[data-act="go"]');
    if (go) go.disabled = !this.canStart();
  }

  private canStart(): boolean {
    const q = this.quota;
    return !!q && q.enabled && q.allowed && q.used < q.limit && this.prompt.trim().length >= GEN_PROMPT_MIN;
  }

  private render(): void {
    if (!this.open) return;
    const q = this.quota;
    const busy = this.running;
    const refinable = this.canRefine();
    const refine = this.refine && refinable;
    const examples = refine ? REFINE_EXAMPLES : NEW_EXAMPLES;
    const opt = (v: string, cur: string, label: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    const left = q ? Math.max(0, q.limit - q.used) : null;
    let quotaLine = '';
    if (q && !q.enabled) quotaLine = 'The map generator is not set up on this server.';
    else if (q && !q.allowed) quotaLine = 'Your account has no map generator right. Ask the admin to grant it.';
    else if (left !== null) quotaLine = left > 0 ? `${left} of ${q!.limit} generations left today.` : `You have used all ${q!.limit} generations for today.`;

    const steps = this.steps
      .map((s, i) => {
        const now = busy && i === this.steps.length - 1;
        return `<li class="${now ? 'now' : s.bad ? 'bad' : ''}">${esc(s.text)}${s.problems.slice(0, 4).map((p) => `<span class="why">${esc(p)}</span>`).join('')}</li>`;
      })
      .join('');

    this.root.innerHTML = `
      <div class="head"><b>Generate a map</b><button class="x" data-act="close" ${busy ? 'disabled' : ''} title="Close">✕</button></div>
      <textarea data-f="prompt" maxlength="${GEN_PROMPT_MAX}" ${busy ? 'disabled' : ''} placeholder="${refine ? 'What should change? e.g. make the platforms higher' : 'Describe the map: its kind, shape, hazards, how it should play...'}">${esc(this.prompt)}</textarea>
      <div class="count">${this.prompt.length} / ${GEN_PROMPT_MAX}</div>
      <label class="refine ${refinable ? '' : 'off'}" title="${refinable ? 'Send the map in the editor along with your description and have it changed' : `Only maps with 1-${REFINE_PIECES_MAX} pieces can be changed`}">
        <input type="checkbox" data-f="refine" ${refine ? 'checked' : ''} ${busy || !refinable ? 'disabled' : ''}> Change the map in the editor instead of making a new one</label>
      <div class="opts" ${refine ? 'hidden' : ''}>
        <label>Type <select data-f="kind" ${busy ? 'disabled' : ''}>${opt('auto', this.kind, 'Auto')}${opt('combat', this.kind, 'Combat')}${opt('puzzle', this.kind, 'Puzzle')}</select></label>
        <label>Size <select data-f="size" ${busy ? 'disabled' : ''}>${opt('auto', this.size, 'Auto')}${opt('small', this.size, 'Small')}${opt('medium', this.size, 'Medium')}${opt('large', this.size, 'Large')}</select></label>
      </div>
      ${busy ? '' : `<div class="try">${examples.map((t) => `<button data-act="example" data-text="${esc(t)}">${esc(t)}</button>`).join('')}</div>`}
      <div class="quota ${left === 0 ? 'low' : ''}">${esc(quotaLine)}</div>
      <div class="go">
        ${
          busy
            ? `<button class="b danger" data-act="cancel" ${this.cancelling ? 'disabled' : ''}>${this.cancelling ? 'Cancelling...' : 'Cancel'}</button>`
            : `<button class="b primary" data-act="go" ${this.canStart() ? '' : 'disabled'}>${refine ? 'Change map' : 'Generate'}</button>`
        }
      </div>
      ${steps ? `<ul class="steps">${steps}</ul>` : ''}
      ${this.result ? `<div class="result ${this.result.tone}">${this.result.html}</div>` : ''}`;
    const area = this.root.querySelector<HTMLTextAreaElement>('textarea');
    if (area && !busy && document.activeElement !== area && this.prompt === '') area.focus();
  }
}
