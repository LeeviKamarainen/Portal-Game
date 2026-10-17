/**
 * What the game page and the server agree on about the speedrun leaderboards: the shapes
 * /api/leaderboard returns, and the check on a submitted run (so the page can skip sending
 * a run the server would refuse). The boards are for the built-in courses (`SPEEDRUNS`);
 * one entry per player and course - their best run.
 */

/** Shortest run the server believes: no course gets finished faster than this. */
export const RUN_TIME_MIN = 3;
/** A run longer than this is not a record worth keeping (and keeps the number sane). */
export const RUN_TIME_MAX = 3600;
/** Entries one request returns. */
export const BOARD_PAGE = 50;

/** One course as the boards know it. */
export interface CourseInfo {
  /** The map's id (`slipstream`). */
  id: string;
  name: string;
  /** Checkpoints before the finish: a run has this many splits. */
  checkpoints: number;
}

/** A player's best run on a course. */
export interface BoardEntry {
  /** 1 = fastest; of equal times the earlier run ranks higher. */
  rank: number;
  userId: number;
  name: string;
  time: number;
  /** Run time at each checkpoint. */
  splits: number[];
  setAt: number;
}

/** GET /api/leaderboard/:course */
export interface BoardReply {
  course: CourseInfo;
  /** Runners with a time on this course. */
  total: number;
  entries: BoardEntry[];
  /** The logged-in player's own entry, wherever they rank (null: a guest, or no time yet). */
  you: BoardEntry | null;
}

/** POST /api/leaderboard/:course */
export interface SubmitReply {
  /** The run is now the player's best on the board (false: they have a faster one). */
  improved: boolean;
  /** The player's entry after this submission. */
  you: BoardEntry;
  total: number;
}

/** Why a run can't go on a course's board, or null if it can. */
export function runProblem(checkpoints: number, time: unknown, splits: unknown): string | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return 'The run has no time.';
  if (time < RUN_TIME_MIN || time > RUN_TIME_MAX) return `Run times are ${RUN_TIME_MIN}-${RUN_TIME_MAX} seconds.`;
  if (!Array.isArray(splits) || splits.length !== checkpoints) return `The run needs ${checkpoints} checkpoint splits.`;
  let last = 0;
  for (const s of splits) {
    if (typeof s !== 'number' || !Number.isFinite(s) || s < last || s > time) return 'The splits are out of order.';
    last = s;
  }
  return null;
}
