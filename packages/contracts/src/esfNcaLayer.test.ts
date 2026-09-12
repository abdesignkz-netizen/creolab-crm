import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ESF_NCALAYER_AUTH,
  ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME,
  ESF_NCALAYER_BUNDLE_VERSION,
  ESF_NCALAYER_SERVICE,
  ESF_NCALAYER_SIGN_PLAIN_DATA,
  ESF_NCALAYER_SIGN_PLAIN_DATA_MAP,
  buildEsfAuthRequest,
  buildEsfSignPlainDataRequest,
  extractPublicCertificateFromUnknown,
  findOfficialEsfBundle,
  findOfficialEsfService,
  parseEsfSignerResponse,
  sanitizeUnknownEsfResponse,
} from "./esfNcaLayer.ts";

describe("official NCALayer ESF module 1.2 contract", () => {
  it("по-прежнему экспортирует исторический service com.osdkz.esf.signer.esfSigner", () => {
    assert.equal(ESF_NCALAYER_BUNDLE_SYMBOLIC_NAME, "com.osdkz.esf.signer");
    assert.equal(ESF_NCALAYER_BUNDLE_VERSION, "1.2");
    assert.equal(ESF_NCALAYER_SERVICE, "com.osdkz.esf.signer.esfSigner");
    assert.equal(ESF_NCALAYER_SIGN_PLAIN_DATA, "signPlainData");
    assert.equal(ESF_NCALAYER_SIGN_PLAIN_DATA_MAP, "signPlainDataMap");
    assert.equal(ESF_NCALAYER_AUTH, "auth");
  });

  it("находит официальный bundle/service и игнорирует Uchet.kz", () => {
    assert.deepEqual(
      findOfficialEsfBundle({
        "kz.gov.pki.knca.basics": "1.0",
        "com.osdkz.esf.signer": "1.2",
        "kz.uchet.esfSignUtil": "1.0",
      }),
      { name: "com.osdkz.esf.signer", version: "1.2" },
    );
    assert.equal(
      findOfficialEsfService({
        services: ["kz.gov.pki.ncalayerservices.accessory", "kz.uchet.esfSignUtil", "com.osdkz.esf.signer.esfSigner"],
      }),
      "com.osdkz.esf.signer.esfSigner",
    );
  });

  it("собирает запрос signPlainData как на тестовом стенде ИС ЭСФ", () => {
    assert.deepEqual(buildEsfSignPlainDataRequest("<v2:invoice/>", "PKCS12"), {
      module: "com.osdkz.esf.signer.esfSigner",
      method: "signPlainData",
      storageName: "PKCS12",
      data: "<v2:invoice/>",
    });
  });

  it("читает responseObject.signature и pem без секретов в метаданных", () => {
    const parsed = parseEsfSignerResponse({
      code: "200",
      message: null,
      responseObject: {
        signature: "abcd",
        pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
        keyInfo: { algorithm: "GOST3411-2015-512withGOST3410-2015-512", subjectCn: "TEST", serialNumber: "01" },
      },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.signature, "abcd");
    assert.match(parsed.publicCertificate, /BEGIN CERTIFICATE/);
    assert.equal(parsed.keyInfo.algorithm, "GOST3411-2015-512withGOST3410-2015-512");
  });

  it("собирает auth-запрос без выдуманного createSessionSigned", () => {
    assert.deepEqual(buildEsfAuthRequest("nonce-1", "PKCS12"), {
      module: "com.osdkz.esf.signer.esfSigner",
      method: "auth",
      storageName: "PKCS12",
      data: "nonce-1",
    });
  });

  it("читает pem из keyInfo, как у method auth", () => {
    const parsed = parseEsfSignerResponse({
      code: "200",
      responseObject: {
        signature: "sig",
        data: "nonce-1",
        keyInfo: { pem: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----", algorithm: "GOST", subjectCn: "AUTH" },
      },
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.match(parsed.publicCertificate, /BEGIN CERTIFICATE/);
    const sanitized = sanitizeUnknownEsfResponse({
      code: "200",
      responseObject: { pem: "-----BEGIN CERTIFICATE-----", signature: "abcd" },
    }) as { responseObject: { pem: { present: boolean; length: number } } };
    assert.equal(sanitized.responseObject.pem.present, true);
    assert.doesNotMatch(JSON.stringify(sanitized), /BEGIN CERTIFICATE/);
  });

  it("отличает отмену пользователя", () => {
    const parsed = parseEsfSignerResponse({ code: "500", message: "action.canceled" });
    assert.deepEqual(parsed, { ok: false, code: "USER_CANCELLED", message: "action.canceled" });
  });

  it("достаёт PEM из неизвестной схемы auth без требования signature", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    assert.equal(
      extractPublicCertificateFromUnknown({
        code: "200",
        responseObject: { keyInfo: { pem, subjectCn: "AUTH" } },
      }),
      pem,
    );
    const sanitized = sanitizeUnknownEsfResponse({
      code: "200",
      responseObject: { keyInfo: { pem, subjectCn: "AUTH" } },
    });
    assert.doesNotMatch(JSON.stringify(sanitized), /BEGIN CERTIFICATE/);
  });
});
