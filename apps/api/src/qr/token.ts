import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Signed QR tokens. Stateless: nothing is stored when one is issued, and a token is never
 * "consumed" (many students scan the same code). Uniqueness of attendance comes from the database,
 * not from the token. A valid token proves only that someone saw a recent code; it does not prove
 * who is holding the phone.
 *
 *   token   = "ST1" "." kid "." b64url(payload) "." b64url(mac)
 *   payload = version(1) | session id(16) | jti(16, random) | issued-at ms(8) | expires-at ms(8)
 *   mac     = HMAC-SHA256(key[kid], "scanin-qr-v1" 0x00 kid 0x00 payload)
 *
 * All times are database-clock milliseconds supplied by the caller; this module never reads a clock.
 */
/**
 * How long a freshly minted code is "current". Configurable (QR_TOKEN_TTL_SECONDS); short by design
 * so a code relayed to someone outside the room is useful for seconds, not minutes. The projector
 * mints a new code every TTL, and check-in also accepts the immediately previous window (see
 * `checkTokenTimes`), so a slow upload that straddles a rotation still succeeds.
 */
export const DEFAULT_TOKEN_TTL_MS = 15_000;
/** A sanity bound on a signed token's lifetime, to catch our own mistakes (not a security control). */
export const MAX_TOKEN_TTL_MS = 600_000;
/** Tolerated "issued in the future" gap, guarding against clock oddities. */
export const MAX_FUTURE_SKEW_MS = 5_000;

const PREFIX = 'ST1';
const DOMAIN = 'scanin-qr-v1';
const FORMAT_VERSION = 1;
const PAYLOAD_LENGTH = 1 + 16 + 16 + 8 + 8;
const MAC_LENGTH = 32;
const MAX_TOKEN_CHARS = 200;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;
const MIN_KEY_BYTES = 32;

export interface Keyring {
  /** Signs new tokens. */
  activeKid: string;
  /** Every key that may verify tokens: the active one plus older, verify-only ones. */
  keys: ReadonlyMap<string, Buffer>;
}

/**
 * Parses "kid:base64url,kid2:base64url" plus the active key id. Error messages name key ids only,
 * never key material.
 */
export function parseKeyring(spec: string, activeKid: string): Keyring {
  const keys = new Map<string, Buffer>();
  for (const entry of spec
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const colon = entry.indexOf(':');
    const kid = colon < 0 ? entry : entry.slice(0, colon);
    if (!KID_PATTERN.test(kid))
      throw new Error('QR key id is invalid (use 1-16 of A-Z a-z 0-9 _ -)');
    if (keys.has(kid)) throw new Error(`QR key id "${kid}" is listed twice`);
    const key = Buffer.from(colon < 0 ? '' : entry.slice(colon + 1), 'base64url');
    if (key.length < MIN_KEY_BYTES)
      throw new Error(`QR key "${kid}" must be at least ${MIN_KEY_BYTES} bytes`);
    keys.set(kid, key);
  }
  if (keys.size === 0) throw new Error('No QR signing keys configured');
  if (!keys.has(activeKid))
    throw new Error(`Active QR key "${activeKid}" is not among the configured keys`);
  return { activeKid, keys };
}

