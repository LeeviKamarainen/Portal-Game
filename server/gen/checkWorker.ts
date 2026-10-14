/**
 * Runs the map checks off the main thread. Building a map headless takes 10-100 ms (the route
 * analysis a few hundred), and the game server's 60 Hz loop has about 16 ms a tick, so a
 * generation's checks must not run on the thread that steps the rooms. `checkPool.ts` starts
 * this file as a worker.
 */
import { parentPort } from 'node:worker_threads';
import type { MapData } from '../../src/world/maps/MapFormat';
import { checkGenerated, type CheckOptions } from './check';
import { playtest, type PlayStep } from './playtest';
import { analyzeRoutes } from './routes';

if (!parentPort) throw new Error('checkWorker.ts is a worker: start it through checkPool.ts');
const port = parentPort;

type Request =
  | { id: number; kind?: 'check'; map: MapData; options?: CheckOptions }
  | { id: number; kind: 'routes'; map: MapData }
  | { id: number; kind: 'playtest'; map: MapData; steps: PlayStep[] };

port.on('message', async (msg: Request) => {
  try {
    const result = msg.kind === 'routes' ? await analyzeRoutes(msg.map) : msg.kind === 'playtest' ? await playtest(msg.map, msg.steps) : await checkGenerated(msg.map, msg.options);
    port.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    port.postMessage({ id: msg.id, ok: false, error: (e as Error).message });
  }
});
