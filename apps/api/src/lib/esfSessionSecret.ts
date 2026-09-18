import { decryptSecret, encryptSecret } from "./secretBox.ts";

/**
 * ESF SOAP sessionId is a bearer credential (createSession token reused on later SOAP).
 * Encrypt at rest with the existing AES-GCM secretBox / ENCRYPTION_KEY.
 * Do not store ESF PIN, ЭЦП PIN, private key, or p12.
 * AES-GCM payload from secretBox: 12-byte IV, 16-byte tag, ciphertext.
 */
const BOX = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;

export function isEsfSessionCiphertext(stored: string | null | undefined) {
  return Boolean(stored && BOX.test(stored));
}

export function persistEsfSessionId(plain: string | null | undefined) {
  if (!plain) return null;
  if (isEsfSessionCiphertext(plain)) return plain;
  return encryptSecret(plain);
}

export function revealEsfSessionId(stored: string | null | undefined) {
  if (!stored) return null;
  if (!isEsfSessionCiphertext(stored)) return stored;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

export function withRevealedEsfSession<T extends { sessionId: string | null }>(row: T): T {
  return { ...row, sessionId: revealEsfSessionId(row.sessionId) };
}
