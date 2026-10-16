import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TOKEN_TTL_MS,
  MAX_TOKEN_TTL_MS,
  MAX_FUTURE_SKEW_MS,
  checkTokenTimes,
  mintToken,
  parseKeyring,
  verifyToken,
  type Keyring,
} from '../../src/qr/token.js';

const K1 = 'A'.repeat(43); // 32 bytes of zero, base64url
const K2 = 'B'.repeat(43);
const K3 = 'C'.repeat(43);
const SESSION = '0b1f4c5e-9d3a-4f7e-8a21-5c6d7e8f9a0b';
const OTHER_SESSION = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NOW = 1_800_000_000_000;

const ring = (spec: string, active: string): Keyring => parseKeyring(spec, active);
const k1 = ring(`k1:${K1}`, 'k1');

/** Re-implementation of the signing spec, used to build tokens a correct signer would never emit. */
function forge(
  r: Keyring,
  opts: {
    kid?: string;
    version?: number;
    lifetimeMs?: number;
    domain?: string;
    prefix?: string;
  } = {},
): string {
  const kid = opts.kid ?? r.activeKid;
  const payload = Buffer.alloc(49);
  payload.writeUInt8(opts.version ?? 1, 0);
  Buffer.from(SESSION.replaceAll('-', ''), 'hex').copy(payload, 1);
  Buffer.alloc(16, 7).copy(payload, 17);
  payload.writeBigUInt64BE(BigInt(NOW), 33);
  payload.writeBigUInt64BE(BigInt(NOW + (opts.lifetimeMs ?? DEFAULT_TOKEN_TTL_MS)), 41);
  const mac = createHmac('sha256', r.keys.get(kid)!)
    .update(opts.domain ?? 'scanin-qr-v1')
    .update('\0')
    .update(kid)
    .update('\0')
    .update(payload)
    .digest();
  return `${opts.prefix ?? 'ST1'}.${kid}.${payload.toString('base64url')}.${mac.toString('base64url')}`;
}

