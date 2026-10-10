import { Engine } from '../core/Engine';
import { InputManager } from '../core/InputManager';
import { Loop } from '../core/Loop';
import { Audio } from '../core/Audio';
import { FLAGS } from '../core/Flags';
import { SKINS, loadProgress, loadSettings, saveProgress, saveSettings, type Settings } from '../core/Settings';
import { PlayerAvatar } from '../player/PlayerAvatar';
import { PortalGunModel } from '../player/PortalGunModel';
import { BotController } from '../bots/BotController';
import { BOT_SKILLS } from '../bots/BotSkill';
import { IdleCommands, KeyboardCommands, emptyCommand } from '../player/PlayerCommand';
import { NavGraph } from '../bots/NavGraph';
import { BotDebugView } from '../bots/BotDebug';
import type { ArenaPlayer } from './ArenaPlayer';
import { ViewModel } from '../player/ViewModel';
import { Hud } from '../ui/Hud';
import { NetOverlay } from '../ui/NetOverlay';
import { Menu } from '../ui/Menu';
import { Editor } from '../editor/Editor';
import { mapToArena, type MapData } from '../world/maps/MapFormat';
import { ARENAS, PVP_ARENA, TEST_ARENA } from '../world/arenas';
import type { ArenaDef } from '../world/ArenaBuilder';
import type { PortalColor } from '../portals/Portal';
import { Session, type SessionEvent } from './Session';
import { OnlineLobby } from '../net/OnlineLobby';
import { NetSession } from '../net/NetSession';
import { AccountClient, AccountError } from '../net/AccountClient';
import { BUILT_IN_ONLINE_MAPS, REJOIN_SECONDS, cleanName, type ServerMessage } from '../net/protocol';

