# Bot opponents & portal stealing — plan

Started 2026-10-07. Builds on the win conditions already in the game (`src/game/Match.ts`,
`src/world/PointOrbs.ts`): point orbs, portal kill credit, first to the target score wins.

## Goals

- AI opponents that genuinely try to win: collect orbs, set hazard traps with portals,
  steal portals, dodge hazards.
- Bots are **not all-seeing** and **don't snap around**: they only know what they have
  seen or heard, they turn at human speeds, and they react with a delay.
- **Portal stealing**: shooting another player's portal takes it over.

## Agreed rules and decisions

| Topic | Decision |
|---|---|
| Steal rule | The gun colour you shoot with decides: hitting someone's portal with your orange makes it **your orange** (your old orange closes), linked to your blue. The victim's other portal is left unlinked (inert). The stolen portal stays where it is. |
| Telling portals apart | Each player has their own colour pair. You keep orange/blue; bots get other pairs (no acid green, no laser red). A stolen portal recolours to the thief's pair. |
| First format | 1v1 against one bot on Highwire (the map's two team spawns). Free-for-all with up to 3 bots since 2026-10-08; teams later. |
| First playtest | Bot collects orbs, reads hazard warnings, sets floor-portal traps when it sees you. |
| Death in a match | Only the dead player respawns (at their team spawn, with brief spawn protection); their own portals close; the arena keeps running. Tutorial stages keep the old "reset the whole arena" behaviour. |

## How bots stay fair

- **Same controls as a human.** A bot produces the same per-step command a keyboard and
  mouse do (move, jump, look change, fire, immunity). It can't move its body directly.
- **Sight:** ~100-115° view cone, range limited by fog, line-of-sight ray to head/chest/legs,
  and an enemy must stay visible 0.16-0.38 s (by difficulty) before the bot notices.
- **Hearing:** shots, portals opening, teleports, landings within a radius — gives a rough
  position (with deliberate error), not an exact one.
- **Memory:** last-seen positions fade over ~5 s. Orbs and enemy portals are known only once
  seen (an orb's light column counts — humans see it too).
- **Aim:** turn-speed cap (220–620°/s by difficulty, raised on request 2026-10-08) with
  acceleration, 150–340 ms reaction delay, aim error that shrinks while tracking (down to a
  small wobble), slight overshoot.
- **Speed:** Easy runs at a person's speed; on request (2026-10-08) Normal runs 10% and Hard
  22% faster.
- **Difficulty** (Easy / Normal / Hard) changes these numbers. Easy and Normal never know
  more than this. **Hard is the exception, on request (2026-10-08):** it knows where everyone,
  every orb and every portal is at all times. It still turns at its turn rate, looks at you
  only when you're actually in view, and needs a clear line to hit what it shoots.

## Milestones

### 1. Multiplayer foundation — *done 2026-10-07*

The game assumed one player everywhere. Now everything is per-player:

- [x] Player commands: the controller reads a `PlayerCommand` (move, jump, look, fire,
      immunity) from a command source (`src/player/PlayerCommand.ts`); keyboard+mouse is one
      source, a bot will be another. The camera follows only the local player.
- [x] `Session.players` (`src/game/ArenaPlayer.ts`): each player has a controller, a portal
      pair in their own colours (`PLAYER_PALETTES`), a portal gun, an avatar, a spawn, and
      kill-credit state. `session.player` / `.portals` / `.gun` still mean the local player.
- [x] Portal travel (`PortalSystem.portals`), the laser and portal placement work with any
      number of pairs; a portal can't be placed overlapping anyone's portal.
- [x] Portal rendering handles N pairs within a budget of two full-depth chains, shared out
      nearest-first; every visible open portal gets at least one view. Known limitation:
      inside a portal's view, *other* pairs' portals show their closed swirl.
- [x] Hazards (acid, crushers, platforms, rams, spikes, lasers, crates) act on every player.
- [x] Per-player death and respawn in a match (opponents come back after 1.5 s; 1.5 s spawn
      protection); team spawns from the map (`ArenaBuilder.spawns`). Tutorial stages keep
      the full arena reset.
- [x] A do-nothing **dummy opponent** ("DUMMY", pink/violet portals) in the PvP arena with
      its own body, portals and scoreboard row — portal traps on it already score.
- [x] Tests: `?test=players` (10 checks) plus all existing suites pass (scoring 14, hazards 14,
      arenas 8, portals 15); perf unchanged.

### 2. Portal stealing — *done 2026-10-07*

- [x] A shot landing inside another player's portal opening steals it (`PortalGun` reports
      `stolen`, `Session.steal` swaps it over): it becomes the thief's portal of the gun colour
      used, recoloured, linked to their other portal; the thief's old portal of that colour
      closes and becomes the victim's empty slot. Frame flash, `steal` sound, toasts
      ("STOLE DUMMY'S PORTAL" / "DUMMY STOLE YOUR PORTAL").
- [x] Anything mid-passage carries on to the new partner (tested), or lets go if there is none.
- [x] Kill credit follows the owner at the moment of travel (tested).
- [ ] Short anti-ping-pong lock only if playtests show instant back-and-forth stealing.

### 3. Bot perception and aim — *done 2026-10-07*

Code in `src/bots/`: `BotSkill.ts` (Easy/Normal/Hard numbers, seeded random),
`Perception.ts`, `LookController.ts`, `BotController.ts` (a `CommandSource`).

- [x] Sight: view cone, range capped by fog, line of sight to head/chest/legs, noticing delay
      (re-acquired instantly if lost for under 0.5 s). Hearing: the session records noises
      (shots, portals opening, steals, teleports, landings, footsteps) and bots hear the ones
      in range; only shots/teleports/landings/footsteps give away a player, and only roughly
      (error grows with distance). Memory fades over the skill's memory time. Orbs (or their
      light column) and enemy portals are known only once seen, and forgotten when seen gone.
      Every new piece of knowledge goes in `Perception.log`.
