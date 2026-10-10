/**
 * The generator's deterministic core (docs/llm-map-generation-plan.md, milestone 1): the
 * model-facing wire format, the catalogue prompt, and autofix + lint + build. No model is
 * called here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BUILT_IN_MAPS, blankMap, blankPuzzle } from '../../src/editor/templates';
import { PIECES, expandPieces, type MapData, type Piece } from '../../src/world/maps/MapFormat';
import { buildCatalogue, renderExample } from '../gen/catalogue';
import { autofix, checkGenerated, fixSupport, lint } from '../gen/check';
import { summarizeMap } from '../gen/prompts';
import { WireMapSchema, fromWire, toWire } from '../gen/wire';

const maps = BUILT_IN_MAPS.map((m) => ({ label: m.label, data: m.data() }));
const highwire = (): MapData => structuredClone(maps.find((m) => m.label.startsWith('Highwire'))!.data);

/** Counts what Anthropic's structured outputs limit: optional properties and union types. */
function schemaCost(schema: unknown): { optional: number; unions: number } {
  let optional = 0;
  let unions = 0;
  const walk = (s: unknown): void => {
    if (Array.isArray(s)) return s.forEach(walk);
    if (!s || typeof s !== 'object') return;
    const o = s as Record<string, unknown>;
    if (o.properties && typeof o.properties === 'object') {
      const required = new Set((o.required as string[] | undefined) ?? []);
      optional += Object.keys(o.properties).filter((k) => !required.has(k)).length;
    }
    if (o.anyOf || Array.isArray(o.type)) unions++;
    Object.values(o).forEach(walk);
  };
  walk(schema);
  return { optional, unions };
}

test('the wire schema fits the structured-output limits (24 optional fields, 16 unions)', () => {
  const { optional, unions } = schemaCost(zodOutputFormat(WireMapSchema).schema);
  console.log(`wire schema: ${optional} optional fields, ${unions} unions`);
  assert.equal(optional, 0);
  assert.equal(unions, 0);
});

for (const { label, data } of maps) {
  test(`wire format round-trips ${label}`, () => {
    const wire = WireMapSchema.parse(toWire(data));
    const back = fromWire(wire, { id: data.id });
    assert.deepEqual(back.problems, []);
    // An explicit rot of 0 and no rot mean the same thing.
    const norm = (m: MapData) => expandPieces(m).map(({ rot, ...rest }) => (rot ? { ...rest, rot } : rest));
    assert.deepEqual(norm(back.map), norm(data));
    assert.equal(back.map.kind ?? 'combat', data.kind ?? 'combat');
  });
}

test('wire params that are not valid values come back as problems', () => {
  const wire = toWire(highwire());
  const spikes = wire.pieces.find((p) => p.type === 'spikes')!;
  spikes.params.push({ key: 'rest', value: 'soon' }, { key: 'sparkle', value: '1' });
  const { problems } = fromWire(wire);
  assert.equal(problems.length, 2);
  assert.match(problems.join('\n'), /parameter "rest": "soon" is not a number/);
  assert.match(problems.join('\n'), /unknown parameter "sparkle"/);
});

test('the catalogue lists every piece type, and is stable between calls', () => {
  const text = buildCatalogue();
  for (const type of Object.keys(PIECES)) assert.ok(text.includes(`- ${type} [`), `missing ${type}`);
  assert.equal(buildCatalogue(), text);
  const example = renderExample('Highwire', highwire());
  console.log(`catalogue: ${text.length} chars (~${Math.round(text.length / 3.5)} tokens), Highwire example: ${example.length} chars (~${Math.round(example.length / 3.5)} tokens)`);
  assert.ok(text.length < 20_000, 'the static prompt should stay well under the 100K token budget');
});

/**
 * Shipped maps that need a fix to pass. Shaft's spawns at (+-10, 0, 14) mirror to (-+10, 0, -14),
 * which is inside the 6 m blocks at (+-12, 0, -12): the pads are buried, and the support autofix
 * lifts them onto the blocks (y=6). When the map file itself is fixed this test fails, which is
 * the cue to delete the entry.
 */
const KNOWN_FIXED: Record<string, RegExp> = { 'Shaft (PvP)': /\(spawn\) at x=-?10, z=14 moved from y=0 to y=6/ };

