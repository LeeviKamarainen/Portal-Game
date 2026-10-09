/**
 * Runs `checkGenerated` off the main thread. Building a map headless takes 10-100 ms, and the
 * game server's 60 Hz loop has about 16 ms a tick, so a generation's checks must not run on
 * the thread that steps the rooms. `checkPool.ts` starts this file as a worker.
 */
import { parentPort } from 'node:worker_threads';
import type { MapData } from '../../src/world/maps/MapFormat';
import { checkGenerated } from './check';

if (!parentPort) throw new Error('checkWorker.ts is a worker: start it through checkPool.ts');
const port = parentPort;

port.on('message', async (msg: { id: number; map: MapData }) => {
  try {
    port.postMessage({ id: msg.id, ok: true, result: await checkGenerated(msg.map) });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
});
