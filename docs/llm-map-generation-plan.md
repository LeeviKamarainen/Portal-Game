# LLM map generation - plan

Started 2026-10-09. Builds on the map format (`src/world/maps/MapFormat.ts`), the server map API (`server/auth/MapApi.ts`), accounts and rights (`src/net/accounts.ts`), and the editor (`src/editor/Editor.ts`). See also [online-multiplayer-plan.md](online-multiplayer-plan.md).

Users describe a map in words ("PvP map with big height differences, floating platforms with hazards on each platform", "recreate Portal 1 chamber 1 as a puzzle") and get a playable map in the editor.

## Goals

- Text prompt in, valid `MapData` out, for **combat and puzzle** maps.
- Output always passes the same build checks as a hand-made map (`mapToArena`, `checkMap`).
- Progress is visible while it runs, and the result lands in the editor for review before it is saved.
- Costs are bounded: opt-in right, per-user quota, global ceiling.
- Puzzle generation gets real Portal-style mechanics (pressure plates, cubes, fizzlers), not just switches and lasers.

## Agreed rules and decisions

| Topic | Decision |
|---|---|
| Orchestration | **LangGraph.js** inside the existing Node server. Microsoft Agent Framework was considered and dropped: it has .NET and Python (and Go preview) SDKs, no JS/TS. A Python sidecar was rejected (second deploy, validation would be re-implemented). |
| LLM provider | **Anthropic API** (`@anthropic-ai/sdk`) for now, changed 2026-10-09 because Azure AI Foundry quota is not available. Claude on Foundry (`@anthropic-ai/foundry-sdk`) or other Foundry models stay a later swap behind a thin model interface in `server/gen/llm.ts`. Model ids come from env, none hard-coded in nodes. |
| Scope v1 | Combat and puzzle maps. |
| Delivery | Job + streamed progress (SSE), not one blocking request. |
| Access | Existing `generate-maps` right (declared in `accounts.ts:15`, not yet enforced anywhere). |
| Turrets | Out of scope. Light bridge, funnel and gel are a stretch decision after the core mechanics. |
| Saved maps | Generated maps are private by default. Text fields are sanitised. |
| Workflow shape | Fixed graph (brief, draft, check, repair, critique, finalize), not a free tool-calling agent. |

## How generation works

```
START -> brief -> draft -> check --ok--> critique --ok--> finalize -> END
                    ^        |                |
                    |        +--problems------+--mismatch--+
                    +------------ repair (max 3 attempts) <-+
```

- **brief** (`claude-haiku-5-5`, structured output): kind, size, height tiers, hazard plan, symmetry; for "recreate X" requests, how the original's mechanics map onto ours, reported to the user as notes.
- **draft** (`claude-haiku-5-5`, structured output, streamed): the whole map in the wire format of `server/gen/wire.ts` (see milestone 1), converted to `MapData` by `fromWire`. Prompt is built from `PIECES` (help, fields, defaults), the coordinate conventions, player/jump numbers, and few-shot maps, so it cannot drift from the code. Static content first, with `cache_control`, so repeat calls pay ~10% for the big prefix.
- **check** (no LLM): zod schema from `PIECES`, deterministic autofix (snap to 0.5 m, clamp into the room, add missing room/lights), `mapProblem`, `mapToArena` + headless build (`checkMap` for combat, new `checkPuzzle` for puzzles), lints (finite numbers, spawns on solid ground, spawn count/spread, exactly one goal for puzzles). Error text carries coordinates.
- **repair**: previous JSON + numbered problems in, whole corrected map out.
- **critique** (`claude-haiku-5-5`): sees the brief and a compact summary of the map, not raw JSON; at most one extra repair loop.
- **finalize**: id, trimmed name/hint/blurb, markup stripped, notes attached.

Provider access: graph nodes call Claude through `@anthropic-ai/sdk`, either directly or via `@langchain/anthropic` (existence and fit to be checked at install; direct SDK calls inside nodes are the fallback). `ANTHROPIC_API_KEY` is server-only: `fly secrets` in production, a gitignored `.env` locally. API rules to respect on these models:
- structured JSON comes from `output_config.format`;
- Haiku 5.5 thinks adaptively by default; `disabled` is only allowed at effort `high` or below, and `budget_tokens` and non-default sampling values return a 400. Set `output_config.effort` explicitly per node (default is `medium`; `low` for `brief`/`critique`);
- no temperature/top_p, no assistant prefill;
- large outputs are streamed (`stream().finalMessage()`), which also feeds the progress events;
- check `stop_reason` for `max_tokens` and `refusal` before using output (Haiku 5.5 has no server-side refusal fallback; a refusal fails the job with a clear message);
- log `usage` (input, output, cache read/write) per call into `generation_jobs`.
Models are injectable so tests use fakes. Switching to Claude on Microsoft Foundry later means swapping the client (`@anthropic-ai/foundry-sdk`) behind the same interface; model ids and any fallback behaviour would be re-checked then.

