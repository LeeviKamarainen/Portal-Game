import { ByteReader, ByteWriter } from './codec';
import { clearCommand, emptyCommand, type PlayerCommand } from '../player/PlayerCommand';

/** First byte of every binary message. */
export const BIN_INPUT = 1;
export const BIN_SNAPSHOT = 2;

/** Each input message repeats this many of the latest commands, so one lost or late message costs nothing. */
export const INPUT_REDUNDANCY = 4;
/** One step's look change can't be more than this (a hard flick is ~0.5 rad a step). */
const MAX_LOOK_STEP = Math.PI;

const JUMP = 1;
const IMMUNITY = 2;
const FIRE_ORANGE = 4;
const FIRE_BLUE = 8;

export interface SeqCommand {
  seq: number;
  cmd: PlayerCommand;
}

/**
 * The command as the server will see it: move axes in 1/127 steps and look changes in
 * 32-bit floats. The client plays its own copy of the command with exactly these values,
 * so its prediction and the server agree to the bit.
 */
export function quantizeCommand(cmd: PlayerCommand): PlayerCommand {
  cmd.forward = Math.round(clampAxis(cmd.forward) * 127) / 127;
  cmd.right = Math.round(clampAxis(cmd.right) * 127) / 127;
  cmd.yaw = Math.fround(clampLook(cmd.yaw));
  cmd.pitch = Math.fround(clampLook(cmd.pitch));
  return cmd;
}

/** The latest commands (oldest first, the last one numbered `commands[n-1].seq`). */
export function writeInput(commands: readonly SeqCommand[]): Uint8Array<ArrayBuffer> {
  const w = new ByteWriter(8 + commands.length * 11);
  w.u8(BIN_INPUT).u16(commands[commands.length - 1].seq).u8(commands.length);
  for (const { cmd } of commands) {
    const flags = (cmd.jump ? JUMP : 0) | (cmd.immunity ? IMMUNITY : 0) | (cmd.fire === 'orange' ? FIRE_ORANGE : cmd.fire === 'blue' ? FIRE_BLUE : 0);
    w.i8(cmd.forward * 127).i8(cmd.right * 127).u8(flags).f32(cmd.yaw).f32(cmd.pitch);
  }
  return w.bytes();
}

/** An input message, checked (it comes from a client): commands oldest first, or null if malformed. */
export function readInput(data: Uint8Array): SeqCommand[] | null {
  try {
    const r = new ByteReader(data);
    if (r.u8() !== BIN_INPUT) return null;
    const last = r.u16();
    const n = r.u8();
    if (n < 1 || n > INPUT_REDUNDANCY * 2) return null;
    const out: SeqCommand[] = [];
    for (let i = 0; i < n; i++) {
      const cmd = clearCommand(emptyCommand());
      cmd.forward = clampAxis(r.i8() / 127);
      cmd.right = clampAxis(r.i8() / 127);
      const flags = r.u8();
      cmd.jump = (flags & JUMP) !== 0;
      cmd.immunity = (flags & IMMUNITY) !== 0;
      cmd.fire = flags & FIRE_ORANGE ? 'orange' : flags & FIRE_BLUE ? 'blue' : null;
      cmd.yaw = Math.fround(clampLook(r.f32()));
      cmd.pitch = Math.fround(clampLook(r.f32()));
      out.push({ seq: (last - (n - 1 - i)) & 0xffff, cmd });
    }
    return r.remaining === 0 ? out : null;
  } catch {
    return null;
  }
}

function clampAxis(v: number): number {
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}

function clampLook(v: number): number {
  return Number.isFinite(v) ? Math.max(-MAX_LOOK_STEP, Math.min(MAX_LOOK_STEP, v)) : 0;
}

export function copyCommand(from: PlayerCommand, to: PlayerCommand): PlayerCommand {
  to.forward = from.forward;
  to.right = from.right;
  to.jump = from.jump;
  to.immunity = from.immunity;
  to.yaw = from.yaw;
  to.pitch = from.pitch;
  to.fire = from.fire;
  return to;
}
