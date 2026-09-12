import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 2", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contactId = "";
  let dealId = "";
  let contractId = "";
  let generatedFileId = "";

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

    const profile = await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        directorPosition: "Директор",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(profile.response.status, 200);

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase2 клиент", phone: "+77015550021" }),
    });
    contactId = created.body.client?.id || created.body.id;
    assert.ok(contactId);

    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase2 сайт",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    assert.equal(deal.response.status, 201);
    dealId = deal.body.deal.id;
  });

  after(() => {
    server?.close();
  });

  it("не даёт собрать PDF без компании покупателя", async () => {
    const ready = await json(`/api/v1/deals/${dealId}/contract-readiness`);
    assert.equal(ready.response.status, 200);
    assert.equal(ready.body.ready, false);
    assert.ok(ready.body.missingFields.includes("customer.company"));

    const draft = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(draft.response.status, 201);
    contractId = draft.body.contract.id;

    const generated = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(generated.response.status, 422);
    assert.equal(generated.body.code, "missing_fields");
    assert.equal(generated.body.details.ready, false);
    assert.ok(generated.body.details.missingFields.includes("customer.company"));
  });

  it("пишет PDF, hash и READY_TO_SIGN, повтор с тем же содержимым не плодит версию", async () => {
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase2 Buyer",
        legalName: "ТОО Phase2 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));

    const linked = await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });
    assert.equal(linked.response.status, 200);
    assert.equal(linked.body.deal.company.id, company.body.id);

    const ready = await json(`/api/v1/deals/${dealId}/contract-readiness`);
    assert.equal(ready.body.ready, true);

    const first = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(first.response.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.contract.status, "READY_TO_SIGN");
    assert.ok(first.body.contract.generatedFileId);
    assert.ok(first.body.version.sha256);
    assert.equal(first.body.version.version, 1);
    generatedFileId = first.body.contract.generatedFileId;

    const attachment = await prisma.attachment.findFirst({
      where: { id: generatedFileId },
    });
    assert.ok(attachment);
    assert.equal(attachment?.mimeType, "application/pdf");
    assert.equal(attachment?.checksum, first.body.version.sha256);

    const second = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(second.body.reused, true);
    assert.equal(second.body.contract.generatedFileId, generatedFileId);
    assert.equal(second.body.version.version, 1);

    const pdf = await fetch(`${base}/api/v1/contracts/${contractId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("content-type") || "", /pdf/);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString("utf8"), "%PDF");
  });

  it("не отдаёт PDF другому тенанту и блокирует пересборку после ухода в подпись", async () => {
    const foreign = await fetch(`${base}/api/v1/contracts/${contractId}/pdf`, {
      headers: { cookie: otherCookie },
    });
    assert.equal(foreign.status, 404);

    const changed = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({ paymentTerms: "100% предоплата" }),
    });
    assert.equal(changed.response.status, 200);
    assert.equal(changed.body.reused, false);
    assert.equal(changed.body.version.version, 2);

    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "PENDING_SIGNATURE" },
    });
    const locked = await json(`/api/v1/contracts/${contractId}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(locked.response.status, 422);
    assert.equal(locked.body.code, "contract_immutable");
  });
});
