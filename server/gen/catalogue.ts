import { PIECES, MAP_KINDS, FACE_NAMES, ROOM_SIDES, type FieldSpec, type MapData, type PieceSpec } from '../../src/world/maps/MapFormat';
import { PLAYER_HEIGHT, PLAYER_RADIUS } from '../../src/player/PlayerController';
import { MAP_PIECES_MAX } from '../../src/net/protocol';
import { toWire } from './wire';

/**
 * The static part of the generator's prompt: how maps are written, what the pieces are and
 * what the player can do. Built from `PIECES` and the game's own constants so it cannot drift
 * from the code, and kept byte-for-byte stable (no dates, no ordering that depends on a run)
 * because it is sent with `cache_control` and a changed byte means a cold cache.
 */

const kindHelp = (f: FieldSpec): string => {
  switch (f.kind) {
    case 'number': return 'number';
    case 'bool': return 'true|false';
    case 'select': return `one of ${(f.options ?? []).map((o) => (o === '' ? '(empty)' : o)).join('|')}`;
    case 'faces': return `faces list, any of ${FACE_NAMES.join(',')},sides,all`;
    case 'sides': return `room sides list, any of ${ROOM_SIDES.join(',')},walls`;
    case 'ids': return 'comma-separated ids';
    case 'vec3': return '"x,y,z"';
    case 'color': return '"#rrggbb"';
    default: return 'text';
  }
};

const fmtDefaults = (d: PieceSpec['defaults']): string =>
  d && Object.keys(d).length ? Object.entries(d).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join('; ') : 'none';

function pieceLine(type: string, s: PieceSpec): string {
  const turn = s.turn === 'quarter' ? 'rot in multiples of 90' : s.turn === 'free' ? 'any rot' : 'no rot (use 0)';
  const size = s.sizeLabels ? `size [${s.sizeLabels.join(', ')}]` : 'no size (use [])';
  // "hide" is left out on purpose: models used it on the undersides of floating blocks, which then show nothing from below.
  const params = (s.fields ?? []).filter((f) => f.key !== 'hide').map((f) => `${f.key} (${kindHelp(f)}${f.hint ? `; ${f.hint}` : ''})`).join('; ') || 'none';
  return [`- ${type} [${s.group}] ${s.help}`, `    ${size}; ${turn}; defaults: ${fmtDefaults(s.defaults)}`, `    params: ${params}`].join('\n');
}

export function buildCatalogue(): string {
  const groups = ['Structure', 'Hazards', 'Interactive', 'Markers'] as const;
  const pieces = groups
    .map((g) => `## ${g}\n` + Object.entries(PIECES).filter(([, s]) => s.group === g).map(([t, s]) => pieceLine(t, s)).join('\n'))
    .join('\n\n');
  const kinds = MAP_KINDS.map((k) => `- ${k.id}: ${k.help}`).join('\n');
  return `# Writing maps for the portal arena game

You design levels for a first-person portal-gun game. A level is a list of pieces from a fixed catalogue, each placed with a position, size and rotation. Reply only with the map in the requested structure.

## Units and axes
- All lengths are metres. y is up. x is east/west, z is north/south; at rotation 0 a piece's front faces -z (north), and rotation 90 faces -x (west). Rotation is in degrees, counter-clockwise seen from above.
- "at" is [x, y, z]. It is the bottom centre of the piece unless the piece says otherwise. "size" is [width across, height, depth along its front] in the piece's own frame.
- A piece's top surface is at at.y + size[1]. Stack pieces by matching those numbers exactly.
- Faces are named from the piece's own point of view: top, bottom, front, back, left, right; "sides" is the four upright faces and "all" is all six.
- Round positions and sizes to 0.5 m (thin walls and slabs to 0.1 m). Keep every piece inside the room.

## The player
- Height ${PLAYER_HEIGHT} m, radius ${PLAYER_RADIUS} m, standing jump about 2 m high and 6 m long, walking speed 7 m/s. Steps of 0.3 m or less are climbed automatically; anything taller needs stairs, a ramp of stairs, a portal, or a jump of at most 2 m.
- Falling more than about 4 m is harmless, long falls hurt, and falling below killY is fatal. Corridors need to be at least 1.5 m wide and 2.5 m high to walk through.
- A portal opening is 1.9 m wide and 2.9 m tall. Portals can only be placed on faces listed in a piece's "portal" parameter (and room walls listed in the room's "portal"). A level without enough portal surfaces is a level without portals; give every tier and every important wall some.

## Map kinds
${kinds}

## Map fields
- name: at most 40 characters. hint: how to play, one or two sentences. blurb: a short card line, at most 100 characters.
- kind: "combat" or "puzzle". symmetry: "rotate180" copies every piece that is not marked center with a half turn about x=0, z=0 (team colours swap, ids get a "~" suffix, references flip), so author one half and put anything on the centre line with center=true. Use symmetry for fair combat maps. Puzzles use "none".
- fogColor "#rrggbb", fogNear and fogFar in metres (for example "#0c1018", 45, 170). killY: anything falling below it dies (for example -2 with a pit, -6 otherwise).

## Structure of every map
1. First piece: a room shell. at = the centre of the floor, size = [width, height, depth]. Everything must fit inside it. Use portal=walls for portal walls. The room has its own floor at its y; leave "skip" out so it stays. Only a level that is islands over a void uses skip=floor, and then every place a player stands needs a block or floor piece under it.
2. Add a lights piece over the room (at the ceiling height) so the level is lit.
3. Spawns: type spawn with at on a solid floor, rot facing the action. A spawn's y must equal the top surface it stands on, exactly: the room's floor top is the room's own y (usually 0), and the top of a block or floor piece is its at.y + size[1]. A spawn whose y is lower than the top of a block it overlaps is buried and invalid, and one higher than the surface hangs in the air. Combat maps need at least 2 spawns after symmetry (a spawn that is not marked center doubles). Spawn at least 3 m apart, never inside a solid. Check the mirrored position of every spawn against the mirrored blocks.
4. A puzzle map needs exactly one goal piece (at = floor centre) and at least one spawn.
5. Hazards that can be set off by a switch need an id; the switch lists those ids in targets. Only spikes, trapdoor, crusher and ram can be targets. A door names a receiver id; a receiver is lit by a laser. A reference to an id that does not exist is an error.

## How a piece is written (the output structure)
Each piece has: type, at (3 numbers), size (3 numbers, or an empty list when the piece has no size), rot, center, and params, a list of {key, value} text pairs for the piece's own parameters. Values by parameter kind: numbers as "3.5"; lists as "top,sides"; booleans as "true" or "false"; vec3 as "x,y,z". Only list a parameter when you want something other than its default. Never invent parameter names.

# Piece catalogue (at most ${MAP_PIECES_MAX} pieces per map)

${pieces}
`;
}

/** A finished map as a worked example, in the output structure, one piece per line. */
export function renderExample(title: string, map: MapData): string {
  const w = toWire(map);
  const { pieces, ...head } = w;
  const lines = pieces.map((p) => '    ' + JSON.stringify(p));
  return `### Example: ${title}\n${JSON.stringify(head)}\npieces:\n${lines.join('\n')}\n`;
}
