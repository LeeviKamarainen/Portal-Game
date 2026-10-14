/**
 * The map check worker (docs/llm-map-generation-plan.md): checks run off the main thread, in a
 * worker with a capped heap, and the pool keeps answering through many checks.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_IN_MAPS } from '../../src/editor/templates';
import { CheckWorker, WORKER_LIMITS } from '../gen/checkPool';

test('the worker has a heap cap that fits the small production machine', () => {
  assert.ok(WORKER_LIMITS.maxOldGenerationSizeMb <= 160);
  assert.ok(WORKER_LIMITS.maxOldGenerationSizeMb >= 64, 'a map check peaks around 40 MB live');
});

test('a worker with the cap checks many maps, and a broken map is a problem list, not a crash', async () => {
  const logs: string[] = [];
  const pool = new CheckWorker((l) => logs.push(l));
  const map = BUILT_IN_MAPS[0].data();
  try {
    for (let i = 0; i < 12; i++) {
      const r = await pool.check(structuredClone(map));
      assert.equal(r.ok, true, `check ${i}: ${r.problems.join(' | ')}`);
    }
    const bad = await pool.check({ ...map, pieces: [{ type: 'block', at: [0, 0, 0], size: [2, 2, 2] }] });
    assert.equal(bad.ok, false);
    assert.ok(bad.problems.length > 0);
    assert.deepEqual(logs, [], 'the worker started without falling back to the main thread');
  } finally {
    await pool.dispose();
  }
});
