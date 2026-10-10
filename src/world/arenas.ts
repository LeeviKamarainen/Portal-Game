import * as THREE from 'three';
import type { ArenaDef } from './ArenaBuilder';
import { mapToArena, type MapData } from './maps/MapFormat';
import highwire from './maps/highwire.json';
import catapult from './maps/catapult.json';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const V2 = (x: number, y: number) => new THREE.Vector2(x, y);
const PLAYER_Y = 1.02;

/**
 * The arena sequence, easiest first:
 *  1. Calibration     - two portals and a wall: the core idea, nothing can hurt you.
 *  2. Acid Moat       - acid, a moving platform, and portalling up onto a ledge.
 *  3. Crusher Gallery - timed crushers, then relaying a laser through a portal pair to
 *                       open the exit door.
 *  4. Proving Grounds - everything at once: sweeping laser, droppers, a crusher on the
 *                       stairs, and an acid ring around the exit pillar that can only be
 *                       reached by coming up out of a floor portal.
 *  5. Catapult        - jump pads over an acid pit, a cube released by a switch, and a floor
 *                       button locked behind glass: a map file (maps/catapult.json).
 *
 * Portal surfaces are the pale panels; dark metal never takes a portal.
 */
export const ARENAS: ArenaDef[] = [
  {
    id: 'calibration',
    name: 'Calibration',
    hint: 'Pale panels take portals. Put one high on the far wall, one near you, and walk through.',
    blurb: 'Two portals and a wall. Nothing here can hurt you.',
    build(b) {
      const min = V(-10, 0, -14);
      const max = V(10, 8, 14);
      b.level.room(min, max, { portalable: { north: true, south: true, west: true, east: true, floor: true } });
      // The divider: too tall to jump, low enough to see the far wall over it.
      b.box(V(-10, 0, -0.5), V(10, 3.2, 0.5), { material: 'metal', faces: ['py', 'pz', 'nz'] });
      b.ceilingLights(V2(-10, -14), V2(10, 14), 8, 5);
      b.setSpawn(V(0, PLAYER_Y, 10), 0);
      b.setGoal(V(0, 0, -10));
      b.fog = { color: 0x0e121a, near: 30, far: 110 };
      b.bounds.set(V(-11, 0, -15), V(11, 8, 15));
    },
  },
  {
    id: 'acid-moat',
    name: 'Acid Moat',
    hint: 'Acid is lethal. Ride the platform under the bulkhead, then use portals to get up onto the ledge.',
    blurb: 'Acid, a moving platform, and a ledge to earn.',
    build(b) {
      const min = V(-12, 0, -18);
      const max = V(12, 10, 18);
      b.level.room(min, max, { portalable: { north: true, south: true }, skip: ['floor'] });
      // Floors either side of the moat; their inner faces are the moat's walls.
      b.box(V(-12, -3, 6), V(12, 0, 18), { portalable: ['py'], faces: ['py', 'nz'] });
      b.box(V(-12, -3, -12), V(12, 0, -6), { portalable: ['py'], faces: ['py', 'pz'] });
      b.box(V(-12, -3, -6), V(12, -2.4, 6), { faces: ['py'] });
      // Close the moat's ends below the room walls.
      b.box(V(-13, -3, -6), V(-12, 0, 6), { faces: ['px'] });
      b.box(V(12, -3, -6), V(13, 0, 6), { faces: ['nx'] });
      // The exit ledge against the north wall.
      b.box(V(-12, -3, -18), V(12, 4, -12), { portalable: ['py'], faces: ['py', 'pz'] });
      b.acid(V2(-12, -6), V2(12, 6), -0.7);
      // A bulkhead hanging over the moat: the platform passes under it, but it hides the
      // wall above the ledge from the south side - the ledge has to be earned.
      b.box(V(-12, 2.3, -0.4), V(12, 10, 0.4), { material: 'metal', faces: ['pz', 'nz', 'ny'] });
      b.platform(V(3, 0.4, 3), V(-7, -0.2, 4.45), V(-7, -0.2, -4.45), 2.6, 1.6);
      b.ceilingLights(V2(-12, -18), V2(12, 18), 10, 6);
      b.setSpawn(V(0, PLAYER_Y, 15), 0);
      b.setGoal(V(0, 4, -15));
      b.killY = -2;
      b.fog = { color: 0x0b1410, near: 25, far: 110 };
      b.bounds.set(V(-13, -3, -19), V(13, 10, 19));
    },
  },
  {
    id: 'crusher-gallery',
    name: 'Crusher Gallery',
    hint: 'Time the crushers. Then relay the laser through your portals into the receiver to open the door.',
    blurb: 'Time the crushers, then bend a laser to open the door.',
    build(b) {
      const min = V(-6, 0, -30);
      const max = V(6, 8, 20);
      b.level.room(min, max, { portalable: { west: true, east: true, floor: false } });
      // Crusher corridor: solid blocks either side leave a 4 m lane.
      b.box(V(-6, 0, 2), V(-2, 8, 14), { faces: ['px', 'pz', 'nz'], portalable: ['nz'] });
      b.box(V(2, 0, 2), V(6, 8, 14), { faces: ['nx', 'pz', 'nz'], portalable: ['nz'] });
      b.crusher(0, 12.2, V2(3.8, 2.4), 0, 5, 1.8, 0);
      b.crusher(0, 8, V2(3.8, 2.4), 0, 5, 1.8, 1.4);
      b.crusher(0, 3.8, V2(3.8, 2.4), 0, 5, 1.8, 2.8);

      // The lock: a wall with a door, a laser firing back along the west side and a
      // receiver on the east side. Bend the beam round with a portal pair on the faces of
      // the corridor blocks - the target ring marks the spot opposite the receiver.
      b.box(V(-6, 0, -24.5), V(-2, 8, -23.5), { faces: ['pz', 'nz', 'px'] });
      b.box(V(2, 0, -24.5), V(6, 8, -23.5), { faces: ['pz', 'nz', 'nx'] });
      b.box(V(-2, 3.6, -24.5), V(2, 8, -23.5), { faces: ['pz', 'nz', 'ny'] });
      const receiver = b.receiver(V(4, 1.45, -23.2), V(0, 0, 1));
      b.door(V(-2, 0, -24.3), V(2, 3.6, -23.7), receiver);
      b.laser(V(-4, 1.45, -23.4), V(0, 0, 1));
      b.target(V(4, 1.45, 2), V(0, 0, -1));

      b.ceilingLights(V2(-6, -30), V2(6, 20), 8, 4);
      b.setSpawn(V(0, PLAYER_Y, 17.5), 0);
      b.setGoal(V(0, 0, -27.5));
      b.fog = { color: 0x120d0c, near: 25, far: 120 };
      b.bounds.set(V(-7, 0, -31), V(7, 8, 21));
    },
  },
  {
    id: 'proving-grounds',
    name: 'Proving Grounds',
    hint: 'The exit is on the pillar. Climb to the north gallery, put a portal on the pillar top and one on the floor below, then drop in.',
    blurb: 'Everything at once. The exit waits on top of the pillar.',
    build(b) {
      const min = V(-30, 0, -30);
      const max = V(30, 12, 30);
      b.level.room(min, max, { portalable: { north: true, south: true, west: true, east: true }, skip: ['floor'] });

      // Floor around a square acid pit, and the exit pillar standing in the middle.
      b.box(V(-30, -3, -30), V(30, 0, -11), { portalable: ['py'], faces: ['py', 'pz'] });
      b.box(V(-30, -3, 11), V(30, 0, 30), { portalable: ['py'], faces: ['py', 'nz'] });
      b.box(V(-30, -3, -11), V(-11, 0, 11), { portalable: ['py'], faces: ['py', 'px'] });
      b.box(V(11, -3, -11), V(30, 0, 11), { portalable: ['py'], faces: ['py', 'nx'] });
      b.box(V(-11, -3, -11), V(11, -2.4, 11), { faces: ['py'] });
      b.box(V(-5, -3, -5), V(5, 7, 5), { portalable: ['py'], faces: ['py', 'px', 'nx', 'pz', 'nz'] });
      b.acid(V2(-11, -11), V2(11, 11), -0.6);

      // North gallery (tier 3), reached by stairs along the north wall with a crusher on
      // the landing halfway up.
      b.box(V(-10, 0, -30), V(10, 7.5, -23), { faces: ['py', 'pz', 'px', 'nx'], portalable: ['py'] });
      b.stairs(V(-26, 0, -28), V(1, 0, 0), 3.5, 6, 4);
      b.box(V(-20, 0, -30), V(-15, 3.5, -26), { faces: ['py', 'pz'] });
      b.stairs(V(-15, 3.5, -28), V(1, 0, 0), 4, 5, 4);
      b.box(V(-15, 0, -30), V(-10, 3.5, -26), { faces: ['pz'] });
      b.crusher(-17.5, -28, V2(4.4, 3.8), 3.5, 8.5, 2.2, 0);

      // Cover blocks in the south half.
      b.box(V(-18, 0, 16), V(-15, 2, 19), { material: 'metal' });
      b.box(V(14, 0, 14), V(17, 3, 17), { material: 'metal' });
      b.box(V(-4, 0, 20), V(-1, 1.5, 23), { material: 'metal' });

      // A tripwire across the gallery (jump it, or bend it away with a portal), a laser
      // sweeping the east floor, and crates dropping beside the west approach.
      b.laser(V(9.6, 8.2, -26.5), V(-1, 0, 0));
      b.laser(V(20, 1.1, 29.3), V(0, 0, -1), { axis: V(0, 1, 0), angle: 0.3, period: 6 });
      b.dropper(V(-20, 11.2, 8), 12);
      b.dropper(V(-21, 11.2, -12), 12);

      b.ceilingLights(V2(-30, -30), V2(30, 30), 12, 8);
      b.setSpawn(V(0, PLAYER_Y, 26), Math.PI * 0.12);
      b.setGoal(V(2.2, 7, 2.2));
      b.killY = -2;
      b.fog = { color: 0x0b0f16, near: 35, far: 150 };
      b.bounds.set(V(-31, -3, -31), V(31, 12, 31));
    },
  },
  mapToArena(catapult as MapData),
];

