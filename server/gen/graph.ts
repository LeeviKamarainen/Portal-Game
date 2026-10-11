import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { MapData, Piece } from '../../src/world/maps/MapFormat';
import { BlueprintSchema, applyGround, blueprintLines, blueprintProblems, conformance, repairBlueprint, scaffold, type Blueprint } from './blueprint';
import { checkGenerated, type CheckResult } from './check';
import type { GenConfig } from './config';
import { GenError, type Llm } from './llm';
import { PartialMapReader, type MapHead } from './partial';
import {
  CritiqueSchema,
  briefUser,
  critiqueSystem,
  critiqueUser,
  draftSystem,
  fillUser,
  planSystem,
  refineUser,
  repairUser,
  replanUser,
  summarizeMap,
  type GenRequest,
} from './prompts';
import { WireMapSchema, fromWire, toWire, type WireMap } from './wire';

/**
 * The generation graph (docs/llm-map-generation-plan.md):
 *
 *   plan -> build -> draft -> check --ok--> critique --fits--> finalize
 *                               |                |
 *                               +--problems--> repair <--misses--+
 *                          (repair loops back to check, at most `maxAttempts` model drafts in all)
 *
 * plan: the model writes a blueprint (areas with positions and heights, how they connect,
 * spawns); code checks it and the model corrects it until it is sound. build: code builds
 * the structure of the map from the blueprint, so the floor and every platform exist and sit
 * where planned. draft: the model completes that map with hazards and detail. check: the map
 * is tidied, linted, built, and compared with the blueprint. repair and critique as before.
 * A refinement of an existing map skips plan and build: the map is the plan.
 *
 * Events and calls call the plan "brief": a node cannot share a state field's name. The graph
 * is built per generation and holds no state of its own, so any number can run at once.
 */

export interface GenEvent {
  node: 'brief' | 'draft' | 'check' | 'repair' | 'critique' | 'finalize';
  message: string;
  /** Problems found, for `check` events. */
  problems?: string[];
  /** More lines to show under the message (the plan, for the planning step). */
  detail?: string[];
}

/**
 * The map as it is being built, for showing it live. `start` begins a streamed attempt (the
 * viewer clears and starts again), `piece` adds one piece as the model writes it, and `map`
 * is the map after code has changed it (the structure built from the plan, then each checked,
 * tidied draft): replace what is shown with it.
 */
export type BuildEvent =
  | { type: 'start'; stage: 'draft' | 'repair'; head: MapHead }
  | { type: 'piece'; index: number; piece: Piece }
  | { type: 'map'; map: MapData; ok: boolean };

export interface GenDeps {
  /** Already wrapped in a `BudgetedLlm` by the caller. */
  llm: Llm;
  config: GenConfig;
  emit?: (event: GenEvent) => void;
  /** Receives the map piece by piece as the model writes it. Streaming is only requested when this is set. */
  onPartial?: (event: BuildEvent) => void;
  signal?: AbortSignal;
  /** Replaceable in tests; the default builds the map headless. */
  check?: (map: MapData) => Promise<CheckResult>;
}

export interface GenOutcome {
  /** The map passed every check. When false, `map` is the closest the generator got. */
  ok: boolean;
  map: MapData | null;
  problems: string[];
  /** For the user: substitutions, approximations. */
  notes: string[];
  fixes: string[];
  /** Model drafts used (the first draft counts as 1). */
  attempts: number;
  stoppedBy: 'ok' | 'attempts' | 'budget';
  /** The blueprint the map was built from (null for a refinement). */
  plan: Blueprint | null;
}

/** Most plan corrections asked for; each is one model call. */
const MAX_REPLANS = 2;
/** The longest list of problems put in a repair prompt. */
const MAX_PROBLEMS = 14;

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_old: T, next: T) => next, default: init });

