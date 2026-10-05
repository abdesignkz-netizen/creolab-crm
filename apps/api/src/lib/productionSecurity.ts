/** Validate without printing secrets, and without silently rotating encryption keys. */
export function assertProductionSecurity(
  env: NodeJS.ProcessEnv = process.env,
  options: { requireStrongEncryptionKey?: boolean } = {},
) {
  if (env.NODE_ENV !== "production") return;
  let legacyEncryption = false;
  for (const key of ["SESSION_SECRET", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"]) {
    const value = env[key] || "";
    if (value.trim().length < 32 || /^(dev-|change|example|test|placeholder|replace[-_ ]|your[-_ ])/i.test(value) || new Set(value).size < 8) {
      if (key === "ENCRYPTION_KEY") {
        // Existing ciphertext depends on the exact old value. Never generate or replace it here.
        // This explicit migration exception applies only to a nonempty encryption key.
        if (value.trim() && env.ALLOW_LEGACY_ENCRYPTION_KEY === "1" && !options.requireStrongEncryptionKey) {
          legacyEncryption = true;
          continue;
        }
        throw new Error("ENCRYPTION_KEY does not meet production requirements. Do not replace an existing key without re-encrypting stored data. For an existing installation only, ALLOW_LEGACY_ENCRYPTION_KEY=1 temporarily preserves the current nonempty key pending migration.");
      }
      throw new Error(`${key} must be a strong, independently generated production secret (at least 32 characters)`);
    }
  }
  const secrets = [env.SESSION_SECRET, env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.ENCRYPTION_KEY];
  if (new Set(secrets).size !== secrets.length) throw new Error("Production session, JWT and encryption keys must be different");
  if (env.TRUST_PROXY_DEBUG === "1") throw new Error("TRUST_PROXY_DEBUG must be disabled in production");
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") throw new Error("TLS certificate verification must remain enabled");
  for (const key of ["APP_BASE_URL", "API_BASE_URL"]) {
    if (!env[key]) continue;
    const url = new URL(env[key]!);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${key} must use HTTPS without embedded credentials`);
  }
  if (legacyEncryption) {
    console.warn("[security] Legacy ENCRYPTION_KEY explicitly retained for migration. Encryption is unchanged; key strength is below production requirements. Back up and re-encrypt stored secrets before replacing the key, then remove ALLOW_LEGACY_ENCRYPTION_KEY. Never share the key in logs or support messages.");
  }
}
