import forge from "node-forge";
import { makeTestGostCertificate } from "./testGostCertificate.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { inspectCms, pemFromCms } from "./services/cmsInspect.ts";
import { verifyCmsWithKalkan } from "./services/kalkanCmsVerifyClient.ts";
import { verifyDocumentSignature } from "./services/signatureVerificationService.ts";
import { makeTestCms } from "./testCms.ts";
import { startTestKalkan } from "./testKalkan.ts";

describe("cms inspect", { concurrency: false }, () => {
  it("достаёт ИИН и БИН из сертификата", () => {
    const cms = makeTestCms(Buffer.from("hello-contract"), { iin: "222222222220", bin: "123456789013" });
    const inspected = inspectCms(cms);
    assert.equal(inspected.primary?.iin, "222222222220");
    assert.equal(inspected.primary?.bin, "123456789013");
    const pem = pemFromCms(cms);
    assert.match(pem, /BEGIN CERTIFICATE/);
    assert.doesNotMatch(pem, /PRIVATE KEY/);
  });

  it("отклоняет просроченный сертификат и чужой БИН", async () => {
    const expired = await verifyDocumentSignature({
      cmsBase64: makeTestCms(Buffer.from("hello"), { expired: true }),
      documentHash: "abc",
    });
    assert.equal(expired.status, "FAILED");

    const mismatch = await verifyDocumentSignature({
      cmsBase64: makeTestCms(Buffer.from("hello"), { bin: "222222222220" }),
      documentHash: "abc",
      expectedBin: "123456789013",
    });
    assert.equal(mismatch.status, "FAILED");
    assert.equal(mismatch.details.error, "bin_mismatch");
  });

  it("разбирает ГОСТ-сертификат подписанта, а не первый сертификат в контейнере", () => {
    const children = (node: forge.asn1.Asn1) => node.value as forge.asn1.Asn1[];
    const cms = forge.asn1.fromDer(Buffer.from(makeTestCms(Buffer.from("metadata only")), "base64").toString("binary"));
    const data = children(children(children(cms)[1])[0]);
    const certSet = data.find((node) => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0)!;
    const pem = makeTestGostCertificate();
    const gost = forge.asn1.fromDer(Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""), "base64").toString("binary"));
    children(certSet).push(gost);
    const tbs = children(children(gost)[0]);
    const offset = tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
    const sid = children(children(data.at(-1)!)[0])[1];
    sid.value = [tbs[offset + 2], tbs[offset]];
    const encoded = Buffer.from(forge.asn1.toDer(cms).getBytes(), "binary").toString("base64");
    const parsed = inspectCms(encoded);
    assert.equal(parsed.certificates.length, 2);
    assert.equal(parsed.primary?.commonName, "GOST Test Signer");
    assert.equal(parsed.primary?.iin, "222222222220");
    assert.equal(parsed.primary?.bin, "123456789013");
    assert.equal(pemFromCms(encoded), pem);
    // This fixture checks parsing only; it contains no valid GOST signature.
  });

  it("отклоняет сертификат без БИН компании и несовпадающий ИИН ИП", async () => {
    for (const expected of [{ expectedBin: "123456789013" }, { expectedIin: "111111111111" }]) {
      const result = await verifyDocumentSignature({ cmsBase64: makeTestCms(Buffer.from("x"), { bin: null }), documentHash: "x", ...expected });
      assert.equal(result.status, "FAILED");
      assert.equal(result.details.error, "expectedBin" in expected ? "bin_mismatch" : "iin_mismatch");
    }
  });

  it("не принимает контейнер со встроенным другим документом вместо detached-подписи", async () => {
    const children = (node: forge.asn1.Asn1) => node.value as forge.asn1.Asn1[];
    const cms = forge.asn1.fromDer(Buffer.from(makeTestCms(Buffer.from("different")), "base64").toString("binary"));
    const data = children(children(children(cms)[1])[0]);
    children(data[2]).push(forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
      forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, "different"),
    ]));
    const result = await verifyDocumentSignature({
      cmsBase64: Buffer.from(forge.asn1.toDer(cms).getBytes(), "binary").toString("base64"),
      documentBytes: Buffer.from("actual contract"), documentHash: "hash",
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.details.error, "detached_signature_required");
  });

  it("без Kalkan sidecar отклоняет подпись", async () => {
    delete process.env.KALKAN_VERIFY_URL;
    const document = Buffer.from("hello-kalkan-off");
    const parsed = await verifyDocumentSignature({
      cmsBase64: makeTestCms(document, { iin: "222222222220", bin: "123456789013" }),
      documentHash: "abc",
      documentBytes: document,
    });
    assert.equal(parsed.status, "FAILED");
    assert.equal(parsed.cryptoStatus, "UNAVAILABLE");
    assert.equal(parsed.details.crypto, "gost_kalkan_adapter_missing");
  });
});