- [x] Look controller: turn-rate cap with acceleration and braking (slight overshoot),
      reaction delay before taking up a new target, aim error that shrinks while tracking.
- [x] The PvP opponent now runs a bot ("sentry" behaviour: stays put, glances around, turns to
      watch whatever it has seen or heard). It still doesn't move or shoot.
- [x] `?test=bots` (8 checks): noticing delay, no seeing through walls or behind its back,
      hearing a shot and turning round at capped speed after its reaction time, aim settling,
      memory fading, orbs only once seen, PvP opponent watching you. All other suites pass
      (players 15, scoring 14, hazards 14, arenas 8, portals 15).
- [x] Residual aim wobble while tracking (milestone 6: 0.2-0.6° by difficulty, never settles
      to zero).

### 4. Navigation — *done 2026-10-07*

Code in `src/bots/NavGraph.ts` and `src/bots/PathFollower.ts`; `BotController.goTo(point)`.

- [x] Navigation graph built at arena load (shared by every bot in the arena): a 1 m grid
      of walkable floor on every tier (one ray per column finds every layer), with room to
      stand checked from just above step height. Links: walk (floor sampled across the body's
      width, steps the controller can take), drop (up to 4 m - free of fall damage), jump (up
      onto ledges up to 1.4 m, across gaps up to 3 m). Highwire: ~4,400 points, ~0.3 s to build.
