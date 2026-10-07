import RAPIER from '@dimforge/rapier3d-compat';

export type ColliderOwnerType =
  | 'player'
  | 'solid'
  | 'prop'
  | 'portal-tunnel'
  | 'hazard'
  | 'mover'
  | 'receiver'
  | 'door';

export interface ColliderOwner {
  type: ColliderOwnerType;
  ref: unknown;
}

let initialised = false;

export class PhysicsWorld {
  readonly world: RAPIER.World;
  readonly eventQueue: RAPIER.EventQueue;
  readonly owners = new Map<number, ColliderOwner>();
  /** Contact filtering (portal pass-through); see PortalSystem. */
  hooks: RAPIER.PhysicsHooks | undefined;

  private constructor(world: RAPIER.World) {
    this.world = world;
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  static async create(): Promise<PhysicsWorld> {
    if (!initialised) {
      await RAPIER.init();
      initialised = true;
    }
    const world = new RAPIER.World({ x: 0, y: -20, z: 0 });
    world.timestep = 1 / 60;
    return new PhysicsWorld(world);
  }

  registerOwner(colliderHandle: number, owner: ColliderOwner): void {
    this.owners.set(colliderHandle, owner);
  }

  getOwner(colliderHandle: number): ColliderOwner | undefined {
    return this.owners.get(colliderHandle);
  }

  step(): void {
    this.world.step(this.eventQueue, this.hooks);
  }

  dispose(): void {
    this.eventQueue.free();
    this.world.free();
  }
}