// Hand-made maps that ship with the game are valid by definition: the checks must accept them.
for (const { label, data } of maps) {
  test(`checkGenerated accepts ${label}`, async () => {
    const r = await checkGenerated(data);
    assert.deepEqual(r.problems, [], `${label}: ${r.problems.join(' | ')}`);
    assert.equal(r.ok, true);
    const known = KNOWN_FIXED[label];
    if (known) assert.match(r.fixes.join('\n'), known, `${label} needs no fix any more: remove it from KNOWN_FIXED`);
    else assert.deepEqual(r.fixes.filter((f) => !/hidden faces/.test(f)), [], `${label} should need no fixes (showing hidden faces is expected)`);
    console.log(`${label}: ok, build ${r.buildMs} ms, ${r.fixes.length} fixes`);
  });
}

test('autofix: rounds, snaps quarter turns, drops unknown parameters, adds lights, cleans text', () => {
  const m = highwire();
  m.name = '  <b>Sky</b>  Arena  ';
  m.pieces = m.pieces.filter((p) => p.type !== 'lights');
  m.pieces.push({ type: 'block', at: [4.123456, 0, 4], size: [2, 2, 2], rot: 80, glitter: true });
  const { map, fixes } = autofix(m);
  assert.equal(map.name, 'b Sky /b Arena');
  const block = map.pieces[map.pieces.length - 1];
  assert.deepEqual(block.at, [4.12, 0, 4]);
  assert.equal(block.rot, 90);
  assert.equal('glitter' in block, false);
  assert.ok(map.pieces.some((p) => p.type === 'lights'));
  assert.match(fixes.join('\n'), /snapped to 90/);
  assert.match(fixes.join('\n'), /dropped unknown parameter "glitter"/);
  assert.match(fixes.join('\n'), /added ceiling lights/);
});

test('a spawn hanging in the air is dropped onto the surface below, and the fix is reported', async () => {
  const m = highwire();
  m.pieces.push({ type: 'spawn', at: [-8, 30, 34] });
  const r = await checkGenerated(m);
  assert.equal(r.ok, true, r.problems.join(' | '));
  assert.deepEqual(r.map.pieces[r.map.pieces.length - 1].at, [-8, 8, 34]);
  assert.match(r.fixes.join('\n'), /\(spawn\) at x=-8, z=34 moved from y=30 to y=8/);
});

test('a spawn buried in a block is lifted to the top of it', async () => {
  const m = highwire();
  m.pieces.push({ type: 'spawn', at: [0, 5, 0], center: true });
  const r = await checkGenerated(m);
  assert.equal(r.ok, true, r.problems.join(' | '));
  assert.deepEqual(r.map.pieces[r.map.pieces.length - 1].at, [0, 16, 0]);
});

test('a goal gets the same treatment, and a spawn already on its surface is left alone', () => {
  const m = blankPuzzle();
  m.pieces = m.pieces.map((p) => (p.type === 'goal' ? { ...p, at: [0, 2, -10] as [number, number, number] } : p));
  const fixed = fixSupport(m);
  assert.deepEqual(fixed.map.pieces.find((p) => p.type === 'goal')!.at, [0, 0, -10]);
  assert.equal(fixed.fixes.length, 1, 'only the goal moved');
});

test('autofix removes switch targets that point at nothing, and a trigger switch left with none', async () => {
  const m = highwire();
  m.pieces.push(
    { type: 'switch', at: [0, 12, 4], rot: 180, effect: 'trigger', targets: ['trap', 'ghost'] },
    { type: 'switch', at: [2, 12, 4], rot: 180, effect: 'trigger', targets: ['laserkill'] },
    { type: 'switch', at: [-2, 12, 4], rot: 180, effect: 'portals', cooldown: 20 },
  );
  const before = m.pieces.length;
  const r = await checkGenerated(m);
  assert.equal(r.ok, true, r.problems.join(' | '));
  assert.equal(r.map.pieces.length, before - 1, 'only the switch with nothing left went');
  assert.deepEqual(r.map.pieces[before - 3].targets, ['trap']);
  assert.match(r.fixes.join('\n'), /piece #\d+ \(switch\): removed, it had nothing left to set off/);
});

test('autofix lifts a dropper ceiling that is not above the drop point', () => {
  const m = highwire();
  m.pieces.push({ type: 'dropper', at: [0, 13, 0], ceiling: 13 });
  const { map, fixes } = autofix(m);
  assert.equal(map.pieces[map.pieces.length - 1].ceiling, 14);
  assert.match(fixes.join('\n'), /dropper\): ceiling 13 was not above the drop point; set 14/);
});

