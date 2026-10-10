/**
 * The Catapult chamber (src/world/maps/catapult.json) and the pieces it is built from -
 * glass, jump pads, floor buttons, a switch-released cube - played headless by a script:
 * the whole solution, start to exit, with nothing but a player's own commands.
 *
 *   npm run test:server
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MapData } from '../../src/world/maps/MapFormat';
import { FaithPlate } from '../../src/world/hazards/FaithPlate';
import { FloorButton } from '../../src/world/hazards/FloorButton';
import { Dropper } from '../../src/world/hazards/Dropper';
import { Door } from '../../src/world/hazards/Door';
import { Switch } from '../../src/world/hazards/Switch';
import catapult from '../../src/world/maps/catapult.json';
import { DT, V, hazards, scripted } from './scripted';

test('Catapult: the whole chamber, solved by script', async () => {
  const g = await scripted(catapult as MapData);
  const { sim, body } = g;
  try {
    const [plateA, plateR] = hazards(sim, FaithPlate);
    const [button] = hazards(sim, FloorButton);
    const [hatch] = hazards(sim, Dropper);
    const [door] = hazards(sim, Door);
    const swtch = hazards(sim, Switch)[0];
    assert.ok(plateA && plateR && button && hatch && door && swtch, 'the chamber is missing a piece');
    const cube = hatch.box;
    assert.equal(button.powered, false);

    // The hatch holds its cube until the switch is shot - from across the pit.
    assert.ok(cube.getPosition().y > 12, 'the cube hangs in its hatch');
    g.idle(1);
    assert.ok(cube.getPosition().y > 12, 'the hatch lets nothing go by itself');
    g.shoot('orange', V(8, 8, -21.9));
    g.idle(3.5);
    const rest = cube.getPosition();
    assert.ok(Math.abs(rest.y - 5.4) < 0.15, `the cube came to rest on the far platform (y ${rest.y.toFixed(2)})`);
    assert.ok(Math.abs(rest.x - 8) < 1 && Math.abs(rest.z + 14) < 1.5, `…under its hatch (${rest.x.toFixed(1)}, ${rest.z.toFixed(1)})`);

    // The jump pad throws you over the acid to the far platform.
    g.walk(-11, 11.4, 0.4, 12, () => !body.isGrounded);
    assert.ok(!body.isGrounded, 'the jump pad threw you');
    for (let i = 0; i < 6 / DT && !(body.isGrounded && body.getPosition().z < -5); i++) g.stepTo(null);
    const landed = body.getPosition();
    console.log(`  flight landed at (${landed.x.toFixed(2)}, ${landed.y.toFixed(2)}, ${landed.z.toFixed(2)}), thrown ${plateA.flightTime.toFixed(2)} s`);
    assert.ok(!g.me.dead, 'survived the flight');
    assert.equal(body.health.value, body.health.max, 'a jump pad lands softly');
    assert.ok(Math.hypot(landed.x + 11, landed.z + 12) < 1.5, `landed on the marker (${landed.x.toFixed(2)}, ${landed.z.toFixed(2)})`);
    assert.ok(Math.abs(landed.y - 5 - 1) < 0.2, `…on the far platform (y ${landed.y.toFixed(2)})`);

    // From up here you can shoot over the glass: a portal on the cell's back wall, one on the floor.
    g.idle(0.3);
    g.shoot('blue', V(10, 2.4, 19.9));
    assert.ok(g.me.portals.blue.placed, 'portal on the cell wall');
    g.shoot('orange', V(8, 5, -9.5));
    assert.ok(g.me.portals.orange.placed, 'portal on the platform floor');

    // Shoving the cube into the floor portal drops it into the cell, onto the button.
    // (Walk behind it, in line with the opening, and shove; let go as it tips in, and brake.)
    const hole = V(8, 5, -9.5);
    let shoved = false;
    for (let t = 0; t < 25 && cube.getPosition().z < 10; t += DT) {
      const me = body.getPosition();
      const at = cube.getPosition();
      const along = at.clone().sub(hole).setY(0).normalize();
      const behind = at.clone().addScaledVector(along, 1.2);
      const lateral = Math.abs((me.x - at.x) * along.z - (me.z - at.z) * along.x);
      const inLine = lateral < 0.2 && me.distanceTo(at) < 1.6;
      if (inLine) {
        shoved = true;
        // Past the near edge of the opening the cube goes in by itself.
        const tipping = at.z > hole.z - 0.8;
        g.commands.next.forward = tipping ? -1 : 1;
        g.stepTo(V(at.x, me.y, at.z));
      } else if (me.distanceTo(behind) > 0.3) {
        g.commands.next.forward = 1;
        g.stepTo(V(behind.x, me.y, behind.z));
      } else {
        g.commands.next.forward = 0;
        g.stepTo(V(at.x, me.y, at.z));
      }
    }
    assert.ok(shoved, 'got behind the cube');
    g.commands.next.forward = 0;
    g.idle(0.5);
    for (let t = 0; t < 8 && !button.powered; t += DT) g.stepTo(null);
    const c = cube.getPosition();
    console.log(`  cube at (${c.x.toFixed(2)}, ${c.y.toFixed(2)}, ${c.z.toFixed(2)}), button ${button.powered ? 'down' : 'up'}`);
    assert.ok(button.powered, 'the cube is on the button');
    g.idle(1.5);
    assert.ok(door.isOpen, 'the exit door is open');

    // The second pad throws you back to the near ledge; the way out is open.
    g.me.portals.orange.unplace();
    g.me.portals.blue.unplace();
    // (Keys are let go once airborne: holding W against the throw would steer you back.)
    assert.ok(body.getPosition().y > 5, 'still up on the far platform');
    g.walk(-11, -19, 0.4, 25, () => !body.isGrounded);
    assert.ok(!body.isGrounded, 'the return pad threw you');
    for (let i = 0; i < 6 / DT && !(body.isGrounded && body.getPosition().z > 5); i++) g.stepTo(null);
    const back = body.getPosition();
    console.log(`  return flight landed at (${back.x.toFixed(2)}, ${back.y.toFixed(2)}, ${back.z.toFixed(2)})`);
    assert.ok(Math.hypot(back.x + 9, back.z - 16) < 1.5, 'landed on the near ledge');
    assert.equal(body.health.value, body.health.max, 'the return flight lands softly too');
    assert.ok(g.walk(-6, 23.5, 0.8, 15, () => g.events.includes('goal')), 'walks through the door');
    g.idle(0.2);
    assert.ok(g.events.includes('goal'), 'reached the exit');
  } finally {
    sim.dispose();
  }
});
