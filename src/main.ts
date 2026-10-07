import { FLAGS } from './core/Flags';
import { Game } from './game/Game';
import { ARENAS } from './world/arenas';

async function main(): Promise<void> {
  const container = document.querySelector<HTMLDivElement>('#app')!;
  const game = new Game(container);
  (window as unknown as { __game: unknown }).__game = game;

  // ?arena=, ?editor and the test suites skip the main menu.
  const start =
    FLAGS.test === 'portals' || FLAGS.arena === 'test'
      ? -1
      : FLAGS.editor
        ? 'editor'
        : FLAGS.arena === 'pvp'
          ? 'pvp'
          : FLAGS.arena === null && !FLAGS.test
          ? 'menu'
          : Math.min(ARENAS.length - 1, Math.max(0, parseInt(FLAGS.arena ?? '1', 10) - 1 || 0));
  await game.init(start);

  if (FLAGS.test) {
    const { runTestSuite } = await import('./debug/runTests');
    await runTestSuite(game, FLAGS.test, container);
  }
}

main().catch((err) => {
  console.error(err);
});
