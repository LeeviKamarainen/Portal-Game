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
| Transport | WebSocket for v1 (one origin with the game page: `wss://` for free, no CORS); full self-contained snapshots so a later move to WebTransport datagrams changes nothing else. |

## How the netcode works

- **Server:** 60 Hz fixed step (the same step as offline), a snapshot to each client every
  2nd tick (30 Hz). Each snapshot has full precision for that client's own player.
- **Inputs:** one `PlayerCommand` per tick, numbered; each packet repeats the last 4 so a lost
  or late packet costs nothing. The server takes exactly one command per player per tick
  (queue capped - no speed hacks); a missing one repeats the last movement with no look/fire.
- **Your own player is predicted:** the client runs your body on its own copy of the map and
  checks it against the server's answer for the same command; if they disagree beyond a few
  centimetres it rewinds to the server's state and replays the commands since. Small leftover
  error fades out over ~0.1 s; big ones snap.
- **Everyone else is ~0.1 s in the past**, smoothly interpolated between snapshots (jumps
  straight across teleports and respawns instead of sliding through walls).
- **Hazards run on the client's own clock** (they're timer-driven), so a ram shoves you where the
  server will shove you; the server corrects drift now and then.
- **Portal shots:** your own placements show up at once (predicted) and the server confirms;
  steals and switch hits show the shot at once and the result when the server says so. No
  lag compensation is needed: a portal shot only hits the level, never players.
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

### 2. Server, rooms, lobby

- [ ] Node server (`server/`): serves the game, `/healthz`, WebSocket on `/ws`; rooms with
      5-letter codes; reconnect tokens.
- [ ] Menu: Online → name, Create room / Join with code; lobby with the code, Copy invite link,
      the slots (human / bot / empty), and for the host: map, bots, difficulty, Start.
- [ ] Map picker: built-in combat maps and the host's editor maps; puzzle maps listed but
      greyed out ("Puzzle maps are single-player"); broken or oversized maps refused with the
      reason; the slot cap follows the map's spawns.
- [ ] Errors for a wrong code, a full room, an old game version; the host leaving hands the
      room to the next player.

### 3. First online match (authoritative, no prediction yet)

- [ ] Binary inputs and snapshots, interpolation of everyone (even yourself, to prove the
      plumbing), server events (deaths, scores, steals, win) through the same HUD/audio code as
      offline. Ping in the HUD.
- [ ] 2 humans + 2 bots play to 100 on localhost; scoreboards agree; portals and steals show on
      both screens; under 15 KB/s per client.

### 4. Prediction, reconciliation, clock sync

- [ ] Your own body predicted and corrected (rewind + replay through portals), client clock
      kept a couple of ticks ahead of the server, hazards on the client clock.
- [ ] Latency simulation flags (`?lag=150&jitter=30&loss=2`) and an in-page loopback server
      (`?online=loopback`); `?test=net` suite.
- [ ] ~0 corrections a minute at zero latency; at 150 ms movement feels local.

### 5. Portals, crates, hazards, effects

- [ ] Predicted own portal placements; remote shots, sounds and steal flashes in time with the
      shooter; crates through portals; switch effects (all portals closed, gravity) on every
      client; ram knockback and trapdoor timing match.

### 6. Bots online, join/leave, reconnect, rematch, deploy

- [ ] Server-side bots, joining a match in progress, rejoining within 20 s keeps your slot and
      score, rematch / back to lobby.
- [ ] Deployed (one Node process on Fly.io or a VPS), played from two different networks.

### 7. Polish

- [ ] Adaptive interpolation delay, `?net=1` stats overlay, bandwidth tuning, WebTransport
      trial, a "favour the shooter" grace for steals only if playtests ask for it.
- [ ] Later: puzzle race / co-op, public lobby, teams.

## Risks

- **Server CPU per room** - measured in milestone 1; rooms move to worker threads if one core
  can't hold enough of them.
- **Prediction drift** - the client's world is never identical to the server's (other players
  sit in the past), so corrections are expected; kept small by rounding inputs the way the
  network does and sending your own state at full precision.
- **Cheating** - inputs are clamped and rate-limited and the server decides every hit, but every
  snapshot contains everyone's position (a wallhack is possible). Acceptable for friends' rooms.
- **TCP stalls under packet loss** - absorbed by the interpolation buffer; WebTransport later.
- **Hidden tabs stop the game loop** - the server keeps you standing still; the client re-syncs
  when the tab comes back.
