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
| LLM hosting | **Azure AI Foundry** model deployments via the OpenAI-compatible `/openai/v1/` endpoint. Deployment names come from env, none hard-coded. |
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

- **brief** (fast model, structured output): kind, size, height tiers, hazard plan, symmetry; for "recreate X" requests, how the original's mechanics map onto ours, reported to the user as notes.
- **draft** (strong model, structured output): full `MapData`. Prompt is built from `PIECES` (help, fields, defaults), the coordinate conventions, player/jump numbers, and few-shot maps, so it cannot drift from the code. Static content first for prompt caching.
- **check** (no LLM): zod schema from `PIECES`, deterministic autofix (snap to 0.5 m, clamp into the room, add missing room/lights), `mapProblem`, `mapToArena` + headless build (`checkMap` for combat, new `checkPuzzle` for puzzles), lints (finite numbers, spawns on solid ground, spawn count/spread, exactly one goal for puzzles). Error text carries coordinates.
- **repair**: previous JSON + numbered problems in, whole corrected map out.
- **critique** (fast model): sees the brief and a compact summary of the map, not raw JSON; at most one extra repair loop.
- **finalize**: id, trimmed name/hint/blurb, markup stripped, notes attached.

Foundry access: `ChatOpenAI` (fallback `AzureChatOpenAI`, then the `@azure/ai-projects` OpenAI client) with key auth in production (`fly secrets`) and Entra ID (`az login`) locally. The JS v1-endpoint + token-provider combination is unverified and is the first spike. Models are injectable so tests use fakes.

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
- [ ] **Foundry:** create the resource and two deployments (strong + fast).
- [ ] **Node client:** key and Entra auth, `ChatOpenAI` on the v1 endpoint, structured output, abort signal. *Typing check done 2026-10-09:* `@langchain/openai` 1.6.2 takes the `openai` 7.31 `ClientOptions["apiKey"]`, which is `string | (() => Promise<string>)`, so an Entra token provider (`getBearerTokenProvider` from `@azure/identity`) fits without `AzureChatOpenAI`. Not yet run against a real endpoint (the local `az` login has expired).
- [x] **Bundle** *(done 2026-10-09)*: the headless build runs in a `worker_threads` worker built as a second SSR bundle with `vite build --ssr <worker entry> --outDir dist-server --no-emptyOutDir` (so `build:server` becomes two commands, `--emptyOutDir` on the first only). Spike on Highwire: 118 ms cold, 30 ms warm, a bad map returns the same `nothing with id "nope"` error text, and a 16 ms timer on the main thread was at most ~15 ms late while it ran. The worker's imports are only `three`, `@dimforge/rapier3d-compat` and `node:worker_threads`, all already in `dependencies`, so the `--omit=dev` image has what it needs. Still to do: confirm in the Docker image, and decide the dev (`tsx`) path for the worker.
- [x] **This doc.**

### 1. Deterministic core (no LLM)
- [ ] `catalogue.ts`, zod schema from `PIECES`, `check.ts` autofix + lints, tests with Highwire, `blankMap`, `blankPuzzle` and hand-broken maps.

### 2. Graph + CLI
- [ ] `graph.ts` with fake models (broken then fixed output proves the repair loop).
- [ ] `npm run gen -- "<prompt>" --out map.json` against real models, tried on both example prompts.

### 3. Job API
- [ ] `GenerateApi`, `JobManager`, SSE, gates, migration 1, tests (403 without the right, 429 over quota, cancel, SSE order, interrupted job).

### 4. Editor UI
- [ ] Generate panel, progress, apply, refine, hidden without the right.

### 5. Puzzle mechanics (parallel track; each step ships on its own)
- [ ] 5a. `plate` + multi-input `door`, editor view and validation, tests.
- [ ] 5b. `cube` variant, puzzle reset of free props, puzzle-only build guard.
- [ ] 5c. Grab/carry through portals (spike first; must not block the others).
- [ ] 5d. `fizzler`.
- [ ] 5e. Stretch: light bridge, funnel, gel.
- After each step: `?test=sim` and `?test=hazards`, plus new Node tests that build a puzzle with `ArenaSim.load(mapToArena(data), null)` and step it headless.

### 6. Puzzle quality
- [ ] Convert 1-2 campaign puzzles (and a new plate/cube one) to JSON as few-shot; Portal substitution table; `checkPuzzle` + spawn-to-goal reachability lint (reuse `NavGraph` if it fits); "unverified" badge; critique tuning.

### 7. Eval + deploy
- [ ] `npm run gen:eval` over ~20 golden prompts against real Foundry (build-pass rate, attempts, tokens, latency, cost).
- [ ] Fly secrets, VM size, budget alerts; update the deploy notes in `online-multiplayer-plan.md`.

## Risks

- **Spatial quality.** LLMs place pieces badly; mitigated by brief-first design, autofix and coordinate-bearing errors, but expect an eval-driven prompt loop.
- **Cost.** Repair loops multiply tokens; capped by attempts, quotas and the global ceiling.
- **Unverified JS path.** Foundry v1 + Entra from JS is not confirmed; milestone 0 decides.
- **Puzzle solvability.** No solver exists; v1 only lints reachability. Until 5a-5d land, generated puzzles can only use switches, lasers and hazards.
- **"Copy Portal 1 stage 1".** The model reconstructs an approximate layout from its own knowledge as new geometry; results are labelled "inspired by".
- **Grab/carry through portals** is the highest-risk game change.
- **Concurrent edits.** Other sessions edit the same files; keep mechanics changes small and gated behind new pieces.
- **Bundle and memory.** Worker entry under Vite SSR; 512 MB VM.
- **Deploys end jobs** because state is in memory.
