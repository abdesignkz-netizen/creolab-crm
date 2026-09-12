import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeEsfSignature } from "./integrations/esf/poc/analyzeEsfSignature.ts";
import { makeTestCms } from "./testCms.ts";

describe("ESF signature format probe", () => {
  it("распознаёт CMS/ASN.1 из LocalService-подобного base64", () => {
    const cms = makeTestCms(Buffer.from("<v1:awp/>"));
    const analysis = analyzeEsfSignature(cms);
    assert.equal(analysis.encoding, "base64");
    assert.equal(analysis.asn1Sequence, true);
    assert.ok(analysis.ncalayerCandidates.includes("cms"));
  });

  it("распознаёт 64-байтовый detached blob, для которого в basics нет format", () => {
    const raw = Buffer.alloc(64, 7).toString("base64");
    const analysis = analyzeEsfSignature(raw);
    assert.equal(analysis.format, "raw_64");
    assert.deepEqual(analysis.ncalayerCandidates, []);
  });

  it("распознаёт XMLDSig как кандидат basics format=xml", () => {
    const analysis = analyzeEsfSignature(
      `<Signature xmlns="http://www.w3.org/2000/09/xmldsig#"><SignedInfo/></Signature>`,
    );
    assert.equal(analysis.format, "xmldsig");
    assert.deepEqual(analysis.ncalayerCandidates, ["xml"]);
  });
});
