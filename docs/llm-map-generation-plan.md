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
- [ ] `npm run gen:eval` over ~20 golden prompts against the real API (build-pass rate, attempts, tokens, cache hit rate, latency, cost); measure how far Haiku 5.5 gets within the 100K budgets, and only then decide whether a larger model for `draft` is worth its price.
- [ ] Fly secrets, VM size, spend limit/alerts in the Console; update the deploy notes in `online-multiplayer-plan.md`.

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
