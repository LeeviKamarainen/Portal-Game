/**
 * The scripted playtest the chat's `playtest` tool runs (server/gen/playtest.ts): a person's
 * inputs on the real simulation, for the mechanics the route analysis cannot see. No model calls.
 *
 *   npx tsx --test server/test/playtest.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blankPuzzle } from '../../src/editor/templates';
import type { MapData, Piece } from '../../src/world/maps/MapFormat';
import { playtest } from '../gen/playtest';

const puzzle = (pieces: Piece[]): MapData => ({ id: 'play-test', name: 'Play test', hint: '', kind: 'puzzle', symmetry: 'none', fog: { color: '#0e121a', near: 30, far: 110 }, killY: -6, pieces });

test('the starting template is solved by one portal pair: a high exit portal over the divider, an entrance on the floor', async () => {
  const r = await playtest(blankPuzzle(), [
    { do: 'stand', at: [0, 0, 10] },
    { do: 'shoot', color: 'orange', at: [10, 4.8, -1] },
    { do: 'shoot', color: 'blue', at: [0, 0, 6] },
    { do: 'walk', to: [0, 6] },
    { do: 'walk', to: [0, -10], seconds: 14 },
  ]);
  assert.match(r.text, /portal placed at/);
  assert.match(r.text, /went through a portal 1 time/);
  assert.equal(r.goal, true, r.text);
  assert.match(r.text, /exit was REACHED/);
});

test('without the portals the same walk stops at the divider, and the report says so', async () => {
  const r = await playtest(blankPuzzle(), [{ do: 'stand', at: [0, 0, 10] }, { do: 'walk', to: [0, -10], seconds: 10 }]);
  assert.equal(r.goal, false);
  assert.match(r.text, /stuck at/);
});

test('a shot at a surface that takes no portals says so', async () => {
  const map = blankPuzzle();
  map.pieces[0] = { type: 'room', at: [0, 0, 0], size: [20, 8, 28], portal: [] };
  const r = await playtest(map, [{ do: 'stand', at: [0, 0, 10] }, { do: 'shoot', color: 'blue', at: [0, 2, 14] }]);
  assert.match(r.text, /NO portal/);
});

test('a beam bent through two portals lights the receiver that it could not reach directly', async () => {
  // The laser fires east along z=5 at a wall; the receiver sits on the far side of that wall, facing west.
  // A portal on each side of the wall carries the beam through it.
  const map = puzzle([
    { type: 'room', at: [0, 0, 0], size: [24, 8, 24], portal: [] },
    { type: 'lights', at: [0, 8, 0], size: [24, 0, 24], center: true },
    { type: 'portal-wall', at: [0, 0, 0], size: [0.6, 6, 24], rot: 0, portal: ['left', 'right'] },
    { type: 'laser', at: [-9, 1.6, 5], rot: 270 },
    { type: 'receiver', at: [9, 1.6, -5], rot: 90, id: 'r1' },
    { type: 'door', at: [9, 0, 8], size: [2, 3.6, 0.6], rot: 90, receiver: 'r1' },
    { type: 'spawn', at: [-9, 0, 9], rot: 0 },
    { type: 'goal', at: [9, 0, 9] },
  ]);
  const dark = await playtest(map, [{ do: 'stand', at: [-9, 0, 9] }, { do: 'wait', seconds: 2 }]);
  assert.match(dark.text, /receiver #4 "r1": dark/);
  assert.match(dark.text, /door #5: shut/);
  // The beam hits the wall's west face at (−0.3, 1.6, 5): a blue portal there, an orange one on the east face
  // opposite the receiver (z = −5), and the beam comes out along +x into it.
  const lit = await playtest(map, [
    { do: 'stand', at: [-9, 0, 9] },
    { do: 'shoot', color: 'blue', at: [-0.3, 1.6, 5] },
    { do: 'stand', at: [9, 0, 2] },
    { do: 'shoot', color: 'orange', at: [0.3, 1.6, -5] },
    { do: 'wait', seconds: 2 },
  ]);
  assert.match(lit.text, /receiver #4 "r1": LIT/, lit.text);
});
