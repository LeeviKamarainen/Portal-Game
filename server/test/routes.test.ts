/**
 * The route analysis the chat's `check_routes` tool runs (server/gen/routes.ts): can a player
 * get from the spawn to the exit, with how many portal hops, and what opens each door. Headless,
 * no model calls.
 *
 *   npx tsx --test server/test/routes.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_MAPS, blankPuzzle } from '../../src/editor/templates';
import type { MapData, Piece } from '../../src/world/maps/MapFormat';
import catapult from '../../src/world/maps/catapult.json';
import { analyzeRoutes, describeRoutes } from '../gen/routes';

const puzzle = (pieces: Piece[], extra: Partial<MapData> = {}): MapData => ({
  id: 'routes-test',
  name: 'Routes test',
  hint: '',
  kind: 'puzzle',
  symmetry: 'none',
  fog: { color: '#0e121a', near: 30, far: 110 },
  killY: -6,
  pieces,
  ...extra,
});

test('the starting puzzle template needs exactly one portal hop, and the route says how', async () => {
  const r = await analyzeRoutes(blankPuzzle());
  assert.equal(r.kind, 'puzzle');
  assert.equal(r.connected, true);
  assert.equal(r.hops, 1);
  assert.ok(r.steps.some((s) => s.kind === 'portal'), 'one step is a portal hop');
  const text = describeRoutes(r);
  assert.match(text, /1 portal hop/);
  assert.match(text, /shoot an exit portal/);
});

test('with nothing that takes a portal the divider cannot be crossed, and the report says what separates the floors', async () => {
  const map = blankPuzzle();
  // The room's walls and floor and the divider no longer take portals; the divider is also too high to jump.
  map.pieces[0] = { type: 'room', at: [0, 0, 0], size: [20, 8, 28], portal: [] };
  map.pieces[2] = { type: 'block', at: [0, 0, 0], size: [20, 3.2, 1] };
  const r = await analyzeRoutes(map);
  assert.equal(r.connected, false);
  assert.equal(r.hops, null);
  assert.ok(r.stranded.length > 0, 'the far side is listed as unreachable floor');
  assert.ok(r.stranded[0].closest, 'with the reached floor nearest to it');
  assert.match(describeRoutes(r), /CANNOT be reached/);
});

test('without the divider the exit is a walk: no hops', async () => {
  const map = blankPuzzle();
  map.pieces.splice(2, 1);
  const r = await analyzeRoutes(map);
  assert.equal(r.connected, true);
  assert.equal(r.hops, 0);
  assert.match(describeRoutes(r), /no portals are needed/);
});

test('a pit between the floors is crossed by a portal on the far floor, and that is one hop', async () => {
  const map = puzzle([
    { type: 'room', at: [0, 0, 0], size: [16, 8, 36], portal: [], skip: ['floor'] },
    { type: 'lights', at: [0, 8, 0], size: [16, 0, 36], center: true },
    // Two islands with a 10 m pit between them; only the far one takes portals, and so does a pad by the spawn.
    { type: 'floor', at: [0, -0.4, 12], size: [16, 0.4, 12], portal: ['top'] },
    { type: 'floor', at: [0, -0.4, -12], size: [16, 0.4, 12], portal: ['top'] },
    { type: 'spawn', at: [0, 0, 14], rot: 0 },
    { type: 'goal', at: [0, 0, -14] },
  ]);
  const r = await analyzeRoutes(map);
  assert.equal(r.connected, true, describeRoutes(r));
  assert.equal(r.hops, 1);
  // Take the portal surface off the far island and it cannot be reached.
  map.pieces[3] = { type: 'floor', at: [0, -0.4, -12], size: [16, 0.4, 12], portal: [] };
  const blocked = await analyzeRoutes(map);
  assert.equal(blocked.connected, false);
});

test('Catapult: the jump pads are part of the route, and its crate door is reported as not opening by itself', async () => {
  const r = await analyzeRoutes(catapult as MapData);
  assert.equal(r.connected, true);
  assert.ok(r.steps.some((s) => /jump pad/.test(s.text)), `the route uses the pads: ${r.steps.map((s) => s.text).join(' | ')}`);
  const door = r.doors.find((d) => d.onRoute);
  assert.ok(door, 'the door is on the route');
  assert.equal(door!.waitsFor, 'plate');
  // A cube that needs shoving onto the button is the player's work: not something the analysis can see.
  assert.equal(door!.opens, 'never');
  assert.ok(r.blockedByDoor, 'so the report says the level cannot be finished as analysed');
});

test('a laser that already hits its receiver opens the door by itself', async () => {
  const map = puzzle([
    { type: 'room', at: [0, 0, 0], size: [24, 8, 24], portal: [] },
    { type: 'lights', at: [0, 8, 0], size: [24, 0, 24], center: true },
    { type: 'block', at: [-6.5, 0, 0], size: [11, 4, 0.6] },
    { type: 'block', at: [6.5, 0, 0], size: [11, 4, 0.6] },
    { type: 'door', at: [0, 0, 0], size: [2, 3.6, 0.6], receiver: 'r1' },
    { type: 'laser', at: [-9, 1.5, 6], rot: 270 },
    { type: 'receiver', at: [9, 1.5, 6], rot: 90, id: 'r1' },
    { type: 'spawn', at: [0, 0, 9], rot: 0 },
    { type: 'goal', at: [0, 0, -9] },
  ]);
  const r = await analyzeRoutes(map);
  assert.equal(r.connected, true, describeRoutes(r));
  assert.equal(r.doors.length, 1);
  assert.equal(r.doors[0].opens, 'itself');
  assert.equal(r.doors[0].onRoute, true);
  assert.equal(r.blockedByDoor, null);
});

test('a door held by a button that a switch-released crate lands on opens once the switches are shot', async () => {
  const map = puzzle([
    { type: 'room', at: [0, 0, 0], size: [24, 9, 24], portal: [] },
    { type: 'lights', at: [0, 9, 0], size: [24, 0, 24], center: true },
    { type: 'block', at: [-6.5, 0, 0], size: [11, 4, 0.6] },
    { type: 'block', at: [6.5, 0, 0], size: [11, 4, 0.6] },
    { type: 'door', at: [0, 0, 0], size: [2, 3.6, 0.6], receiver: 'plate' },
    { type: 'button', at: [5, 0, 5], size: [2.4, 0, 2.4], id: 'plate', needs: 'crate' },
    { type: 'dropper', at: [5, 6, 5], ceiling: 7, auto: false, id: 'hatch' },
    { type: 'switch', at: [-11.9, 1.6, 8], rot: 270, effect: 'trigger', targets: ['hatch'] },
    { type: 'spawn', at: [0, 0, 9], rot: 0 },
    { type: 'goal', at: [0, 0, -9] },
  ]);
  const r = await analyzeRoutes(map);
  assert.equal(r.connected, true, describeRoutes(r));
  assert.equal(r.doors[0].opens, 'switches');
  assert.equal(r.blockedByDoor, null);
  assert.match(describeRoutes(r), /opens once the switches are shot/);
});

test('combat maps: every spawn of Highwire reaches every other; a map with a buried spawn says which', async () => {
  const highwire = BUILT_IN_MAPS[0].data();
  const ok = await analyzeRoutes(highwire);
  assert.equal(ok.kind, 'combat');
  assert.equal(ok.connected, true);
  assert.equal(ok.unreachableSpawns.length, 0);
  const shaft = BUILT_IN_MAPS.find((m) => m.label.startsWith('Shaft'))!.data();
  const bad = await analyzeRoutes(shaft);
  assert.equal(bad.connected, false);
  assert.ok(bad.unreachableSpawns.length > 0);
});