const sessionIdToBytes = (id: string): Buffer => Buffer.from(id.replaceAll('-', ''), 'hex');
function bytesToSessionId(b: Buffer): string {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function macFor(key: Buffer, kid: string, payload: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(DOMAIN)
    .update('\0')
    .update(kid)
    .update('\0')
    .update(payload)
    .digest();
}

export interface TokenPayload {
  kid: string;
  sessionId: string;
  /** 128-bit random id, hex. Recorded with scans; never a secret by itself. */
  jti: string;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface MintedToken extends TokenPayload {
  token: string;
}

export function mintToken(
  ring: Keyring,
  sessionId: string,
  nowMs: number,
  ttlMs: number = DEFAULT_TOKEN_TTL_MS,
): MintedToken {
  const key = ring.keys.get(ring.activeKid);
  if (!key) throw new Error('active QR key missing');
  const jti = randomBytes(16);
  const payload = Buffer.alloc(PAYLOAD_LENGTH);
  payload.writeUInt8(FORMAT_VERSION, 0);
  sessionIdToBytes(sessionId).copy(payload, 1);
  jti.copy(payload, 17);
  payload.writeBigUInt64BE(BigInt(nowMs), 33);
  payload.writeBigUInt64BE(BigInt(nowMs + ttlMs), 41);
  const mac = macFor(key, ring.activeKid, payload);
  return {
    token: `${PREFIX}.${ring.activeKid}.${payload.toString('base64url')}.${mac.toString('base64url')}`,
    kid: ring.activeKid,
    sessionId,
    jti: jti.toString('hex'),
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + ttlMs,
  };
}

export type VerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: 'MALFORMED' | 'UNSUPPORTED_VERSION' | 'UNKNOWN_KEY' | 'BAD_SIGNATURE' };

const fail = (reason: Extract<VerifyResult, { ok: false }>['reason']): VerifyResult => ({
  ok: false,
  reason,
});

/**
 * Checks format, key id and signature ONLY. It says nothing about time, revocation or whether the
 * session is open: those are decided separately, against the database, at check-in.
 */
export function verifyToken(ring: Keyring, token: string): VerifyResult {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_CHARS)
    return fail('MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 4) return fail('MALFORMED');
  const [prefix, kid, payloadB64, macB64] = parts as [string, string, string, string];

  if (prefix !== PREFIX) return fail(/^ST\d+$/.test(prefix) ? 'UNSUPPORTED_VERSION' : 'MALFORMED');
  if (!KID_PATTERN.test(kid)) return fail('MALFORMED');
  const key = ring.keys.get(kid);
  if (!key) return fail('UNKNOWN_KEY');

  const payload = Buffer.from(payloadB64, 'base64url');
  const mac = Buffer.from(macB64, 'base64url');
  // Reject non-canonical encodings so one token has exactly one textual form.
  if (payload.length !== PAYLOAD_LENGTH || payload.toString('base64url') !== payloadB64)
    return fail('MALFORMED');
  if (mac.length !== MAC_LENGTH || mac.toString('base64url') !== macB64) return fail('MALFORMED');

  const expected = macFor(key, kid, payload);
  if (!timingSafeEqual(expected, mac)) return fail('BAD_SIGNATURE');

  // Authentic from here on; these checks guard against our own future mistakes.
  if (payload.readUInt8(0) !== FORMAT_VERSION) return fail('UNSUPPORTED_VERSION');
  const issuedAtMs = Number(payload.readBigUInt64BE(33));
  const expiresAtMs = Number(payload.readBigUInt64BE(41));
  // The lifetime is configurable, so we no longer fix it; we only reject a non-positive or
  // implausibly long one, which could only come from our own bug (the MAC already verified).
  const lifetimeMs = expiresAtMs - issuedAtMs;
  if (lifetimeMs <= 0 || lifetimeMs > MAX_TOKEN_TTL_MS) return fail('MALFORMED');

  return {
    ok: true,
    payload: {
      kid,
      sessionId: bytesToSessionId(payload.subarray(1, 17)),
      jti: payload.subarray(17, 33).toString('hex'),
      issuedAtMs,
      expiresAtMs,
    },
  };
}

export type TimeCheck = 'OK' | 'NOT_YET_VALID' | 'EXPIRED' | 'REVOKED';

/**
 * Valid while issued-at <= now < expires-at + grace, and not issued before the session's
 * `qr_not_before` mark (set when a lecturer invalidates issued codes). `nowMs` must be the
 * database clock.
 *
 * `graceMs` extends acceptance past expiry so that the code one window older than the one on screen
 * is still accepted: a student who scanned just as the projector rotated, or whose upload was slow,
 * still gets in. Callers pass one token lifetime, so the effective acceptance is two windows
 * (the current code plus the immediately previous one) and no more. Revocation still wins: a code
 * issued before the mark is `REVOKED` even inside the grace window.
 */
export function checkTokenTimes(
  payload: Pick<TokenPayload, 'issuedAtMs' | 'expiresAtMs'>,
  nowMs: number,
  qrNotBeforeMs: number | null,
  graceMs = 0,
): TimeCheck {
  if (payload.issuedAtMs > nowMs + MAX_FUTURE_SKEW_MS) return 'NOT_YET_VALID';
  if (nowMs >= payload.expiresAtMs + graceMs) return 'EXPIRED';
  if (qrNotBeforeMs !== null && payload.issuedAtMs < qrNotBeforeMs) return 'REVOKED';
  return 'OK';
}
