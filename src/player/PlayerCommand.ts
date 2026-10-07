import type { InputManager } from '../core/InputManager';
import type { PortalColor } from '../portals/Portal';

/** Look radians per mouse pixel, before the settings' sensitivity. */
export const MOUSE_SENSITIVITY = 0.0025;
const IMMUNITY_KEY = 'ShiftLeft';

/**
 * What a player wants to do this step. Keyboard and mouse fill one in for the local
 * player and a bot fills one in for itself; either way the body obeys the same rules
 * (speed, jump, turn), so a bot can't do anything a person couldn't.
 */
export interface PlayerCommand {
  /** Wish direction in the player's own frame, each -1..1. */
  forward: number;
  right: number;
  jump: boolean;
  immunity: boolean;
  /** Look change this step in radians: yaw to the left, pitch up. */
  yaw: number;
  pitch: number;
  /** Portal to shoot this step (bots; the local player's shots go through Game). */
  fire: PortalColor | null;
}

export interface CommandSource {
  /** Fills in this step's command (every field); `dt` is the step length. */
  read(cmd: PlayerCommand, dt: number): void;
}

export function emptyCommand(): PlayerCommand {
  return { forward: 0, right: 0, jump: false, immunity: false, yaw: 0, pitch: 0, fire: null };
}

export function clearCommand(cmd: PlayerCommand): PlayerCommand {
  cmd.forward = cmd.right = cmd.yaw = cmd.pitch = 0;
  cmd.jump = cmd.immunity = false;
  cmd.fire = null;
  return cmd;
}

/** The local player: WASD, Space, Shift and the mouse. */
export class KeyboardCommands implements CommandSource {
  private readonly input: InputManager;

  constructor(input: InputManager) {
    this.input = input;
  }

  read(cmd: PlayerCommand): void {
    const input = this.input;
    clearCommand(cmd);
    const d = input.consumeMouseDelta();
    cmd.yaw = -d.x * MOUSE_SENSITIVITY;
    cmd.pitch = -d.y * MOUSE_SENSITIVITY;
    cmd.forward = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0);
    cmd.right = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0);
    cmd.jump = input.isDown('Space');
    cmd.immunity = input.isDown(IMMUNITY_KEY);
  }
}

/** Stands still and does nothing: the dummy opponent. */
export class IdleCommands implements CommandSource {
  read(cmd: PlayerCommand): void {
    clearCommand(cmd);
  }
}
