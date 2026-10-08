/**
 * Start-up switches, read once from the URL.
 *
 *   ?mute=1 / ?mute=0   force audio off / on. Without it, dev builds start muted (so test
 *                       and dev runs are silent) and production builds start with sound.
 *   ?arena=N            start at arena N (1-based) or `test` for the portal test chamber.
 *   ?test=portals       run the scripted portal-travel tests (implies the test chamber).
 *   ?test=arenas        run the scripted playthrough of every arena.
 *   ?test=hazards       check every hazard does what its tell promises, and respawn time.
 *   ?test=scoring       check the PvP win conditions: point orbs, no-portal zones, kill credit.
 *   ?test=players       check more than one player per arena: the PvP opponent, its portals, hazards.
 *   ?test=bots          check bots play fair: what they can see and hear, how fast they turn.
 *   ?test=nav           check bots find their way: the navigation graph, walking, jumps, crushers.
 *   ?test=brain         check the bot plays: orbs, exploring, escaping, dodging, portal traps, a match.
 *   ?test=sim           bot-vs-bot matches, 1 v 1 and free-for-all: everyone scores, nobody stuck, traps,
 *                       steals and drop-ins, fair play.
 *   ?test=balance       win rates by bot difficulty: 50 bot-vs-bot matches per pairing (&n= to change).
 *   ?test=perf          measure GPU/CPU frame time per arena with timer queries.
 *                       (Results show in an overlay and in window.__testResults.)
 *   ?quality=auto|low|medium|high   override the quality chosen in the settings menu.
 *   ?editor=1           open the map editor straight away.
 *   (Without ?arena, ?editor or ?test the game opens on the main menu.)
 *   ?fps=1              show the frame-time readout (always on in dev builds).
 *   ?arena=pvp          start straight in the PvP arena.
 *   ?debug=nav          draw the bots' navigation graph (green floor points; grey walk, blue
 *                       drop and yellow jump links; orange/yellow points: hazard / edge cost).
 *   ?debug=bots         draw what each bot knows and plans: view cone, route, remembered
 *                       enemies (red seen, yellow heard), known orbs, aim point, goal label.
 */
const params = new URLSearchParams(location.search);

function readMuted(): boolean {
  const v = params.get('mute');
  if (v !== null) return v !== '0' && v !== 'false';
  return import.meta.env.DEV;
}

export type Quality = 'auto' | 'low' | 'medium' | 'high';

/** Null when the URL does not say: the settings menu decides. */
function readQuality(): Quality | null {
  const q = params.get('quality');
  return q === 'auto' || q === 'low' || q === 'medium' || q === 'high' ? q : null;
}

export const FLAGS = {
  muted: readMuted(),
  test: params.get('test'),
  arena: params.get('arena'),
  editor: params.has('editor'),
  quality: readQuality(),
  showFps: params.has('fps') || import.meta.env.DEV,
  debug: params.get('debug'),
};
