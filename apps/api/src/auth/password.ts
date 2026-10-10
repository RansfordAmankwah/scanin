import { hash, verify } from '@node-rs/argon2';

// Argon2id is the library default. Parameters follow the OWASP minimum (19 MiB, 2 passes, 1 lane);
// raise memoryCost/timeCost after benchmarking on the production instance (target ~250 ms).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same CPU time as a real verification, so a login for an unknown account cannot be told
 * apart from a wrong password by response time.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password-used-only-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** Length-only policy (no composition rules). Returns an error code, or null if acceptable. */
export function checkPasswordPolicy(
  password: string,
): 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return 'PASSWORD_TOO_SHORT';
  if (length > PASSWORD_MAX_LENGTH) return 'PASSWORD_TOO_LONG';
  return null;
}