**Cost rule (2026-10-09): Haiku 5.5 only, every call under 100K tokens.** Haiku 5.5 is $0.10 in / $0.50 out per million tokens for prompts up to 100K tokens, and $0.50 / $2.50 beyond that, so staying under 100K keeps every call in the cheap tier. Enforced in `llm.ts`, all values configurable:
- **Per call:** prompt (input) tokens must stay under 100K. The static catalogue plus few-shot prefix is expected to be a few thousand tokens, so this is a guard against runaway repair history, checked with `messages.countTokens` or a conservative estimate before sending; over the limit the job fails (or drops to the best partial map) instead of sending. `max_tokens` is capped per node (proposal: 24K for `draft`/`repair`, 2K for `brief`/`critique`).
- **Per job (interpretation to confirm):** total input + output tokens across all calls of one generation are also capped at 100K by `JobManager`; when the budget would be exceeded the loop stops and returns the best partial result with its remaining problems. With a ~10K prefix and ~15K map this allows roughly 3-4 `draft`/`repair` calls, so `attempt` limit stays 3 and the budget is the harder stop.
- Haiku is weaker at 3D layout than the larger models, so expect more repair loops and simpler maps; the deterministic autofix and lints carry more of the load, and the eval (milestone 7) decides whether a larger model is ever worth the cost. The model id is an env setting per node, so changing it is one line.

## Server and client

- `server/gen/`: `GenerateApi.ts`, `JobManager.ts`, `graph.ts`, `catalogue.ts`, `check.ts`, `llm.ts`, `config.ts`; wired in `server/main.ts` beside `MapApi`.
- Routes: `POST /api/generate` (202 + job id), `GET /api/generate/:id/events` (SSE), `GET /api/generate/:id`, `DELETE /api/generate/:id` (cancel through `AbortSignal`).
- Gates in order: login, `hasRight`, `originOk`, per-user rate limit, daily quota (10/day proposed), global concurrency (2), prompt <= 500 chars, global daily token ceiling (503 kill switch).
- Migration 1 adds `generation_jobs` (tokens, attempts, status) for quota and audit. Running jobs live in memory; a deploy loses them and interrupted jobs are not charged.
- Validation runs in a `worker_threads` worker: `checkMap`'s headless build is ~300 ms and the 60 Hz tick must not hitch. The worker needs its own entry in `build:server`.
- New dependencies go in `dependencies` (the Dockerfile runs `npm ci --omit=dev`). Watch the 512 MB Fly VM.
- Editor: a Generate button (only with the right), panel with prompt, kind, size, example chips, step timeline, Cancel; result applied with `setMap` so Undo restores the old draft; a Refine box starts a job with `baseMap`.

## Puzzle mechanics to add

Puzzles are single-player and client-only (`mapCheck.ts:52`), so none of this touches netcode or the protocol. New pieces' `build()` throw outside puzzle maps so they can never reach an online room. Existing physics numerics must stay bit-identical (`?test=sim`).

| Mechanic | Approach | Risk |
|---|---|---|
| Pressure plate (`plate`) | `PressurePlate` hazard with `powered` from AABB overlap with players and props. Doors take `inputs[]` with `all\|any` via a `PowerSource` interface (`LaserReceiver` already fits); old `receiver` doors keep working. | Low |
| Weighted cube (`cube`) | `PropBox` variant (skin). `respawn()` resets free props to home. Beware the `'box' in h` duck-typing in `ArenaSim.updatePropLife`. | Low-Med |
| Grab / carry (E) | Velocity-steered hold so existing portal passing carries it; hold target remapped through open portals; holder and cube do not collide; release on death; HUD prompt. | High |
| Fizzler (`fizzler`) | Thick trigger volume: hides props (feeds respawn timer), unplaces portals, clears player portals. | Low-Med |
| Light bridge, funnel, gel | Stretch, decide later. Gel is the likeliest to disturb physics numerics. | High |

## Milestones

### 0. Spike + doc
- [x] **Anthropic key** *(done 2026-10-09)*: key is in the gitignored `.env` at the project root; `.claude/settings.json` denies Claude Code reads of `.env`; `.env` is in `.gitignore` and `.dockerignore`. Still to do on the Console side: a spend limit.
- [x] **Node client** *(done 2026-10-09)*: `@anthropic-ai/sdk` ^0.133 and `zod` ^4.6 added to `dependencies`. Spike run with `tsx --env-file=.env` against `claude-haiku-5-5`:
  - streamed `messages.stream(...).finalMessage()` with `output_config: {effort: 'low', format: zodOutputFormat(schema)}` returned valid JSON that parsed against the zod schema (388 in / 139 out tokens, 3.6 s, content blocks were `["text"]` only, so no thinking text is returned by default);
  - an `AbortSignal` cancelled a long generation with `APIUserAbortError` after 1.5 s;
  - prompt caching works on Haiku 5.5: a ~14K-token static system prefix with `cache_control` wrote 14,416 tokens on the first call and read 14,416 from cache on the second (16 uncached input tokens). The real catalogue prefix will be cached the same way.
  - Still open: `@langchain/anthropic` vs direct SDK calls inside the LangGraph nodes (decide when `graph.ts` is written; direct SDK calls are proven).