test('the review summary says which floating platforms carry a hazard', () => {
  const m = blankMap();
  m.pieces.push({ type: 'floor', at: [10, 5, 10], size: [6, 0.4, 6] }, { type: 'spikes', at: [10, 5.4, 10], size: [2, 0, 2] }, { type: 'floor', at: [-10, 5, 10], size: [6, 0.4, 6] });
  const text = summarizeMap(m);
  assert.match(text, /Floating surfaces, clear of the floor \(2\):/);
  assert.match(text, /floor at \[10, 5, 10\], top y=5\.4: spikes/);
  assert.match(text, /floor at \[-10, 5, 10\], top y=5\.4: no hazard/);
});

/** Each case breaks a shipped map in one way and names the words the problem must contain. */
const BROKEN: { name: string; make: () => MapData; expect: RegExp; build?: true }[] = [
  { name: 'unknown piece type', make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'turret', at: [0, 0, 0] }] }), expect: /unknown piece type/ },
  {
    name: 'a spawn with nothing below it',
    make: () => ({ ...blankMap(), pieces: blankMap().pieces.map((p) => (p.type === 'room' ? { ...p, skip: ['floor'] } : p)) }),
    expect: /spawn at \[0, 0, 20\] has no floor under it \(nothing below it\)/,
  },
  {
    name: 'a spawn in the acid',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'spawn', at: [6, -0.6, 6], center: true }] }),
    expect: /spawn at \[6, -2\.4, 6\] is in an acid pool/,
  },
  {
    name: 'a goal with no headroom under the ceiling',
    make: () => ({ ...blankPuzzle(), pieces: blankPuzzle().pieces.map((p) => (p.type === 'room' ? { ...p, size: [20, 2, 28] as [number, number, number] } : p)) }),
    expect: /goal at \[0, 0, -10\] has no headroom: the room ceiling is at y=2/,
  },
  {
    name: 'a piece outside the room',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'block', at: [100, 0, 0], size: [2, 2, 2] }] }),
    expect: /outside the room/,
  },
  {
    name: 'a block sticking through the wall',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'block', at: [20, 0, 0], size: [20, 2, 2] }] }),
    expect: /sticks out of the room/,
  },
  {
    name: 'duplicate ids',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'spikes', at: [-8, 0, 0], size: [2, 0, 2], id: 'trap' }] }),
    expect: /the id "trap" is used twice/,
  },
  {
    name: 'a bad parameter value',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'spikes', at: [-8, 0, 0], size: [2, 0, 2], mode: 'sometimes', rest: 'x' }] }),
    expect: /parameter "mode" must be one of/,
  },
  {
    name: 'no room',
    make: () => ({ ...highwire(), pieces: highwire().pieces.filter((p) => p.type !== 'room') }),
    expect: /no room piece/,
  },
  {
    name: 'a combat map with one spawn',
    make: () => ({ ...blankMap(), symmetry: 'none' }),
    expect: /needs at least 2 spawn points/,
  },
  {
    name: 'a puzzle without a goal',
    make: () => ({ ...blankPuzzle(), pieces: blankPuzzle().pieces.filter((p) => p.type !== 'goal') }),
    expect: /exactly one goal/,
  },
  {
    name: 'a symmetric map with an off-centre room',
    make: () => ({ ...highwire(), pieces: highwire().pieces.map((p) => (p.type === 'room' ? { ...p, at: [5, 0, 0] as [number, number, number] } : p)) }),
    expect: /centred at \[5, 0, 0\]/,
  },
  {
    name: 'a door with no receiver',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'door', at: [0, 0, 5], receiver: 'ghost' }] }),
    expect: /\(door\) at \[0, 0, 5\]: no receiver piece has the id "ghost"/,
  },
  {
    name: 'a parameter of the wrong type',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'laser', at: [0, 5, 0], pitch: 'up' }] }),
    expect: /parameter "pitch" must be a number/,
  },
];

for (const c of BROKEN) {
  test(`checkGenerated reports: ${c.name}`, async () => {
    const r = await checkGenerated(c.make());
    assert.equal(r.ok, false);
    assert.match(r.problems.join('\n'), c.expect);
    if (c.build) assert.ok(r.buildMs !== undefined, 'this one is found by the build, not the lint');
  });
}