describe('QR-01 token format, signature and version', () => {
  it('mints a token that verifies and carries session, issue time, expiry, key id and a random id', () => {
    const m = mintToken(k1, SESSION, NOW);
    const v = verifyToken(k1, m.token);
    expect(v).toEqual({
      ok: true,
      payload: {
        kid: 'k1',
        sessionId: SESSION,
        jti: m.jti,
        issuedAtMs: NOW,
        expiresAtMs: NOW + 15_000,
      },
    });
    expect(m.jti).toMatch(/^[0-9a-f]{32}$/);
    expect(m.token.startsWith('ST1.k1.')).toBe(true);
  });

  it('has a short default lifetime, honours a caller-supplied one, and stays compact', () => {
    expect(DEFAULT_TOKEN_TTL_MS).toBe(15_000);
    const m = mintToken(k1, SESSION, NOW);
    expect(m.expiresAtMs - m.issuedAtMs).toBe(15_000);
    const custom = mintToken(k1, SESSION, NOW, 20_000);
    expect(custom.expiresAtMs - custom.issuedAtMs).toBe(20_000);
    expect(m.token.length).toBeLessThan(130); // small QR code, easy to scan from the back of a room
  });

  it('gives every mint a fresh random id', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => mintToken(k1, SESSION, NOW).jti));
    expect(ids.size).toBe(2000);
  });

  it('rejects any single-character change anywhere in the token', () => {
    const { token } = mintToken(k1, SESSION, NOW);
    for (let i = 0; i < token.length; i++) {
      const original = token[i]!;
      const replacement = original === 'A' ? 'B' : 'A';
      const tampered = token.slice(0, i) + replacement + token.slice(i + 1);
      const r = verifyToken(k1, tampered);
      expect(r.ok, `position ${i}`).toBe(false);
    }
  });

  it('rejects a payload swapped between two valid tokens (cannot move a signature to another session)', () => {
    const a = mintToken(k1, SESSION, NOW).token.split('.');
    const b = mintToken(k1, OTHER_SESSION, NOW).token.split('.');
    const spliced = [a[0], a[1], b[2], a[3]].join('.');
    expect(verifyToken(k1, spliced)).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects tokens signed with a different key (another environment) or an unknown key id', () => {
    const other = ring(`k1:${K2}`, 'k1');
    expect(verifyToken(k1, mintToken(other, SESSION, NOW).token)).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    const stranger = ring(`zz:${K2}`, 'zz');
    expect(verifyToken(k1, mintToken(stranger, SESSION, NOW).token)).toEqual({
      ok: false,
      reason: 'UNKNOWN_KEY',
    });
  });

  it('binds the key id into the signature: relabelling a token with another valid key id fails', () => {
    const both = ring(`k1:${K1},k2:${K2}`, 'k1');
    const parts = mintToken(both, SESSION, NOW).token.split('.');
    parts[1] = 'k2';
    expect(verifyToken(both, parts.join('.'))).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('rejects other format versions and a signature made without the domain separator', () => {
    expect(verifyToken(k1, forge(k1, { prefix: 'ST2' }))).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_VERSION',
    });
    expect(verifyToken(k1, forge(k1, { prefix: 'XYZ' }))).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
    expect(verifyToken(k1, forge(k1, { domain: 'some-other-protocol' }))).toEqual({
      ok: false,
      reason: 'BAD_SIGNATURE',
    });
    // Correctly signed, but our own invariants are violated:
    expect(verifyToken(k1, forge(k1, { version: 2 }))).toEqual({
      ok: false,
      reason: 'UNSUPPORTED_VERSION',
    });
    // A lifetime past the sanity cap could only be our own bug; a plausible non-default one is fine.
    expect(verifyToken(k1, forge(k1, { lifetimeMs: MAX_TOKEN_TTL_MS + 1 }))).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
    expect(verifyToken(k1, forge(k1, { lifetimeMs: 0 }))).toEqual({
      ok: false,
      reason: 'MALFORMED',
    });
    expect(verifyToken(k1, forge(k1, { lifetimeMs: 30_000 }))).toMatchObject({ ok: true });
    expect(verifyToken(k1, forge(k1))).toMatchObject({ ok: true }); // the forge itself is faithful
  });

  it.each([
    ['empty', ''],
    ['one part', 'ST1'],
    ['three parts', 'ST1.k1.abc'],
    ['five parts', 'ST1.k1.a.b.c'],
    ['bad key id', 'ST1.k 1.AAAA.BBBB'],
    ['not base64', 'ST1.k1.!!!!.????'],
    ['wrong lengths', 'ST1.k1.AAAA.BBBB'],
    ['oversized', `ST1.k1.${'A'.repeat(500)}.${'B'.repeat(43)}`],
    ['whitespace', ' ST1.k1.AAAA.BBBB '],
  ])('treats %s as malformed without throwing', (_label, token) => {
    expect(verifyToken(k1, token)).toEqual({
      ok: false,
      reason: expect.stringMatching(/MALFORMED|UNKNOWN_KEY|UNSUPPORTED_VERSION/),
    });
  });

  it('never throws on non-string input', () => {
    for (const bad of [undefined, null, 42, {}, [], Symbol.iterator]) {
      expect(verifyToken(k1, bad as unknown as string)).toEqual({ ok: false, reason: 'MALFORMED' });
    }
  });
});

describe('QR-02 the lifetime is enforced from issue and expiry times', () => {
  const payload = { issuedAtMs: NOW, expiresAtMs: NOW + 15_000 };

  it('is valid from issue until just before expiry, and expired at expiry (no grace)', () => {
    expect(checkTokenTimes(payload, NOW, null)).toBe('OK');
    expect(checkTokenTimes(payload, NOW + 14_999, null)).toBe('OK');
    expect(checkTokenTimes(payload, NOW + 15_000, null)).toBe('EXPIRED');
    expect(checkTokenTimes(payload, NOW + 15_001, null)).toBe('EXPIRED');
    expect(checkTokenTimes(payload, NOW + 24 * 3_600_000, null)).toBe('EXPIRED');
  });

  it('with one window of grace, the immediately previous code is still accepted', () => {
    const grace = 15_000; // one token lifetime, as check-in passes
    expect(checkTokenTimes(payload, NOW + 15_000, null, grace)).toBe('OK'); // just past its own expiry
    expect(checkTokenTimes(payload, NOW + 29_999, null, grace)).toBe('OK');
    expect(checkTokenTimes(payload, NOW + 30_000, null, grace)).toBe('EXPIRED'); // two windows is the cap
  });

  it('rejects a token issued implausibly far in the future, but tolerates a few seconds', () => {
    expect(checkTokenTimes(payload, NOW - MAX_FUTURE_SKEW_MS, null)).toBe('OK');
    expect(checkTokenTimes(payload, NOW - MAX_FUTURE_SKEW_MS - 1, null)).toBe('NOT_YET_VALID');
  });

  it('at a 15s refresh, the current code and the one before it are accepted (two windows)', () => {
    const refreshMs = 15_000;
    const grace = 15_000;
    const issued = Array.from({ length: 10 }, (_, i) => ({
      issuedAtMs: NOW + i * refreshMs,
      expiresAtMs: NOW + i * refreshMs + 15_000,
    }));
    const now = NOW + 9 * refreshMs;
    const valid = issued.filter((p) => checkTokenTimes(p, now, null, grace) === 'OK');
    expect(valid).toHaveLength(2); // the code on screen now, plus the one immediately before it
  });
});

