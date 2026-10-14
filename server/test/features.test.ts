/**
 * The plan's relations (stairs and bridges between areas, moats around them, pits in the floor)
 * and the request's features, measured on geometry. No model calls.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandPieces } from '../../src/world/maps/MapFormat';
import { BlueprintSchema, applyGround, blueprintProblems, conformance, repairBlueprint, resolveAreas, scaffold, type Blueprint } from '../gen/blueprint';
import { area, combatExample, feature, sinkholeExample } from '../gen/blueprintExamples';
import { checkGenerated } from '../gen/check';
import { featureProblems, tidyFeatures } from '../gen/features';

const resolved = (bp: Blueprint, id: string) => resolveAreas(bp).areas.find((a) => a.id === id)!;

/** A floor level with a fortress in the middle, for moats. */
function fortress(): Blueprint {
  return {
    ...sinkholeExample(),
    features: [feature({ what: 'moat', where: 'center', hazard: 'acid', words: 'surrounded by an acid moat' })],
    symmetric: false,
    areas: [
      area({ id: 'F', role: 'raised', what: 'fortress', x: 0, z: 0, width: 10, depth: 10, baseY: 0, topY: 3, portals: true, center: true }),
      area({ id: 'M', role: 'moat', what: 'acid moat', x: 0, z: 0, width: 4, depth: 0, baseY: 0, topY: 0.3, hazards: ['acid'], around: 'F' }),
      area({ id: 'S', role: 'stairs', what: 'stairs up to the fortress, long enough to cross the moat', x: 0, z: 9, width: 3, depth: 6, baseY: 0, topY: 0, from: 'FLOOR', to: 'F' }),
    ],
    links: [],
    spawns: [{ area: 'FLOOR', x: -15, z: 15 }, { area: 'FLOOR', x: 15, z: -15 }],
  };
}

test('stairs written as a relation stand against the upper area, foot on the lower one, climbing toward it', () => {
  const s1 = resolved(sinkholeExample(), 'S1');
  assert.deepEqual([s1.x, s1.z, s1.width, s1.depth, s1.baseY, s1.topY, s1.climbs], [-8.5, -18, 5, 3, 0, 4, 'east'], 'west of the platform: north lands in the room wall, south in the pit');
  // The shipped Highwire's stairs come out exactly where the map has them.
  const h = resolved(combatExample(), 'S1');
  assert.deepEqual([h.x, h.z, h.width, h.depth, h.climbs], [-24, 18, 4, 20, 'south']);
});

test('stairs that climb the wrong way are not a way up', () => {
  const bp = combatExample();
  bp.areas[4].climbs = 'south'; // S2 now rises away from the catwalk it starts on
  const problems = blueprintProblems(bp);
  assert.ok(problems.some((p) => /Link F2 -> S2 \(walk\) does not work/.test(p)), problems.join('\n'));
  // Climbing the right way, its low end meets the catwalk at the catwalk's height.
  assert.deepEqual(blueprintProblems(combatExample()), []);
});

test('stairs that cannot be built say why', () => {
  const level = sinkholeExample();
  level.areas.push(area({ id: 'S9', role: 'stairs', what: 'stairs between equal ledges', x: 10, z: -18, width: 3, depth: 0, baseY: 0, topY: 0, from: 'E1', to: 'P1' }));
  assert.ok(blueprintProblems(level).some((p) => /stairs "S9".*same height/.test(p)));
  const voided = combatExample();
  voided.areas.push(area({ id: 'S9', role: 'stairs', what: 'stairs from the floor', x: 0, z: 0, width: 3, depth: 0, baseY: 0, topY: 0, from: 'FLOOR', to: 'T1' }));
  assert.ok(blueprintProblems(voided).some((p) => /stairs "S9".*no floor/.test(p)));
});

test('a bridge goes straight between two areas that face each other; ones that do not line up are a problem', () => {
  const b1 = resolved(sinkholeExample(), 'B1');
  assert.deepEqual([b1.x, b1.z, b1.width, b1.depth, b1.topY, b1.baseY], [10, -18, 8.5, 2, 4, 3.5]);
  const askew = sinkholeExample();
  Object.assign(askew.areas.find((a) => a.id === 'E1')!, { x: 20, z: -5 });
  assert.ok(blueprintProblems(askew).some((p) => /bridge "B1".*do not face each other/.test(p)), blueprintProblems(askew).join('\n'));
});