- ~~Foundry resource and deployments~~ *(dropped 2026-10-09: no Foundry quota; revisit later. The `az` login on this machine had also expired. The earlier typing check showed `@langchain/openai` 1.6.2 accepts a token-provider function as `apiKey`, which is the route if OpenAI-compatible Foundry models are ever wanted.)*
- [x] **Bundle** *(done 2026-10-09)*: the headless build runs in a `worker_threads` worker built as a second SSR bundle with `vite build --ssr <worker entry> --outDir dist-server --no-emptyOutDir` (so `build:server` becomes two commands, `--emptyOutDir` on the first only). Spike on Highwire: 118 ms cold, 30 ms warm, a bad map returns the same `nothing with id "nope"` error text, and a 16 ms timer on the main thread was at most ~15 ms late while it ran. The worker's imports are only `three`, `@dimforge/rapier3d-compat` and `node:worker_threads`, all already in `dependencies`, so the `--omit=dev` image has what it needs. Still to do: confirm in the Docker image, and decide the dev (`tsx`) path for the worker.
- [x] **This doc.**

### 1. Deterministic core (no LLM) - *done 2026-10-09*
- [x] **Wire format** (`server/gen/wire.ts`): the schema the model fills in. Anthropic structured outputs allow at most 24 optional fields and 16 union types per schema, `minItems` only 0 or 1, and no `maxItems`/tuples, so a schema with every piece parameter does not fit. Instead every field is required and a piece's own parameters are `{key, value}` string pairs, converted back with the catalogue's `FieldSpec` kinds (`fromWire` / `toWire`). The schema has 0 optional fields and 0 unions (asserted in a test) and the API accepted it. Round-trips all six built-in maps and templates exactly.
- [x] **Catalogue prompt** (`server/gen/catalogue.ts`): built from `PIECES`, `MAP_KINDS`, face/side names and the player constants, so it follows the code. About 10K characters (~2.9K tokens), plus ~1.6K tokens for the Highwire example (`renderExample`). Byte-stable between calls (cache-friendly); a test asserts every piece type appears.
- [x] **Checks** (`server/gen/check.ts`): `autofix` (round to 0.01, snap quarter-turn pieces, drop unknown parameters, fix kind/symmetry/fog/killY/id, strip markup from text, add ceiling lights), `lint` (unknown types, bad `at`/`size`/`rot`/parameter values, one room, pieces inside the room and not sticking through walls, unique ids, dropper ceiling, spawn and goal standing on a surface and not buried, spawn spacing, spawn count per kind, one goal for puzzles, symmetric room centred on the origin, every message with coordinates and a suggested fix), `buildCheck` (combat through the existing `checkMap`, puzzle through `ArenaSim.load(..., null)`), and `checkGenerated` chaining them (build only when lint is clean). Deviation from the earlier plan: positions are rounded to 0.01 m rather than snapped to 0.5 m, because shipped maps use values like 7.6 and snapping would break stacking.
- [x] **Tests** (`server/test/gen.test.ts`, 29 tests, no model calls): wire limits and round trips, catalogue, `checkGenerated` accepting every shipped map, 12 deliberately broken maps each reporting the right problem. Full `npm run test:server`: 86 tests, 0 failures.
- **Found on the way:** the shipped **Shaft** map has spawn pads buried inside blocks (its spawn at `(-10, 0, 14)` mirrors to `(10, 0, -14)`, inside the 6 m block at `(12, 0, -12)`). The lint rightly rejects it; it is listed in `KNOWN_BAD` in the test until the map is fixed. Highwire, Catwalk, Courtyard and both blank templates pass.
- **First model drafts (milestone 2 input, one real call each, "pvp map with big height differences, floating platforms with hazards on each platform", `claude-haiku-5-5`, ~7.9K-token cached prefix):**

  | Setting | Time | Output tokens | Result |
  |---|---|---|---|
  | effort `medium` (default thinking) | 47 s | 9.5K | 13 pieces, passed every check first time |
  | effort `low` | 38 s | 7.9K | 18 pieces, 4 spawn problems (buried in a 2 m slab) |
  | thinking disabled, effort `low` | 11 s | 2.3K (~$0.001) | 27 pieces, 8 spawn/placement problems |

  The schema compiled on the first call, and the prompt cache wrote 7.9K tokens then read them back on the next call. Takeaway: thinking is the main cost and latency; thinking off plus lint-driven repair looks like the cheapest path to a richer map, and the failures are the kind the lint explains precisely. To decide with the eval in milestone 2/7.
