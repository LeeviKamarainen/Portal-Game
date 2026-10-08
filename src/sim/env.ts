/**
 * Where the simulation is running. Headless (the game server, Node tests) means no DOM: no
 * canvases for procedural textures, and nothing that only exists to be looked at needs to
 * be built in detail. The sim still builds three.js meshes - portal shots raycast against
 * them - just with plain materials.
 */
export const simEnv = {
  headless: typeof document === 'undefined',
};