test('a pit cuts the room floor: the floor is built around it, and nobody spawns over it', async () => {
  const map = scaffold(sinkholeExample());
  assert.deepEqual(map.pieces[0].skip, ['floor']);
  const slabs = map.pieces.filter((p) => p.type === 'block' && p.at[1] === -1);
  assert.ok(slabs.length >= 4 && slabs.length <= 8, `${slabs.length} floor slabs`);
  for (const s of slabs) {
    const [x, , z] = s.at;
    const [w, , d] = s.size!;
    assert.ok(x + w / 2 <= -10 || x - w / 2 >= 10 || z + d / 2 <= -10 || z - d / 2 >= 10, 'no slab over the pit');
  }
  assert.equal((await checkGenerated(map)).ok, true);
  // The model put the floor back: the room is told to skip it again.
  const covered = structuredClone(map);
  delete covered.pieces[0].skip;
  assert.deepEqual(applyGround(sinkholeExample(), covered).map.pieces[0].skip, ['floor']);

  const over = sinkholeExample();
  over.spawns = [{ area: 'FLOOR', x: 0, z: 2 }, { area: 'FLOOR', x: 18, z: 18 }];
  assert.ok(blueprintProblems(over).some((p) => /spawn at \(0, 2\) on FLOOR is over a pit/.test(p)));
  const r = repairBlueprint(over);
  assert.deepEqual(blueprintProblems(r.plan), [], r.fixes.join(' | '));
  assert.ok(Math.max(Math.abs(r.plan.spawns[0].x), Math.abs(r.plan.spawns[0].z)) > 10, 'moved off the pit');
});

test('a chasm too wide to jump splits the floor in two; the far side needs a way across', () => {
  const bp = sinkholeExample();
  bp.symmetric = false;
  bp.features = [];
  bp.areas = [
    area({ id: 'H1', role: 'pit', what: 'chasm across the room', x: 0, z: 0, width: 48, depth: 8, baseY: 0, topY: 0 }),
    area({ id: 'R', role: 'raised', what: 'low ledge on the far side', x: 0, z: -16, width: 8, depth: 6, baseY: 0, topY: 1 }),
  ];
  bp.links = [];
  bp.spawns = [{ area: 'FLOOR', x: -8, z: 14 }, { area: 'FLOOR', x: 8, z: 14 }];
  assert.ok(blueprintProblems(bp).some((p) => /area "R".*cannot be reached/.test(p)));
  // A narrow trench is a jump, and the floor beyond it is reached.
  bp.areas[0].depth = 3;
  assert.deepEqual(blueprintProblems(bp), []);
});

test('a moat around an area is built as four strips of acid, and the moat feature sees the ring', async () => {
  const bp = fortress();
  assert.deepEqual(blueprintProblems(bp), []);
  const map = scaffold(bp);
  assert.equal(map.pieces.filter((p) => p.type === 'acid').length, 4);
  assert.equal((await checkGenerated(map)).ok, true);
  assert.deepEqual(featureProblems(bp.features, map, { plan: bp }), []);
  const stairs = resolved(bp, 'S');
  assert.equal(stairs.climbs, 'north', 'the flight crosses the moat to the fortress');

  const without = { ...bp, areas: bp.areas.filter((a) => a.role !== 'moat') };
  const problems = featureProblems(without.features, scaffold(without), { plan: without });
  assert.ok(problems.some((p) => /acid moat.*Add a moat area \(role "moat"\) with around/.test(p)), problems.join('\n'));
});

test('a requested hole is an opening in the floor, not acid and not a floor with something drawn on it', () => {
  const bp = sinkholeExample();
  assert.deepEqual(featureProblems(bp.features, scaffold(bp), { plan: bp }), []);
  // The hole planned as acid: the plan is told to make it a pit.
  const acid = sinkholeExample();
  acid.areas[0].role = 'pool';
  const asAcid = featureProblems(acid.features, scaffold(acid), { plan: acid });
  assert.ok(asAcid.some((p) => /bottomless hole in the floor at the centre \("a giant hole in the middle"\).*no opening in the floor at the centre.*Add a pit area/.test(p)), asAcid.join('\n'));
  // The finished map with its floor put back: the map is told to leave it out.
  const map = scaffold(bp);
  delete map.pieces[0].skip;
  const filled = featureProblems(bp.features, map);
  assert.ok(filled.some((p) => /Leave the floor out at x=0, z=0/.test(p)), filled.join('\n'));
});

