# Realtime online multiplayer — plan

Started 2026-10-08. Builds on the multiplayer foundation from the bot work
(`docs/bot-opponents-plan.md`, milestone 1): every player already drives their body through a
`PlayerCommand`, `Session.players` holds everyone, portal pairs/hazards/respawn are per player.

## Goals

- Friends play the same combat map together over the internet, 2-4 players, everyone for
  themselves; empty slots can be filled with bots.
- Movement feels local at normal internet latency (~150 ms): your own body is predicted, nobody
  else can make you rubber-band unless the server really disagrees.
- One rule set: the server runs exactly the simulation offline play runs.

## Agreed rules and decisions

| Topic | Decision |
|---|---|
| Who runs the match | A **dedicated Node.js server** runs every match headless (Rapier + three.js maths, no rendering) and is the authority on everything. Clients send inputs, draw snapshots. |
| Finding each other | **Room code / invite link**: create a room, share the 5-letter code or `?room=ABCDE` link, the host presses Start. No public lobby or queue yet. |
| Match size | **2-4 players free-for-all**, capped by the map's spawn count. The host can fill empty slots with **server-side bots** (difficulty picked in the lobby). |
| Map kinds | **Combat maps only online.** Puzzle maps (solo, ended by the exit goal) stay single-player; the protocol leaves room for a puzzle race/co-op mode later. |
| Which maps | **Built-in combat maps** (Highwire) **or the host's own editor maps**: the host uploads the map JSON, the server checks it (size, kind, it builds) and hands it to everyone who joins. |
| Transport | WebSocket for v1 (one origin with the game page: `wss://` for free, no CORS); snapshots that need no earlier one (what one leaves out comes again soon), so a later move to WebTransport datagrams changes nothing else. |

## How the netcode works

- **Server:** 60 Hz fixed step (the same step as offline), a snapshot to each client every
  2nd tick (30 Hz). Each snapshot has full precision for that client's own player.
- **Inputs:** one `PlayerCommand` per tick, numbered; each packet repeats the last 4 so a lost
  or late packet costs nothing. The server takes exactly one command per player per tick, in
  number order (no speed hacks). When the next one is late the player **waits for it, paused**
  (nothing moves or hurts them) for up to 0.5 s, so the commands play out exactly as that
  player's screen predicted them; after that they stand idle.
- **Clock sync:** each snapshot says how many of your commands are waiting on the server; your
  game clock runs up to 3% fast or slow to keep about 3 waiting. At the start (and after the
  server ran dry) the client jumps 2 steps ahead at once.
- **Your own player is predicted:** the client runs your body on its own copy of the map and
  checks it against the server's answer for the same command; if they disagree beyond a few
  centimetres it rewinds to the server's state and replays the commands since. Small leftover
  error fades out over ~0.1 s; big ones snap.
- **Everyone else is drawn 67-150 ms in the past**, smoothly interpolated between snapshots
  (jumps straight across teleports and respawns instead of sliding through walls). The delay
  follows the connection: as short as it can be while a snapshot is still always in hand.
- **Hazards run on the client's own clock** (they're timer-driven), so a ram shoves you where the
  server will shove you. Twice a second (and straight after a switch is shot) a snapshot carries
  every hazard's state at full precision; the client takes it and runs the hazards on by the
  steps it has played since the command the server last used, which lines them up exactly.
- **Portals and orbs** come in the snapshots after a change (4 in a row), after any shot, and
  twice a second otherwise; the rest of a snapshot is bodies, crates, scores, shots and sounds.
- **Portal shots:** your own placements show up at once (predicted) and the server confirms;
  steals and switch hits show the shot at once and the result when the server says so. No
  lag compensation is needed: a portal shot only hits the level, never players. Other
  players' shots and sounds go off when their (past) bodies are drawn making them.
- **Deaths, health, scores, orbs, steals** are always the server's word.

## Milestones

### 1. Headless simulation core — *done 2026-10-08*

