import bcrypt from 'bcrypt';
import { config } from '../../config.js';

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, config.PASSWORD_SALT_ROUNDS);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A real bcrypt hash of a value nothing can supply, used to give the "no such user" branch of login
 * the same cost as the "wrong password" branch.
 *
 * Without it, an unknown email returns 401 immediately while a known one first pays for
 * `bcrypt.compare` — tens of milliseconds, trivially measurable, and enough to turn login into an
 * email-enumeration oracle. Built lazily and once: hashing at module load would add a salt-round's
 * delay to startup for a value most requests never need.
 */
let dummyHash: Promise<string> | null = null;

/**
 * Burns the same work `comparePassword` would, then reports `false`.
 *
 * The comparison itself is genuine, so the cost tracks `PASSWORD_SALT_ROUNDS` automatically — a
 * hardcoded `setTimeout` would drift the moment that setting changed.
 */
export async function comparePasswordAgainstDummy(password: string): Promise<false> {
  dummyHash ??= bcrypt.hash('pix3-nonexistent-user-placeholder', config.PASSWORD_SALT_ROUNDS);
  await bcrypt.compare(password, await dummyHash);
  return false;
}
