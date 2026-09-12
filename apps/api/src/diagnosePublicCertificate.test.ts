import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosePublicCertificate, officialEsfFaultCode } from "./integrations/esf/poc/diagnosePublicCertificate.ts";
import forge from "node-forge";
import { makeTestGostCertificate } from "./testGostCertificate.ts";
import { pemFromCms, inspectCertificatePem } from "./services/cmsInspect.ts";
import { makeTestCms } from "./testCms.ts";

describe("public certificate diagnosis", () => {
  it("отдаёт subject/issuer/EKU без private key", () => {
    const pem = pemFromCms(makeTestCms(Buffer.from("auth"), { iin: "222222222220", bin: "123456789013" }));
    const diagnosed = diagnosePublicCertificate(pem, {
      expectedEnv: "test",
      expectedBin: "123456789013",
      lastFault: "CERTIFICATE_NOT_VALID",
    });
    assert.equal(diagnosed.bin, "123456789013");
    assert.equal(diagnosed.iin, "222222222220");
    assert.equal(diagnosed.x509Format.hasPemHeaders, true);
    assert.equal(diagnosed.x509Format.sentToCreateSessionAs, "pem_with_headers_xml_escaped");
    assert.ok(diagnosed.likelyCertificateNotValidReasons.length > 0);
    assert.doesNotMatch(JSON.stringify(diagnosed), /PRIVATE KEY/);
    assert.doesNotMatch(JSON.stringify(diagnosed), /BEGIN CERTIFICATE/);
  });

  it("reads GOST-2015 metadata and usages without an RSA decoder", () => {
    const pem = makeTestGostCertificate();
    assert.throws(() => forge.pki.certificateFromPem(pem), /OID is not RSA/);
    const inspected = inspectCertificatePem(pem);
    assert.equal(inspected.commonName, "GOST Test Signer");
    assert.equal(inspected.serial, "0a112233");
    assert.equal(inspected.iin, "222222222220");
    assert.equal(inspected.bin, "123456789013");
    const result = diagnosePublicCertificate(pem, { expectedEnv: "test" });
    assert.equal(result.signatureAlgorithm, "1.2.643.7.1.1.3.2");
    assert.equal(result.ekuAuth, true);
    assert.equal(result.ekuSign, true);
    assert.deepEqual(result.keyUsage, ["digitalSignature", "nonRepudiation"]);
    assert.equal(result.validNow, true);
    assert.equal(result.caEnvironment, "test");
    assert.doesNotMatch(JSON.stringify(result), /BEGIN CERTIFICATE|PRIVATE KEY/);
  });

  it("достаёт официальный fault code", () => {
    assert.equal(officialEsfFaultCode("esf: CERTIFICATE_NOT_VALID from SessionService"), "CERTIFICATE_NOT_VALID");
  });
});
