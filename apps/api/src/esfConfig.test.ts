import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESF_OFFICIAL,
  isProductionEsfUrl,
  readEsfConfig,
  resolveEsfBaseUrl,
  sanitizedEsfHost,
} from "./integrations/esf/EsfConfig.ts";

describe("ESF TEST endpoint guard", () => {
  it("при ESF_ENV=test выбирает только TEST host", () => {
    const official = resolveEsfBaseUrl({ esfEnv: "test" });
    assert.equal(official, ESF_OFFICIAL.testBaseUrl);
    assert.equal(sanitizedEsfHost(official), "test3.esf.kgd.gov.kz");
    assert.equal(isProductionEsfUrl(official), false);
  });

  it("ESF_ALLOW_LIVE_SEND не переключает test → production", () => {
    const prev = process.env.ESF_ALLOW_LIVE_SEND;
    process.env.ESF_ALLOW_LIVE_SEND = "1";
    const url = resolveEsfBaseUrl({
      esfEnv: "test",
      baseUrl: ESF_OFFICIAL.prodBaseUrl,
      productionApiUrl: ESF_OFFICIAL.prodBaseUrl,
      testApiUrl: ESF_OFFICIAL.prodBaseUrl,
    });
    assert.equal(url, ESF_OFFICIAL.testBaseUrl);
    assert.equal(isProductionEsfUrl(url), false);
    if (prev == null) delete process.env.ESF_ALLOW_LIVE_SEND;
    else process.env.ESF_ALLOW_LIVE_SEND = prev;
  });

  it("readEsfConfig при ESF_ENV=test не отдаёт esf.gov.kz", () => {
    const prev = {
      ESF_ENV: process.env.ESF_ENV,
      ESF_BASE_URL: process.env.ESF_BASE_URL,
      ESF_TEST_API_URL: process.env.ESF_TEST_API_URL,
      ESF_PRODUCTION_API_URL: process.env.ESF_PRODUCTION_API_URL,
      ESF_ALLOW_LIVE_SEND: process.env.ESF_ALLOW_LIVE_SEND,
    };
    process.env.ESF_ENV = "test";
    process.env.ESF_ALLOW_LIVE_SEND = "1";
    process.env.ESF_BASE_URL = "https://esf.gov.kz:8443/esf-web";
    process.env.ESF_TEST_API_URL = "https://esf.gov.kz:8443/esf-web";
    process.env.ESF_PRODUCTION_API_URL = "https://esf.gov.kz:8443/esf-web";
    const config = readEsfConfig();
    assert.equal(config.esfEnv, "test");
    assert.equal(config.liveSendAllowed, true);
    assert.equal(config.endpointHost, "test3.esf.kgd.gov.kz");
    assert.doesNotMatch(config.baseUrl, /esf\.gov\.kz/);
    assert.match(config.awpUrl, /test3\.esf\.kgd\.gov\.kz/);
    for (const [key, value] of Object.entries(prev)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
});
