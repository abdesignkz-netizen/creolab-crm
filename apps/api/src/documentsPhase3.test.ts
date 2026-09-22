import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { makeTestCms } from "./testCms.ts";

describe("Documents phase 3", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contractId = "";
  let sellerRequestId = "";
  let buyerToken = "";
  let verificationId = "";
  let previousKalkanUrl: string | undefined;

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: useCookie,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  before(async () => {
    previousKalkanUrl = process.env.KALKAN_VERIFY_URL;
    delete process.env.KALKAN_VERIFY_URL;
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;

    const login = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@creolab.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json(
      "/api/v1/auth/login",
      {
        method: "POST",
        body: JSON.stringify({
          email: "owner@demo-agency.example",
          password: process.env.SEED_PASSWORD,
          client: "web",
        }),
      },
      "",
    );
    otherCookie = demo.response.headers.get("set-cookie") || "";

    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        defaultVatMode: "percent",
        defaultVatRate: 12,
        contractSigningEnabled: true,
      }),
    });
    const contact = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase3 клиент", phone: "+77015550041" }),
    });
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase3 Buyer",
        legalName: "ТОО Phase3 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана",
        forceCreate: true,
      }),
    });
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase3 подпись",
        contactId: contact.body.client?.id || contact.body.id,
        companyId: company.body.id,
        items: [{ name: "Аудит", quantity: 1, unitPrice: 100000 }],
      }),
    });
    const draft = await json(`/api/v1/deals/${deal.body.deal.id}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const generated = await json(`/api/v1/contracts/${draft.body.contract.id}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 200, JSON.stringify(generated.body));
    contractId = generated.body.contract.id;
  });

  after(() => {
    if (previousKalkanUrl === undefined) delete process.env.KALKAN_VERIFY_URL;
    else process.env.KALKAN_VERIFY_URL = previousKalkanUrl;
    server?.close();
  });

  it("готовит только подпись исполнителя и не создаёт ссылку заказчику до неё", async () => {
    const early = await json(`/api/v1/contracts/${contractId}/send-to-buyer`, { method: "POST" });
    assert.equal(early.response.status, 422);
    assert.equal(early.body.code, "seller_must_sign_first");
    assert.equal(await prisma.signatureRequest.count({ where: { contractId } }), 0);
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await json(`/api/v1/contracts/${contractId}/prepare-seller-sign`, { method: "POST" });
      assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
      assert.equal(prepared.body.requests.length, 1);
      assert.equal(prepared.body.requests[0].signerType, "SELLER");
      assert.equal(prepared.body.requests[0].signUrl, null);
    }
    assert.equal(await prisma.signatureRequest.count({ where: { contractId } }), 1);
    assert.equal(await prisma.signatureRequest.count({ where: { contractId, signerType: "BUYER" } }), 0);
    const foreign = await json(`/api/v1/contracts/${contractId}/prepare-seller-sign`, { method: "POST" }, otherCookie);
    assert.equal(foreign.response.status, 403); // The other tenant has contract signing disabled.
    assert.equal(await prisma.signatureRequest.count({ where: { contractId } }), 1);
  });

  it("не раскрывает raw token в базе и не пускает заказчика раньше исполнителя", async () => {
    const sent = await json(`/api/v1/contracts/${contractId}/send-for-sign`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.contract.status, "PENDING_SIGNATURE");
    sellerRequestId = sent.body.requests.find((row: { signerType: string }) => row.signerType === "SELLER").id;
    const buyer = sent.body.requests.find((row: { signerType: string }) => row.signerType === "BUYER");
    assert.ok(buyer.signUrl);
    buyerToken = String(buyer.signUrl).split("/sign/")[1];
    assert.ok(buyerToken);
    const stored = await prisma.signatureRequest.findMany({ where: { contractId } });
    assert.ok(stored.every((row) => !row.tokenHash || row.tokenHash !== buyerToken));

    const publicView = await json(`/public/sign/${buyerToken}`, {}, "");
    assert.equal(publicView.body.canSign, false);
    assert.equal(publicView.body.waitingForSeller, true);

    const early = await json(
      `/public/sign/${buyerToken}/sign`,
      { method: "POST", body: JSON.stringify({ cmsBase64: makeTestCms(Buffer.from("nope"), { bin: "222222222220" }) }) },
      "",
    );
    assert.equal(early.response.status, 422);
    assert.equal(early.body.code, "seller_must_sign_first");

    const foreign = await json(`/api/v1/contracts/${contractId}/signing`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);
  });

  it("принимает подписи по очереди и закрывает договор", async () => {
    const pdf = await fetch(`${base}/api/v1/contracts/${contractId}/pdf`, { headers: { cookie } });
    const bytes = Buffer.from(await pdf.arrayBuffer());
    const sellerCms = makeTestCms(bytes, { iin: "123456789013", bin: "123456789013" });
    const seller = await json(`/api/v1/signature-requests/${sellerRequestId}/sign`, {
      method: "POST",
      body: JSON.stringify({ cmsBase64: sellerCms }),
    });
    assert.equal(seller.response.status, 200, JSON.stringify(seller.body));
    assert.equal(seller.body.contract.status, "PARTIALLY_SIGNED");

    const sentToBuyer = await json(`/api/v1/contracts/${contractId}/send-to-buyer`, { method: "POST" });
    assert.equal(sentToBuyer.response.status, 200, JSON.stringify(sentToBuyer.body));
    buyerToken = sentToBuyer.body.requests.find((row: { signerType: string }) => row.signerType === "BUYER").signUrl.split("/sign/")[1];
    assert.ok(buyerToken);
    assert.equal(await prisma.signatureRequest.count({ where: { contractId } }), 2);

    const publicView = await json(`/public/sign/${buyerToken}`, {}, "");
    assert.equal(publicView.body.canSign, true);
    assert.equal(publicView.body.version, 1);

    const buyerCms = makeTestCms(bytes, { iin: "222222222220", bin: "222222222220" });
    const stored = await prisma.contract.findFirst({ where: { id: contractId } });
    const attachment = await prisma.attachment.findFirst({ where: { id: stored?.generatedFileId || "" } });
    assert.ok(attachment);
    const { resolveUploadPath } = await import("./lib/storage.ts");
    const abs = resolveUploadPath(attachment.storageKey);
    const original = await readFile(abs);
    await writeFile(abs, Buffer.concat([original, Buffer.from("x")]));
    const tampered = await json(
      `/public/sign/${buyerToken}/sign`,
      { method: "POST", body: JSON.stringify({ cmsBase64: buyerCms }) },
      "",
    );
    assert.equal(tampered.response.status, 409, JSON.stringify(tampered.body));
    assert.equal(tampered.body.code, "DOCUMENT_CHANGED");
    await writeFile(abs, original);

    const buyer = await json(
      `/public/sign/${buyerToken}/sign`,
      { method: "POST", body: JSON.stringify({ cmsBase64: buyerCms }) },
      "",
    );
    assert.equal(buyer.response.status, 200, JSON.stringify(buyer.body));
    assert.equal(buyer.body.bothSigned, true);
    assert.equal(buyer.body.contractStatus, "SIGNED");

    const signing = await json(`/api/v1/contracts/${contractId}/signing`);
    verificationId = String(signing.body.verificationUrl || "").split("/verify/")[1];
    assert.ok(verificationId);
    const verify = await json(`/public/verify/${verificationId}`, {}, "");
    assert.equal(verify.body.status, "SIGNED");
    assert.equal(verify.body.signers.length, 2);
    assert.ok(verify.body.documentHash);
    assert.equal(verify.body.hashAlgorithm, "SHA-256");
    assert.equal("tenantId" in verify.body, false);
    assert.equal("dealId" in verify.body, false);
    for (const signer of verify.body.signers) {
      assert.equal(String(signer.iin || "").includes("222222222220"), false);
      assert.equal(String(signer.iin || "").includes("123456789013"), false);
      if (signer.iin) assert.match(String(signer.iin), /•+\d{4}$/);
    }

    const regen = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(regen.response.status, 422);
    assert.equal(regen.body.code, "contract_immutable");
  });
});
