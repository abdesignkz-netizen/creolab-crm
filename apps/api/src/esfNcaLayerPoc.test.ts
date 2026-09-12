import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { ApiError } from "./errors.ts";
import { officialAvrBody, officialInvoiceBody, rejectPrivateKeyFields, sha256Utf8 } from "./services/esfNcaLayerPocService.ts";
import { bindAvrFixtureSenderTin, senderTinFromAvrXml } from "./integrations/esf/poc/bindAvrFixtureSenderTin.ts";
import { publicCertificateFingerprint } from "./services/cmsInspect.ts";
import { pemFromCms } from "./services/cmsInspect.ts";
import { makeTestCms } from "./testCms.ts";
import { analyzeEsfSignature } from "./integrations/esf/poc/analyzeEsfSignature.ts";

describe("ESF NCALayer POC helpers", () => {
  it("отклоняет PIN/P12 на backend", () => {
    assert.throws(
      () => rejectPrivateKeyFields({ pin: "0000", signature: "abc" }),
      (error: unknown) => error instanceof ApiError && error.code === "esf_private_key_forbidden",
    );
  });

  it("берёт тот же official invoice body, что и LocalService.generateSignature", () => {
    const payload = officialInvoiceBody();
    assert.match(payload, /<v2:invoice/);
    assert.match(payload, /<\/v2:invoice>/);
    assert.equal(sha256Utf8(payload).length, 64);
    assert.equal(analyzeEsfSignature("").format, "empty");
  });

  it("AVR fixture читается одинаковыми байтами без trim/pretty", () => {
    const first = officialAvrBody();
    const second = officialAvrBody();
    assert.equal(first.equals(second), true);
    assert.match(first.toString("utf8"), /<v1:awp/);
    assert.equal(first[0], 0x3c);
    assert.equal(sha256Utf8(first.toString("utf8")), createHash("sha256").update(first).digest("hex"));
  });

  it("подставляет только sender TIN до SHA-256 и не трогает остальной fixture", () => {
    const official = officialAvrBody().toString("utf8");
    const tenantBin = "123456789013";
    const bound = bindAvrFixtureSenderTin(official, tenantBin);
    assert.equal(senderTinFromAvrXml(bound), tenantBin);
    assert.match(bound, /<recipients>[\s\S]*<tin>123456789011<\/tin>/);
    assert.equal(bound.replace(`<tin>${tenantBin}</tin>`, "<tin>123456789021</tin>"), official);
    assert.notEqual(sha256Utf8(bound), sha256Utf8(official));
  });

  it("не путает AUTH PEM и SIGN PEM по fingerprint", () => {
    const auth = pemFromCms(makeTestCms(Buffer.from("auth-role"), { iin: "111111111111", bin: "123456789013" }));
    const sign = pemFromCms(makeTestCms(Buffer.from("sign-role"), { iin: "222222222220", bin: "123456789013" }));
    assert.notEqual(publicCertificateFingerprint(auth), publicCertificateFingerprint(sign));
  });
});