test('platforms, bridges, levels and towers are counted on the geometry', () => {
  const bp = sinkholeExample();
  const map = scaffold(bp);
  assert.deepEqual(featureProblems([feature({ what: 'platforms', count: 3, words: '' }), feature({ what: 'bridge', words: '' }), feature({ what: 'levels', count: 3, words: '' })], map), []);
  // The platform, its bridge and the ledge across are two platforms, not one; with the mirrored pair and the floating one, five.
  const more = featureProblems([feature({ what: 'platforms', count: 6, words: 'six platforms' })], map);
  assert.match(more[0], /the map has 5 \(/);
  const tower = featureProblems([feature({ what: 'tower', where: 'center', words: 'a central tower' })], map);
  assert.match(tower[0], /0 blocks at least 6 m tall/);
  // Tall walls are not towers.
  const walled = structuredClone(map);
  walled.pieces.push({ type: 'portal-wall', at: [0, 0, 0], size: [6, 12, 0.6], center: true });
  assert.equal(featureProblems([feature({ what: 'tower', where: 'center', words: '' })], walled).length, 1);
  map.pieces.push({ type: 'block', at: [0, 0, 0], size: [4, 12, 4], center: true });
  assert.deepEqual(featureProblems([feature({ what: 'tower', where: 'center', words: '' })], map), []);
});

test('hazards in a plan come from its lists; in a map from its pieces', () => {
  const bp = combatExample();
  const want = [feature({ what: 'hazard', hazard: 'crusher', count: 2, words: 'crushers' })];
  assert.match(featureProblems(want, scaffold(bp), { plan: bp })[0], /no area lists crusher/);
  bp.areas[3].hazards = ['crusher'];
  assert.deepEqual(featureProblems(want, scaffold(bp), { plan: bp }), []);
  const map = scaffold(bp);
  assert.match(featureProblems(want, map)[0], /the map has 0\. Add 2 more crusher pieces/);
});

test('the finished map is held to the plan: stairs turned the wrong way, a covered pit', () => {
  const bp = sinkholeExample();
  const map = scaffold(bp);
  assert.deepEqual(conformance(bp, map), []);
  const turned = structuredClone(map);
  turned.pieces.find((p) => p.type === 'stairs')!.rot = 90;
  assert.ok(conformance(bp, turned).some((m) => /area "S1".*climbs the wrong way.*Set its rot to 270/.test(m)), conformance(bp, turned).join('\n'));
  const covered = structuredClone(map);
  covered.pieces.push({ type: 'block', at: [6, -1, 6], size: [6, 1, 6], center: true });
  assert.ok(conformance(bp, covered).some((m) => /area "H1".*is covered/.test(m)));
  const lost = structuredClone(map);
  lost.pieces = lost.pieces.filter((p) => !(p.type === 'block' && p.at[1] === -1));
  assert.ok(conformance(bp, lost).some((m) => /floor around the pits is missing/.test(m)));
  // Mirrored copies are checked too.
  assert.equal(expandPieces(map).filter((p) => p.type === 'stairs').length, 2);
});

test('a feature the model cannot name is dropped, not the whole plan', () => {
  const answer = BlueprintSchema.parse({ ...sinkholeExample(), features: [{ ...sinkholeExample().features[0] }, { ...sinkholeExample().features[1], what: 'chambers' }] });
  assert.equal(answer.features[1], null);
  assert.deepEqual(tidyFeatures(answer.features).map((f) => f.what), ['hole']);
});

test('features are tidied: sane numbers, no duplicates, a hazard needs its kind', () => {
  const t = tidyFeatures([
    feature({ what: 'platforms', count: 3.4, words: 'three platforms' }),
    feature({ what: 'platforms', count: 3, words: 'again' }),
    feature({ what: 'hazard', words: 'some hazard' }),
    feature({ what: 'tower', metres: 400, words: 'x'.repeat(200) }),
  ]);
  assert.equal(t.length, 2);
  assert.equal(t[0].count, 3);
  assert.equal(t[1].metres, 60);
  assert.equal(t[1].words.length, 80);
});
