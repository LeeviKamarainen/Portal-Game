import { Engine } from '../core/Engine';
import { InputManager } from '../core/InputManager';
import { Loop } from '../core/Loop';
import { Audio } from '../core/Audio';
import { FLAGS } from '../core/Flags';
import { SKINS, loadProgress, loadSettings, saveProgress, type Settings } from '../core/Settings';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { PortalGunModel } from '../player/PortalGunModel';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS } from '../bots/BotSkill';
import { IdleCommands } from '../player/PlayerCommand';
import { NavGraph } from '../bots/NavGraph';
import { BotDebugView } from '../bots/BotDebug';
import type { ArenaPlayer } from './ArenaPlayer';
import { ViewModel } from '../player/ViewModel';
import { Hud } from '../ui/Hud';
import { Menu } from '../ui/Menu';
import { Editor } from '../editor/Editor';
import { mapToArena, type MapData } from '../world/maps/MapFormat';
import { ARENAS, PVP_ARENA, TEST_ARENA } from '../world/arenas';
import type { ArenaDef } from '../world/ArenaBuilder';
import type { PortalColor } from '../portals/Portal';
import { Session } from './Session';

type State =
  | 'playing'
  | 'dying'
  | 'respawning'
  | 'complete'
  | 'entering'
  | 'finished'
  | 'loading'
  /** Main menu over a live arena backdrop. */
  | 'menu'
  /** Pause menu: the arena is frozen underneath. */
  | 'paused'
  /** The map editor owns the screen. */
  | 'editor';

/** What the loaded arena is for. */
type Mode = 'tutorial' | 'pvp' | 'test' | 'menu' | 'playtest';

/** Death to control again: under a second, most of it a fade. */
const DEATH_FADE = 0.45;
const RESPAWN_FADE = 0.25;
const COMPLETE_HOLD = 1.6;
const LEVEL_FADE = 0.35;
/** The arena behind the main menu, and how fast the camera turns there (rad/s). */
const MENU_BACKDROP = ARENAS.length - 1;
const MENU_TURN = 0.05;

const IN_PLAY: ReadonlySet<State> = new Set(['playing', 'entering', 'dying', 'respawning', 'complete', 'finished']);

export class Game {
  readonly engine: Engine;
  readonly input: InputManager;
  readonly audio: Audio;
  readonly hud: Hud;
  readonly menu: Menu;
  readonly settings: Settings;
  readonly viewModel = new ViewModel();
  readonly loop: Loop;
  session: Session | null = null;
  /** Index into ARENAS, or -1 for the test chamber. */
  arenaIndex = 0;
  mode: Mode = 'tutorial';
  /** The loaded arena is a scored match against bots (the PvP arena, or a combat map in playtest). */
  combat = false;
  /** What is loaded, so a match or playtest can start over. */
  private current: { def: ArenaDef; mode: Mode; index: number } | null = null;
  /** Who drives the PvP opponent: a bot, or nothing (scripted test suites move it themselves). */
  opponentBrain: 'bot' | 'idle' = 'bot';
  /** `?debug=bots`: what each bot knows and plans, drawn in the arena. */
  private botViews: BotDebugView[] = [];