describe('QR-07 invalidating issued codes (token side)', () => {
  const payload = { issuedAtMs: NOW, expiresAtMs: NOW + 15_000 };

  it('rejects codes issued before the mark and accepts codes issued at or after it', () => {
    expect(checkTokenTimes(payload, NOW + 1000, NOW - 500)).toBe('OK'); // mark set before it was issued
    expect(checkTokenTimes(payload, NOW + 1000, NOW)).toBe('OK');
    expect(checkTokenTimes(payload, NOW + 1000, NOW + 1)).toBe('REVOKED');
    expect(checkTokenTimes(payload, NOW + 1000, NOW + 90_000)).toBe('REVOKED');
  });

  it('reports expiry before revocation when both apply', () => {
    expect(checkTokenTimes(payload, NOW + 200_000, NOW + 90_000)).toBe('EXPIRED');
  });
});

describe('QR-03 a token is not consumed by being used', () => {
  it('verifies identically for any number of different holders', () => {
    const m = mintToken(k1, SESSION, NOW);
    for (let student = 0; student < 1000; student++) {
      const r = verifyToken(k1, m.token);
      expect(r.ok).toBe(true);
      expect(
        checkTokenTimes(
          (r as { payload: { issuedAtMs: number; expiresAtMs: number } }).payload,
          NOW + 5_000,
          null,
        ),
      ).toBe('OK');
    }
  });
});

describe('QR-06 key rotation', () => {
  it('keeps old codes valid while the old key is verify-only, then stops them when it is removed', () => {
    const before = ring(`k1:${K1}`, 'k1');
    const old = mintToken(before, SESSION, NOW);

    const during = ring(`k1:${K1},k2:${K2}`, 'k2'); // k2 now signs; k1 still verifies
    expect(verifyToken(during, old.token)).toMatchObject({ ok: true, payload: { kid: 'k1' } });
    const fresh = mintToken(during, SESSION, NOW + 1000);
    expect(fresh.kid).toBe('k2');
    expect(verifyToken(during, fresh.token)).toMatchObject({ ok: true, payload: { kid: 'k2' } });

    const after = ring(`k2:${K2}`, 'k2'); // k1 retired
    expect(verifyToken(after, old.token)).toEqual({ ok: false, reason: 'UNKNOWN_KEY' });
    expect(verifyToken(after, fresh.token)).toMatchObject({ ok: true });
  });

  it('does not accept tokens signed by a key that has not been introduced yet', () => {
    const next = mintToken(ring(`k2:${K2}`, 'k2'), SESSION, NOW);
    expect(verifyToken(k1, next.token)).toEqual({ ok: false, reason: 'UNKNOWN_KEY' });
  });

  it('supports emergency revocation: removing a key kills every code it signed', () => {
    const both = ring(`k1:${K1},k3:${K3}`, 'k3');
    const compromised = mintToken(both, SESSION, NOW);
    expect(verifyToken(both, compromised.token).ok).toBe(true);
    expect(verifyToken(ring(`k1:${K1}`, 'k1'), compromised.token).ok).toBe(false);
  });

  it('validates the key configuration without ever echoing key material', () => {
    const secret = 'SECRETSHORTKEYMATERIAL';
    const bad: Array<[string, string, string]> = [
      ['', 'k1', 'No QR signing keys'],
      [`k1:${secret}`, 'k1', 'at least 32 bytes'],
      [`k1:${K1},k1:${K2}`, 'k1', 'listed twice'],
      [`k 1:${K1}`, 'k 1', 'key id is invalid'],
      [`k1:${K1}`, 'k9', 'not among'],
      ['k1', 'k1', 'at least 32 bytes'],
    ];
    for (const [spec, active, expected] of bad) {
      let message = '';
      try {
        parseKeyring(spec, active);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, spec).toContain(expected);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(K1);
    }
  });
});
