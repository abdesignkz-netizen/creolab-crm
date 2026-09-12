import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectCms, pemFromCms } from "./services/cmsInspect.ts";
import { verifyDocumentSignature } from "./services/signatureVerificationService.ts";
import { makeTestCms } from "./testCms.ts";

describe("cms inspect", () => {
  it("достаёт ИИН и БИН из сертификата", () => {
    const cms = makeTestCms(Buffer.from("hello-contract"), { iin: "222222222220", bin: "123456789013" });
    const inspected = inspectCms(cms);
    assert.equal(inspected.primary?.iin, "222222222220");
    assert.equal(inspected.primary?.bin, "123456789013");
    const pem = pemFromCms(cms);
    assert.match(pem, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(pem, /PRIVATE KEY/);
  });

  it("отклоняет просроченный сертификат и чужой БИН", () => {
    const expired = verifyDocumentSignature({
      cmsBase64: makeTestCms(Buffer.from("hello"), { expired: true }),
      documentHash: "abc",
    });
    assert.equal(expired.status, "FAILED");

    const mismatch = verifyDocumentSignature({
      cmsBase64: makeTestCms(Buffer.from("hello"), { bin: "222222222220" }),
      documentHash: "abc",
      expectedBin: "123456789013",
    });
    assert.equal(mismatch.status, "FAILED");
    assert.equal(mismatch.details.error, "bin_mismatch");
  });
});
