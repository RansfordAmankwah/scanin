import { createHash, createHmac, randomBytes } from 'node:crypto';

export function sha256(value: string | Buffer): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Unguessable URL-safe token (256 bits by default). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Keyed, truncated hash for values we want to correlate but not store (IP addresses, student IDs
 * in security events). Different labels give unrelated outputs.
 */
export function keyedHash(secret: string, label: string, value: string): Buffer {
  return createHmac('sha256', secret)
    .update(label)
    .update('\0')
    .update(value)
    .digest()
    .subarray(0, 16);
}