/**
 * The PvP arena, scored as a match (see game/Match.ts) - playable solo for now: there are
 * no opponents or networking yet. Built from a map file (see maps/MapFormat.ts).
 */
export const PVP_ARENA: ArenaDef = mapToArena(highwire as MapData);

/**
 * Debug chamber for the scripted portal tests: plain portalable box with the same
 * coordinates the scenarios were written against (walls at x = -60 and z = -60, floor at
 * 0, ceiling at 9, a platform and stairs against the north wall).
 */
export const TEST_ARENA: ArenaDef = {
  id: 'test',
  name: 'Portal Test Chamber',
  hint: 'Debug chamber for the scripted portal tests.',
  build(b) {
    const min = V(-60, 0, -60);
    const max = V(20, 9, 0);
    b.level.room(min, max, { portalable: { floor: true, ceiling: true, north: true, south: true, west: true, east: true } });
    b.box(V(-12, 1.95, -60), V(12, 2.4, -52), { portalable: ['py'], faces: ['py', 'ny', 'pz', 'px', 'nx'] });
    b.stairs(V(0, 0, -43), V(0, 0, -1), 2.4, 9, 4);
    b.ceilingLights(V2(-60, -60), V2(20, 0), 9, 10);
    b.prop(V(10, 0.42, -10));
    b.setSpawn(V(-50, PLAYER_Y, -10), 0);
    b.fog = { color: 0x0b0e14, near: 40, far: 170 };
    b.bounds.set(V(-61, 0, -61), V(21, 9, 1));
  },
};
