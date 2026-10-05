import assert from "node:assert/strict";
import { it } from "node:test";
import { randomBytes, createCipheriv, scryptSync } from "node:crypto";
import { assertProductionSecurity } from "./lib/productionSecurity.ts";
import { decryptSecret, encryptSecret } from "./lib/secretBox.ts";

function productionEnv(): NodeJS.ProcessEnv {
  return { NODE_ENV: "production", ...Object.fromEntries(
    ["SESSION_SECRET", "JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "ENCRYPTION_KEY"]
      .map(key => [key, randomBytes(32).toString("hex")]),
  ) };
}

it("requires explicit migration opt-in for an existing weak encryption key and never logs it", () => {
  const env = { ...productionEnv(), ENCRYPTION_KEY: "legacy-key-for-test" };
  assert.throws(() => assertProductionSecurity(env), /Do not replace/);
  for (const value of ["", "true", "0"]) {
    assert.throws(() => assertProductionSecurity({ ...env, ALLOW_LEGACY_ENCRYPTION_KEY: value }));
  }
  const oldWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    assert.doesNotThrow(() => assertProductionSecurity({ ...env, ALLOW_LEGACY_ENCRYPTION_KEY: "1" }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /below production requirements/);
    assert(!warnings[0].includes(env.ENCRYPTION_KEY));
    assert.equal(env.ENCRYPTION_KEY, "legacy-key-for-test");
  } finally { console.warn = oldWarn; }
});

it("never permits missing keys, weak auth keys, shared keys or disabled TLS through the exception", () => {
  const env = { ...productionEnv(), ALLOW_LEGACY_ENCRYPTION_KEY: "1" };
  for (const patch of [
    { ENCRYPTION_KEY: "" }, { ENCRYPTION_KEY: "   " }, { SESSION_SECRET: "short" },
    { JWT_ACCESS_SECRET: "short" }, { JWT_REFRESH_SECRET: "short" },
    { ENCRYPTION_KEY: env.SESSION_SECRET }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { TRUST_PROXY_DEBUG: "1" },
  ]) assert.throws(() => assertProductionSecurity({ ...env, ...patch }));
});

it("keeps readiness strict even when temporary migration mode is enabled", () => {
  assert.throws(() => assertProductionSecurity({ ...productionEnv(), ENCRYPTION_KEY: "old-key", ALLOW_LEGACY_ENCRYPTION_KEY: "1" },
    { requireStrongEncryptionKey: true }), /ENCRYPTION_KEY/);
  assert.doesNotThrow(() => assertProductionSecurity(productionEnv(), { requireStrongEncryptionKey: true }));
});

it("retains ciphertext from before the startup change and continues using the exact existing key", () => {
  const originalKey = process.env.ENCRYPTION_KEY;
  const originalMode = process.env.NODE_ENV;
  const oldWarn = console.warn;
  const legacyKey = "short-old-key";
  // Independently construct the existing on-disk AES-GCM format, not a round-trip alone.
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(legacyKey, "creolab-crm", 32), iv);
  const encrypted = Buffer.concat([cipher.update("stored-connection-test", "utf8"), cipher.final()]);
  const fixture = `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${encrypted.toString("hex")}`;
  try {
    process.env.ENCRYPTION_KEY = legacyKey;
    process.env.NODE_ENV = "production";
    console.warn = () => {};
    assertProductionSecurity({ ...productionEnv(), ENCRYPTION_KEY: legacyKey, ALLOW_LEGACY_ENCRYPTION_KEY: "1" });
    assert.equal(decryptSecret(fixture), "stored-connection-test");
    assert.equal(decryptSecret(encryptSecret("new-connection-test")), "new-connection-test");
    assert.equal(process.env.ENCRYPTION_KEY, legacyKey);
  } finally {
    console.warn = oldWarn;
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = originalKey;
    if (originalMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalMode;
  }
});
