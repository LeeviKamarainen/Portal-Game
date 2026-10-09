/**
 * Little binary writer and reader for the per-tick messages (inputs, snapshots): plain
 * DataView, little-endian, no schema. Lobby and control messages stay JSON.
 */

export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 0;

  constructor(capacity = 512) {
    this.buf = new ArrayBuffer(capacity);
    this.view = new DataView(this.buf);
  }

  get length(): number {
    return this.pos;
  }

  private room(n: number): void {
    if (this.pos + n <= this.buf.byteLength) return;
    const next = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.pos + n));
    new Uint8Array(next).set(new Uint8Array(this.buf, 0, this.pos));
    this.buf = next;
    this.view = new DataView(next);
  }

  u8(v: number): this {
    this.room(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
    return this;
  }

  i8(v: number): this {
    this.room(1);
    this.view.setInt8(this.pos, clamp(Math.round(v), -128, 127));
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    this.room(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.room(2);
    this.view.setInt16(this.pos, clamp(Math.round(v), -32768, 32767), true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.room(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  f32(v: number): this {
    this.room(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
    return this;
  }

  f64(v: number): this {
    this.room(8);
    this.view.setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  /** Bytes written elsewhere, as they are. */
  raw(bytes: Uint8Array): this {
    this.room(bytes.length);
    new Uint8Array(this.buf, this.pos, bytes.length).set(bytes);
    this.pos += bytes.length;
    return this;
  }

  /** Overwrites a u16 written earlier (a count only known once the items are written). */
  patchU16(at: number, v: number): void {
    this.view.setUint16(at, v, true);
  }

  /** A copy of what has been written. */
  bytes(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.buf.slice(0, this.pos));
  }
}

/** Reads what ByteWriter wrote; reading past the end throws (a short or forged message). */
export class ByteReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view = data instanceof Uint8Array ? new DataView(data.buffer, data.byteOffset, data.byteLength) : new DataView(data);
  }

  get remaining(): number {
    return this.view.byteLength - this.pos;
  }

  get offset(): number {
    return this.pos;
  }

  private need(n: number): number {
    if (this.pos + n > this.view.byteLength) throw new RangeError('message too short');
    const at = this.pos;
    this.pos += n;
    return at;
  }

  u8(): number {
    return this.view.getUint8(this.need(1));
  }

  i8(): number {
    return this.view.getInt8(this.need(1));
  }

  u16(): number {
    return this.view.getUint16(this.need(2), true);
  }

  i16(): number {
    return this.view.getInt16(this.need(2), true);
  }

  u32(): number {
    return this.view.getUint32(this.need(4), true);
  }

  f32(): number {
    return this.view.getFloat32(this.need(4), true);
  }

  f64(): number {
    return this.view.getFloat64(this.need(8), true);
  }

  skip(n: number): void {
    this.need(n);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Sequence numbers wrap at 16 bits: whether `a` comes after `b`. */
export function seqNewer(a: number, b: number): boolean {
  const d = (a - b) & 0xffff;
  return d !== 0 && d < 0x8000;
}

/** How far `a` is after `b` (negative if before), across the wrap. */
export function seqDiff(a: number, b: number): number {
  const d = (a - b) & 0xffff;
  return d < 0x8000 ? d : d - 0x10000;
}
