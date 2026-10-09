import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import type { MapData } from '../../src/world/maps/MapFormat';
import { checkGenerated, type CheckResult } from './check';
import type { GenConfig } from './config';
import { GenError, type Llm } from './llm';
import {
  BriefSchema,
  CritiqueSchema,
  briefSystem,
  briefUser,
  critiqueSystem,
  critiqueUser,
  draftSystem,
  draftUser,
  repairUser,
  summarizeMap,
  type Brief,
  type GenRequest,
} from './prompts';
import { WireMapSchema, fromWire, toWire, type WireMap } from './wire';

/**
 * The generation graph (docs/llm-map-generation-plan.md):
 *
 *   plan -> draft -> check --ok--> critique --fits--> finalize
 *                       |                |
 *                       +--problems--> repair <--misses--+
 *                  (repair loops back to check, at most `maxAttempts` model drafts in all)
 *
 * The model is only used in plan (events and calls call it "brief": a node cannot share a state field's name), draft, repair and critique; check and finalize are the
 * deterministic code of check.ts. The graph is built per generation and holds no state of its
 * own, so any number can run at once.
 */

export interface GenEvent {
  node: 'brief' | 'draft' | 'check' | 'repair' | 'critique' | 'finalize';
  message: string;
  /** Problems found, for `check` events. */
  problems?: string[];
}

export interface GenDeps {
  /** Already wrapped in a `BudgetedLlm` by the caller. */
  llm: Llm;
  config: GenConfig;
  emit?: (event: GenEvent) => void;
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
  brief: Brief | null;
}

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_old: T, next: T) => next, default: init });

const State = Annotation.Root({
  request: last<GenRequest>(() => ({ prompt: '', kind: 'auto', size: 'auto' })),
  brief: last<Brief | null>(() => null),
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

export async function generateMap(request: GenRequest, deps: GenDeps): Promise<GenOutcome> {
  const { llm, config } = deps;
  const check = deps.check ?? checkGenerated;
  const emit = (e: GenEvent) => deps.emit?.(e);
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

  const brief = async (s: S): Promise<Partial<S>> => {
    step('brief');
    emit({ node: 'brief', message: 'Planning the level' });
    const r = await llm.generate({
      label: 'brief',
      model: config.fast.model,
      system: briefSystem(),
      user: briefUser(s.request),
      schema: BriefSchema,
      thinking: config.fast.thinking,
      effort: config.fast.effort,
      maxTokens: config.fast.maxTokens,
      signal: deps.signal,
    });
    // An explicit request overrides what the planner picked.
    const planned = { ...r.value, kind: s.request.kind === 'auto' ? r.value.kind : s.request.kind };
    emit({ node: 'brief', message: `Plan: ${planned.kind}, ${planned.size} room - ${planned.concept}` });
    return { brief: planned };
  };

  const draft = async (s: S): Promise<Partial<S>> => {
    step('draft');
    emit({ node: 'draft', message: 'Drafting the map' });
    const r = await llm.generate({
      label: 'draft',
      model: config.draft.model,
      system: draftSystem(),
      user: draftUser(s.request, s.brief!),
      schema: WireMapSchema,
      thinking: config.draft.thinking,
      effort: config.draft.effort,
      maxTokens: config.draft.maxTokens,
      signal: deps.signal,
    });
    return { wire: r.value, attempt: s.attempt + 1 };
  };

  const checkNode = async (s: S): Promise<Partial<S>> => {
    step('check');
    emit({ node: 'check', message: 'Checking the map' });
    const converted = fromWire(s.wire!, s.map ? { id: s.map.id } : {});
    const r = await check(converted.map);
    const problems = [...converted.problems, ...r.problems];
    const ok = r.ok && converted.problems.length === 0;
    const closest = !ok && (!s.closest || problems.length < s.closest.problems.length) ? { map: r.map, problems } : s.closest;
    emit({ node: 'check', message: ok ? `The map builds${r.buildMs !== undefined ? ` (${r.buildMs} ms)` : ''}` : `${problems.length} problem${problems.length === 1 ? '' : 's'} found`, problems });
    return {
      map: r.map,
      wire: toWire(r.map),
      problems,
      fixes: r.fixes,
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
        user: repairUser(s.request, s.brief!, JSON.stringify(s.wire), s.problems),
        schema: WireMapSchema,
        thinking: config.draft.thinking,
        effort: config.draft.effort,
        maxTokens: config.draft.maxTokens,
        signal: deps.signal,
      }),
    );
    if (r === 'budget') return { stoppedBy: 'budget' };
    return { wire: r.value, attempt: s.attempt + 1 };
  };

  const critique = async (s: S): Promise<Partial<S>> => {
    step('critique');
    const requirements = s.brief?.requirements ?? [];
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
      notes: s.brief?.notes ?? [],
      fixes: s.fixes,
      attempts: s.attempt,
      stoppedBy: ok ? 'ok' : s.stoppedBy,
      brief: s.brief,
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
    .addNode('plan', brief)
    .addNode('draft', draft)
    .addNode('check', checkNode)
    .addNode('repair', repair)
    .addNode('critique', critique)
    .addNode('finalize', finalize)
    .addEdge(START, 'plan')
    .addEdge('plan', 'draft')
    .addEdge('draft', 'check')
    .addConditionalEdges('check', afterCheck, ['critique', 'repair', 'finalize'])
    .addConditionalEdges('critique', afterCritique, ['repair', 'finalize'])
    .addConditionalEdges('repair', afterRepair, ['check', 'finalize'])
    .addEdge('finalize', END)
    .compile();

  const final = await graph.invoke({ request });
  return final.outcome!;
}
