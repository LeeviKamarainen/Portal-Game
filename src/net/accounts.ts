/**
 * What the game page and the server agree on about accounts and saved maps: the names of
 * roles, rights and visibilities, the limits, the checks on what a person types (so the page
 * can say "too short" before asking), and the shapes the /api/... endpoints return.
 */
import { NAME_MAX } from './protocol';

export const ROLES = ['user', 'admin'] as const;
export type Role = (typeof ROLES)[number];

/**
 * What a user may do beyond playing and saving maps. Admins have every right; give a plain
 * user one to let them in on it (the AI map generator costs money, so it is opt-in).
 */
export const RIGHTS = ['generate-maps'] as const;
export type Right = (typeof RIGHTS)[number];

export const VISIBILITIES = ['private', 'unlisted', 'public'] as const;
/** Private: the owner only. Unlisted: anyone with the id. Public: also in the shared list. */
export type Visibility = (typeof VISIBILITIES)[number];

export const USER_NAME_MIN = 3;
export const USER_NAME_MAX = NAME_MAX;
export const MAP_NAME_MAX = 40;
/** Saved maps one user may keep (the generator will make plenty). */
export const MAPS_PER_USER = 50;
export const PASSWORD_MIN = 8;
/** scrypt takes whatever it is given, so the length is capped before anyone can send megabytes. */
export const PASSWORD_MAX = 128;

/** Why `name` can't be an account name, or null if it can. */
export function userNameProblem(name: string): string | null {
  if (name.length < USER_NAME_MIN || name.length > USER_NAME_MAX) {
    return `Names are ${USER_NAME_MIN}-${USER_NAME_MAX} characters.`;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return 'Names use letters, digits, - and _ only.';
  return null;
}

/** Why `password` is not acceptable for a new password, or null. */
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < PASSWORD_MIN) return `Passwords are at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Passwords are at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function hasRight(user: { role: Role; rights: readonly Right[] }, right: Right): boolean {
  return user.role === 'admin' || user.rights.includes(right);
}

/** The logged-in user as /api/me and the login calls describe them. */
export interface PublicUser {
  id: number;
  name: string;
  role: Role;
  /** What the user may do: all of them for an admin. */
  rights: Right[];
}

/** A saved map in a list: everything but the map itself. */
export interface MapSummary {
  id: string;
  ownerId: number;
  ownerName: string;
  name: string;
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
}

/** What /api/maps/:id returns: the listing plus the map file. */
export interface MapListing extends MapSummary {
  data: unknown;
}
