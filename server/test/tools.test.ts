/**
 * The chat's tools (server/gen/tools.ts): what the model edits the map with and checks it with.
 * No model calls.
 *
 *   npx tsx --test server/test/tools.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankMap, blankPuzzle } from '../../src/editor/templates';
import type { MapData } from '../../src/world/maps/MapFormat';
import { checkGenerated } from '../gen/check';
import { playtest } from '../gen/playtest';
import { analyzeRoutes } from '../gen/routes';
import { TOOLS, Workspace, mapListing } from '../gen/tools';

const env = { check: checkGenerated, routes: analyzeRoutes, playtest };
const workspace = (map: MapData = blankPuzzle()) => new Workspace(map, env);

test('every tool the model is offered has a schema and a description', () => {
  assert.deepEqual(TOOLS.map((t) => t.name), ['view_map', 'edit_map', 'validate_map', 'check_routes', 'playtest', 'surface_at']);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal((t.input_schema as { type: string }).type, 'object');
  }
});

test('view_map lists every piece with its number and the extents it covers', async () => {
  const ws = workspace();
  const out = await ws.run('view_map', {});
  assert.equal(out.isError, false);
  assert.match(out.text, /^Map "New puzzle"/);
  assert.match(out.text, /#2 block at \[0, 0, 0\] size \[20, 3\.2, 1\]/);
  assert.match(out.text, /\[x -10\.\.10, y 0\.\.3\.2, z -0\.5\.\.0\.5\]/);
  const only = await ws.run('view_map', { types: ['spawn', 'goal'] });
  assert.match(only.text, /#3 spawn/);
  assert.doesNotMatch(only.text, /#2 block/);
});

test('edit_map adds, updates and removes, and says what the numbers are afterwards', async () => {
  const ws = workspace();
  const added = await ws.run('edit_map', {
    ops: [
      { op: 'add', piece: { type: 'block', at: [4, 0, 4], size: [2, 2, 2], portal: ['top'] } },
      { op: 'add', piece: { type: 'block', at: [-4, 0, 4], size: [2, 3, 2] } },
    ],
  });
  assert.equal(added.isError, false, added.text);
  assert.equal(added.mapChanged, true);
  assert.equal(ws.map.pieces.length, 7);
  assert.match(added.text, /added 2 pieces \(#5-#6\)/);
  assert.match(added.text, /#5 block at \[4, 0, 4\] size \[2, 2, 2\] portal=top {2}\[x 3\.\.5, y 0\.\.2, z 3\.\.5\]/);

  // Updates keep what they do not mention, and null drops a parameter.
  const changed = await ws.run('edit_map', { ops: [{ op: 'update', index: 5, set: { at: [6, 0, 4], portal: null } }] });
  assert.equal(changed.isError, false, changed.text);
  assert.deepEqual(ws.map.pieces[5].at, [6, 0, 4]);
  assert.deepEqual(ws.map.pieces[5].size, [2, 2, 2]);
  assert.equal('portal' in ws.map.pieces[5], false);

  // Removing renumbers what follows; numbers inside one call mean the map as it was before it.
  const removed = await ws.run('edit_map', { ops: [{ op: 'remove', index: 5 }, { op: 'update', index: 6, set: { size: [2, 4, 2] } }] });
  assert.equal(removed.isError, false, removed.text);
  assert.equal(ws.map.pieces.length, 6);
  assert.deepEqual(ws.map.pieces[5].size, [2, 4, 2]);
  assert.match(removed.text, /Numbers after the removal/);
});

test('an invalid operation refuses the whole call and applies nothing', async () => {
  const ws = workspace();
  const before = JSON.stringify(ws.map);
  const bad = await ws.run('edit_map', {
    ops: [
      { op: 'add', piece: { type: 'block', at: [0, 0, 8], size: [2, 2, 2] } },
      { op: 'add', piece: { type: 'teleporter', at: [0, 0, 0] } },
    ],
  });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /unknown piece type "teleporter"/);
  assert.equal(JSON.stringify(ws.map), before);

  for (const [ops, pattern] of [
    [[{ op: 'update', index: 99, set: {} }], /no piece #99/],
    [[{ op: 'add', piece: { type: 'block', at: [0, 0] } }], /"at" must be three numbers/],
    [[{ op: 'add', piece: { type: 'block', at: [0, 0, 0], size: [2, 2, 2], speed: 3 } }], /no parameter "speed"/],
    [[{ op: 'add', piece: { type: 'door', at: [0, 0, 0], receiver: 5 } }], /must be text/],
    [[{ op: 'add', piece: { type: 'room', at: [0, 0, 0], size: [10, 5, 10] } }], /already has a room/],
    [[{ op: 'meta', meta: { kind: 'racing' } }], /combat or puzzle/],
    [[{ op: 'dance' }], /"op" must be/],
  ] as const) {
    const r = await ws.run('edit_map', { ops });
    assert.equal(r.isError, true);
    assert.match(r.text, pattern);
  }
  assert.equal(JSON.stringify(ws.map), before);
});

test('numbers and values are tidied on the way in: rounding, quarter turns, "3.5" for 3.5, "top,front" for a list', async () => {
  const ws = workspace();
  const r = await ws.run('edit_map', {
    ops: [{ op: 'add', piece: { type: 'block', at: [1.234, '0', 2], size: [2, 2, 2.004], rot: 47, portal: 'top,front' } }],
  });
  assert.equal(r.isError, false, r.text);
  const p = ws.map.pieces[5];
  assert.deepEqual(p.at, [1.23, 0, 2]);
  assert.deepEqual(p.size, [2, 2, 2]);
  assert.equal(p.rot, 90);
  assert.deepEqual(p.portal, ['top', 'front']);
  assert.match(r.text, /snapped to 90/);
});

test('what is wrong with a piece you touched comes back with the edit', async () => {
  const ws = workspace();
  // A spawn floating 3 m above the floor, and a block poking out of the room.
  const r = await ws.run('edit_map', {
    ops: [
      { op: 'add', piece: { type: 'spawn', at: [3, 3, 3] } },
      { op: 'add', piece: { type: 'block', at: [30, 0, 0], size: [2, 2, 2] } },
    ],
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /Problems with what you touched \(3\)/);
  assert.match(r.text, /spawn at \[3, 3, 3\] has no floor under it/);
  assert.match(r.text, /is outside the room/);
  assert.equal(r.problems?.length, 3);
});

test('clear and meta: a new map can be started from the template', async () => {
  const ws = workspace(blankMap());
  const r = await ws.run('edit_map', {
    ops: [
      { op: 'clear' },
      { op: 'meta', meta: { name: 'Fresh', kind: 'puzzle', symmetry: 'none', hint: 'Go.' } },
      { op: 'add', piece: { type: 'room', at: [0, 0, 0], size: [10, 6, 10], portal: ['walls'] } },
      { op: 'add', piece: { type: 'spawn', at: [0, 0, 3] } },
      { op: 'add', piece: { type: 'goal', at: [0, 0, -3] } },
    ],
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(ws.map.name, 'Fresh');
  assert.equal(ws.map.kind, 'puzzle');
  assert.equal(ws.map.pieces.length, 3);
  assert.equal(ws.changed, true);
});

test('validate_map tidies, reports every problem, builds, and remembers a pass', async () => {
  const ws = workspace();
  assert.equal(ws.isValidated, false);
  const ok = await ws.run('validate_map', {});
  assert.match(ok.text, /The map is valid/);
  assert.equal(ws.isValidated, true);
  // Any edit makes it unvalidated again.
  await ws.run('edit_map', { ops: [{ op: 'add', piece: { type: 'block', at: [4, 0, 4], size: [2, 2, 2] } }] });
  assert.equal(ws.isValidated, false);
  // A door for a receiver that does not exist.
  await ws.run('edit_map', { ops: [{ op: 'add', piece: { type: 'door', at: [0, 0, 6], receiver: 'nope' } }] });
  const bad = await ws.run('validate_map', {});
  assert.match(bad.text, /problem/);
  assert.match(bad.text, /no receiver piece has the id "nope"/);
  assert.equal(ws.isValidated, false);
});

test('surface_at finds the floor, a block top, and a hole', async () => {
  const ws = workspace();
  const r = await ws.run('surface_at', { points: [[0, 0], [0, 5], [30, 30]] });
  assert.equal(r.isError, false);
  const [onDivider, onFloor, outside] = r.text.split('\n');
  assert.match(onDivider, /block y 0\.\.3\.2/);
  assert.match(onDivider, /the highest flat surface to stand on is y=3\.2/);
  assert.match(onFloor, /room floor y -1\.\.0/);
  assert.match(outside, /nothing solid/);
  await ws.run('edit_map', { ops: [{ op: 'update', index: 0, set: { skip: ['floor'] } }] });
  const hole = await ws.run('surface_at', { points: [[0, 5]] });
  assert.match(hole.text, /this is a hole/);
});

test('check_routes goes through the same analysis the checker runs', async () => {
  const ws = workspace();
  const r = await ws.run('check_routes', {});
  assert.equal(r.isError, false);
  assert.equal(r.routesOk, true);
  assert.match(r.summary, /1 portal hop/);
  await ws.run('edit_map', { ops: [{ op: 'update', index: 0, set: { portal: [] } }, { op: 'update', index: 2, set: { portal: [] } }] });
  const blocked = await ws.run('check_routes', {});
  assert.equal(blocked.routesOk, false);
  assert.match(blocked.summary, /NOT reachable/);
});

test('mapListing marks mirrored maps and lists pieces in order', () => {
  const m = blankMap();
  const text = mapListing(m);
  assert.match(text, /kind combat, symmetry rotate180/);
  assert.match(text, /Symmetric: every piece not marked center is copied/);
});
