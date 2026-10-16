import { BUILT_IN_MAPS, blankMap, blankPuzzle } from '../../src/editor/templates';
import type { MapData } from '../../src/world/maps/MapFormat';
import { roomSizeFor, type GenKind, type RoomSize } from './blueprint';
import { buildCatalogue } from './catalogue';
import { GenError, addUsage, estimateCostUsd, noUsage, totalTokens, type Llm, type TurnBlock, type TurnMessage, type Usage } from './llm';
import type { AgentSettings, Prices } from './config';
import { TOOLS, Workspace, mapListing, type ToolEnv } from './tools';
import catapult from '../../src/world/maps/catapult.json';

/**
 * The map chat (docs/llm-map-generation-plan.md, "Chat and tools"): one model, a handful of
 * tools, and a loop. The user's message and the map in the editor go in; the model looks,
 * edits, checks its own work with the validation tools and answers in a few sentences. There
 * is no plan to fit and no feature list to meet: what keeps the result honest is that the
 * tools tell it, in numbers and coordinates, what is wrong, and that the loop will not let it
 * finish with a map that does not build or (for a puzzle) whose exit cannot be reached.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AgentRequest {
  prompt: string;
  kind: 'auto' | GenKind;
  size: 'auto' | RoomSize;
  /** The map in the editor, which the chat changes (or replaces, when it is just a template). */
  baseMap: MapData;
  /** Earlier turns of this conversation, oldest first. */
  history: ChatTurn[];
}

export type AgentEvent =
  | { type: 'turn'; n: number }
  | { type: 'say'; text: string }
  | { type: 'tool'; tool: string; summary: string; ok: boolean; problems?: string[]; detail?: string[] }
  | { type: 'map'; map: MapData; ok: boolean };