`Session` (src/game/Session.ts) is now split: `ArenaSim` (src/sim/ArenaSim.ts) is the whole
simulation with nothing to look at or listen to, and runs in Node and the browser; `Session
extends ArenaSim` and adds lights, portal views, opponents' bodies, sound from the camera and
the keyboard player, so every existing caller works unchanged.

- [x] `ArenaSim`: physics, level, players, portals, hazards, match, orbs, events, noises,
      `step()`; `ArenaSim.load(def, rules)` makes one with no screen (Session.create is unchanged).
      Bots take an `ArenaSim`.
- [x] No DOM in the sim path: `src/sim/env.ts` (`simEnv.headless` when there's no `document`)
      gives plain materials instead of canvas textures (Materials, ram chevrons, switch icons).
      Hazards and the arena make sounds through `ctx.sound(name, volume, at?, radius?)` /
      `ArenaSim.sound()` - recorded in `sim.sounds` headless, played from the camera by Session.
      `SoundName`, `SessionEvent`, `Noise` live in `src/sim/SimEvents.ts`. The laser hum distance
      is worked out at render time (`Laser.distanceTo`).
- [x] Explicit player slots (`addPlayer(..., { slot, local })`; default the lowest free slot),
      `removePlayer(id)` (body, portals and avatar go, the scoreboard row stays; the slot is
      reused), `localPlayer` (null on a server; `local` is no longer `players[0]`), stable
      `Portal.netId = slot * 2 + (0 orange | 1 blue)`. Non-local players fire through their
      command and respawn on their own - exactly what server-side players need, so the planned
      per-player respawn delay wasn't needed yet.
- [x] Both map kinds still run offline: tutorial stages, an editor puzzle playtest (stepping on
      the exit ends it: LEVEL COMPLETE), an editor combat playtest (scored, bot plays).
- [x] `npm run test:server` (`server/test/headlessSim.test.ts`, run with tsx): 4 bots on
      Highwire headless, **0.25 ms per tick** (match won in 82 s of game time, scores
      85/120/80/40), bots ready in ~0.2 s; the blank combat template 0.13 ms/tick; a player
      leaving mid-match and another joining into the free slot. At 0.25 ms/tick one core could
      run dozens of rooms.
- [x] All existing suites pass: portals 15, arenas 8, hazards 14, scoring 14, players 15,
      bots 8, nav 7, brain 15, sim 10.

### 2. Server, rooms, lobby — *done 2026-10-08*

- [x] **Game server** (`server/main.ts`, `npm run server` = `tsx watch`, port 8787 or `PORT`):
      serves the built game from `dist/`, `/healthz`, and the rooms over a WebSocket on `/ws`
      (`ws` library). `ALLOWED_ORIGINS` limits which pages may connect (unset = any, for dev);
      30 creates/joins per address per minute; heartbeat drops dead connections. The Vite dev
      server proxies `/ws` to it (`vite.config.ts`), so the page always connects to its own
      origin; `?server=` or `VITE_SERVER_URL` point it elsewhere.
- [x] **Rooms** (`src/room/` - plain TypeScript, no networking of its own): `RoomManager`
      checks every message (version handshake first, one slow request per client at a time),
      `Room` holds the lobby (humans in join order, host = first, bots, difficulty, map) and
      builds the match. Codes are 5 letters from `BCDFGHJKLMNPQRSTVWXZ`. Each player gets a
      reconnect token (kept in `sessionStorage`; used in milestone 6). Messages: `src/net/protocol.ts`
      (`PROTOCOL_VERSION` 1).
- [x] **Menu**: main menu → Online (your name, Create room, Join with a code; Enter works in
      both fields) → Lobby (big code, Copy invite link, a row per slot - humans with their
      character, bots, open slots - ping, and for the host: map, bots 0..free slots, difficulty,
      Start). Everyone else sees "Waiting for HOST to start". `?room=ABCDE` (the invite link)
      opens the Online page with the code filled in. Your name is remembered (`Settings.playerName`).
- [x] **Maps**: built-in Highwire, "Editor map: NAME" (the editor's saved draft, now read
      through `src/editor/draft.ts`), or Load .json…. A puzzle draft is listed but greyed out
      ("Puzzle maps are single-player"); the server also refuses puzzle maps, maps over 256 KB
      or 2000 pieces, maps that don't build (it builds them headless, `src/room/mapCheck.ts`),
      and maps with fewer than 2 spawns. Slots = min(4, spawn pads): Highwire 4, the blank
      combat template 2. Bots are clamped to the free slots whenever a friend joins or the
      map changes; a map smaller than the people already in the room is refused.
- [x] **Start** (host, at least 2 players counting bots): the server builds the match - humans
      in slots 0.., then the bots (`BotController`, server side) - logs it ("match built on
      Highwire in 300 ms (2 humans, 2 hard bots)") and sends everyone `matchStart` (map, roster,
      their player id, rules). The lobby then shows "Match starting"; nobody can join a match in
      progress yet. Humans stand still on the server until milestone 3 brings their inputs.
- [x] Errors: wrong code, full room, match already started, not the host, old game version
      ("reload the page"), lost connection.
- [x] `npm run test:server` now 12 tests (8 new in `server/test/room.test.ts`, real WebSocket
      clients against the server on a random port): version check, create/join by code (names
      cleaned), wrong code, host-only bot settings clamped to free slots and passed to everyone,
      full room, custom/puzzle/broken/oversized maps, host hand-over and the room closing when
      empty, Start building a 4-player match. Checked by hand in two browser tabs too (create,
      join through the invite link, bots, Hard, Start, host leaving, puzzle draft greyed out,
      editor combat map picked). Suites players 15 and arenas 8 still pass.

Known limits: back to the lobby / rematch after a match is milestone 6; leaving drops you
straight away (the 20 s rejoin grace is milestone 6).

### 3. First online match — *done 2026-10-09*

Done together with milestone 4: prediction went in straight away, and `?predict=0` gives this
milestone's version (your own player drawn where the server had it, like everyone else).

- [x] **Binary messages** (`src/net/codec.ts` ByteWriter/ByteReader, little-endian):
      `commands.ts` - input messages (the last 4 commands, each 11 bytes: move axes in 1/127
      steps, flags, look change as 32-bit floats; the client plays its own copy quantized the
      same way); `snapshot.ts` - one per client every 2nd step: every player (yours in full
      precision, others at 1/128 m), every portal (face index + centre + up, owner slot and
      colour - stealing just changes those), orbs, crates, hazard states (once a second), the
      shots and sounds since the last one. ~230-300 bytes without hazards. Protocol version 2.
- [x] **Server match loop** (`server/TickLoop.ts`: one 60 Hz accumulator for every room;
      `Room.tick`): loading (everyone sends `loaded`, or 20 s) → 3 s countdown (snapshots,
      arena frozen) → `go` → playing → finished on the win. Humans get an `InputQueue`
      (`src/room/InputQueue.ts`), bots their BotController as before. Deaths, scores, steals
      and the win go out as JSON `events` right after the snapshot that shows them; switch
      notices as `notice`. The server logs each busy room's KB/s and ms/step every 30 s.
- [x] **Client** (`src/net/NetSession.ts`, renderer-free): the arena built from the same map
      JSON, everyone else as *puppets* drawn ~100 ms in the past (`Interpolation.ts`, no sliding
      across portal trips or respawns), portals/orbs/crates/scores/gravity taken on arrival,
      shot tracers and remote sounds played from the snapshot. `ArenaSim.netClient` turns off
      everything the server decides (deaths, damage, scoring, orb pickups, crates, respawns).
- [x] **Game** `Mode 'online'` (`Game.loadOnline` on `matchStart`): the event handling shared
      with offline play (`handleEvent`), countdown banner then GO, dying waits for the server's
      respawn, Esc opens a menu while the match goes on (Leave match, no Restart), losing the
      connection goes back to the Online page. HUD corner: ping; `?net=1` adds KB/s, fixes,
      queue and clock.
- [x] 2 humans + 2 hard bots play a whole match to 105 against the real server (`FULL=1 npm run
      test:server`); both screens end with the server's scoreboard and winner; every portal is
      open in the same place, held by the same player; 10-12 KB/s down, 2.8 KB/s up.

### 4. Prediction, reconciliation, clock sync — *done 2026-10-09*

- [x] Your own body moves at once; every snapshot checks the step the server last used against
      what was predicted for it (3 cm, 0.2 m/s, look, grounded, portal passing) and on a
      miss puts the body where the server had it and replays the commands since
      (`PlayerController.saveMove/restoreMove/replay`, `PortalSystem.stepEntity`; hazards'
      pushes during each step are recorded and replayed). What is left eases out of the camera
      in ~0.1 s; over 1 m it jumps.
- [x] Exact restores: own speed and look go at full 64-bit precision, portal orientation and
      hazard timers too; portal trips derive the new look from yaw/pitch only (not the camera's
      ease-out), so a replayed trip turns you exactly as the server's did.
- [x] Clock sync (above); server holds a player for a late command instead of guessing; out-of-
      order input is slotted back into place.
- [x] `?lag=150&jitter=30&loss=2` (`src/net/DelayLine.ts`: in order, like TCP; loss = a 200 ms
      hold-up), `?predict=0`, `?net=1`.
- [x] Corrections at zero latency: 0-9 a minute (usually 0-3), mostly a few cm - left are
      someone else's portal opening under you before you hear of it, bumping into other players
      (they're drawn in the past) and contact-order differences between the two physics
      worlds. At 150 ± 30 ms with 2% loss: 0-9 a minute (browser: 0 in 18 s of scripted play).
- [x] `npm run test:server` 15 tests (+1 opt-in full match): wire formats, the input queue, two
      headless clients with prediction against the real server, a bad line.

Not done from the original M4 list: the in-page loopback server (`?online=loopback`) and a
browser `?test=net` suite - the headless clients in `server/test/netplay.test.ts` cover the same
ground against the real server. All browser suites still pass (portals 15, arenas 8, hazards 14,
scoring 14, players 15, bots 8, nav 7, brain 15, sim 10).

Known limits then (all fixed in milestone 5): your own portal shots showed a round trip late;
crates were not interpolated; shots and sounds played on arrival.

### 5. Portals, crates, hazards, effects — *done 2026-10-09*

- [x] **Your own portal shots are predicted**: the shot is fired on your screen on the step the
      server will fire it (`ArenaSim.predictShot`, from the same eye), so your portal opens the
      moment you click. Until the server has used that command, what it says about that portal
      is older news and is left alone (`NetSession.pending`); then the server's word stands. A
      steal or a switch only shows the shot - what it does is the server's to say.
      `stats.shotMisses` counts shots that came out differently (usually 0; a miss is a spot
      nudged round a portal a bot had just opened there, put right a round trip later).
- [x] **Other players' shots, sounds and steal flashes go off when their bodies are drawn
      there** (~100 ms after they arrive): snapshot sounds now carry who made them, and
      anything by a player drawn in the past waits for the drawing clock. Your own steal
      flashes when the server confirms it.
- [x] **Crates are interpolated** like players (no sliding across a portal trip or a return
      home; each carries a trip counter) and drawn halfway through portals - the snapshot
      says which portal a crate is passing, so the far-side copy shows.
- [x] **Switch effects on every screen**: portals closing come with the snapshot (and the
      notice); gravity now travels as the exact factor and the number of steps it has left,
      counted the way the server counts them, so it starts and ends on the very step it does
      for your commands (your recent steps are replayed under the new gravity).
- [x] **Rams and trapdoors** (milestone 4 already ran hazards on your clock): checked - a ram
      throwing you off the walkway, a trapdoor dropping you, heavy gravity coming and going:
      0 corrections each.
- [x] Tests: `server/test/netplay.test.ts` - gravity / ram / trapdoor, and a crate dropping
      through a floor portal and out of a wall portal (drawn passing, one jump for the trip,
      at rest exactly where the server has it). Protocol version 3.

Found on the way (not online-specific, handed to its own task): a portal opened under a crate
that has come to rest leaves it hovering - the physics engine has put the crate to sleep.

### 6. Bots online, join/leave, reconnect, rematch, deploy — *done 2026-10-09 (deploy prepared)*

- [x] Server-side bots (since milestone 2).
- [x] **Joining a match in progress**: a friend who joins gets a free slot - or the last bot
      makes room - and loads the match with the scoreboard so far (`matchStart.scores`); their
      body appears once they have loaded, with spawn protection, and everyone else gets
      `playerJoined`. Player ids are never reused in a match (the bot keeps its row and points).
      Messages that arrive while the match is loading wait for it.
- [x] **Dropped connections keep your place for 20 s**: your player holds still, out of reach
      (nothing can kill them for points); the client reconnects by itself (every 2 s, showing
      RECONNECTING… over the match) with its token, gets the match again and carries on as the
      same player with the same score. A reloaded page gets its place back the same way (the
      token is kept per tab) by joining the room's code again. After 20 s the place goes;
      everyone sees "X LOST CONNECTION", "X IS BACK", "X JOINED", "X LEFT". Leaving from the menu
      leaves at once. In the lobby a dropped connection still just leaves.
- [x] **Rematch**: the result stays up 8 s, then the room goes back to its lobby (same map, bots
      and difficulty) and the host can start the next match. Someone joining while a result is
      up waits in the lobby for it.
- [x] Tests: a friend joining a full match (a bot makes room, both scoreboards match the
      server), a dropped connection coming back (same player, same body, score kept, held
      meanwhile), a dropped player who never comes back (gone after 20 s, room closes), the win
      → lobby → rematch. In the browser: two tabs, a mid-match join, a forced 4 s outage
      (RECONNECTING… then back as the same player), the bots winning, both tabs back in the
      lobby, a rematch.
- [x] **Deploy prepared**: `npm run build:server` bundles the server (`dist-server/main.js`,
      Vite SSR); `npm start` runs it, serving the built game and `/ws` from one origin.
      `Dockerfile` (Node 24, `DB_PATH=/data/game.db`), `.dockerignore`, `fly.toml` (one
      always-on machine - rooms live in memory - a volume for the accounts database, `/healthz`
      check, `ALLOWED_ORIGINS`, secure cookies behind Fly's proxy). Checked by running the
      built server locally and playing a match against 3 hard bots through it (0.66 ms a step).
- [ ] Deployed and played from two different networks - needs a Fly.io (or VPS) account:
      `fly launch --no-deploy --copy-config`, `fly volumes create portal_data --size 1`,
      set `ALLOWED_ORIGINS` to the app's address, `fly deploy`.

### 7. Polish — *in progress 2026-10-09*

- [x] **Adaptive interpolation delay** (`Interpolation.ts`): each arriving snapshot measures how
      much was still in hand (counting the steps the drawing clock had to wait at the newest
      one). Short of a step's margin, the delay goes up at once by the shortfall (up to 9
      steps, 150 ms); a whole second with room to spare and it comes down half a step (down
      to 4 steps, 67 ms). A clean line sits at 67 ms (it was a fixed 100 ms); the pretend bad
      line (150 ms, ±30, 2% held back 200 ms) at 150 ms. `stats.delay`, `stats.late`.
- [x] **`?net=1` stats panel** (`src/ui/NetOverlay.ts`, under the ping): down and up KB/s and
      bytes a snapshot, how far behind everyone is drawn and how many snapshots came late,
      the command queue on the server and the clock, corrections (total and last minute) and
      own shots placed differently, the latest correction reasons, and a graph of the last 4 s
      of snapshot arrival gaps (amber/red bars for bunched ones, a red mark where your player
      was corrected) - `NetSession.trace`.
- [x] **Muzzle-origin tracers**, online and off: a shot still goes from the eye, but its tracer
      leaves the gun as it is drawn - the gun in your hands (`ViewModel.muzzleIn`, mapped from
      its own scene to where the main camera sees it) or an opponent's third-person gun
      (`PortalGunModel.muzzlePosition`). `ArenaSim.muzzleOf` (nothing headless, so the server
      sends eye positions); `Session.muzzleOf` / `localMuzzle`.
- [x] **Bandwidth**: portals and orbs only in the snapshots that need them (`writeWorld`,
      written once a round and compared byte for byte; a player who has just loaded gets
      everything for half a second); hazard numbers that are whole go as one byte (phases,
      flags, resting values; timers stay f64). A lean snapshot 300 → ~150 bytes, one with
      hazards 1030 → ~700. Measured in the tests: 11.7 → 7.5 KB/s down a client; up is
      2.8 KB/s (60 input messages a second, each repeating 4 commands). Protocol version 4.
- [ ] **Clock and queue on a lossy line - looked at, left as it is.** The server holds a
      player whose next command is late, so every TCP stall puts their commands later and
      the queue grows by the stall; the client only drains it by running up to 3% slow. On
      the pretend bad line (a 200 ms stall about once a second) the queue settles at ~10
      commands - in effect the queue covers the stalls, which is the right trade there
      (no holds, no mispredictions) at about 0.1 s of extra input delay. Real TCP resends sooner
      than that line pretends; datagrams (below) remove the stalls altogether.
- [ ] **WebTransport trial - assessed, not built** (needs a decision). The client side is small
      (browser `WebTransport`: snapshots and inputs as unreliable datagrams, lobby messages on
      a reliable stream; snapshots already stand alone and inputs repeat the last 4 commands).
      The server side is the cost: Node has no WebTransport server built in, so it means a
      native add-on (e.g. `@fails-components/webtransport`) or a small sidecar in Go/Rust
      relaying to the room server; QUIC needs the server's own TLS certificate (or 14-day
      self-signed certificates passed to the browser by hash); on Fly.io UDP needs a
      dedicated IPv4 and bypasses its HTTPS proxy. Browser support needs checking for Safari.
      Worth it if playtests on real connections show stalls (the `?net=1` graph shows them as
      red bars); keep WebSocket as the fallback either way.
- [ ] A "favour the shooter" grace for steals - only if playtests ask for it.
- [ ] Later: puzzle race / co-op, public lobby, teams.

## Risks

- **Server CPU per room** - measured in milestone 1; the built server runs a 4-player room
  (1 human, 3 hard bots) at 0.66 ms a step - a core holds a couple of dozen. Rooms move to
  worker threads if one core can't hold enough of them.
- **Rooms live in memory** - restarting or redeploying the server ends every match (the
  accounts database is on disk). Deploy when nobody is playing.
- **Prediction drift** - the client's world is never identical to the server's (other players
  sit in the past), so corrections are expected; kept small by rounding inputs the way the
  network does and sending your own state at full precision.
- **Cheating** - inputs are clamped and rate-limited and the server decides every hit, but every
  snapshot contains everyone's position (a wallhack is possible). Acceptable for friends' rooms.
- **TCP stalls under packet loss** - absorbed by the interpolation buffer (it grows to 150 ms
  on a bad line) and by the server waiting for late commands (the queue grows); WebTransport
  later (assessed in milestone 7). A player whose commands are late is paused
  (untouchable) for up to 0.5 s - holding back commands on purpose would exploit that.
- **Hidden tabs stop the game loop** - the server keeps you standing still; the client re-syncs
  when the tab comes back.