- [x] A* routes (≈6 ms across Highwire). Acid is left out; cells next to it cost more. Floor
      under timed hazards - crushers, spikes, trapdoors, and now rams' strike zones - stays in
      at a higher cost; while a hazard is dangerous (from its warning on) routes go round it if
      they can, and the follower waits for it if they can't. Hazards gained `covers()` /
      `dangerNow()` for this (point orbs no longer appear under crushers, on trapdoors or in a
      ram's reach either).
- [x] Path follower: fills in the same forward/right/jump keys a person would press, relative
      to wherever the bot is looking; cuts corners only on flat ground; looks a few metres
      ahead along its heading; re-plans when knocked off the route or stuck.
- [x] `?debug=nav` draws the graph; `?arena=pvp` starts straight in the PvP arena.
- [x] `?test=nav` (7 checks): the PvP map mapped on every tier with nothing over acid; spawn to
      spawn on foot in ~27 s unhurt; turn rate within the cap; 5/5 jumps (3 up onto ledges,
      2 across gaps); a safe 3.2 m drop with no damage; no invented routes (tutorial exits
      that need portals have none); waits 4 s for a crusher that is about to come down and
      gets through alive. All other suites pass (bots 8, players 15, scoring 14, hazards 14,
      arenas 8, portals 15).
- [ ] Later: portal moves (portal up to a ledge, floor-portal fling), verified before use.
      Moving platforms are not walkable in the graph yet (Acid Moat only).
- Fixed on the way: Rapier's queries only see colliders after a physics step, so a session
  now takes one quiet step when it is built.

### 5. Bot decisions — first playable bot — *done 2026-10-07*

Code in `src/bots/BotBrain.ts` and `src/bots/TrapSpots.ts`. The brain re-decides every
`thinkInterval` (0.15-0.45 s by difficulty) in this order, using only what Perception knows:

- [x] **Escape** — off floor a hazard covers once its warning starts (nearest safe floor by
      links), out of a laser beam (sideways), and a short sidestep when an enemy it can see
      is aiming straight at it (their look direction shows on their avatar).
- [x] **Floor-portal trap** — an enemy it has noticed, 4-35 m away, standing on portal-taking
      floor: shoot the exit (blue) at the nearest deadly exit spot it can see, then the
      floor portal (orange) under the enemy's feet, leading a walking target slightly.
      Deadly exit spots are precomputed per arena by simulating a body flying out of each
      candidate spot near acid at walking and falling speed (Highwire: 84 spots, low on the
      central pillar's sides, ~15 ms). Gives up if it loses sight for 1.5 s or after 6 s.
- [x] **Collect orb** — nearest known orb an enemy isn't much closer to; orbs it can't reach
      are skipped for a while.
- [x] **Hunt / explore** — no orb known: head for where an enemy was last seen or heard, else
      somewhere it hasn't been lately (12-45 m away), watching for orbs on the way.
- [x] Routes never step on open floor portals (its own trap included).
- [x] Shots go through the same command as a person's: it fires when its view is within
      `aimTolerance` of the mark, at most once per `shotCooldown`.
- [x] Easy / Normal / Hard presets (BotSkill: think rate, shot cooldown, aim tolerance, trap
      chance - Easy only takes ~35% of trap chances - and dodging), picked from the PvP menu
      card (saved in settings); the opponent is now "BOT".
- [x] New rule found while testing: **no portals on spawn pads** in a match (2.5 m) - a floor
      portal left on someone's spawn sent them back into the trap on every respawn.
- [x] `?test=brain` (8 checks): 84 trap exits found; goes for a visible orb (1 s); explores
      to find one out of sight (22 s); steps out from under a crusher as its warning starts;
      never goes for someone before noticing them; traps a player standing in the open
      (noticed 0.5 s, exit 1.3 s, floor 2.3 s, dead in acid 2.8 s, credited to the bot);
      sidesteps 0.3 s after being aimed at; beats a player who stands still (won at 91 s:
      8 orbs, 1 trap kill, never died). All other suites pass (bots 8, nav 7, players 15,
      scoring 14, hazards 14, arenas 8, portals 15).

**→ Playtest 1v1 here** (main menu → PvP Arena → pick a difficulty, or `?arena=pvp`).

Known limits of this first bot: it only sets acid traps (no ram/laser/crate plays yet), it
doesn't steal portals deliberately, its aim settles very precisely once on target, and it
stands still while lining up a trap.

### 6. Testing, tuning, more tactics — *done 2026-10-07*

User asks for this milestone: every difficulty a bit harder, and the hardest one aiming while
moving.

- [x] **Harder presets** (`BotSkill.ts`). Every bot sees wider and further, notices and
      reacts sooner, turns faster, shoots more often:

      | | Easy | Normal | Hard |
      |---|---|---|---|
      | View cone (half-angle) / range | 48° / 45 m | 52° / 60 m | 58° / 80 m |
      | Noticing delay / reaction | 0.38 / 0.38 s | 0.25 / 0.28 s | 0.16 / 0.2 s |
      | Turn rate | 170°/s | 210°/s | 250°/s |
      | Re-decides every / shot cooldown | 0.35 / 0.75 s | 0.2 / 0.5 s | 0.12 / 0.35 s |
      | Trap chance / trap range | 60% / 30 m | 100% / 38 m | 100% / 45 m |
      | Steals a portal it sees | 30% | 70% | always |
      | Dodges / aims on the move | no / no | yes / no | yes / **yes** |

- [x] **Hard aims while moving**: lining up a trap or a steal it keeps walking its route, or
      strafes a few metres across the target's line and back (it holds fire while something is
      in the way). In the sims over 90% of Hard's shots are fired at 1.5+ m/s (Easy/Normal: about 2%).
- [x] **Stealing as a tactic**: an enemy portal it sees (within 32 m, facing it) - someone's trap
      exit is stolen with blue and becomes its own trap exit; a floor portal is stolen with
      orange (a ready-made floor trap once its exit is set); anything else breaks the owner's
      link.
- [x] **Residual aim wobble** (see milestone 3).
- [x] **`?test=sim`** (8 checks, ~5 s): four bot-vs-bot matches at a fixed step with a bot
      driving the local slot too (`ArenaPlayer.autopilot`): all won in time; both bots score in
      every match; nobody stands stuck > 5 s or goes 60 s without scoring; at most one
      uncredited (self-inflicted) death per match; trap kills and steals happen; turn rates
      within the cap and no trap/steal before noticing anyone; Hard shoots on the move and the
      others don't.
- [x] **`?test=balance`** - 50 matches per pairing (~2.5 min; `&n=` to change), sides swapped
      every other match. Latest: **Normal beats Easy 78%, Hard beats Normal 84%, Hard beats
      Easy 96%**; matches last 60-72 s on average, none unfinished.
- [x] **`?debug=bots`** overlay (`BotDebug.ts`): view cone, route, remembered enemies (red
      seen, yellow heard, fading with confidence), known orbs, aim point, and a label with
      difficulty, goal and walking status.
- [x] `?test=brain` now 10 checks (new: Hard sets the trap while moving; steals a trap exit
      and makes it its own). All suites pass: sim 8, brain 10, bots 8, nav 7, players 15,
      scoring 14, hazards 14, arenas 8, portals 15.

Bugs the sims found (all fixed):
- Blind sidesteps walked bots into the acid (13 of Normal's 34 deaths in one run). Dodging now
  reacts to someone aiming at the floor under it (the real threat - a portal), and only steps
  to a side with safe floor for 3 m.
- Orbs counted as "contested" whenever an enemy stood nearer, even standing still; now only if
  they are heading for it or right by it, and contested orbs are just less attractive.
- Two orbs on far sides of a tier took turns looking nearest as the crow flies, so it walked
  laps; it now keeps its orb unless another is clearly nearer.
- It stared at where it last saw an enemy while exploring, so never saw orbs on the way; it now
  watches a lost enemy for 2.5 s (or while hunting), else looks ahead with glances aside.
- Hunt/explore flip-flopping near a visible but untrappable enemy (spawn pad); it closes in on
  someone too far to trap, and leaves alone someone standing where no trap works.
- Static spikes were treated as a timed hazard to wait out - both bots could wait for minutes.
  They're now left off the navigation map like acid, and an orb whose route keeps getting
  stuck is skipped for a while (that check never fired before).

Known limits: traps are still acid floor-portal traps only; one rare self-inflicted death per
few matches remains (falling through its own portal).

### 6b. Hard bot specials — *done 2026-10-08*

User request: Hard sees the whole map, jumps around, and when you're on high ground it gets up
there by portal - a wall exit, or any ceiling that takes portals (flash immunity cancels the
fall damage) - shoots you mid-air, and carries on.

- [x] **Omniscient** (`BotSkill.omniscient`, Hard only): Perception knows every enemy, orb and
      portal; `KnownEnemy.inSight` still says whether you're really in view (it only looks at
      you then - not through walls). Shot decisions use `Perception.clearShot` (only the level
      blocks a portal shot - players and crates don't).
- [x] **Hops** while running (`BotSkill.hops`): only on wide open floor - 2 m of safe floor at
      the same height all round the route ahead and the line it takes off along (it steers in
      the air, and early versions hopped into the acid: 29 self-inflicted deaths in 100
      matches, now 1). On Highwire's narrow walkways that means it hops mostly on the ground
      floor (~8 hops a minute collecting orbs).
- [x] **Portal climbs** (`BotSkill.portalClimb`, `ClimbSpots.ts`): exits worked out per map by
      simulating a body coming out of every wall/ceiling spot that takes portals and keeping
      those that land on high, walkable floor (Highwire: ~390, 10 ms; ceiling exits must fit a
      portal at any angle, so the small 4x3 slots are left out). When you're 3.5 m+ above it:
      pick an exit that lands 3-22 m from you, preferring ones with a deadly trap exit in view
      on the way down; if none is in clear view, walk to a vantage point first; then blue on
      the exit, orange on the floor beside itself, walk in. Out the other side it starts a trap
      on you straight away (planned shots skip the reaction delay) - usually the exit shot is
      fired mid-air - and flashes immunity just before a hard landing. With orbs to collect it
      only climbs when a trap can follow.
- [x] Fixed on the way: trap exits now have to be deadly for the whole body at exit speeds of
      3, 7 and 9 m/s (56 on Highwire, was 84 - some only dropped you on the acid's rim); a trap
      is dropped after 1.5 s without a clear shot; routes keep 2.2 m from open floor portals;
      the follower doesn't count starting a little off the graph as being knocked off its
      route; bot-vs-bot sims and brain tests seed the orbs, so a seed always plays the same.
- [x] Fixed on the way too: a floor trap never goes within 3 m of where it is or is heading.
- [x] Tests: `?test=brain` 13 checks (new: Hard knows where you are and Normal doesn't; Hard
      climbs to you on the north platform and kills you - exit shot fired 14-16 m up in the air;
      Hard hops without dying). All other suites pass (sim 8, bots 8, nav 7, players 15,
      scoring 14, hazards 14, arenas 8, portals 15).
- [x] Balance (50 matches per pairing): **Hard beats Normal 90%, Easy 98%** (was 84% / 96%),
      winning in ~52 s on average; Normal beats Easy 76%.

### 6c. Faster bots, drop-ins — *done 2026-10-08*

User request: Hard does the ceiling combo more often, not only when you're on high ground,
and flicks faster; harder bots move and turn faster.

- [x] **Drop-ins** (`BotSkill.comboChance`, Hard 0.4 every 3 s): an exit in a ceiling it can
      see that lands within 30 m of someone whose floor takes a portal, with that floor and a
      deadly trap exit in view halfway down; a portal beside itself, in, and the trap on them
      while it falls (both trap shots usually mid-air), flash immunity for the landing. Ceiling
      exits may now land on any floor (`ClimbSpots`; wall exits still need high floor). On
      Highwire only the two platform slots qualify - from the pillar-top drop no deadly exit
      can be seen (they're on the pillar's sides).
- [x] **Quicker flicks**: climb and drop-in shots are planned (no reaction delay), and it looks
      at where a planned shot landed after 0.04 s instead of 0.15 s.
- [x] **Faster**: `BotSkill.moveSpeed` (Easy 1, Normal 1.1, Hard 1.22 times a person's top
      speed, via `PlayerController.speedScale`); turn rates 220 / 330 / 620°/s (were
      170 / 210 / 250), quicker reactions and thinking.
- [x] Tests: `?test=brain` 15 checks (new: Hard drops in on you from the north platform's
      ceiling slot - both trap shots fired in mid-air, 20 m and 15 m up, kill in 2.5 s; a bot
      with two enemies picks by nearness and score). The high-ground climb kill now takes 4.1 s
      (was 6.6). `?test=sim` 10 checks over four 1 v 1 and two free-for-all matches.
- [x] Balance (50 matches per pairing): Normal beats Easy 84% (was 76%), **Hard beats Normal
      82%** (was 90% - Normal got faster too), Hard beats Easy 96%; Hard wins in ~49 s.

### 7. More tactics, more players

- [x] **Free-for-all, first cut** (2026-10-08): 1-3 bots picked in the PvP menu
      (`Settings.botCount`), one spawn pad each (Highwire now has four: two per platform).
      Who a bot goes after balances nearest and leading (`BotBrain.priority`: nearness out to
      50 m plus their score against the leader's - early on a small lead counts for little -
      plus a little for whoever it's already after); traps, climbs, drop-ins, hunting and where
      it looks all use it. Sims play two free-for-all matches.
- [ ] More trap kinds: laser relays, dropper crates through portals, ram timing.
- [ ] Ambushing orbs; portal shortcuts in navigation (portal up to a ledge, floor fling);
      personality weights.
- [ ] Teams; per-bot difficulty in free-for-all; spawns for more than two on other maps
      (players beyond a map's spawn count share pads).
- [ ] Moving platforms walkable in the navigation map.

## Risks

- **Portal rendering cost** grows with the number of open portals (each is a full scene render
  per recursion level). Mitigated by the render budget in milestone 1; measure with `?test=perf`.
- **Navigation on portal-heavy maps**: start with walk/drop/jump only; portal moves later.
- **Physics edge case** (found 2026-10-07): a very fast crate launched point-blank sometimes
  bounces off a player without registering the hit. Tracked as a separate task.