describe("kalkan cms verify sidecar", { concurrency: false }, () => {
  it("проверяет PEM-ответ NCALayer по исходному файлу и отклоняет другой файл", async () => {
    const verifier = await startTestKalkan();
    try {
      const documentBytes = Buffer.from("NCALayer contract bytes");
      const raw = makeTestCms(documentBytes);
      const pem = `-----BEGIN CMS-----\r\n${raw.match(/.{1,64}/g)!.join("\r\n")}\r\n-----END CMS-----\r\n`;
      for (const cmsBase64 of [raw, pem]) {
        const valid = await verifyDocumentSignature({ cmsBase64, documentBytes, documentHash: "test", expectedBin: "123456789013" });
        assert.equal(valid.status, "VERIFIED", JSON.stringify(valid.details));
        const wrong = await verifyDocumentSignature({ cmsBase64, documentBytes: Buffer.from("Another contract"), documentHash: "other" });
        assert.equal(wrong.status, "FAILED");
        assert.equal(wrong.details.error, "cms_verify_failed");
      }
    } finally { await verifier.close(); }
  });

  async function withSidecar(
    handler: (body: { cmsBase64?: string; documentBase64?: string }, req: { headers: Record<string, string | string[] | undefined> }) => { status: number; json: Record<string, unknown> },
    run: (base: string) => Promise<void>,
  ) {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        let payload: { cmsBase64?: string; documentBase64?: string } = {};
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as typeof payload;
        } catch {
          payload = {};
        }
        if (req.url !== "/verify" || req.method !== "POST") {
          res.statusCode = 404;
          res.end("{}");
          return;
        }
        const result = handler(payload, { headers: req.headers });
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const previousUrl = process.env.KALKAN_VERIFY_URL;
    const previousSecret = process.env.KALKAN_VERIFY_SECRET;
    process.env.KALKAN_VERIFY_URL = `http://127.0.0.1:${port}`;
    process.env.KALKAN_VERIFY_SECRET = "sidecar-secret";
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      if (previousUrl === undefined) delete process.env.KALKAN_VERIFY_URL;
      else process.env.KALKAN_VERIFY_URL = previousUrl;
      if (previousSecret === undefined) delete process.env.KALKAN_VERIFY_SECRET;
      else process.env.KALKAN_VERIFY_SECRET = previousSecret;
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  }

  it("принимает VERIFIED от sidecar и отклоняет FAILED", async () => {
    const document = Buffer.from("signed-bytes");
    const cms = makeTestCms(document, { iin: "222222222220", bin: "123456789013" });
    await withSidecar(
      () => ({ status: 200, json: { ok: true, cryptoStatus: "VERIFIED", authorityStatus: "VALID" } }),
      async () => {
        const verified = await verifyDocumentSignature({
          cmsBase64: cms,
          documentHash: "hash",
          documentBytes: document,
        });
        assert.equal(verified.status, "VERIFIED");
        assert.equal(verified.cryptoStatus, "VERIFIED");
        assert.equal(verified.details.crypto, "kalkan_cms_verified");
      },
    );

    await withSidecar(
      () => ({ status: 200, json: { ok: false, cryptoStatus: "FAILED", error: "cms_verify_failed" } }),
      async () => {
        const failed = await verifyDocumentSignature({
          cmsBase64: cms,
          documentHash: "hash",
          documentBytes: document,
        });
        assert.equal(failed.status, "FAILED");
        assert.equal(failed.cryptoStatus, "FAILED");
        assert.equal(failed.details.error, "cms_verify_failed");
      },
    );
  });

  it("принимает OCSP VALID и отклоняет отозванный сертификат", async () => {
    const document = Buffer.from("signed-bytes-ocsp");
    const cms = makeTestCms(document, { iin: "222222222220", bin: "123456789013" });
    await withSidecar(
      () => ({ status: 200, json: { ok: true, cryptoStatus: "VERIFIED", authorityStatus: "VALID" } }),
      async () => {
        const verified = await verifyDocumentSignature({
          cmsBase64: cms,
          documentHash: "hash",
          documentBytes: document,
        });
        assert.equal(verified.status, "VERIFIED");
        assert.equal(verified.authorityStatus, "VALID");
        assert.equal(verified.details.authority, "VALID");
      },
    );

    await withSidecar(
      () => ({
        status: 200,
        json: { ok: false, cryptoStatus: "VERIFIED", authorityStatus: "REVOKED", error: "certificate_revoked" },
      }),
      async () => {
        const failed = await verifyDocumentSignature({
          cmsBase64: cms,
          documentHash: "hash",
          documentBytes: document,
        });
        assert.equal(failed.status, "FAILED");
        assert.equal(failed.cryptoStatus, "VERIFIED");
        assert.equal(failed.authorityStatus, "REVOKED");
        assert.equal(failed.details.error, "certificate_revoked");
      },
    );
  });

  it("сохраняет причину отказа OCSP и отличает сбой сервиса от неверной подписи", async () => {
    const document = Buffer.from("diagnostic-check");
    const cmsBase64 = makeTestCms(document);
    await withSidecar(() => ({ status: 200, json: { ok: false, cryptoStatus: "VERIFIED", authorityStatus: "UNCHECKED", error: "issuer_cert_not_found" } }), async () => {
      const result = await verifyDocumentSignature({ cmsBase64, documentHash: "x", documentBytes: document });
      assert.equal(result.status, "FAILED");
      assert.equal(result.details.authorityError, "issuer_cert_not_found");
    });
    for (const status of [401, 403, 429, 500, 502, 503]) {
      await withSidecar(() => ({ status, json: { error: status === 401 ? "unauthorized" : `kalkan_http_${status}` } }), async () => {
        const result = await verifyDocumentSignature({ cmsBase64, documentHash: "x", documentBytes: document });
        assert.equal(result.status, "FAILED");
        assert.equal(result.cryptoStatus, "UNAVAILABLE");
      });
    }
  });

  it("отклоняет непроверенную цепочку и неполные ответы проверяющего сервиса", async () => {
    const document = Buffer.from("strict-verification");
    const cmsBase64 = makeTestCms(document);
    for (const body of [
      { ok: true, cryptoStatus: "VERIFIED", authorityStatus: "UNCHECKED" },
      { ok: false, cryptoStatus: "VERIFIED", authorityStatus: "UNCHECKED" },
      { ok: true, authorityStatus: "VALID" },
      { ok: false, cryptoStatus: "VERIFIED", authorityStatus: "VALID" },
    ]) {
      await withSidecar(() => ({ status: 200, json: body }), async () => {
        const result = await verifyDocumentSignature({ cmsBase64, documentHash: "x", documentBytes: document });
        assert.equal(result.status, "FAILED");
      });
    }
    await withSidecar(() => ({ status: 200, json: { ok: true, cryptoStatus: "VERIFIED", authorityStatus: "VALID" } }), async () => {
      const result = await verifyDocumentSignature({ cmsBase64: makeTestCms(document, { bin: null }), documentHash: "x", documentBytes: document, expectedIin: "222222222220" });
      assert.equal(result.status, "VERIFIED");
    });
  });

  it("недоступный sidecar не считает подпись проверенной", async () => {
    process.env.KALKAN_VERIFY_URL = "http://127.0.0.1:1";
    process.env.KALKAN_VERIFY_TIMEOUT_MS = "400";
    try {
      const result = await verifyCmsWithKalkan({
        cmsBase64: makeTestCms(Buffer.from("x"), { iin: "222222222220" }),
        documentBytes: Buffer.from("x"),
      });
      assert.equal(result.skipped, false);
      assert.equal(result.cryptoStatus, "UNAVAILABLE");
      assert.equal(result.error, "kalkan_unreachable");
    } finally {
      delete process.env.KALKAN_VERIFY_URL;
      delete process.env.KALKAN_VERIFY_TIMEOUT_MS;
    }
  });
});