export interface AgentDeps {
  llm: Llm;
  settings: AgentSettings;
  prices: Prices;
  env: ToolEnv;
  emit?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface AgentOutcome {
  /** The map as it stands passes every check. */
  ok: boolean;
  /** The map after this turn, or null when nothing changed (a question was answered). */
  map: MapData | null;
  /** What the model said at the end. */
  reply: string;
  /** Problems still found in the map when the turn ended. */
  problems: string[];
  /** Things the user should know that the checks found (an exit that cannot be reached...). */
  notes: string[];
  fixes: string[];
  turns: number;
  stoppedBy: 'ok' | 'turns' | 'budget';
  usage: Usage;
  costUsd: number;
}

// ---------------------------------------------------------------- prompt

let cachedSystem: string | undefined;

/** One piece per line, as a worked example. */
function renderFileExample(title: string, map: MapData): string {
  const { pieces, ...head } = map;
  const lines = pieces.map((p) => '  ' + JSON.stringify(p));
  return `### ${title}\n${JSON.stringify(head)}\npieces:\n${lines.join('\n')}\n`;
}

/** The static prompt: who you are, how you work, what makes a good level, the catalogue and examples. Byte-stable (it is cached). */
export function agentSystem(): string {
  if (cachedSystem) return cachedSystem;
  const highwire = structuredClone(BUILT_IN_MAPS.find((m) => m.label.startsWith('Highwire'))!.data());
  for (const p of highwire.pieces) delete p.hide;
  cachedSystem = `${buildCatalogue('file')}
# Your job

You are the level designer built into this game's map editor. The user chats with you to make a map or to change the one in the editor, and you edit it directly with your tools. There is no fixed procedure: design what they ask for, using the whole catalogue, and use the tools to check what you build. You answer in the chat, in plain words.

## How to work
0. For a new map or a big change, begin your first answer with a short plan in a few lines (what the player sees at the start, the steps, which mechanics and where, how it ends), then build it. For a small change, just do it.
1. Look at the map you are given. If it is an untouched starting template and the user asks for a new map, replace it (clear it and write your own room); if they ask for a change, change only what the request is about and leave the rest alone. Small requests ("make the bridge longer", "add acid under it") are a few operations, not a rebuild.
2. (edit_map's reply lists the numbers of what it added and, after a removal, of everything renumbered: you do not need view_map to find out.) Build with a few large edit_map calls (the room and its structure together, then spawns/goal/hazards/mechanics), not one piece per call. For a puzzle with several parts, build and verify one part at a time (check it with playtest before the next); each part should be one idea you can play through. Think in coordinates: write down the extents of each piece, and stack things exactly (a piece's top is at.y + size[1]).
3. Check as you go. The reply to every edit lists what is wrong with the pieces you touched. validate_map is the full check and build; check_routes tells you whether a player can really get from the spawn to the exit and how (see below); playtest plays a script of your own (stand here, shoot there, walk there) in the real game and tells you what happened; surface_at gives you the exact height of the floor under a spot.
4. Fix what the tools report, and re-check. Do not claim something works unless a tool showed it. check_routes cannot see a beam bent through portals or a crate sent through one: for those, write the intended solution as a playtest (place the portals, shoot the switch, wait, walk to the exit) and look at what lit, what opened and whether the exit was reached. Only what no tool can show (a crate you must shove by hand) is left to the user: say so, and explain the intended solution.
5. Finish with a short answer: what you built or changed, and for a puzzle how it is meant to be solved (one or two sentences). Mention anything approximate. Do not paste the map.

You have a limited number of steps (a step is one round of tool calls) and a spending limit for each message, and you are warned when few are left. A verified, finished puzzle of two parts beats an unfinished one of four: when you run short, drop or simplify the part you cannot get working, leave the map in a state that builds, and say what you left out.

If the request asks for something the game cannot do (turrets, gel, a copy of another game's level), build the closest thing from what exists and say what you substituted. Never silently drop part of a request.

## What the player can do
- Walk, jump 2 m high (ledges up to about 1.8 m can be jumped onto; 2.2 m and more cannot), cross gaps of about 4-5 m with a running jump. Stairs and slopes climb without jumping. Falling more than ~4 m hurts; below killY is death.
- Shoot a blue and an orange portal onto any surface that takes portals, from any distance they can see. Walking into one comes out of the other, keeping speed (falling into a floor portal and coming out of a wall portal flings you sideways). A portal is 2.2 m wide and 3.3 m tall and needs a flat face at least that big: a narrow wall takes none.
- Shoot switches, stand on floor buttons, ride jump pads, move crates (they cannot be carried).
- Portals go only on faces whose "portal" list names them (and the room walls the room's "portal" names). Nothing else takes one, and glass stops them. Putting "portal": ["walls"] on the room makes every wall take portals: that is generous, and it is how a puzzle becomes trivial. A puzzle usually gives the room NO portal walls and puts portal surfaces only where the solution needs them.

## Puzzles
A puzzle map (kind "puzzle") has one spawn and exactly one goal. It is single-player. It is a puzzle only if getting to the goal takes the player thinking, not just walking:
- Plan the solution first, in words, before placing anything: what the player sees at the start, which portal surfaces they use, what each step unlocks, where it ends. Then build exactly that, with portal surfaces only where the plan needs them.
- Typical steps: a ledge higher than a jump (put a portal surface high on a wall the player can see from below, and one near them on the floor or a wall); a gap or acid pool (a portal surface on the far side they can see); a locked door (a laser + receiver whose beam must be bent through portals around a corner or a glass pane, or a floor button held down by a crate from a dropper that a shot switch releases); a jump pad that throws them to a ledge.
- To make it multi-part, chain rooms or areas: each part's way on is only reachable after the previous part (a door that the first part opens, a ledge the first part's portals reach). A level one portal solves is one step: add more.
- It must be passable: the exit has to be reachable by a route you can describe, and check_routes must show it (hops = the portal hops it needs; 0 means a plain walk, which is no puzzle unless doors are on the way). A puzzle whose solution you have not played through with playtest (stand at the spawn, do exactly what you tell the player to do, reach the exit) is not finished.
- Hard does not mean unfair: every needed surface must be visible from where the player is when they need it, there must be room to place the entrance beside them, and nothing may kill them with no warning.
- Doors: a door piece blocks until its receiver is lit by a beam, or its floor button is held down. check_routes assumes doors open and tells you which ones are on the route and whether they open by themselves; a door that stays shut with nothing that can open it makes the exit unreachable in practice.

## Combat maps
Combat maps are symmetric two-sided arenas ("symmetry": "rotate180": write one half, the other is its half-turn copy; put things on the centre line with "center": true) with at least two spawns on each side, cover, height differences and portal surfaces. Keep the room centred on x=0, z=0. check_routes tells you whether every spawn can get to every other.

## Numbers that matter
- Room: at = the centre of the floor (y 0 is the floor), size [width, height, depth]. Combat rooms 24-90 m wide and deep; puzzle rooms 10-40 m wide, 5-14 m tall, 10-50 m deep. Everything stays inside.
- Player 2 m tall: keep 2.5 m of free height over anything they stand on. A spawn's y is the top of the surface it stands on, exactly (the room floor is the room's y). The goal's "at" is the floor centre.
- Heights on a 0.5 m grid, positions to 0.5 m, thin walls and slabs to 0.1 m.
- Portal walls need to be ≥ 2.3 m wide and ≥ 3.4 m tall to take a portal.

# Worked examples (valid maps; study how heights line up and how the mechanics are wired)

${renderFileExample('The puzzle template: a divider to get over with portals', blankPuzzle())}
${renderFileExample('Catapult: a puzzle with jump pads, a dropper released by a switch, a button that needs a crate, glass and a door', catapult as MapData)}
${renderFileExample('Highwire: a symmetric combat map with three tiers', highwire)}
`;
  return cachedSystem;
}

/** The user message that starts a turn: the editor's map, hints, and the request. */
export function turnUser(req: AgentRequest): string {
  const lines: string[] = [];
  const base = req.baseMap;
  const blank = [blankMap(), blankPuzzle()].some((t) => JSON.stringify(t.pieces) === JSON.stringify(base.pieces));
  lines.push('The map in the editor right now:');
  lines.push(mapListing(base));
  if (blank) lines.push('(This is the editor\'s untouched starting template.)');
  const hints: string[] = [];
  if (req.kind !== 'auto') hints.push(`The user picked kind: ${req.kind}.`);
  if (req.size !== 'auto') {
    const [w, h, d] = roomSizeFor(req.kind === 'puzzle' ? 'puzzle' : 'combat', req.size);
    hints.push(`The user picked a ${req.size} room: about ${w} x ${h} x ${d} m.`);
  }
  if (hints.length) lines.push(hints.join(' '));
  lines.push('', `User: ${req.prompt}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- loop

const RESULT_MAX_CHARS = 7000;
/** Times the loop sends the model back to fix problems it tried to finish with. */
const GATE_ROUNDS = 3;

const clip = (s: string): string => (s.length > RESULT_MAX_CHARS ? s.slice(0, RESULT_MAX_CHARS) + '\n...(cut)' : s);

export async function runAgent(request: AgentRequest, deps: AgentDeps): Promise<AgentOutcome> {
  const { llm, settings, prices, env } = deps;
  const emit = (e: AgentEvent) => deps.emit?.(e);
  const now = deps.now ?? Date.now;
  const started = now();
  const ws = new Workspace(request.baseMap, env);
  const messages: TurnMessage[] = [
    ...request.history.map((t) => ({ role: t.role, content: t.text }) as TurnMessage),
    { role: 'user', content: turnUser(request) },
  ];
  // Alternating roles are required: merge neighbours of the same role (a history that starts or ends oddly).
  for (let i = messages.length - 1; i > 0; i--) {
    if (messages[i].role === messages[i - 1].role) {
      messages[i - 1] = { role: messages[i].role, content: `${messages[i - 1].content as string}\n\n${messages[i].content as string}` };
      messages.splice(i, 1);
    }
  }
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: '(The conversation so far.)' });

  let usage = noUsage();
  let turns = 0;
  let gates = 0;
  let cutOff = 0;
  let reply = '';
  let stoppedBy: AgentOutcome['stoppedBy'] = 'ok';
  let routesFor: string | null = null;
  let routesMessage: string | null = null;
  let routesConnected: boolean | null = null;
  /** The map (as JSON) a playtest of the model's own got to the exit on: proof enough, whatever the route analysis cannot see. */
  let provenFor: string | null = null;
  const aborted = () => {
    if (deps.signal?.aborted) throw new GenError('aborted', 'The generation was cancelled.');
  };
  const cost = () => estimateCostUsd(usage, prices);

  for (;;) {
    aborted();
    if (turns >= settings.maxTurns || cost() >= settings.maxUsd || (now() - started) / 1000 > settings.maxSeconds) {
      stoppedBy = turns >= settings.maxTurns ? 'turns' : 'budget';
      break;
    }
    turns++;
    emit({ type: 'turn', n: turns });
    const r = await llm.turn({
      label: 'chat',
      model: settings.model,
      system: agentSystem(),
      messages,
      tools: TOOLS,
      thinking: settings.thinking,
      effort: settings.effort,
      maxTokens: settings.maxTokens,
      signal: deps.signal,
    });
    usage = addUsage(usage, r.usage);
    if (r.stop === 'refusal') throw new GenError('refusal', 'The model declined this request. Try describing the map differently.');
    const text = r.content.filter((b): b is Extract<TurnBlock, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) {
      reply = text;
      emit({ type: 'say', text });
    }

    if (r.stop === 'max_tokens') {
      // Cut off, so its last tool call (if any) is incomplete and nothing was done. Say so once and ask for smaller steps.
      if (cutOff++ === 0) {
        messages.push({ role: 'assistant', content: text || '(cut off)' });
        messages.push({
          role: 'user',
          content: 'Your answer ran out of room before it finished, so nothing was done. Do it in smaller steps: build the structure first (room, floors, walls), then add the mechanics, the spawn and the goal in later edit_map calls. Keep your text short.',
        });
        continue;
      }
      stoppedBy = 'budget';
      reply ||= 'I ran out of room to answer before I finished.';
      break;
    }

    messages.push({ role: 'assistant', content: r.content });
    const calls = r.content.filter((b): b is Extract<TurnBlock, { type: 'tool_use' }> => b.type === 'tool_use');

    if (calls.length > 0) {
      const results: TurnBlock[] = [];
      for (const call of calls) {
        aborted();
        const out = await ws.run(call.name, call.input ?? {});
        if (call.name === 'check_routes' && !out.isError) {
          routesFor = JSON.stringify(ws.map);
          routesMessage = out.text;
          routesConnected = out.routesOk === true;
        }
        if (call.name === 'playtest' && out.reachedExit) provenFor = JSON.stringify(ws.map);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: clip(out.text), ...(out.isError ? { is_error: true } : {}) });
        emit({
          type: 'tool',
          tool: call.name,
          summary: out.summary,
          ok: !out.isError && !(out.problems && out.problems.length),
          ...(out.problems?.length ? { problems: out.problems } : {}),
          ...(call.name === 'check_routes' || call.name === 'playtest' ? { detail: out.text.split('\n').slice(0, 24) } : {}),
        });
        if (out.mapChanged) emit({ type: 'map', map: structuredClone(ws.map), ok: ws.isValidated });
      }
      const left = settings.maxTurns - turns;
      if (left <= 5 && left >= 0) {
        results.push({ type: 'text', text: `(Heads-up: ${left} step${left === 1 ? '' : 's'} left for this message. Get the map into a state that builds and works as far as you have verified, drop what you cannot finish, and answer.)` });
      }
      messages.push({ role: 'user', content: results });
      // Stay inside the cheap price tier: a prompt this large ends the turn.
      if (totalTokens(r.usage) - r.usage.output > settings.maxPromptTokens) {
        stoppedBy = 'budget';
        break;
      }
      continue;
    }

    // The model has said its piece. Do not let it finish with a map that is broken or, for a
    // puzzle, cannot be solved: say so and let it fix it.
    if (ws.changed && gates < GATE_ROUNDS) {
      const problems: string[] = [];
      if (!ws.isValidated) {
        const v = await ws.run('validate_map', {});
        emit({ type: 'tool', tool: 'validate_map', summary: v.summary, ok: !v.problems?.length, ...(v.problems?.length ? { problems: v.problems } : {}) });
        if (v.mapChanged) emit({ type: 'map', map: structuredClone(ws.map), ok: ws.isValidated });
        if (!ws.isValidated) problems.push(v.text);
      }
      const proven = provenFor === JSON.stringify(ws.map);
      if (ws.map.kind === 'puzzle' && problems.length === 0 && !proven && routesFor !== JSON.stringify(ws.map)) {
        const rr = await ws.run('check_routes', {});
        routesFor = JSON.stringify(ws.map);
        routesMessage = rr.text;
        routesConnected = !rr.isError && rr.routesOk === true;
        emit({ type: 'tool', tool: 'check_routes', summary: rr.summary, ok: routesConnected, detail: rr.text.split('\n').slice(0, 14) });
        if (!routesConnected) problems.push(rr.text);
      } else if (ws.map.kind === 'puzzle' && problems.length === 0 && !proven && routesConnected === false && routesMessage) problems.push(routesMessage);
      if (problems.length) {
        gates++;
        messages.push({ role: 'user', content: `Before you finish: the checks found problems with the map as it stands.\n\n${problems.join('\n\n')}\n\nFix them with edit_map and check again. Do not repeat your earlier explanation. If the way you intend is one the route check cannot see (a beam or a crate through portals), prove it with a playtest instead; only if nothing can show it, leave the map and say so in two or three sentences.` });
        continue;
      }
    }
    break;
  }

  // ---- The outcome: the map as tidied by the same check the editor's maps pass.
  const outcome: AgentOutcome = { ok: true, map: null, reply, problems: [], notes: [], fixes: [], turns, stoppedBy, usage, costUsd: cost() };
  if (ws.changed) {
    const r = await env.check(ws.map);
    outcome.map = r.map;
    outcome.ok = r.ok;
    outcome.problems = r.problems;
    outcome.fixes = r.fixes;
    if (r.ok && r.map.kind === 'puzzle' && provenFor !== JSON.stringify(ws.map)) {
      if (routesFor !== JSON.stringify(ws.map) && routesFor !== JSON.stringify(r.map)) {
        try {
          const report = await env.routes(r.map);
          routesConnected = report.connected && !report.blockedByDoor;
          routesMessage = null;
          if (!report.connected) outcome.notes.push('The exit could not be reached from the spawn in the final check: this puzzle may not be solvable. Test it before you rely on it.');
        } catch {
          /* the analysis is advice; the map still built */
        }
      } else if (routesConnected === false) outcome.notes.push('The exit could not be reached from the spawn in the last route check: this puzzle may not be solvable. Test it before you rely on it.');
    }
  }
  if (stoppedBy !== 'ok') outcome.notes.push(stoppedBy === 'turns' ? 'The chat hit its step limit before it was finished; ask for what is missing.' : 'The chat hit its size or cost limit before it was finished; ask for what is missing.');
  return outcome;
}
