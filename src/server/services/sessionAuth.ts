import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { env } from '../config/env.ts';

const scryptAsync = promisify(crypto.scrypt);
const TOKEN_PREFIX = 'obx.';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface SessionPayload {
  userId: number;
  uid: string;
  exp: number;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  if (!salt || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = (await scryptAsync(password, salt, 64)) as Buffer;
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function createSessionToken(userId: number, uid: string): string {
  const payload: SessionPayload = {
    userId,
    uid,
    exp: Date.now() + SESSION_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', env.sessionSecret)
    .update(encoded)
    .digest('base64url');
  return `${TOKEN_PREFIX}${encoded}.${sig}`;
}

export function isSessionToken(token: string): boolean {
  return token.startsWith(TOKEN_PREFIX);
}

export function verifySessionToken(
  token: string
): { userId: number; uid: string } | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const raw = token.slice(TOKEN_PREFIX.length);
  const parts = raw.split('.');
  if (parts.length !== 2) return null;

  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;

  const expectedSig = crypto
    .createHmac('sha256', env.sessionSecret)
    .update(encoded)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8')
    ) as SessionPayload;
    if (
      typeof parsed.userId !== 'number' ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.exp !== 'number' ||
      Date.now() > parsed.exp
    ) {
      return null;
    }
    return { userId: parsed.userId, uid: parsed.uid };
  } catch {
    return null;
  }
}