const State = Annotation.Root({
  request: last<GenRequest>(() => ({ prompt: '', kind: 'auto', size: 'auto' })),
  blueprint: last<Blueprint | null>(() => null),
  /** The plan passed its checks, so the finished map is held to it. */
  planSound: last<boolean>(() => false),
  wire: last<WireMap | null>(() => null),
  map: last<MapData | null>(() => null),
  problems: last<string[]>(() => []),
  fixes: last<string[]>(() => []),
  attempt: last<number>(() => 0),
  checkOk: last<boolean>(() => false),
  critiqued: last<boolean>(() => false),
  /** The last map that passed every check, so a failed second opinion cannot lose it. */
  okMap: last<MapData | null>(() => null),
  /** The closest failing map, by fewest problems. */
  closest: last<{ map: MapData; problems: string[] } | null>(() => null),
  stoppedBy: last<'ok' | 'attempts' | 'budget'>(() => 'ok'),
  outcome: last<GenOutcome | null>(() => null),
});
type S = typeof State.State;

const limited = (problems: string[]): string[] =>
  problems.length > MAX_PROBLEMS ? [...problems.slice(0, MAX_PROBLEMS), `...and ${problems.length - MAX_PROBLEMS} more of the same kind; fix these first.`] : problems;

export async function generateMap(request: GenRequest, deps: GenDeps): Promise<GenOutcome> {
  const { llm, config } = deps;
  const check = deps.check ?? checkGenerated;
  const emit = (e: GenEvent) => deps.emit?.(e);
  /** A text callback that turns the growing answer into build events, or nothing when nobody is watching. */
  const streamTo = (stage: 'draft' | 'repair'): ((snapshot: string) => void) | undefined => {
    const onPartial = deps.onPartial;
    if (!onPartial) return undefined;
    const reader = new PartialMapReader();
    return (snapshot) => {
      for (const e of reader.feed(snapshot)) onPartial(e.type === 'start' ? { ...e, stage } : e);
    };
  };
  const step = (node: GenEvent['node']) => {
    if (deps.signal?.aborted) throw new GenError('aborted', 'The generation was cancelled.');
    return node;
  };

  /** Runs a model call that may be refused for budget reasons; a budget stop ends the loop instead of failing. */
  const budgeted = async <T>(run: () => Promise<T>): Promise<T | 'budget'> => {
    try {
      return await run();
    } catch (e) {
      if (e instanceof GenError && e.code === 'budget') return 'budget';
      throw e;
    }
  };

  const askPlan = (label: string, user: string) =>
    llm.generate({
      label,
      model: config.fast.model,
      system: planSystem(),
      user,
      schema: BlueprintSchema,
      thinking: config.fast.thinking,
      effort: config.fast.effort,
      maxTokens: config.fast.maxTokens,
      signal: deps.signal,
    });
  /** An explicit request overrides what the planner picked. */
  const settle = (bp: Blueprint): Blueprint => ({ ...bp, kind: request.kind === 'auto' ? bp.kind : request.kind, symmetric: (request.kind === 'auto' ? bp.kind : request.kind) === 'combat' ? bp.symmetric : false });

  const plan = async (s: S): Promise<Partial<S>> => {
    step('brief');
    const base = s.request.baseMap;
    if (base) {
      // A refinement needs no plan: the map is the plan, and its kind and symmetry stay as they are.
      emit({ node: 'brief', message: `Reading "${base.name}" (${base.pieces.length} pieces)` });
      return { wire: toWire(base), blueprint: null };
    }
    emit({ node: 'brief', message: 'Planning the level' });
    const adjustments: string[] = [];
    /** What the model wrote, with its arithmetic settled by code. */
    const tidy = (written: Blueprint): Blueprint => {
      const r = repairBlueprint(settle(written));
      adjustments.push(...r.fixes);
      return r.plan;
    };
    let bp = tidy((await askPlan('brief', briefUser(s.request))).value);
    let problems = blueprintProblems(bp);
    for (let i = 0; i < MAX_REPLANS && problems.length > 0; i++) {
      step('brief');
      emit({ node: 'brief', message: `The plan has ${problems.length} problem${problems.length === 1 ? '' : 's'} code cannot settle; asking for a correction`, problems: limited(problems) });
      const again = await budgeted(() => askPlan('replan', replanUser(s.request, bp, limited(problems))));
      if (again === 'budget') break;
      adjustments.length = 0;
      bp = tidy(again.value);
      problems = blueprintProblems(bp);
    }
    const sound = problems.length === 0;
    emit({
      node: 'brief',
      message: `Plan: ${bp.kind}, ${bp.roomWidth} x ${bp.roomHeight} x ${bp.roomDepth} m room, ${bp.areas.length} parts - ${bp.concept}`,
      detail: [...blueprintLines(bp), ...(adjustments.length ? ['Adjusted automatically:', ...adjustments.map((a) => `  ${a}`)] : [])],
      ...(sound ? {} : { problems: limited(problems) }),
    });
    return { blueprint: bp, planSound: sound };
  };

  /** Code, not the model: the structure of the map exactly as planned, shown at once. */
  const build = async (s: S): Promise<Partial<S>> => {
    step('draft');
    if (!s.blueprint) return {};
    const structure = scaffold(s.blueprint);
    emit({ node: 'draft', message: `Built the structure from the plan (${structure.pieces.length} pieces)` });
    deps.onPartial?.({ type: 'map', map: structure, ok: false });
    return { map: structure, wire: toWire(structure) };
  };

  const draft = async (s: S): Promise<Partial<S>> => {
    step('draft');
    emit({ node: 'draft', message: s.request.baseMap ? 'Changing the map' : 'Adding hazards and detail' });
    const r = await llm.generate({
      label: 'draft',
      model: config.draft.model,
      system: draftSystem(),
      user: s.request.baseMap ? refineUser(s.request, JSON.stringify(s.wire)) : fillUser(s.request, s.blueprint!, JSON.stringify(s.wire)),
      schema: WireMapSchema,
      thinking: config.draft.thinking,
      effort: config.draft.effort,
      maxTokens: config.draft.maxTokens,
      signal: deps.signal,
      onText: streamTo('draft'),
    });
    return { wire: r.value, attempt: s.attempt + 1 };
  };

  const checkNode = async (s: S): Promise<Partial<S>> => {
    step('check');
    emit({ node: 'check', message: 'Checking the map' });
    const converted = fromWire(s.wire!, s.map ? { id: s.map.id } : {});
    // The plan decides whether there is a floor; the model often leaves it out or builds a partial one.
    const grounded = s.blueprint ? applyGround(s.blueprint, converted.map) : { map: converted.map, fixes: [] as string[] };
    const r = await check(grounded.map);
    const missing = s.blueprint && s.planSound ? conformance(s.blueprint, r.map) : [];
    const problems = limited([...converted.problems, ...r.problems, ...missing]);
    const ok = r.ok && converted.problems.length === 0 && missing.length === 0;
    const closest = !ok && (!s.closest || problems.length < s.closest.problems.length) ? { map: r.map, problems } : s.closest;
    deps.onPartial?.({ type: 'map', map: r.map, ok });
    emit({ node: 'check', message: ok ? `The map builds${r.buildMs !== undefined ? ` (${r.buildMs} ms)` : ''}` : `${problems.length} problem${problems.length === 1 ? '' : 's'} found`, problems });
    return {
      map: r.map,
      wire: toWire(r.map),
      problems,
      fixes: [...converted.fixes, ...grounded.fixes, ...r.fixes],
      checkOk: ok,
      okMap: ok ? r.map : s.okMap,
      closest,
      stoppedBy: ok ? 'ok' : s.attempt >= config.maxAttempts ? 'attempts' : s.stoppedBy,
    };
  };

  const repair = async (s: S): Promise<Partial<S>> => {
    step('repair');
    emit({ node: 'repair', message: `Fixing ${s.problems.length} problem${s.problems.length === 1 ? '' : 's'}` });
    const r = await budgeted(() =>
      llm.generate({
        label: 'repair',
        model: config.draft.model,
        system: draftSystem(),
        user: repairUser(s.request, s.blueprint, JSON.stringify(s.wire), s.problems),
        schema: WireMapSchema,
        thinking: config.draft.thinking,
        effort: config.draft.effort,
        maxTokens: config.draft.maxTokens,
        signal: deps.signal,
        onText: streamTo('repair'),
      }),
    );
    if (r === 'budget') return { stoppedBy: 'budget' };
    return { wire: r.value, attempt: s.attempt + 1 };
  };

  const critique = async (s: S): Promise<Partial<S>> => {
    step('critique');
    const requirements = s.blueprint?.requirements ?? [];
    if (requirements.length === 0) {
      emit({ node: 'critique', message: 'No checkable requirements in the request; skipping the review' });
      return { critiqued: true };
    }
    emit({ node: 'critique', message: `Reviewing the map against ${requirements.length} requirement${requirements.length === 1 ? '' : 's'}` });
    const r = await budgeted(() =>
      llm.generate({
        label: 'critique',
        model: config.fast.model,
        system: critiqueSystem(),
        user: critiqueUser(s.request, requirements, summarizeMap(s.map!)),
        schema: CritiqueSchema,
        thinking: config.fast.thinking,
        effort: config.fast.effort,
        maxTokens: config.fast.maxTokens,
        signal: deps.signal,
      }),
    );
    if (r === 'budget') return { critiqued: true };
    if (r.value.satisfies || r.value.issues.length === 0) {
      emit({ node: 'critique', message: 'The map fits the request' });
      return { critiqued: true };
    }
    const issues = r.value.issues.slice(0, 3).map((i) => `Review: ${i}`);
    emit({ node: 'critique', message: `The review found ${issues.length} thing${issues.length === 1 ? '' : 's'} missing`, problems: issues });
    return { critiqued: true, checkOk: false, problems: issues };
  };

  const finalize = async (s: S): Promise<Partial<S>> => {
    step('finalize');
    const winner = s.okMap ?? s.closest?.map ?? null;
    const ok = s.okMap !== null;
    const outcome: GenOutcome = {
      ok,
      map: winner,
      problems: ok ? [] : (s.closest?.problems ?? s.problems),
      notes: s.blueprint?.notes ?? [],
      fixes: s.fixes,
      attempts: s.attempt,
      stoppedBy: ok ? 'ok' : s.stoppedBy,
      plan: s.blueprint,
    };
    emit({ node: 'finalize', message: ok ? `Done: ${winner!.name}` : `Stopped with ${outcome.problems.length} problem${outcome.problems.length === 1 ? '' : 's'} (${outcome.stoppedBy})` });
    return { outcome };
  };

  const afterCheck = (s: S): 'critique' | 'repair' | 'finalize' => {
    if (s.checkOk) return config.critique && !s.critiqued ? 'critique' : 'finalize';
    // A failed second opinion repaired once; if that still fails, the earlier good map wins in finalize.
    if (s.critiqued || s.stoppedBy !== 'ok') return 'finalize';
    return 'repair';
  };
  const afterCritique = (s: S): 'repair' | 'finalize' => (s.checkOk ? 'finalize' : 'repair');
  const afterRepair = (s: S): 'check' | 'finalize' => (s.stoppedBy === 'budget' ? 'finalize' : 'check');

  const graph = new StateGraph(State)
    .addNode('plan', plan)
    .addNode('build', build)
    .addNode('draft', draft)
    .addNode('check', checkNode)
    .addNode('repair', repair)
    .addNode('critique', critique)
    .addNode('finalize', finalize)
    .addEdge(START, 'plan')
    .addEdge('plan', 'build')
    .addEdge('build', 'draft')
    .addEdge('draft', 'check')
    .addConditionalEdges('check', afterCheck, ['critique', 'repair', 'finalize'])
    .addConditionalEdges('critique', afterCritique, ['repair', 'finalize'])
    .addConditionalEdges('repair', afterRepair, ['check', 'finalize'])
    .addEdge('finalize', END)
    .compile();

  // A refinement keeps the map's id (the map starts as the base, so the check reuses it).
  const final = await graph.invoke({ request, map: request.baseMap ?? null });
  return final.outcome!;
}
