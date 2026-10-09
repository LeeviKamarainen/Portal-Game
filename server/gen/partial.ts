import type { MapKind, Piece } from '../../src/world/maps/MapFormat';
import { WireMapSchema, WirePieceSchema, pieceFromWire } from './wire';

/**
 * Reads a map out of the model's answer while it is still being written, so the editor can
 * show the level growing piece by piece. The answer is the JSON of `WireMapSchema`, whose
 * fields come in schema order with `pieces` last, so the header is complete by the time the
 * first piece starts, and each piece is a complete `{...}` once its closing brace arrives.
 *
 * `feed` takes the whole text so far (the SDK's snapshot) and returns only what is new. It
 * never throws: anything it cannot make sense of is skipped here, and the final, complete
 * answer is parsed and checked by the graph as usual.
 */

export interface MapHead {
  name: string;
  kind: MapKind;
  symmetry: 'none' | 'rotate180';
  fog: { color: string; near: number; far: number };
  killY: number;
}

export type PartialEvent =
  | { type: 'start'; head: MapHead }
  | { type: 'piece'; index: number; piece: Piece };

const PIECES_KEY = /"pieces"\s*:\s*\[/;

export class PartialMapReader {
  private started = false;
  private done = false;
  private index = 0;
  // Scanner state, kept between feeds so the total work is linear in the text.
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private objectStart = -1;

  feed(text: string): PartialEvent[] {
    const out: PartialEvent[] = [];
    if (this.done) return out;
    if (!this.started) {
      const m = PIECES_KEY.exec(text);
      if (!m) return out;
      this.started = true;
      this.pos = m.index + m[0].length;
      const head = this.headOf(text.slice(0, m.index));
      if (head) out.push({ type: 'start', head });
      else {
        // Without a readable header there is nothing to show; the final parse will say why.
        this.done = true;
        return out;
      }
    }
    for (; this.pos < text.length; this.pos++) {
      const c = text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === '{') {
        if (this.depth === 0) this.objectStart = this.pos;
        this.depth++;
      } else if (c === '}') {
        this.depth--;
        if (this.depth === 0) {
          const piece = this.pieceOf(text.slice(this.objectStart, this.pos + 1));
          if (piece) out.push({ type: 'piece', index: this.index, piece });
          this.index++;
        }
      } else if (c === ']' && this.depth === 0) {
        this.done = true;
        break;
      }
    }
    return out;
  }

  private headOf(prefix: string): MapHead | null {
    try {
      const raw = JSON.parse(prefix.replace(/,\s*$/, '') + '}');
      const head = WireMapSchema.omit({ pieces: true }).parse(raw);
      return { name: head.name, kind: head.kind, symmetry: head.symmetry, fog: { color: head.fogColor, near: head.fogNear, far: head.fogFar }, killY: head.killY };
    } catch {
      return null;
    }
  }

  private pieceOf(text: string): Piece | null {
    try {
      const wire = WirePieceSchema.parse(JSON.parse(text));
      return pieceFromWire(wire, this.index).piece;
    } catch {
      return null;
    }
  }
}