test('lint does not report a clean shipped map', () => {
  for (const { label, data } of maps) assert.deepEqual(lint(fixSupport(autofix(data).map).map), [], label);
});

test('cleanBaseMap accepts a shipped map, tidied, and refuses what cannot be refined', async () => {
  const { cleanBaseMap, REFINE_PIECES_MAX } = await import('../gen/base');
  const ok = cleanBaseMap({ ...BUILT_IN_MAPS[0].data(), name: '  Mine\u0000<b>  ' });
  assert.ok('map' in ok);
  assert.ok(!('map' in ok && /[<>\u0000]/.test(ok.map.name)), 'the name is cleaned like a generated one');
  const piece = { type: 'block', at: [0, 0, 0], size: [1, 1, 1] };
  for (const raw of [null, [], {}, { pieces: [] }, { pieces: [{ ...piece, type: 'constructor' }] }, { pieces: [{ ...piece, at: [0, NaN, 0] }] }, { pieces: [{ ...piece, size: [1, 1] }] }, { pieces: Array(REFINE_PIECES_MAX + 1).fill(piece) }]) {
    assert.ok('error' in cleanBaseMap(raw), JSON.stringify(raw)?.slice(0, 60));
  }
});

test('a portal wall is made level with the ground beside it, and a mismatch it cannot fix is reported', async () => {
  const room: Piece = { type: 'room', at: [0, 0, 0], size: [20, 8, 20], center: true, portal: ['walls'] };
  const mapWith = (...pieces: Piece[]): MapData => ({
    id: 'wall-level',
    name: 'Wall level',
    hint: '',
    kind: 'puzzle',
    pieces: [room, { type: 'spawn', at: [0, 0, 8] }, { type: 'goal', at: [0, 0, -8] }, ...pieces],
  });
  const wall = (y: number, h: number): Piece => ({ type: 'portal-wall', at: [0, y, 0], size: [6, h, 0.6] });
  const slab = (z: number): Piece => ({ type: 'block', at: [0, 0, z], size: [10, 0.5, 4] });

  // Ground 0.5 m up on both sides, the wall's base at the floor: buried by 0.5 m. Both sides agree, so it is raised.
  const fixedSupport = fixSupport(mapWith(wall(0, 4), slab(-3), slab(3)));
  const w = fixedSupport.map.pieces.find((p) => p.type === 'portal-wall')!;
  assert.deepEqual([w.at[1], (w.size as number[])[1]], [0.5, 3.5], 'raised to the ground, top unchanged');
  assert.match(fixedSupport.fixes.join(' | '), /portal-wall.*to stand level with the ground/);
  assert.deepEqual(lint(fixedSupport.map).filter((p) => /portal wall/.test(p)), []);

  // The two sides differ: no single level fits, so it is a problem for the model.
  const split = mapWith(wall(0, 4), slab(-3));
  assert.equal(fixSupport(split).fixes.length, 0);
  const problems = lint(split).filter((p) => /portal wall/.test(p));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ground beside its north face is at y=0.5/);

  // Flush on both sides: fine.
  const flush = mapWith(wall(0.5, 3.5), slab(-3), slab(3));
  assert.deepEqual(lint(flush).filter((p) => /portal wall/.test(p)), []);
  assert.equal(fixSupport(flush).fixes.length, 0);
});

test('a spawn drawn inside an acid pool is moved to the nearest dry spot on the same floor', () => {
  const map: MapData = {
    id: 'acid-spawn',
    name: 'Acid spawn',
    hint: '',
    kind: 'combat',
    pieces: [
      { type: 'room', at: [0, 0, 0], size: [30, 10, 30], center: true, portal: ['walls'] },
      { type: 'acid', at: [0, 0.4, 0], size: [16, 0, 16], center: true },
      { type: 'spawn', at: [-3, 0, 0] },
      { type: 'spawn', at: [10, 0, 10] },
    ],
  };
  const r = fixSupport(map);
  const moved = r.map.pieces[2];
  assert.ok(Math.abs(moved.at[0]) >= 9 || Math.abs(moved.at[2]) >= 9, `clear of the pool (${moved.at.join(',')})`);
  assert.equal(moved.at[1], 0);
  assert.deepEqual(r.map.pieces[3].at, [10, 0, 10], 'a spawn already dry stays');
  assert.match(r.fixes.join(' | '), /out of the acid pool/);
  assert.deepEqual(lint(r.map).filter((p) => /acid/.test(p)), []);
});
