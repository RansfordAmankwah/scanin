import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Template references are sealed with AES-256-GCM before they touch the database, with a key held
 * outside it (FACE_TEMPLATE_KEY). The reference is a vendor handle, not biometric data, but it is
 * still treated as a secret: the database owner alone cannot read it, and a leaked backup does not
 * expose it.
 */
export interface SealedTemplate {
  cipher: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

function key(keyB64url: string): Buffer {
  const k = Buffer.from(keyB64url, 'base64url');
  if (k.length < 32) throw new Error('FACE_TEMPLATE_KEY must be at least 32 bytes');
  return k.subarray(0, 32);
}

export function sealTemplate(keyB64url: string, templateRef: string): SealedTemplate {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(keyB64url), nonce);
  const cipher = Buffer.concat([c.update(templateRef, 'utf8'), c.final()]);
  return { cipher, nonce, tag: c.getAuthTag() };
}

export function openTemplate(keyB64url: string, sealed: SealedTemplate): string {
  const d = createDecipheriv('aes-256-gcm', key(keyB64url), sealed.nonce);
  d.setAuthTag(sealed.tag);
  return Buffer.concat([d.update(sealed.cipher), d.final()]).toString('utf8');
}
