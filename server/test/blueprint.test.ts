import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_MAPS } from '../../src/editor/templates';
import { expandPieces } from '../../src/world/maps/MapFormat';
import { BlueprintSchema, applyGround, blueprintLines, blueprintProblems, blueprintText, conformance, expandAreas, repairBlueprint, scaffold, type Blueprint } from '../gen/blueprint';
import { combatExample, puzzleExample } from '../gen/blueprintExamples';
import { autofix, checkGenerated } from '../gen/check';
import { draftSystem, planSystem } from '../gen/prompts';
import { WireMapSchema } from '../gen/wire';

const highwire = () => BUILT_IN_MAPS[0].data();
const without = (bp: Blueprint, id: string): Blueprint => ({ ...bp, areas: bp.areas.filter((a) => a.id !== id), links: bp.links.filter((l) => l.from !== id && l.to !== id) });

test('the example blueprints are valid and pass every plan check', () => {
  for (const bp of [combatExample(), puzzleExample()]) {
    BlueprintSchema.parse(bp);
    assert.deepEqual(blueprintProblems(bp), [], bp.name);
    assert.ok(blueprintLines(bp).length >= bp.areas.length + bp.links.length);
    assert.match(blueprintText(bp), /Parts \(ids:/);
  }
});

test('the structure built from a plan is a map that passes every check', async () => {
  for (const bp of [combatExample(), puzzleExample()]) {
    const map = scaffold(bp);
    const r = await checkGenerated(map);
    assert.deepEqual(r.problems, [], bp.name);
    assert.equal(r.ok, true, bp.name);
    assert.deepEqual(conformance(bp, r.map), [], `${bp.name}: the scaffold has every planned part, hazards included`);
  }
});

test('scaffold: a void level skips the floor, a floor level does not; stairs and mirrored copies are placed', () => {
  const combat = scaffold(combatExample());
  assert.deepEqual(combat.pieces[0].skip, ['floor']);
  assert.equal(combat.symmetry, 'rotate180');
  const stairs = combat.pieces.find((p) => p.type === 'stairs' && p.at[0] === -24)!;
  assert.deepEqual([stairs.at, stairs.size, stairs.rot], [[-24, 0, 18], [4, 8, 20], 180], 'climbing south is a half turn');
  const spawns = expandPieces(combat).filter((p) => p.type === 'spawn');
  assert.equal(spawns.length, 4, 'each authored spawn is mirrored');
  assert.deepEqual(spawns[0].at, [0, 8, 34], 'on the terrace top');

  const puzzle = scaffold(puzzleExample());
  assert.equal(puzzle.pieces[0].skip, undefined);
  assert.equal(puzzle.pieces.filter((p) => p.type === 'goal').length, 1);
  assert.deepEqual(puzzle.pieces.find((p) => p.type === 'goal')!.at, [0, 3, -11], 'the goal stands on the ledge top');
  assert.equal(expandAreas(puzzleExample()).length, 3, 'puzzles are never mirrored');
});

test('the shipped Highwire conforms to its blueprint; losing a platform is reported with coordinates', () => {
  const bp = combatExample();
  assert.deepEqual(conformance(bp, highwire()), []);
  const map = highwire();
  map.pieces = map.pieces.filter((p) => !(p.type === 'floor' && p.at[0] === 20 && p.at[2] === 23));
  const missing = conformance(bp, map);
  assert.ok(missing.some((m) => /area "F2" \(catwalk beside the terrace\) at x=20, z=23/.test(m) && /top at y=8/.test(m)), missing.join('\n'));
  assert.ok(missing.some((m) => /mirrored copy of "F2"/.test(m)), 'the mirrored copy is missing too');
});

test('hazards the plan lists must be in the map', () => {
  const bp = combatExample();
  bp.areas[3].hazards = ['crusher'];
  const missing = conformance(bp, highwire());
  assert.ok(missing.some((m) => /area "F2".*should have a crusher/.test(m)), missing.join('\n'));
  // A crusher placed over the catwalk satisfies it.
  const map = highwire();
  map.pieces.push({ type: 'crusher', at: [20, 0, 23], size: [3, 8, 3] });
  assert.ok(!conformance(bp, map).some((m) => /area "F2".*crusher/.test(m)));
});

test('a void level with no islands, or a room without a floor under the spawns, is a plan problem', () => {
  const bp = combatExample();
  bp.areas = bp.areas.filter((a) => a.role !== 'ground');
  const problems = blueprintProblems(bp);
  assert.ok(problems.some((p) => /ground is "void"/.test(p)), problems.join('\n'));
  const small = combatExample();
  small.areas[0].width = 4;
  small.areas[0].depth = 4;
  assert.ok(blueprintProblems(small).some((p) => /cover only/.test(p)));
});

test('unreachable parts, impossible links and areas outside the room are found', () => {
  const unreachable = combatExample();
  unreachable.links = unreachable.links.filter((l) => l.to !== 'S2' && l.from !== 'S2');
  assert.ok(blueprintProblems(unreachable).some((p) => /area "S2".*cannot be reached from any spawn/.test(p)));

  const farJump = combatExample();
  farJump.areas.push({ id: 'X', role: 'floating', what: 'a far platform', x: -20, z: -20, width: 4, depth: 4, baseY: 9.5, topY: 10, climbs: 'none', portals: false, center: false, hazards: [] });
  farJump.links.push({ from: 'G1', to: 'X', how: 'jump', note: '' });
  const far = blueprintProblems(farJump);
  assert.ok(far.some((p) => /Link G1 -> X \(jump\) does not work/.test(p)), far.join('\n'));
  assert.ok(far.some((p) => /area "X".*cannot be reached/.test(p)));

  const noPortals = combatExample();
  noPortals.links.push({ from: 'S1', to: 'F2', how: 'portal', note: '' });
  assert.ok(blueprintProblems(noPortals).some((p) => /Link S1 -> F2 \(portal\)/.test(p) && /portals=true/.test(p)));

  const outside = combatExample();
  outside.areas[1].z = 40;
  assert.ok(blueprintProblems(outside).some((p) => /area "T1".*sticks out of the room/.test(p)));

  const steep = combatExample();
  steep.areas[2].depth = 4;
  assert.ok(blueprintProblems(steep).some((p) => /area "S1".*rises 8 m over only 4 m/.test(p)));

  const floor = puzzleExample();
  floor.links = [];
  assert.ok(blueprintProblems(floor).some((p) => /area "L1".*cannot be reached/.test(p)));
});

test('spawns and goals: where they stand, how many', () => {
  const lone = combatExample();
  lone.symmetric = false;
  lone.spawns = lone.spawns.slice(0, 1);
  assert.ok(blueprintProblems(lone).some((p) => /at least 2 spawn points/.test(p)));

  const off = combatExample();
  off.spawns[0] = { area: 'T1', x: 0, z: 0 };
  assert.ok(blueprintProblems(off).some((p) => /not inside "T1"/.test(p)));

  const noGoal = puzzleExample();
  noGoal.goal = { area: '', x: 0, z: 0 };
  assert.ok(blueprintProblems(noGoal).some((p) => /needs a goal/.test(p)));

  const missingArea = without(combatExample(), 'T1');
  assert.ok(blueprintProblems(missingArea).some((p) => /spawn at \(0, 34\) is on "T1"/.test(p)));
});

test('applyGround follows the plan: a floor level keeps its floor, a void level has none', () => {
  const skipped = highwire(); // skips the floor
  const kept = applyGround({ ...combatExample(), ground: 'floor' }, skipped);
  assert.equal(kept.map.pieces.find((p) => p.type === 'room')!.skip, undefined);
  assert.match(kept.fixes[0], /kept the room floor/);
  const bare = highwire();
  delete bare.pieces.find((p) => p.type === 'room')!.skip;
  const voided = applyGround(combatExample(), bare);
  assert.deepEqual(voided.map.pieces.find((p) => p.type === 'room')!.skip, ['floor']);
  assert.deepEqual(applyGround(combatExample(), highwire()).fixes, [], 'already agrees');
});

test('platform undersides are always drawn: hidden faces are dropped, and the prompts never teach them', () => {
  const map = highwire();
  assert.ok(map.pieces.some((p) => Array.isArray(p.hide)), 'the shipped map hides faces');
  const fixed = autofix(map);
  assert.ok(!fixed.map.pieces.some((p) => p.hide !== undefined));
  assert.match(fixed.fixes.join('\n'), /showed the hidden faces of \d+ pieces/);
  // The catalogue text and the worked examples do not mention it.
  assert.ok(!/\bhide\b/.test(draftSystem()), 'no "hide" in the drawing prompt');
  assert.ok(!draftSystem().includes('Hidden faces'));
  WireMapSchema.parse({ name: 'x', hint: '', blurb: '', kind: 'combat', symmetry: 'none', fogColor: '#000000', fogNear: 1, fogFar: 2, killY: -6, pieces: [] });
});

test('the planning prompt is static (cacheable) and carries both worked examples', () => {
  assert.equal(planSystem(), planSystem());
  assert.match(planSystem(), /Highwire/);
  assert.match(planSystem(), /Ledge and acid/);
});

test('repairBlueprint leaves a sound plan alone', () => {
  for (const bp of [combatExample(), puzzleExample()]) {
    const r = repairBlueprint(bp);
    assert.deepEqual(r.fixes, [], bp.name);
    assert.deepEqual(r.plan, bp);
  }
});

test('repairBlueprint settles the arithmetic slips a model makes, without a model call', () => {
  const bp = combatExample();
  bp.areas[0].topY = 0.5; // an island that is not at floor level
  bp.areas[0].baseY = -2.6; // off the grid
  bp.areas[2].depth = 4; // stairs rising 8 m over 4 m
  bp.areas[1].z = 40; // sticks out of the room
  bp.spawns[0] = { area: 'T1', x: 0, z: 90 }; // outside its area
  assert.ok(blueprintProblems(bp).length > 0);
  const r = repairBlueprint(bp);
  assert.deepEqual(blueprintProblems(r.plan), [], r.fixes.join(' | '));
  assert.equal(r.plan.areas[0].topY, 0);
  assert.equal(r.plan.areas[2].depth, 8, 'a climb of 8 m gets 8 m of run');
  assert.ok(r.plan.areas[1].z + r.plan.areas[1].depth / 2 <= 38);
  assert.ok(r.fixes.some((f) => /stairs "S1" lengthened/.test(f)));
});

test('repairBlueprint retypes a link that works another way and joins what nothing reaches', () => {
  const bp = combatExample();
  // A "walk" between a landing and a platform 8 m up cannot work; the stairs already join them, so the link is dropped.
  bp.links.push({ from: 'G1', to: 'F2', how: 'walk', note: '' });
  // A tower with no way up, standing apart.
  bp.areas.push({ id: 'X', role: 'raised', what: 'a lone tower', x: -10, z: 5, width: 6, depth: 6, baseY: 0, topY: 12, climbs: 'none', portals: true, center: false, hazards: [] });
  assert.ok(blueprintProblems(bp).some((p) => /area "X".*cannot be reached/.test(p)));
  const r = repairBlueprint(bp);
  assert.deepEqual(blueprintProblems(r.plan), [], r.fixes.join(' | '));
  assert.ok(r.fixes.some((f) => /"X" could not be reached/.test(f)), r.fixes.join(' | '));
  const joined = r.plan.links.find((l) => l.to === 'X')!;
  assert.ok(['jump', 'drop', 'portal'].includes(joined.how));
});

test('repairBlueprint makes a floor-level plan reachable through portals when nothing else works', () => {
  const bp = puzzleExample();
  bp.links = [];
  bp.areas[2].portals = false; // the ledge takes no portals
  const r = repairBlueprint(bp);
  assert.deepEqual(blueprintProblems(r.plan), []);
  assert.equal(r.plan.areas[2].portals, true);
  assert.equal(r.plan.links[0].how, 'portal');
});

test('repairBlueprint stands a wall on the ground it is built on', () => {
  const bp = combatExample();
  bp.areas.push({ id: 'W', role: 'wall', what: 'portal wall on the terrace', x: 0, z: 33, width: 6, depth: 0.6, baseY: 7.5, topY: 12, climbs: 'none', portals: true, center: false, hazards: [] });
  const r = repairBlueprint(bp);
  assert.equal(r.plan.areas.find((a) => a.id === 'W')!.baseY, 8, 'on the terrace top, not half a metre into it');
  assert.ok(r.fixes.some((f) => /wall "W" stands level/.test(f)));
  assert.deepEqual(blueprintProblems(r.plan), []);
});

test('spawns and the goal are moved out of acid and spike zones', () => {
  const bp = puzzleExample();
  // The acid pool covers the middle of the room; the spawn stands in it.
  bp.spawns = [{ area: 'FLOOR', x: 0, z: 1 }];
  assert.ok(blueprintProblems(bp).some((p) => /spawn at \(0, 1\) is inside hazard zone "P1"/.test(p)));
  const r = repairBlueprint(bp);
  assert.deepEqual(blueprintProblems(r.plan), [], r.fixes.join(' | '));
  const s = r.plan.spawns[0];
  assert.ok(Math.abs(s.z) > 5, `moved clear of the pool (z ${s.z})`);
  assert.ok(r.fixes.some((f) => /a spawn moved from \(0, 1\)/.test(f)));
});

test('repairBlueprint joins an unreachable part once, to something that is reachable, never to an unreachable floor', () => {
  const bp = puzzleExample();
  bp.spawns = [{ area: 'L1', x: -3, z: -11 }];
  bp.links = [];
  bp.areas.push({ id: 'X', role: 'raised', what: 'a tall pillar', x: 5, z: 10, width: 4, depth: 4, baseY: 0, topY: 4, climbs: 'none', portals: false, center: false, hazards: [] });
  const r = repairBlueprint(bp);
  assert.deepEqual(blueprintProblems(r.plan), [], r.fixes.join(' | '));
  assert.equal(r.plan.links.filter((l) => l.to === 'X').length, 1);
  assert.ok(r.plan.links.every((l) => l.from !== 'FLOOR' || l.to !== 'X'), 'the floor is not reachable from this spawn, so it cannot be the way in');
  assert.equal(r.fixes.filter((f) => /could not be reached/.test(f)).length, 1, 'the pillar is joined once');
});

test('a ledge standing above an acid pool is a fine place to spawn; a plan that lists both halves is not mirrored twice', () => {
  const bp = combatExample();
  bp.ground = 'floor';
  bp.symmetric = false;
  bp.areas = [
    { id: 'P1', role: 'hazard-zone', what: 'acid over the whole floor', x: 0, z: 0, width: 40, depth: 40, baseY: 0, topY: 0.4, climbs: 'none', portals: false, center: true, hazards: ['acid'] },
    { id: 'R1', role: 'raised', what: 'ledge', x: -11, z: 11, width: 6, depth: 6, baseY: 0, topY: 1.5, climbs: 'none', portals: true, center: false, hazards: [] },
    { id: 'R2', role: 'raised', what: 'ledge', x: 11, z: -11, width: 6, depth: 6, baseY: 0, topY: 1.5, climbs: 'none', portals: true, center: false, hazards: [] },
  ];
  bp.links = [];
  bp.spawns = [{ area: 'R1', x: -11, z: 11 }, { area: 'R2', x: 11, z: -11 }];
  bp.roomWidth = 40;
  bp.roomDepth = 40;
  assert.deepEqual(blueprintProblems(bp), []);
  const sym = { ...bp, symmetric: true };
  const r = repairBlueprint(sym);
  assert.equal(r.plan.symmetric, false);
  assert.ok(r.fixes.some((f) => /lists both halves/.test(f)));
  assert.equal(expandAreas(r.plan).length, 3, 'nothing is copied');
});