  private avatar!: PlayerAvatar;
  private avatarSkin = '';
  private skinTicket = 0;
  private loadTicket = 0;
  private readonly heldGun = new PortalGunModel();
  private state: State = 'loading';
  private pausedFrom: State = 'playing';
  private stateTime = 0;
  private fade = 1;
  private menuYaw = 0;
  private readonly progress = loadProgress();
  private readonly container: HTMLElement;
  private editor: Editor | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.settings = loadSettings();
    this.engine = new Engine(container, this.viewModel.scene, this.viewModel.camera, FLAGS.quality ?? this.settings.quality);
    this.input = new InputManager(this.engine.renderer.domElement);
    this.audio = new Audio(FLAGS.muted);
    this.hud = new Hud(container);
    this.menu = new Menu(container, this.settings, {
      playStage: (i) => this.startFromMenu(() => this.loadArena(i)),
      playPvp: () => this.startFromMenu(() => this.loadPvp()),
      resume: () => this.resume(),
      restart: () => {
        this.resume();
        this.restart();
      },
      mainMenu: () => void this.openMainMenu(),
      openEditor: () => this.openEditor(),
      backToEditor: () => this.openEditor(),
      settingsChanged: () => this.applySettings(),
      toggleMute: () => this.audio.toggle(),
    });
    this.hud.setMuted(this.audio.muted);
    this.menu.setMuted(this.audio.muted);
    this.menu.setProgress(this.progress);
    this.audio.onChange((m) => {
      this.hud.setMuted(m);
      this.menu.setMuted(m);
    });
    this.hud.onMuteClick = () => this.audio.toggle();
    // Esc releases the mouse; while playing that means "pause".
    this.input.onLockChange = (locked) => {
      if (!locked && IN_PLAY.has(this.state)) this.pause();
    };
    this.applySettings();
    this.loop = new Loop(
      (dt) => this.step(dt),
      (frameDt) => this.render(frameDt),
    );
  }

  /** `start` is an arena index (-1 = test chamber), 'pvp', 'menu' for the main menu, or 'editor'. */
  async init(start: number | 'pvp' | 'menu' | 'editor'): Promise<void> {
    this.avatarSkin = this.settings.skin;
    this.avatar = await PlayerAvatar.load(this.avatarSkin);
    this.avatar.attachToHand(this.heldGun.object);
    if (start === 'menu') await this.openMainMenu();
    else if (start === 'editor') this.openEditor();
    else if (start === 'pvp') await this.loadPvp();
    else await this.loadArena(start);
    this.loop.start();
  }

  private defFor(index: number): ArenaDef {
    return index < 0 ? TEST_ARENA : ARENAS[index];
  }

  async loadArena(index: number): Promise<void> {
    await this.load(this.defFor(index), index < 0 ? 'test' : 'tutorial', index);
  }

  async loadPvp(): Promise<void> {
    await this.load(PVP_ARENA, 'pvp', 0);
  }

  private async load(def: ArenaDef, mode: Mode, index: number, state: State = 'entering'): Promise<void> {
    const ticket = ++this.loadTicket;
    this.state = 'loading';
    this.session?.dispose();
    this.session = null;
    this.arenaIndex = index;
    this.mode = mode;
    this.combat = mode === 'pvp' || (mode === 'playtest' && def.kind === 'combat');
    this.current = { def, mode, index };
    const session = await Session.create(this.engine, this.input, this.audio, def, this.combat ? {} : null);
    // Something else was picked while this arena loaded.
    if (ticket !== this.loadTicket) {
      session.dispose();
      return;
    }
    session.demo = mode === 'menu';
    session.attachAvatar(this.avatar);
    this.botViews = [];
    if (this.combat) this.addOpponents(session);
    if (FLAGS.debug === 'nav') session.scene.add(NavGraph.for(session, session.arena, session.physics).debugObject());
    // Every shader compiled now, not the first time a portal opens. (Test runs don't wait for
    // the driver to finish: a hidden page polls slowly, and their first frame waits anyway.)
    const warm = session.warmUp();
    if (!FLAGS.test) await warm;
    if (ticket !== this.loadTicket) {
      session.dispose();
      return;
    }
    this.engine.setScene(session.scene);
    this.session = session;
    this.hud.setArena(this.arenaLabel(), def.name, def.hint);
    this.hud.setBanner('');
    this.input.flush();
    this.setState(state);
    this.menuYaw = session.arena.spawnYaw;
  }

  /**
   * The PvP opponents: as many bots as picked in the menu, at the difficulty picked there,
   * everyone for themselves (see bots/BotController and docs/bot-opponents-plan.md).
   * `opponentBrain = 'idle'` (test suites) makes it one opponent that stands still.
   */
  private addOpponents(session: Session): void {
    const idle = this.opponentBrain === 'idle';
    const count = idle ? 1 : this.settings.botCount;
    for (let i = 0; i < count; i++) {
      const bot = idle ? null : new BotController(BOT_SKILLS[this.settings.botDifficulty]);
      const name = idle ? 'DUMMY' : count === 1 ? 'BOT' : `BOT ${i + 1}`;
      const opponent = session.addPlayer({ id: `p${i + 2}`, name }, bot ?? new IdleCommands());
      bot?.attach(session, opponent);
      if (bot && FLAGS.debug === 'bots') this.watchBot(session, bot, opponent);
      // Characters different from yours (and each other's), so you can tell who is who.
      const skin = SKINS[(SKINS.indexOf(this.settings.skin) + 7 + 4 * i) % SKINS.length];
      PlayerAvatar.load(skin)
        .then((avatar) => session.setOpponentBody(opponent, avatar, new PortalGunModel('orange', opponent.palette)))
        .catch((e) => console.error(e));
    }
  }

  /** Draws what `bot` knows and plans (`?debug=bots`; tests may call it for a bot they add). */
  watchBot(session: Session, bot: BotController, player: ArenaPlayer): void {
    const view = new BotDebugView(bot, player.palette.orange);
    session.scene.add(view.object);
    this.botViews.push(view);
  }

  private arenaLabel(): string {
    if (this.mode === 'tutorial') return `TUTORIAL ${this.arenaIndex + 1} / ${ARENAS.length}`;
    if (this.combat) {
      const where = this.mode === 'playtest' ? 'PLAYTEST' : 'PVP ARENA';
      if (this.opponentBrain === 'idle') return `${where} · PRACTICE`;
      const n = this.settings.botCount;
      return `${where} · VS ${n === 1 ? '' : `${n} `}${this.settings.botDifficulty.toUpperCase()} BOT${n === 1 ? '' : 'S'}`;
    }
    if (this.mode === 'playtest') return 'PLAYTEST · PUZZLE · ESC FOR THE EDITOR';
    return 'DEBUG';
  }

  /** Back to the main menu, with an arena running quietly behind it. */
  async openMainMenu(): Promise<void> {
    this.input.releaseLock();
    this.hud.setVisible(false);
    this.menu.open('main');
    await this.load(ARENAS[MENU_BACKDROP], 'menu', MENU_BACKDROP, 'menu');
    this.fade = 0;
  }

  /** Runs inside the menu click, so the mouse can be captured straight away. */
  private startFromMenu(load: () => Promise<void>): void {
    this.menu.close();
    this.hud.setVisible(true);
    this.input.requestLock();
    this.fade = 1;
    void load();
  }

  private pause(): void {
    if (!IN_PLAY.has(this.state) || FLAGS.test) return;
    this.pausedFrom = this.state;
    this.state = 'paused';
    this.input.releaseLock();
    this.hud.setVisible(false);
    this.menu.open('pause', `${this.arenaLabel()} · ${this.session?.def.name ?? ''}`, this.mode === 'playtest');
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.menu.close();
    this.hud.setVisible(true);
    this.state = this.pausedFrom;
    this.input.flush();
    this.input.requestLock();
  }

  /** The map editor takes over the screen; the mouse stays free for it. */
  openEditor(): void {
    this.input.releaseLock();
    this.input.lockEnabled = false;
    this.menu.close();
    this.hud.setVisible(false);
    this.editor ??= new Editor(this.container, this.engine.renderer, this.engine.envMap, {
      playtest: (map) => this.playtest(map),
      exit: () => {
        this.editor?.close();
        this.input.lockEnabled = true;
        void this.openMainMenu();
      },
    });
    this.editor.open();
    this.state = 'editor';
  }

  /** Plays the editor's map; if it fails to build, back to the editor with the reason. */
  private playtest(map: MapData): void {
    this.editor?.close();
    this.input.lockEnabled = true;
    this.hud.setVisible(true);
    this.input.requestLock();
    this.fade = 1;
    this.load(mapToArena(map), 'playtest', 0).catch((e: Error) => {
      this.openEditor();
      this.editor?.showError(`The map didn't build: ${e.message}`);
    });
  }

  private applySettings(): void {
    const s = this.settings;
    this.engine.applySettings(s, FLAGS.quality ?? s.quality);
    this.input.sensitivity = s.sensitivity;
    this.input.invertY = s.invertY;
    this.session?.applyLighting();
    if (this.avatar && s.skin !== this.avatarSkin) void this.changeSkin(s.skin);
  }

  private async changeSkin(skin: string): Promise<void> {
    this.avatarSkin = skin;
    const ticket = ++this.skinTicket;
    const next = await PlayerAvatar.load(skin);
    if (ticket !== this.skinTicket) {
      next.dispose();
      return;
    }
    const old = this.avatar;
    this.session?.detachAvatar(old);
    next.attachToHand(this.heldGun.object);
    old.dispose();
    this.avatar = next;
    this.session?.attachAvatar(next);
  }

  private setState(s: State): void {
    this.state = s;
    this.stateTime = 0;
  }

  step(dt: number): void {
    const session = this.session;
    if (!session || this.state === 'paused' || this.state === 'editor') return;
    this.stateTime += dt;

    if (this.state === 'menu') {
      // Attract mode: the arena keeps running while the camera slowly looks around.
      this.menuYaw += dt * MENU_TURN;
      session.player.setLook(this.menuYaw, -0.08);
      session.step(dt);
      session.events.length = 0;
      this.input.flush();
      return;
    }

    if (this.input.consumePress('KeyM')) this.audio.toggle();
    if (this.input.consumePress('Escape')) {
      this.pause();
      return;
    }
    if (this.input.consumePress('KeyR')) this.restart();
    // Loading an arena disposes the current session straight away; stop touching it.
    if (this.session !== session) return;
    if (import.meta.env.DEV && this.input.consumePress('KeyN') && this.state === 'playing') {
      void this.advance();
      return;
    }

    if (this.state === 'playing') {
      if (this.input.consumeFirePrimary()) this.fire('orange');
      if (this.input.consumeFireSecondary()) this.fire('blue');
    } else {
      this.input.consumeFirePrimary();
      this.input.consumeFireSecondary();
    }

    session.step(dt);
    for (const v of this.botViews) v.update();
    for (const e of session.events.splice(0)) {
      if (e.type === 'death' && e.player === session.local.id && this.state === 'playing') {
        this.audio.play('death', 0.8);
        if (e.by) this.hud.toast(`KILLED BY ${session.match?.player(e.by)?.name ?? e.by}`, '#ff8a6a');
        this.setState('dying');
      } else if (e.type === 'goal') {
        this.audio.play('goal', 0.8);
        if (this.mode === 'tutorial') {
          this.progress.add(session.def.id);
          saveProgress(this.progress);
          this.menu.setProgress(this.progress);
        }
        const last = this.mode !== 'tutorial' || this.arenaIndex >= ARENAS.length - 1;
        this.hud.setBanner(
          this.mode === 'playtest' ? 'LEVEL COMPLETE' : this.mode !== 'tutorial' ? 'GOAL REACHED' : last ? 'ALL STAGES COMPLETE' : 'STAGE COMPLETE',
          !last ? '' : this.mode === 'tutorial' ? 'R: play again from stage 1 · Esc: menu' : 'R: play again · Esc: menu',
        );
        this.setState(last ? 'finished' : 'complete');
      } else if (e.type === 'score') {
        const you = e.player === session.player.id;
        const who = you ? '' : `${session.match?.player(e.player)?.name ?? e.player} `;
        this.hud.toast(`${who}+${e.points} ${e.reason === 'orb' ? 'ORB' : 'KILL'}`, you ? undefined : '#ff8a6a');
        if (you) this.audio.play(e.reason === 'orb' ? 'orb' : 'goal', 0.7);
      } else if (e.type === 'steal') {
        const name = (id: string) => session.playerById(id)?.name ?? id;
        if (e.thief === session.local.id) this.hud.toast(`STOLE ${name(e.victim)}'S PORTAL`);
        else if (e.victim === session.local.id) this.hud.toast(`${name(e.thief)} STOLE YOUR PORTAL`, '#ff8a6a');
      } else if (e.type === 'win') {
        const winner = session.match!.player(e.player)!;
        const you = winner.id === session.player.id;
        this.audio.play('goal', 0.9);
        // Whoever was mid-death sees the result, not a black screen.
        if (session.isDead) session.respawn();
        this.fade = 0;
        this.hud.setBanner(you ? 'YOU WIN' : `${winner.name} WINS`, `${winner.score} points · R: rematch · Esc: menu`);
        this.setState('finished');
      }
    }
    this.updateState();
    if (this.session !== session) return;

    const player = session.player;
    this.avatar.update(dt, {
      position: player.getPosition(),
      yaw: player.lookYaw,
      pitch: player.lookPitch,
      speed: player.horizontalSpeed(),
      grounded: player.isGrounded,
    });
    this.heldGun.update(dt);
    this.viewModel.update(dt, player.horizontalSpeed(), player.isGrounded, player.lastLookDelta);
    if (player.landingSpeed > 6) this.audio.play('land', Math.min(1, player.landingSpeed / 20));
    player.landingSpeed = 0;
  }

  private updateState(): void {
    const t = this.stateTime;
    switch (this.state) {
      case 'entering':
        this.fade = Math.max(0, 1 - t / LEVEL_FADE);
        if (t >= LEVEL_FADE) this.setState('playing');
        break;
      case 'playing':
        this.fade = 0;
        break;
      case 'dying':
        this.fade = Math.min(1, t / DEATH_FADE);
        if (t >= DEATH_FADE) {
          this.session!.respawn();
          this.audio.play('respawn', 0.5);
          this.setState('respawning');
        }
        break;
      case 'respawning':
        this.fade = Math.max(0, 1 - t / RESPAWN_FADE);
        if (t >= RESPAWN_FADE) this.setState('playing');
        break;
      case 'complete':
        if (t >= COMPLETE_HOLD) {
          this.fade = Math.min(1, (t - COMPLETE_HOLD) / LEVEL_FADE);
          if (t >= COMPLETE_HOLD + LEVEL_FADE) void this.advance();
        }
        break;
      default:
        break;
    }
  }

  private async advance(): Promise<void> {
    if (this.state === 'loading' || this.mode !== 'tutorial' && this.mode !== 'test') return;
    const next = this.arenaIndex < 0 ? 0 : this.arenaIndex + 1;
    if (next >= ARENAS.length) return;
    await this.loadArena(next);
  }

  restart(): void {
    if (!this.session || this.state === 'loading') return;
    // A match restarts from zero; so does a finished level (its exit has been used up).
    if (this.combat || (this.state === 'finished' && this.mode === 'playtest')) {
      const { def, mode, index } = this.current!;
      this.fade = 1;
      void this.load(def, mode, index);
      return;
    }
    if (this.state === 'finished' && this.mode === 'tutorial') {
      void this.loadArena(0);
      return;
    }
    this.session.respawn();
    this.hud.showHint(this.session.def.hint);
    this.setState('respawning');
  }

  fire(color: PortalColor): void {
    const session = this.session;
    if (!session) return;
    session.fire(color);
    this.viewModel.fire(color);
    this.heldGun.charge(color);
    this.avatar.shoot();
  }

  render(frameDt: number): void {
    if (this.state === 'editor') {
      this.editor?.render(frameDt);
      return;
    }
    const session = this.session;
    if (!session) return;
    const inMenu = this.state === 'menu';
    this.engine.trackFrame(frameDt);
    this.viewModel.setAspect(this.engine.camera.aspect);
    this.viewModel.scene.visible = !inMenu;
    session.portalRenderer.maxDepth = this.engine.portalDepth;
    session.prepareRender(frameDt);

    const player = session.player;
    const uniforms = this.engine.finish.uniforms;
    uniforms.damage.value = inMenu ? 0 : Math.min(0.85, player.damageFlash * 0.55 + (this.state === 'dying' ? this.fade * 0.6 : 0));
    uniforms.fade.value = this.fade;
    uniforms.heal.value = !inMenu && player.isImmune() ? 0.6 : 0;
    this.engine.render();

    this.hud.setEffect(inMenu ? '' : session.effectText);
    const match = inMenu ? null : session.match;
    this.hud.setScores(
      match?.players.map((p) => ({ name: p.name, score: p.score, you: p.id === player.id })) ?? null,
      match?.rules.scoreToWin,
    );
    this.hud.update(frameDt, {
      health: player.health.value / player.health.max,
      immunity: player.immunityCooldownFraction(),
      orange: session.portals.orange.placed,
      blue: session.portals.blue.placed,
      locked: this.input.isPointerLocked() || !!FLAGS.test,
    });
    if (FLAGS.showFps) {
      const ft = this.engine.smoothedFrameTime;
      this.hud.setFps(
        `${(1 / ft).toFixed(0)} fps · ${(ft * 1000).toFixed(1)} ms · ${session.portalRenderer.stats.views} portal views · ${this.engine.pixelRatio.toFixed(2)}x`,
      );
    }
  }

  /** Renders one frame immediately (used by the scripted tests while the loop is paused). */
  renderNow(): void {
    this.render(1 / 60);
  }
}
