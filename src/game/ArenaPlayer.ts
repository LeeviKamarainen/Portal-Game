import type { PlayerController } from '../player/PlayerController';
import type { PlayerAvatar } from '../player/PlayerAvatar';
import type { PortalGunModel } from '../player/PortalGunModel';
import type { Portal, PortalColor } from '../portals/Portal';
import type { PortalGun } from '../portals/PortalGun';

/** Who joins an arena, and who steers them. */
export interface PlayerSetup {
  id: string;
  name: string;
}

/**
 * One player in an arena - the local player or an opponent - with everything that is
 * theirs: body, portal pair (in their colours), portal gun, and match state.
 */
export class ArenaPlayer {
  readonly id: string;
  name: string;
  /** Join order: picks the colour palette and the spawn point. */
  readonly slot: number;
  /** The one the camera, HUD and keyboard belong to. */
  readonly local: boolean;
  readonly controller: PlayerController;
  readonly portals: Record<PortalColor, Portal>;
  readonly gun: PortalGun;
  readonly palette: Readonly<Record<PortalColor, number>>;
  /** Third-person body (opponents; the local one belongs to Game) and the gun in its hand. */
  avatar: PlayerAvatar | null = null;
  gunModel: PortalGunModel | null = null;
  dead = false;
  /** Seconds since dying (opponents come back on their own after a delay). */
  deadFor = 0;
  /**
   * Driven by a bot even in the local slot (bot-vs-bot simulations): fires through its
   * command and respawns on its own, like an opponent.
   */
  autopilot = false;
  /** The last object (beam, crate) to hurt them and who it is credited to. */
  lastHit: { by: string | null; time: number } | null = null;

  constructor(o: {
    setup: PlayerSetup;
    slot: number;
    local: boolean;
    controller: PlayerController;
    portals: Record<PortalColor, Portal>;
    gun: PortalGun;
    palette: Readonly<Record<PortalColor, number>>;
  }) {
    this.id = o.setup.id;
    this.name = o.setup.name;
    this.slot = o.slot;
    this.local = o.local;
    this.controller = o.controller;
    this.portals = o.portals;
    this.gun = o.gun;
    this.palette = o.palette;
  }
}