type MatchStart = Extract<ServerMessage, { type: 'matchStart' }>;

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
type Mode = 'tutorial' | 'pvp' | 'test' | 'menu' | 'playtest' | 'online';

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
  /** `?net=1`: the connection stats panel online. */
  private readonly netOverlay: NetOverlay | null;
  readonly menu: Menu;
  /** Online rooms: the lobby you're in, if any (docs/online-multiplayer-plan.md). */
  readonly online = new OnlineLobby();
  /** Who is logged in, and their saved maps (server/auth/AuthApi.ts, MapApi.ts). */
  readonly accounts = new AccountClient();
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
  /** The online match being played (docs/online-multiplayer-plan.md), if any. */
  net: NetSession | null = null;
  private netRoom = '';
  /** Online: your keyboard and mouse, read here and sent to the server by `net`. */
  private readonly keyboard: KeyboardCommands;
  private readonly netCommand = emptyCommand();
  private pendingFire: PortalColor | null = null;
  /** Match messages that came while the online match was loading. */
  private early: ServerMessage[] = [];
  /** The countdown banner has given way to GO. */
  private netGo = false;

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
    this.keyboard = new KeyboardCommands(this.input);
    this.audio = new Audio(FLAGS.muted);
    this.hud = new Hud(container);
    this.netOverlay = FLAGS.net ? new NetOverlay(this.hud.layer) : null;
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
      editAccountMap: (data, id) => {
        this.openEditor();
        this.editor?.openAccountMap(data, id);
      },
      settingsChanged: () => this.applySettings(),
      toggleMute: () => this.audio.toggle(),
      createRoom: (name) => void this.online.create(this.rememberName(name), this.settings.skin),
      joinRoom: (code, name) => void this.online.join(code, this.rememberName(name), this.settings.skin),
      leaveRoom: () => this.online.leave(),
      setRoomMap: (map) => this.online.setMap(map),
      setRoomBots: (count, difficulty) => this.online.setBots(count, difficulty),
      startMatch: () => this.online.start(),
      onlineError: (message) => this.online.showError(message),
    }, this.accounts);
    this.accounts.onChange = () => this.menu.setAccount();
    this.hud.setMuted(this.audio.muted);
    this.menu.setMuted(this.audio.muted);
    this.menu.setProgress(this.progress);
    this.audio.onChange((m) => {
      this.hud.setMuted(m);
      this.menu.setMuted(m);
    });
    this.hud.onMuteClick = () => this.audio.toggle();
    this.online.onChange = () => {
      const view = this.online.view();
      this.menu.setOnline(view);
      if (!this.net) return;
      // The connection is gone for good: back to the Online page, which says why.
      if (view.status === 'idle') void this.leaveMatch();
      // The result has been up a while: everyone back in the room's lobby (for a rematch).
      else if (view.status === 'room' && view.lobby?.phase === 'lobby') void this.backToLobby();
    };
    this.online.onMatch = (msg) => void this.loadOnline(msg);
    // Whatever comes while the match is still loading (someone joining it) waits for it.
    this.online.onMatchMessage = (msg) => {
      if (this.net) this.net.receive(msg);
      else if (this.online.view().match) this.early.push(msg);
    };
    this.online.onSnapshot = (data) => this.net?.receiveBinary(data);
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
    void this.accounts.refresh();
    this.avatarSkin = this.settings.skin;
    this.avatar = await PlayerAvatar.load(this.avatarSkin);
    this.avatar.attachToHand(this.heldGun.object);
    if (start === 'menu') {
      await this.openMainMenu();
      // An invite link: straight to joining that room.
      if (FLAGS.room) this.menu.openOnline(FLAGS.room);
    }
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

  private async load(def: ArenaDef, mode: Mode, index: number, state: State = 'entering', match: MatchStart | null = null): Promise<void> {
    const ticket = ++this.loadTicket;
    this.state = 'loading';
    this.net?.close();
    this.session?.dispose();
    this.session = null;
    this.net = null;
    this.netGo = false;
    this.loop.timeScale = 1;
    this.hud.setNet(null);
    this.arenaIndex = index;
    this.mode = mode;
    this.combat = mode === 'pvp' || mode === 'online' || (mode === 'playtest' && def.kind === 'combat');
    this.current = { def, mode, index };
    const me = match?.roster.find((r) => r.id === match.you) ?? null;
    const session = await Session.create(
      this.engine,
      this.input,
      this.audio,
      def,
      match ? match.rules : this.combat ? {} : null,
      me ? { setup: { id: me.id, name: me.name }, slot: me.slot } : null,
    );
    // Something else was picked while this arena loaded.
    if (ticket !== this.loadTicket) {
      session.dispose();
      return;
    }
    session.demo = mode === 'menu';
    session.attachAvatar(this.avatar);
    session.localMuzzle = (out) => this.viewModel.muzzleIn(this.engine.camera, out);
    this.botViews = [];
    if (match) this.joinMatch(session, match);
    else if (this.combat) this.addOpponents(session);
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
    if (match) this.online.loaded();
  }

  /**
   * The host started an online match: build its arena with everyone in it and say we are
   * ready. The server runs the match; `net` keeps this screen's copy in step with it.
   */
  private async loadOnline(match: MatchStart): Promise<void> {
    const map = match.map;
    const data = 'builtin' in map ? BUILT_IN_ONLINE_MAPS.find((m) => m.id === map.builtin)?.data : map.custom;
    if (!data || !match.you) {
      this.online.showError("This version of the game can't play that map - reload the page.");
      return;
    }
    this.netRoom = this.online.view().lobby?.code ?? '';
    this.early = [];
    this.menu.close();
    this.hud.setVisible(true);
    this.fade = 1;
    try {
      await this.load(mapToArena(data), 'online', 0, 'entering', match);
    } catch (e) {
      console.error(e);
      this.online.leave();
      this.online.showError(`The match didn't load: ${(e as Error).message}`);
      void this.openMainMenu().then(() => this.menu.openOnline());
    }
  }

  /** Everyone else in the online match (bots included - the server runs them), and the network session. */
  private joinMatch(session: Session, match: MatchStart): void {
    const giveBody = (p: ArenaPlayer, skin: string) =>
      PlayerAvatar.load(skin)
        .then((avatar) => session.setOpponentBody(p, avatar, new PortalGunModel('orange', p.palette)))
        .catch((e) => console.error(e));
    for (const r of match.roster) {
      if (r.id === match.you) continue;
      giveBody(session.addPlayer({ id: r.id, name: r.name }, new IdleCommands(), null, { slot: r.slot, local: false }), r.skin);
    }
    const net = new NetSession(session, session.local, (data) => this.online.sendBinary(data), { predict: FLAGS.predict, scores: match.scores });
    net.onPlayerJoined = (p, entry) => giveBody(p, entry.skin);
    net.onSound = (s) => session.playSound(s.name, s.volume, s.at, s.radius);
    net.onShot = (shot, shooter) => {
      // The server shoots from the eye; the tracer leaves the gun as this screen draws it.
      shooter.gun.showShot(shot.color, session.muzzleOf(shooter) ?? shot.from, shot.to, shot.outcome !== 'fizzle', shot.normal);
      // Your own shot was heard when you clicked; everyone else's from where they stood.
      if (!shooter.local) {
        shooter.avatar?.shoot();
        shooter.gunModel?.charge(shot.color);
        session.playSound(shot.color === 'orange' ? 'shootOrange' : 'shootBlue', 0.7, shot.from, 35);
      }
      if (shot.outcome === 'placed' || shot.outcome === 'fizzle') {
        session.playSound(shot.outcome === 'placed' ? 'portalOpen' : 'fizzle', 0.5, shooter.local ? null : shot.from, 35);
      }
    };
    this.net = net;
    for (const msg of this.early.splice(0)) net.receive(msg);
  }

  /** The connection dropped mid-match for good: back to the Online page (which says so). */
  private async leaveMatch(): Promise<void> {
    this.net?.close();
    this.net = null;
    await this.openMainMenu();
    this.menu.openOnline();
  }

  /** The match is over and the room is back in its lobby: so are we (the host can start a rematch). */
  private async backToLobby(): Promise<void> {
    this.net?.close();
    this.net = null;
    await this.openMainMenu(true);
    this.menu.openOnline();
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
    if (this.mode === 'online') return `ONLINE · ROOM ${this.netRoom}`;
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

  /** Back to the main menu, with an arena running quietly behind it. `keepRoom`: still in the online room (its lobby). */
  async openMainMenu(keepRoom = false): Promise<void> {
    // Leaving an online match leaves its room too.
    if (this.mode === 'online') {
      this.net?.close();
      this.net = null;
      if (!keepRoom && this.online.view().status !== 'idle') this.online.leave();
    }
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
    this.menu.open('pause', `${this.arenaLabel()} · ${this.session?.def.name ?? ''}`, this.mode === 'playtest', this.mode === 'online');
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
      saveToAccount: (map, id) => this.saveToAccount(map, id),
      generator: {
        allowed: () => this.accounts.canGenerate,
        quota: () => this.accounts.generationQuota(),
        start: (request) => this.accounts.startGeneration(request),
        watch: (jobId, onEvent, onLost) => this.accounts.watchGeneration(jobId, onEvent, onLost),
        cancel: (jobId) => this.accounts.cancelGeneration(jobId),
      },
      exit: () => {
        this.editor?.close();
        this.input.lockEnabled = true;
        void this.openMainMenu();
      },
    });
    this.editor.open();
    this.state = 'editor';
  }

  /** The editor's Save online: updates the saved map it came from, or makes a new one. Returns the saved map's id. */
  private async saveToAccount(map: MapData, id: string | null): Promise<string> {
    if (!this.accounts.user) throw new Error('Log in first: main menu → Log in.');
    if (id) {
      try {
        return (await this.accounts.updateMap(id, { data: map })).id;
      } catch (e) {
        // Deleted since, or someone else's (another account is logged in): save a new one instead.
        if (!(e instanceof AccountError) || e.code !== 'no-such-map') throw e;
      }
    }
    return (await this.accounts.saveMap(map)).id;
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

  /** The name typed on the Online page, cleaned up the way the server will, and kept for next time. */
  private rememberName(raw: string): string {
    const name = cleanName(raw);
    if (raw.trim() && name !== this.settings.playerName) {
      this.settings.playerName = name;
      saveSettings(this.settings);
    }
    return name;
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
    if (!session || this.state === 'editor') return;
    // Paused offline, the arena freezes; online the match goes on under the menu.
    if (this.state === 'paused') {
      if (this.net) this.stepOnline(session, this.net, dt, false);
      return;
    }
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
    if (this.input.consumePress('KeyR') && !this.net) this.restart();
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

    if (this.net) this.stepOnline(session, this.net, dt, true);
    else {
      session.step(dt);
      for (const v of this.botViews) v.update();
      for (const e of session.events.splice(0)) this.handleEvent(session, e);
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

  /**
   * One step of an online match: your keyboard and mouse (unless `playing` is false - a menu
   * is open) go to the server and move you here at once; everything else follows the server.
   */
  private stepOnline(session: Session, net: NetSession, dt: number, playing: boolean): void {
    let cmd = null;
    const reconnecting = this.online.view().status === 'reconnecting';
    if (playing && !reconnecting && (this.input.isPointerLocked() || FLAGS.test)) {
      cmd = this.netCommand;
      this.keyboard.read(cmd);
      cmd.fire = this.pendingFire;
    }
    this.pendingFire = null;
    net.step(dt, cmd);
    this.loop.timeScale = net.timeScale;
    if (!net.started) {
      // The countdown: everyone stands on their pad, the arena holds still.
      session.updateOpponentBodies(dt);
      const left = Math.ceil(net.countdown);
      this.hud.setBanner(left > 0 ? String(left) : 'WAITING FOR PLAYERS', left > 0 ? 'Get ready' : '');
    } else if (!this.netGo) {
      this.netGo = true;
      this.hud.setBanner('');
      this.hud.toast('GO!');
    }
    for (const e of net.events.splice(0)) this.handleEvent(session, e);
    session.events.length = 0;
    // (Getting our place back reloads the match; giving up goes to the Online page.)
    if (reconnecting) this.hud.setBanner('RECONNECTING…', `Your place and score are kept for ${REJOIN_SECONDS} s`);
  }

  /** Something happened in the match: tell the player (offline and online alike). */
  private handleEvent(session: Session, e: SessionEvent): void {
    if (e.type === 'death' && e.player === session.local.id && (this.state === 'playing' || this.state === 'entering')) {
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
      if (session.isDead && !this.net) session.respawn();
      this.fade = 0;
      const keys = this.net ? 'Back to the lobby in a moment' : 'R: rematch · Esc: menu';
      this.hud.setBanner(you ? 'YOU WIN' : `${winner.name} WINS`, `${winner.score} points · ${keys}`);
      // Under the menu (online) the result waits for the menu to close.
      if (this.state === 'paused') this.pausedFrom = 'finished';
      else this.setState('finished');
    }
  }

  private updateState(): void {
    const t = this.stateTime;
    // A respawn while not dying (killed under the menu) needs nothing more.
    if (this.net?.respawned && this.state !== 'dying') this.net.respawned = false;
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
        // Online the server brings you back (a little later); offline, as soon as the fade is done.
        if (this.net ? this.net.respawned : t >= DEATH_FADE) {
          if (!this.net) this.session!.respawn();
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
    if (!this.session || this.state === 'loading' || this.net) return;
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
    // Online the shot goes to the server with this step's command; you hear it at once.
    if (this.net) {
      this.pendingFire = color;
      this.audio.play(color === 'orange' ? 'shootOrange' : 'shootBlue', 0.7);
    } else {
      session.fire(color);
    }
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
    const ping = this.online.view().ping;
    // (With ?net=1 the panel shows it, first line.)
    this.hud.setNet(this.net && !this.netOverlay ? (ping === null ? 'PING …' : `PING ${ping} ms`) : null);
    this.netOverlay?.update(frameDt, this.net, ping);
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
