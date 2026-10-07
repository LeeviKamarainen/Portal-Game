import type { Game } from '../game/Game';
import { formatResults, runPortalTests, showResultsOverlay, type ScenarioResult } from './PortalTests';
import { makeGameAdapter } from './gameAdapter';

declare global {
  interface Window {
    __testResults?: { suite: string; text: string; results: unknown; done: boolean };
  }
}

/** Runs a scripted suite with the render loop paused, then reports and resumes. */
export async function runTestSuite(game: Game, suite: string, container: HTMLElement): Promise<void> {
  window.__testResults = { suite, text: '', results: null, done: false };
  // Suites that script the PvP opponent themselves want it to stand still unless told.
  game.opponentBrain = suite === 'bots' || suite === 'brain' ? 'bot' : 'idle';
  game.loop.stop();
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 30; i++) game.step(1 / 60);

  let text = '';
  let results: unknown = null;
  if (suite === 'portals') {
    const adapter = makeGameAdapter(game);
    const r: ScenarioResult[] = runPortalTests(adapter);
    text = formatResults(adapter.label, r);
    results = r;
  } else if (suite === 'arenas') {
    const { runArenaPlaythroughs } = await import('./ArenaPlaythroughs');
    const r = await runArenaPlaythroughs(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'hazards') {
    const { runHazardTests } = await import('./HazardTests');
    const r = await runHazardTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'scoring') {
    const { runScoringTests } = await import('./ScoringTests');
    const r = await runScoringTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'players') {
    const { runPlayerTests } = await import('./PlayerTests');
    const r = await runPlayerTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'brain') {
    const { runBrainTests } = await import('./BrainTests');
    const r = await runBrainTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'nav') {
    const { runNavTests } = await import('./NavTests');
    const r = await runNavTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'bots') {
    const { runBotTests } = await import('./BotTests');
    const r = await runBotTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'sim') {
    const { runSimTests } = await import('./SimTests');
    const r = await runSimTests(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'balance') {
    const { runBalance } = await import('./SimTests');
    const r = await runBalance(game);
    text = r.text;
    results = r.results;
  } else if (suite === 'perf') {
    const { runPerf } = await import('./Perf');
    const r = await runPerf(game);
    text = r.text;
    results = r.results;
  } else {
    text = `Unknown test suite "${suite}"`;
  }

  console.log(text);
  showResultsOverlay(container, text);
  window.__testResults = { suite, text, results, done: true };
  game.input.setScriptedKeys(null);
  game.loop.start();
}
