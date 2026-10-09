/**
 * The generator's deterministic core (docs/llm-map-generation-plan.md, milestone 1): the
 * model-facing wire format, the catalogue prompt, and autofix + lint + build. No model is
 * called here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BUILT_IN_MAPS, blankMap, blankPuzzle } from '../../src/editor/templates';
import { PIECES, expandPieces, type MapData } from '../../src/world/maps/MapFormat';
import { buildCatalogue, renderExample } from '../gen/catalogue';
import { autofix, checkGenerated, lint } from '../gen/check';
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
 * Shipped maps the lint rightly rejects. Shaft's spawns at (+-10, 0, 14) mirror to (-+10, 0, -14),
 * which is inside the 6 m blocks at (+-12, 0, -12): the pads are buried. When the map is fixed
 * this test fails, which is the cue to delete the entry.
 */
const KNOWN_BAD: Record<string, RegExp> = { 'Shaft (PvP)': /spawn at \[-?10, 0, -?14\] is inside a block/ };

// Hand-made maps that ship with the game are valid by definition: the checks must accept them.
for (const { label, data } of maps) {
  test(`checkGenerated accepts ${label}`, async () => {
    const r = await checkGenerated(data);
    const known = KNOWN_BAD[label];
    if (known) {
      assert.equal(r.ok, false, `${label} now passes: remove it from KNOWN_BAD`);
      assert.match(r.problems.join('\n'), known);
      return;
    }
    assert.deepEqual(r.problems, [], `${label}: ${r.problems.join(' | ')}`);
    assert.equal(r.ok, true);
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

/** Each case breaks a shipped map in one way and names the words the problem must contain. */
const BROKEN: { name: string; make: () => MapData; expect: RegExp; build?: true }[] = [
  { name: 'unknown piece type', make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'turret', at: [0, 0, 0] }] }), expect: /unknown piece type/ },
  {
    name: 'a spawn floating above the floor',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'spawn', at: [-16, 30, 34] }] }),
    expect: /spawn at \[-16, 30, 34\] has no floor under it/,
  },
  {
    name: 'a spawn inside a block',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'spawn', at: [0, 5, 0], center: true }] }),
    expect: /spawn at \[0, 5, 0\] is inside a block/,
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
    name: 'a switch aimed at nothing',
    make: () => ({ ...highwire(), pieces: [...highwire().pieces, { type: 'switch', at: [0, 12, 4], rot: 180, effect: 'trigger', targets: ['ghost'] }] }),
    expect: /nothing with id "ghost"/,
    build: true,
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
  for (const { label, data } of maps) if (!KNOWN_BAD[label]) assert.deepEqual(lint(autofix(data).map), [], label);
});