- **Candidates for milestone 2:** an autofix that lifts a buried spawn onto the surface it is inside (the lint message already says where), and dropping duplicate spawns.

### 2. Graph + CLI - *done 2026-10-10*
- [x] **Graph** (`server/gen/graph.ts`): LangGraph.js `StateGraph` with `plan -> draft -> check -> (critique) -> repair loop -> finalize`, direct SDK calls inside the nodes. A node cannot share a state field's name in LangGraph, so the planning node is `plan` while its events and model calls are still labelled `brief`. Progress goes out through an `emit` callback (the events milestone 3 will stream). Stops: success, 3 model drafts, or the token budget; on a stop it returns the closest map and its problems, and a failed second opinion never loses an earlier passing map.
- [x] **Model layer** (`server/gen/llm.ts`, `config.ts`): `Llm` interface, `AnthropicLlm` (streams, `thinking: disabled` by default, effort, JSON-schema output, cached system prompt, refusal/truncation/bad-output errors) and `BudgetedLlm` (a prompt over 100K tokens is never sent; the job's input + output + cache tokens over all calls stay under 100K, and each call's `max_tokens` is lowered to what is left). Models and thinking mode are env-overridable (`GEN_MODEL_DRAFT`, `GEN_DRAFT_THINKING`, ...); everything defaults to `claude-haiku-5-5`.
- [x] **Prompts** (`server/gen/prompts.ts`): the big static prompt (catalogue + two worked examples, ~8.5K tokens, cached and shared by draft and every repair), a short planning prompt, and a review prompt.
- [x] **CLI**: `npm run gen -- "<prompt>" [--out file.json] [--kind combat|puzzle] [--size small|medium|large] [--no-critique] [--thinking] [--effort low|medium|high]`. Prints each step, problems, notes, per-call tokens and an estimated cost. Output goes to `generated/` (gitignored).
- [x] **Tests** (`server/test/graph.test.ts` + `fakeLlm.ts`, 19 tests, no model calls): happy path; repair loop with the problems and the previous map in the prompt; three bad drafts stop with the closest map; unknown wire parameters are problems; token budget stop; per-call limit; `max_tokens` clamping; review pass / one repair / no second review / earlier good map kept; skipping the review without requirements; cancellation; the Anthropic request shape. Full `npm run test:server`: 113 tests, 0 failures (the netplay "few corrections" test is timing-sensitive and failed once under parallel load, passing alone).
- **Real runs** (`claude-haiku-5-5`, thinking off, effort low), after the fixes below:

  | Prompt | Drafts | Time | Tokens | Cost (list) |
  |---|---|---|---|---|
  | "Pvp map with big height differences, floating platforms with hazards on each platform" | 2 | 22 s | 27.6K | ~$0.003 |
  | "Copy puzzle map from Portal 1 stage 1" | 2 | 20 s | 26.3K | ~$0.003 |

  The first attempts took 4 drafts, 45 s and ~$0.007, which is what drove the changes below.
- **Learned and fixed along the way:**
  - Haiku buries or floats spawns constantly, one slab at a time. `fixSupport` (autofix) now lifts a buried spawn/goal onto the surface it is inside, or drops a floating one onto the highest surface below, and reports it in `fixes`. It also repaired the shipped Shaft map in memory.
  - More autofixes for mechanical mistakes: a dropper ceiling not above its drop point, switch targets that name no hazard (a trigger switch left with none is removed). New lints: spawn/goal in an acid pool, no headroom under the ceiling, a door whose receiver does not exist.
  - The review step first judged things it cannot know (it asked for fidelity to the original Portal level and for hazards on platforms nobody asked about). Now the planner extracts explicit, countable `requirements` from the request, the review checks only those against a summary that lists each floating platform and the hazards on it, and with no requirements the review is skipped. It is still only as good as the planner's requirements: it asked for 3 on the Portal prompt, and the review then asked for 3 changes. The eval in milestone 7 decides whether the review earns its extra calls.
- **Budget accounting decision to confirm:** the 100K job budget counts every token, including prompt-cache reads (8.5K per repair call). A typical job shows 26-58K "tokens" but costs under a cent because cache reads are billed at 10%. Counting cache reads at 10% would let jobs run longer for the same money; left strict for now.

