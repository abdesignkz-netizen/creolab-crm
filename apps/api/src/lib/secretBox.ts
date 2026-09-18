import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Keep salt stable so existing ciphertext in DB still decrypts.
 * Rotation: generate a new ENCRYPTION_KEY, decrypt+re-encrypt stored secrets
 * (WhatsApp/LLM credentials, ESF sessionId) under the new key, then drop the old key.
 * Do not change KEY_SALT or ENCRYPTION_KEY independently without re-encrypting rows.
 */
const KEY_SALT = "creolab-crm";

function rawKeyMaterial() {
  const raw = process.env.ENCRYPTION_KEY;
  if (raw) return raw;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ENCRYPTION_KEY is required in production");
  }
  return "dev-encryption-key-change-me";
}

function key() {
  return scryptSync(rawKeyMaterial(), KEY_SALT, 32);
}

export function encryptionKeyVersion() {
  return String(process.env.ENCRYPTION_KEY_VERSION || "v1");
}

export function encryptSecret(plain: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(payload: string) {
  const [ivH, tagH, dataH] = payload.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivH, "hex"));
  decipher.setAuthTag(Buffer.from(tagH, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataH, "hex")), decipher.final()]).toString("utf8");
}

/** Single encryption facade; swap implementation later (KMS) without changing callers. */
export const encryptionService = {
  encrypt: encryptSecret,
  decrypt: decryptSecret,
  keyVersion: encryptionKeyVersion,
};
