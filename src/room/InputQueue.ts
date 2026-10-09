import { clearCommand, type CommandSource, type PlayerCommand } from '../player/PlayerCommand';
import { copyCommand, type SeqCommand } from '../net/commands';
import { seqNewer } from '../net/codec';

/**
 * Commands waiting beyond this (two thirds of a second's worth) are dropped, oldest first.
 * Only one is used a step whatever arrives, so sending more never moves anyone faster; the
 * cap keeps a client that runs ahead from building up lag. It is roomy because commands
 * come in bursts after a hold-up on the connection, and every dropped one is a misprediction.
 */
const MAX_QUEUED = 40;

/**
 * A player waits this many steps (half a second) for a late command before the match goes
 * on without them.
 */
const MAX_HOLD = 30;

/**
 * A human player's commands on the server, as they arrive over the network: one used per
 * step, in order. When the next one is late (a hold-up on the connection) the player holds
 * still until it comes, so the commands play out exactly as that player's screen predicted
 * them, just a little later. After MAX_HOLD steps without one (the tab is hidden, the
 * connection is gone) they stand idle instead: no move, turn or shot.
 */
export class InputQueue implements CommandSource {
  /** Waiting commands, in order (one that arrives late is slotted into its place). */
  private readonly queue: SeqCommand[] = [];
  /** Commands have started arriving, and been used. */
  private started = false;
  private used = false;
  /** The number of the command used on the latest step that had one. */
  executed = 0;
  /** Steps since the last real command (0: the latest step used one). */
  idle = 0;
  /** Commands dropped for arriving too many at once. */
  dropped = 0;
  /** Steps that had no command to use, once commands had started coming. */
  starved = 0;
  /** Steps held waiting for the next command (they don't count as idle). */
  held = 0;
  /** The player's connection is gone (they have a while to come back): held still and out of reach until then. */
  paused = false;
  private holding = 0;

  /** Waiting commands, for the client's clock sync. */
  get queued(): number {
    return this.queue.length;
  }

  /**
   * Whether this step can go ahead: the next command in order is here, or the wait for it
   * is over (then on with whatever is next, or idle).
   */
  ready(): boolean {
    if (this.paused) return false;
    const head = this.queue[0];
    if ((head && (!this.used || head.seq === ((this.executed + 1) & 0xffff))) || this.holding >= MAX_HOLD) return true;
    this.holding++;
    this.held++;
    return false;
  }

  /** The commands of one input message, oldest first (each message repeats the last few). */
  push(commands: readonly SeqCommand[]): void {
    for (const c of commands) {
      if (this.used && !seqNewer(c.seq, this.executed)) continue;
      let i = this.queue.length;
      while (i > 0 && seqNewer(this.queue[i - 1].seq, c.seq)) i--;
      if (this.queue[i - 1]?.seq === c.seq) continue;
      this.queue.splice(i, 0, c);
    }
    this.started = true;
    while (this.queue.length > MAX_QUEUED) {
      const lost = this.queue.shift()!;
      this.executed = lost.seq;
      this.used = true;
      this.dropped++;
    }
  }

  read(cmd: PlayerCommand): void {
    const next = this.queue.shift();
    if (next) {
      this.executed = next.seq;
      this.used = true;
      this.idle = 0;
      this.holding = 0;
      copyCommand(next.cmd, cmd);
      return;
    }
    // Waited long enough: on without them, standing idle.
    this.idle++;
    if (this.started) this.starved++;
    clearCommand(cmd);
  }
}