### 3. Job API (+ live building events) - *done 2026-10-10*
- [x] **Live building events** *(added at the user's request: watch the map appear in the 3D view while it is generated)*. `server/gen/partial.ts` reads the model's streaming JSON (the SDK's text snapshots) and yields the map header once and then each piece the moment its closing brace arrives (string- and escape-aware, linear time, tested with the text cut at 1, 7, 64 and all characters, with braces, quotes and backslashes inside values). The graph asks for streaming only when `onPartial` is set and emits `start` (a new draft or repair begins: clear the view), `piece` (add one), and `map` (the checked, tidied map after each check: replace the view with it). A viewer sees the level grow as the model writes it, then snap to the cleaned-up version, and again for each repair.
- [x] **Store** (`SqliteStore` migration 1, `Store`): table `generation_jobs` (user, prompt, kind, status, attempts, tokens in/out, error, times). The daily quota counts a user's running jobs and finished jobs that spent tokens; a run that failed before costing anything, or was interrupted by a restart, is free. `tokensUsedSince` feeds the global ceiling; `interruptRunningGenerations` runs at startup.
- [x] **JobManager** (`server/gen/JobManager.ts`): jobs in memory with every event kept (numbered) for replay, cancel through an `AbortSignal`, retained 10 minutes after finishing, every run recorded in the store. Gates in order: generator configured (503 `generator-disabled`), the `generate-maps` right (403 `no-right`), input (400: 3-500 characters, kind, size), per-user starts per minute (429 `rate-limited`), one running job per user (409 `already-running`), a global cap of 2 running (429 `busy`), 10 a day per user (429 `quota`), the global token ceiling of 5M a day (503 `generator-paused`). All limits and model ids are env-configurable (`GEN_*`, `server/gen/config.ts`).
- [x] **HTTP** (`server/gen/GenerateApi.ts`, wired in `server/main.ts`): `POST /api/generate` (202 + job id + quota), `GET /api/generate/quota`, `GET /api/generate/:id`, `GET /api/generate/:id/events` (server-sent events: `step`, `start`, `piece`, `map`, then `done` or `error`; heartbeats every 15 s; resume with `Last-Event-ID` or `?after=`), `DELETE /api/generate/:id`. Login required, writes need the game's origin like the other `/api` routes, and a user can only see and cancel their own jobs. The generator is on only when `ANTHROPIC_API_KEY` is set; `npm run server` now loads `.env`.
- [x] **Check worker** (`server/gen/checkWorker.ts`, `checkPool.ts`): map checks (a headless build, 10-100 ms) run on a worker thread so they cannot stall the 60 Hz loop; if the worker cannot start it logs once and falls back to the main thread. `build:server` now also emits `dist-server/checkWorker.js`; verified: the built worker checks Highwire in 234 ms cold, the built server boots, and it sits at 138 MB RSS idle (the Fly VM has 512 MB).
- [x] **Tests**: `server/test/generate.test.ts` (12 end-to-end tests over real HTTP/SSE with a scripted model: gates, the event sequence and every piece streamed, tokens and the stored record, reconnect with `Last-Event-ID`, isolation between users, 409 and cancel, refusal not charged, daily quota, start rate, concurrency and token ceiling, origin check, interruption on shutdown), `store.test.ts` (+2), `graph.test.ts` (+4: the reader and build events). Full `npm run test:server`: 131 tests, 0 failures.
- **Found by a test:** a viewer reconnecting to a finished job with a `Last-Event-ID` already past the last event got no events and the stream never closed; it now closes at once.
- Not done here (belongs with deployment): `fly secrets set ANTHROPIC_API_KEY=...`, and checking the Docker image runs the worker (it only needs the extra `dist-server/checkWorker.js`, which `build:server` now produces).

### 4. Editor UI (with the live 3D view) - *built 2026-10-10, not yet tried in a browser*
- [x] **Generate panel** (`src/editor/GeneratePanel.ts`): a **Generate** button in the editor's top bar, shown only to users with the `generate-maps` right (asked every time the editor opens). The panel has the prompt (500 characters), type and size, example prompts, "N of 10 generations left today", Generate / Cancel, and a step list fed by the `step` events (check steps list their problems). Messages for no right, generator not set up, quota used up, and server errors.
- [x] **Live building in the 3D view** *(requested)*: while a generation runs, editing is locked (the camera still works, WASD/QE too; the bars are dimmed). The editor's own map stays on screen until the model starts writing; then `start` swaps it for an empty generated view, each `piece` adds its view (the newest is marked with a yellow box, the camera frames the room when it arrives), `map` replaces the pieces so far with the checked, tidied map, and `done` makes that map the editor's (`setMap`: Undo restores the previous one; draft autosave and undo history were untouched until then). A failed or cancelled run puts the previous map back. Not done: a drop-in animation.
- [x] **Refine**: the "Change the map in the editor" checkbox sends the current map as `baseMap` (up to 150 pieces). Server: `server/gen/base.ts` validates and tidies it as untrusted input; the planner step is skipped (no model call; the map is the plan, its kind and symmetry stay), the draft prompt is `refineUser` (the request plus the map in the model's own format), repairs say "requested change to an existing map", and the map keeps its id. A refined map stays linked to the saved map it came from (Save online updates it); a new generation is unlinked so it can never overwrite one. The request body limit is now 128 KB.
- [x] **Shared types** in `src/net/generate.ts` (request, quota, events), imported by both the page and `server/gen`, so the wire format cannot drift. `AccountClient` has `canGenerate`, `generationQuota`, `startGeneration`, `cancelGeneration`, `watchGeneration` (EventSource, resumes by itself from the last event).
- [x] Tests: refinement in the graph (+2), the HTTP flow and body limits (+1), `cleanBaseMap` (+1). Full suite 135 tests, 0 failures. `tsc` clean for page and server; both production bundles build.
- [ ] **To do by trying it:** run `npm run server` and `npm run dev`, log in as a user with the right (`npm run admin -- grant <name> generate-maps`), open `/?editor=1`, press Generate. The panel, the lock and the live view have not been exercised in a browser yet (the first browser test was declined), only type-checked and bundled.

### 4b. Blueprint planning: coherent levels - *done 2026-10-10*
Found by trying the generator: it forgot the floor (it set the room to "skip the floor", then built a 24 x 24 m slab under a 64 x 64 m room), and platforms showed no texture underneath (it copied `hide: ["bottom"]` from the Highwire example, so undersides were never drawn).
- [x] **A written plan first** (`server/gen/blueprint.ts`): the planner no longer writes prose tiers. It writes a *blueprint*: the room size, whether there is a `floor` or a `void`, and every part as a rectangle (centre, width, depth, underside, top) with a role (ground island, raised mass, floating slab, stairs, wall, hazard zone), whether it takes portals, which hazards belong on it, and the links between parts (walk, jump, portal, drop), the spawns and the goal. The user sees it as a list under the planning step.
- [x] **Code checks the plan** (`blueprintProblems`): inside the room, headroom, stairs no steeper than 45 degrees, a void level has islands covering at least 12% of the room, every link is possible with the player's real numbers (a walk needs touching areas within 0.3 m, a jump climbs 1.8 m and crosses 3.5 m, a portal needs portal surfaces at both ends), spawns stand inside their area, and every walkable area is reachable from a spawn (mirrored copies included).
- [x] **Code settles the plan's arithmetic** (`repairBlueprint`, no model call): numbers to 0.1 m, islands at y=0, areas pulled into the room, stairs lengthened to the run they need, impossible links retyped or dropped, spawns pulled inside their area, and an unreachable part joined to the nearest reachable one (a walk, jump or drop if one works, otherwise a portal pair). Haiku reasons well about *what* a level contains and badly about metres; on the first real run this removed 9 plan problems that two correction calls had not. Only what code cannot settle goes back to the model (at most 2 corrections).
- [x] **The structure is built from the plan** (`scaffold`): room (with or without floor as planned), every area as blocks, floating slabs, stairs with the right turn, portal walls, acid pools, spike patches, spawns facing the centre, goal. This is shown in the 3D view at once. The model then only adds what the plan lists and the request asks for (moving hazards, switches, portal walls, cover): `fillUser` hands it the scaffold and asks for the complete map back unchanged plus those.
- [x] **The finished map is held to the plan** (`conformance`): every planned surface must exist at its height (sampled at five points), every stairs/wall, the listed hazards near their area, the spawns; each miss is a problem with coordinates for the repair call. `applyGround` forces the room floor to agree with the plan's `floor`/`void`.
- [x] **The texture bug**: `autofix` drops `hide` on generated maps (every face is drawn), the catalogue no longer lists the parameter, and the Highwire worked example is stripped of it. The shipped maps keep theirs (their hidden faces are over a void nobody sees).
- [x] Tests: `blueprint.test.ts` (15: examples pass, scaffold builds a map that passes every check and conforms, Highwire conforms to its blueprint, each plan check and repair, the texture fix), graph and e2e tests updated. 155 tests, 0 failures.
- Real runs (Haiku 5.5, thinking off): PvP prompt 21 s / 33.6K tokens / ~$0.004 with one planning call, nine automatic plan adjustments and one review-triggered repair; the Portal chamber prompt 7 s / 15.8K tokens / ~$0.001. Both ok in the first or second draft. Quality of the layouts is not yet measured (milestone 7).
- Follow-ups from trying it (same day):
  - **Live view shows only what changed.** A repair used to clear the view and stream the whole map again. Now the editor keeps what is shown and patches by piece index (pieces compared by content), so only new or changed pieces are redrawn and flash green; the scaffold includes the lights piece so the tidy-up does not shift every index. The unchanged map stays on screen throughout.
  - **Portal walls stand level with the ground beside them.** A wall a little too low is buried (a portal there opens into the ground) and one a little too high leaves a step nobody can climb into the opening. `fixSupport` snaps a wall whose two sides agree on one ground level (keeping its top), `lint` reports the rest with the levels, and `repairBlueprint` stands planned walls on the area they touch.
  - **Spawns and the goal out of acid.** The plan check and a code fix move them to the nearest dry spot of their area (a ledge above a pool counts as dry); the same at map level in `fixSupport`.
  - **Plan repair bugs found by real runs:** it joined an area to the floor even when no spawn could reach the floor (30 duplicate links); areas up to 1.5 m above the floor now join it implicitly (a standing jump); a plan that lists both halves of a "symmetric" level is no longer mirrored a second time (that made every spawn appear twice).
- Known weaknesses: an unreachable part is joined by portal to the floor, which is correct but lazy; the planner decides whether a request's "hazards on each platform" is met (the review still catches a platform the plan left bare); the plan does not yet place moving hazards, switches or wiring (puzzle mechanics belong to milestones 5 and 6).

### 5. Puzzle mechanics (parallel track; each step ships on its own)
- [ ] 5a. `plate` + multi-input `door`, editor view and validation, tests.
- [ ] 5b. `cube` variant, puzzle reset of free props, puzzle-only build guard.
- [ ] 5c. Grab/carry through portals (spike first; must not block the others).
- [ ] 5d. `fizzler`.
- [ ] 5e. Stretch: light bridge, funnel, gel.
- After each step: `?test=sim` and `?test=hazards`, plus new Node tests that build a puzzle with `ArenaSim.load(mapToArena(data), null)` and step it headless.

### 6. Puzzle quality
- [ ] Convert 1-2 campaign puzzles (and a new plate/cube one) to JSON as few-shot; Portal substitution table; `checkPuzzle` + spawn-to-goal reachability lint (reuse `NavGraph` if it fits); "unverified" badge; critique tuning.

### 7. Eval + deploy - *eval done 2026-10-10; deploy prepared, not deployed*
- [x] **Eval harness** (`npm run gen:eval`; `server/gen/golden.ts`, `evalRun.ts`, `evalReport.ts`, `eval.ts`): 20 golden prompts (12 combat, 8 puzzle, including the two from the original request) run through the real pipeline, N runs each, a few at a time. Per run it records result, drafts, tokens by kind, prompt-cache hit rate, latency, cost at list price, what the *first* check found wrong, what the review asked for, and what was still wrong when it gave up. The report (`report.md` + `report.json` + every map, under `generated/eval/<time>/`, gitignored) has a summary, a row per run, and the problem tables clustered by kind (numbers and ids stripped). Flags: `--only a,b`, `--runs n`, `--concurrency n`, `--no-critique`, `--thinking`, `--effort`, `--list`. A pass only means "builds and lints clean", so each prompt also carries measurable **expectations** (kind, spawns, piece counts, height spread, floating platforms, a hazard on each platform, portal surfaces, void floor); the report shows how many a built map meets. 10 offline tests cover the statistics, clustering, the golden set, the measurements and the runner with a scripted model.
- [x] **Results with Haiku 5.5** (thinking off, effort low, review on):

  | run | runs | build pass | first draft | meets expectations | tokens median / p90 / max | cost per run | latency median / p90 |
  |---|---|---|---|---|---|---|---|
  | 1: before the fixes below | 20 | 95% | 5% | 79% | 28.8K / 42.9K / 50.6K | $0.0025 | 13 s / 22 s |
  | 2: same code, second sample | 20 | 80% | 30% | 75% | 29.1K / 41.3K / 43.1K | $0.0022 | 14 s / 19 s |
  | 3: after the fixes | 40 | **100%** | 82% | 80%* | 17.8K / 29.6K / 41.2K | $0.0015 | 10 s / 13 s |
  | 4: review on | 40 | **100%** | 78% | **97%** | 17.9K / 29.1K / 46.2K | $0.0017 | 10 s / 17 s |
  | 4: review off | 40 | 100% | 82% | 95% | 16.8K / 26.9K / 41.2K | $0.0014 | 9 s / 11 s |

  \* run 3 counted expectations the game cannot meet yet (a switch that opens a door, a crate on a target); they were removed from the golden set for run 4 and return with milestone 5.
  Prompt cache hit rate was 84-88% of prompt tokens. No run came near the 100K job budget (max 50.6K), so the budget stays strict.
- [x] **What the eval found and fixed** (every one was a code problem, not a model limit):
  - *A wall between two ground levels could not be satisfied.* A portal wall on the edge of a shore or ledge has ground at one height on one side and another on the other; the lint demanded both, so the model flipped the wall between y=0 and y=1 for all three drafts. Now `fixSupport` stands the wall on the lower ground and lets only that face take portals (the other face is partly buried, which is what made portals open into the ground); the lint only complains about a face that takes portals.
  - *A spawn with acid all around it could not be moved.* Models draw the pool over the whole floor, or over half of a symmetric map (so the mirrored copy covers the spawns). When no dry spot exists, `fixSupport` cuts a 6 x 6 m dry pad out of the pool (a pool's mirrored copy is cut through its written original).
  - *A parameter the piece does not have* (`id` on a wall) was a problem that cost a repair call; it is dropped and listed under "fixes".
  - *The review step reported what it could not see.* Half its "problems" were "not shown in the summary". It now treats a requirement the summary does not show either way as met, and reports only what the summary shows broken.
  - Harness bug found on the way: the first check event carries no result, so "what the first draft got wrong" read empty in run 1.
- [x] **Decisions the data supports**
  - *Model:* Haiku 5.5 is enough: 100% build pass in 40 of 40 and 97% of measured expectations; nothing to buy with a larger model for `draft`. Revisit if the golden set grows harder prompts and the first-draft rate falls.
  - *Review step:* keep it. It asked for changes in 15% of runs for +6% tokens (about $0.0003 a run) and fixed "hazards on each platform" on the original PvP prompt; the difference in expectations met (97% vs 95%) is one run in 40, a tie within the noise, decided by the price.
  - *Cache reads in the job budget:* keep counting them in full. The largest job used 46K of 100K with cache reads counted in full, so loosening buys nothing.
  - *Spend:* about $0.0017 a generation at list price. The default ceilings (5M tokens a day over all users, 10 a day per user) are roughly 280 generations, well under a dollar a day.
- [x] **Deploy preparation**
  - *Worker memory:* the check worker's heap was unbounded. In a production install (`npm ci --omit=dev`, built bundle) its resident memory climbed to 360 MB after 60 checks (garbage, not a leak), which with the server's ~140 MB would be killed on the 512 MB machine. The worker now has `resourceLimits` (128 MB old space, 16 MB young); the same 60 checks stay flat at 127 MB, and server plus worker are about 270 MB. A worker that does hit the cap dies, the check falls back to the main thread, and the next one starts a fresh worker (covered by a test).
  - *Production dependencies:* verified by installing only `dependencies` in a clean directory and starting the built server: it boots, `/healthz` is ok, `/api/generate/quota` answers 401 (generator enabled with a key set), and the built worker checks a generated map in 20-250 ms.
  - *Admin tool in production:* `npm run admin` uses `tsx`, a dev dependency the image omits, so on Fly there would have been no way to grant `generate-maps`. `build:server` now also bundles `dist-server/admin.js` (`npm run admin:prod -- grant <name> generate-maps`; on Fly `fly ssh console -C "node dist-server/admin.js grant <name> generate-maps"`). Verified against a scratch database.
- [ ] **To do by the owner** (needs accounts and secrets, so not done here):
  1. `fly secrets set ANTHROPIC_API_KEY=...` (the generator switches on when it is set; without it `/api/generate` answers 503 `generator-disabled` and the editor hides the button).
  2. In the Anthropic Console: a monthly spend limit and an alert (the code's ceiling is per day in tokens; the Console limit is the backstop for everything else, including a leaked key).
  3. `fly deploy`, then grant yourself the right with the command above and try it once in the editor.
  4. Watch the first days: the machine's memory (`fly status`, `fly logs`) and the `generation_jobs` table for failures. Tuning without a code change: `GEN_DAILY_LIMIT`, `GEN_MAX_CONCURRENT`, `GEN_DAILY_TOKEN_CEILING`, `GEN_CRITIQUE=off`, `GEN_MODEL_DRAFT`.
- **Not measured:** how the maps *play*. The eval shows that they build, lint clean and contain what was asked for; whether a layout is fun or fair needs people. Also still untried in a real browser: the Generate panel, the locked editor and the live diff view.
- **Limit the eval made visible:** puzzles can only be as good as the mechanics. "A switch that opens a door" and "a crate that opens a door" cannot be built today (a switch only sets off hazards, a door opens only for a laser receiver, a target is a painted ring), and the generator says so in `notes`. Milestone 5a/5b removes this; add the matching expectations back to `golden.ts` when they land.

## Risks

- **Spatial quality.** LLMs place pieces badly; mitigated by brief-first design, autofix and coordinate-bearing errors, but expect an eval-driven prompt loop.
- **Haiku-only quality.** Map layout may come out simpler or need more repairs than a larger model would give; the per-job 100K token budget can end a job with a partial result.
- **Cost.** Repair loops multiply tokens; capped by attempts, the per-call and per-job 100K limits, quotas, the global ceiling and a Console spend limit. Prompt caching on the static prefix is the main saver; verify with `cache_read_input_tokens`. Per-generation cost is unmeasured until milestone 2.
- **Provider lock.** Keep the model interface thin so Foundry (or another provider) can be swapped in later.
- **Puzzle solvability.** No solver exists; v1 only lints reachability. Until 5a-5d land, generated puzzles can only use switches, lasers and hazards.
- **"Copy Portal 1 stage 1".** The model reconstructs an approximate layout from its own knowledge as new geometry; results are labelled "inspired by".
- **Grab/carry through portals** is the highest-risk game change.
- **Concurrent edits.** Other sessions edit the same files; keep mechanics changes small and gated behind new pieces.
- **Bundle and memory.** Worker entry under Vite SSR; 512 MB VM.
- **Deploys end jobs** because state is in memory.
