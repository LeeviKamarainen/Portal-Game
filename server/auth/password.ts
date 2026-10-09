import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt cost: ~50 ms and 16 MB a hash, on the thread pool so the 60 Hz loop never waits for it. */
const N = 16384;
const R = 8;
const P = 1;
const KEY_BYTES = 32;

export { PASSWORD_MAX, PASSWORD_MIN, passwordProblem } from '../../src/net/accounts';

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((done, fail) => {
    scrypt(password, salt, KEY_BYTES, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? fail(err) : done(key)));
  });
}

/** `scrypt$N$r$p$salt$hash` - the cost travels with the hash, so it can be raised later without locking anyone out. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || n > 1 << 20 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, Buffer.from(parts[4], 'base64'), n, r, p);
  return timingSafeEqual(actual, expected);
}

/** A hash nobody has the password for: checked when the name is unknown, so a miss takes as long as a hit. */
let decoy: Promise<string> | null = null;
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'));
  return decoy;
}

/** A random password for the admin tool to hand out (16 characters). */
export function generatePassword(): string {
  return randomBytes(12).toString('base64url');
}
