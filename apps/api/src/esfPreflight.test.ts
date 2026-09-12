import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEsfPreflight } from "./integrations/esf/EsfPreflight.ts";
import { readEsfConfig } from "./integrations/esf/EsfConfig.ts";

describe("ESF TEST preflight", () => {
  it("не готов без флагов и не возвращает секреты", async () => {
    const prev = {
      ESF_PROVIDER: process.env.ESF_PROVIDER,
      ESF_ENV: process.env.ESF_ENV,
      ESF_ALLOW_LIVE_SEND: process.env.ESF_ALLOW_LIVE_SEND,
      ESF_TIN: process.env.ESF_TIN,
      ESF_PASSWORD: process.env.ESF_PASSWORD,
      ESF_AUTH_CERT_PEM: process.env.ESF_AUTH_CERT_PEM,
      ESF_SIGN_CERT_PATH: process.env.ESF_SIGN_CERT_PATH,
      ESF_SIGN_CERT_PIN: process.env.ESF_SIGN_CERT_PIN,
      ESF_SIGN_CERT_PEM: process.env.ESF_SIGN_CERT_PEM,
    };
    process.env.ESF_PROVIDER = "live";
    process.env.ESF_ENV = "off";
    delete process.env.ESF_ALLOW_LIVE_SEND;
    delete process.env.ESF_TIN;
    delete process.env.ESF_PASSWORD;
    delete process.env.ESF_AUTH_CERT_PEM;
    delete process.env.ESF_SIGN_CERT_PATH;
    delete process.env.ESF_SIGN_CERT_PIN;
    delete process.env.ESF_SIGN_CERT_PEM;

    const report = await buildEsfPreflight({
      config: readEsfConfig(),
      probeLocalService: async () => ({ reachable: false }),
      probeEsfHost: async () => ({ reachable: true }),
      pathExists: () => false,
    });

    assert.equal(report.ready, false);
    assert.equal(report.liveSendAllowed, false);
    assert.ok(report.blockers.some((row) => /ESF_ENV=off/.test(row)));
    assert.equal(report.blockers.some((row) => /ESF_TIN/.test(row)), false);
    process.env.ESF_PASSWORD = "secret-esf-password-value";
    process.env.ESF_SIGN_CERT_PIN = "secret-esf-pin-value";
    process.env.ESF_AUTH_CERT_PEM = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----";
    const again = await buildEsfPreflight({
      config: readEsfConfig(),
      probeLocalService: async () => ({ reachable: false }),
      probeEsfHost: async () => ({ reachable: true }),
      pathExists: () => false,
    });
    const dumped = JSON.stringify(again);
    assert.equal(dumped.includes("BEGIN CERTIFICATE"), false);
    assert.equal(dumped.includes("secret-esf-password-value"), false);
    assert.equal(dumped.includes("secret-esf-pin-value"), false);

    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("mock не считается живым TEST", async () => {
    const prevProvider = process.env.ESF_PROVIDER;
    const prevEnv = process.env.ESF_ENV;
    const prevAllow = process.env.ESF_ALLOW_LIVE_SEND;
    process.env.ESF_PROVIDER = "mock";
    process.env.ESF_ENV = "test";
    process.env.ESF_ALLOW_LIVE_SEND = "1";
    const report = await buildEsfPreflight({
      config: readEsfConfig(),
      probeLocalService: async () => ({ reachable: true }),
      probeEsfHost: async () => ({ reachable: true }),
    });
    assert.equal(report.ready, false);
    assert.ok(report.blockers.some((row) => /mock/.test(row)));
    if (prevProvider == null) delete process.env.ESF_PROVIDER;
    else process.env.ESF_PROVIDER = prevProvider;
    if (prevEnv == null) delete process.env.ESF_ENV;
    else process.env.ESF_ENV = prevEnv;
    if (prevAllow == null) delete process.env.ESF_ALLOW_LIVE_SEND;
    else process.env.ESF_ALLOW_LIVE_SEND = prevAllow;
  });
});
