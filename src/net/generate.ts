/**
 * What the game page and the server agree on about the map generator
 * (server/gen/, docs/llm-map-generation-plan.md): the request, the quota and the events a
 * generation streams. Types only, so the page never pulls the server's code in.
 */
import type { MapData, MapKind, Piece } from '../world/maps/MapFormat';

export const GEN_KINDS = ['auto', 'combat', 'puzzle'] as const;
export const GEN_SIZES = ['auto', 'small', 'medium', 'large'] as const;
export type GenKind = (typeof GEN_KINDS)[number];
export type GenSize = (typeof GEN_SIZES)[number];

/** The longest description the server takes. */
export const GEN_PROMPT_MAX = 500;
export const GEN_PROMPT_MIN = 3;

/** Body of POST /api/generate. `baseMap` makes it a refinement of that map instead of a new one. */
export interface GenStartRequest {
  prompt: string;
  kind?: GenKind;
  size?: GenSize;
  baseMap?: MapData;
}

/** GET /api/generate/quota: what this user may do today. */
export interface GenQuota {
  used: number;
  limit: number;
  /** The user has the `generate-maps` right. */
  allowed: boolean;
  /** The server has a model key configured. */
  enabled: boolean;
}

export type GenStep = 'brief' | 'draft' | 'check' | 'repair' | 'critique' | 'finalize';

/** The header of the map being written, before its pieces arrive. */
export interface MapHead {
  name: string;
  kind: MapKind;
  symmetry: 'none' | 'rotate180';
  fog: { color: string; near: number; far: number };
  killY: number;
}

export type GenStopReason = 'ok' | 'attempts' | 'budget';

export interface PublicOutcome {
  ok: boolean;
  /** The finished map, or when `ok` is false the closest the generator got. */
  map: MapData | null;
  problems: string[];
  notes: string[];
  fixes: string[];
  attempts: number;
  stoppedBy: GenStopReason;
  tokens: { input: number; output: number };
  /** List-price estimate in US dollars; the Anthropic Console has the real bill. */
  costUsd: number;
}

/** What a viewer is sent, in order. `start`, `piece` and `map` let the editor show the level being built. */
export type JobEvent =
  | { type: 'step'; node: GenStep; message: string; problems?: string[]; /** More lines under the message (the plan). */ detail?: string[] }
  | { type: 'start'; stage: 'draft' | 'repair'; head: MapHead }
  | { type: 'piece'; index: number; piece: Piece }
  | { type: 'map'; map: MapData; ok: boolean }
  | { type: 'done'; status: 'ok' | 'partial'; outcome: PublicOutcome }
  | { type: 'error'; status: 'failed' | 'cancelled'; code: string; message: string };

export const isTerminalEvent = (e: JobEvent): boolean => e.type === 'done' || e.type === 'error';
