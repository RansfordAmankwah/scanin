import { apiFetch } from './client';

export type Role = 'LECTURER' | 'STUDENT';

export interface CurrentUser {
  id: string;
  role: Role;
  fullName: string;
  emailVerified: boolean;
  /** The signed-in user's own e-mail and, for a student, student ID. */
  email: string;
  studentId: string | null;
}

export interface RegistrationInput {
  studentId: string;
  fullName: string;
  email: string;
  password: string;
}

export async function fetchMe(): Promise<CurrentUser | null> {
  const res = await apiFetch<{ user: CurrentUser }>('/auth/me');
  return res.ok && res.data ? res.data.user : null;
}

export type LoginOutcome =
  | { ok: true; user: CurrentUser }
  | {
      ok: false;
      reason: 'INVALID_CREDENTIALS' | 'RATE_LIMITED' | 'NETWORK' | 'ERROR';
      retryAfterSeconds?: number;
    };

export async function login(email: string, password: string): Promise<LoginOutcome> {
  try {
    const res = await apiFetch<{ user: CurrentUser }>('/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    if (res.ok && res.data) return { ok: true, user: res.data.user };
    if (res.status === 401) return { ok: false, reason: 'INVALID_CREDENTIALS' };
    if (res.status === 429) {
      return {
        ok: false,
        reason: 'RATE_LIMITED',
        ...(res.retryAfterSeconds ? { retryAfterSeconds: res.retryAfterSeconds } : {}),
      };
    }
    return { ok: false, reason: 'ERROR' };
  } catch {
    return { ok: false, reason: 'NETWORK' };
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const res = await apiFetch<{ error?: { code: string } }>('/auth/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    });
    if (res.ok) return { ok: true };
    return { ok: false, code: res.data?.error?.code ?? 'ERROR' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}

export async function logout(): Promise<void> {
  await apiFetch('/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
}

export type PreviewOutcome =
  { ok: true; studentId: string; fullName: string; email: string } | { ok: false; code: string };

export async function previewRegistration(input: RegistrationInput): Promise<PreviewOutcome> {
  try {
    const res = await apiFetch<{
      studentId: string;
      fullName: string;
      email: string;
      error?: { code: string };
    }>('/auth/register/preview', { method: 'POST', body: input });
    if (res.ok && res.data && 'studentId' in res.data) return { ok: true, ...res.data };
    return {
      ok: false,
      code: (res.data as { error?: { code: string } } | null)?.error?.code ?? 'ERROR',
    };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}

export async function commitRegistration(
  input: RegistrationInput,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const res = await apiFetch<{ error?: { code: string } }>('/auth/register/commit', {
      method: 'POST',
      body: { ...input, confirmed: true },
    });
    if (res.ok) return { ok: true };
    return { ok: false, code: res.data?.error?.code ?? 'ERROR' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}

export interface LecturerRegistrationInput {
  fullName: string;
  email: string;
  password: string;
}

export async function registerLecturer(
  input: LecturerRegistrationInput,
): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    const res = await apiFetch<{ error?: { code: string } }>('/auth/register/lecturer', {
      method: 'POST',
      body: input,
    });
    if (res.ok) return { ok: true };
    return { ok: false, code: res.data?.error?.code ?? 'ERROR' };
  } catch {
    return { ok: false, code: 'NETWORK' };
  }
}

export async function verifyEmail(token: string): Promise<boolean> {
  try {
    return (await apiFetch('/auth/verify-email', { method: 'POST', body: { token } })).ok;
  } catch {
    return false;
  }
}
