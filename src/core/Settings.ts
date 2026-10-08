import { FLAGS, type Quality } from './Flags';

/**
 * Player options from the settings menu, kept in localStorage. Test runs ignore anything
 * stored so their results never depend on what someone picked in the menu. Sound is not
 * stored: it follows the mute flag on every start (see Flags).
 */

export type QualitySetting = Quality;
export type ShadowSetting = 'off' | 'low' | 'high';

export interface Settings {
  /** Character from the Blocky Characters pack, a-r. */
  skin: string;
  quality: QualitySetting;
  shadows: ShadowSetting;
  /** Multipliers on the tuned defaults (1 = as designed). */
  brightness: number;
  ambient: number;
  glow: number;
  /** Vertical field of view in degrees. */
  fov: number;
  sensitivity: number;
  invertY: boolean;
  /** The PvP bots' difficulty, and how many of them (everyone for themselves). */
  botDifficulty: BotDifficultySetting;
  botCount: number;
}

export type BotDifficultySetting = 'easy' | 'normal' | 'hard';

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  skin: 'a',
  quality: 'auto',
  shadows: 'high',
  brightness: 1,
  ambient: 1,
  glow: 1,
  fov: 90,
  sensitivity: 1,
  invertY: false,
  botDifficulty: 'normal',
  botCount: 1,
};

/** Most bots in one match (with you, one per spawn pad on Highwire). */
export const MAX_BOTS = 3;

export const SKINS = 'abcdefghijklmnopqr'.split('');

const SETTINGS_KEY = 'portal-arena.settings';
const PROGRESS_KEY = 'portal-arena.progress';

function read(key: string): unknown {
  if (FLAGS.test) return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  if (FLAGS.test) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private window, previews): settings just last for this visit.
  }
}

const clamp = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;

function oneOf<T extends string>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

export function loadSettings(): Settings {
  const s = (read(SETTINGS_KEY) ?? {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    skin: oneOf(s.skin, SKINS, d.skin),
    quality: oneOf(s.quality, ['auto', 'low', 'medium', 'high'] as const, d.quality),
    shadows: oneOf(s.shadows, ['off', 'low', 'high'] as const, d.shadows),
    brightness: clamp(s.brightness, 0.5, 1.5, d.brightness),
    ambient: clamp(s.ambient, 0, 2, d.ambient),
    glow: clamp(s.glow, 0, 2, d.glow),
    fov: clamp(s.fov, 60, 100, d.fov),
    sensitivity: clamp(s.sensitivity, 0.2, 3, d.sensitivity),
    invertY: typeof s.invertY === 'boolean' ? s.invertY : d.invertY,
    botDifficulty: oneOf(s.botDifficulty, ['easy', 'normal', 'hard'] as const, d.botDifficulty),
    botCount: Math.round(clamp(s.botCount, 1, MAX_BOTS, d.botCount)),
  };
}

export function saveSettings(s: Settings): void {
  write(SETTINGS_KEY, s);
}

/** Ids of the tutorial arenas the player has finished. */
export function loadProgress(): Set<string> {
  const v = read(PROGRESS_KEY);
  return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
}

export function saveProgress(done: Set<string>): void {
  write(PROGRESS_KEY, [...done]);
}
