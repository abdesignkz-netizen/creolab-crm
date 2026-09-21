import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { inspectCms, pemFromCms } from "./services/cmsInspect.ts";
import { verifyCmsWithKalkan } from "./services/kalkanCmsVerifyClient.ts";
import { verifyDocumentSignature } from "./services/signatureVerificationService.ts";
import { makeTestCms } from "./testCms.ts";

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

  it("без Kalkan sidecar остаётся parse-only", async () => {
    delete process.env.KALKAN_VERIFY_URL;
    const document = Buffer.from("hello-kalkan-off");
    const parsed = await verifyDocumentSignature({
      cmsBase64: makeTestCms(document, { iin: "222222222220", bin: "123456789013" }),
      documentHash: "abc",
      documentBytes: document,
    });
    assert.equal(parsed.status, "PARSED");
    assert.equal(parsed.cryptoStatus, "UNAVAILABLE");
    assert.equal(parsed.details.crypto, "gost_kalkan_adapter_missing");
  });
});

describe("kalkan cms verify sidecar", { concurrency: false }, () => {
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
      () => ({ status: 200, json: { ok: true, cryptoStatus: "VERIFIED", authorityStatus: "UNCHECKED" } }),
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

  it("недоступный sidecar не считает подпись проверенной", async () => {
    process.env.KALKAN_VERIFY_URL = "http://127.0.0.1:1";
    process.env.KALKAN_VERIFY_TIMEOUT_MS = "400";
    try {
      const result = await verifyCmsWithKalkan({
        cmsBase64: makeTestCms(Buffer.from("x"), { iin: "222222222220" }),
        documentBytes: Buffer.from("x"),
      });
      assert.equal(result.skipped, false);
      assert.equal(result.cryptoStatus, "FAILED");
      assert.equal(result.error, "kalkan_unreachable");
    } finally {
      delete process.env.KALKAN_VERIFY_URL;
      delete process.env.KALKAN_VERIFY_TIMEOUT_MS;
    }
  });
});
