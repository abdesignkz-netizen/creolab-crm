import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { readFile } from "node:fs/promises";
import { makeTestCms } from "./testCms.ts";
import { pemFromCms } from "./services/cmsInspect.ts";
import { resolveUploadPath } from "./lib/storage.ts";
import { createApp } from "./app.ts";
import { mockSetInvoiceStatus, resetEsfMock } from "./integrations/esf/EsfMock.ts";

describe("Documents phase 8 ЭСФ → syncInvoice", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
  let avrId = "";
  let esfId = "";

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
    process.env.ESF_ENV = "off";
    process.env.ESF_PROVIDER = "mock";
    delete process.env.ESF_ALLOW_LIVE_SEND;
    resetEsfMock();
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    await (await import("./services/runtimeSettings.ts")).savePlatformSettings(prisma, { features: { esf: true } });
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
        bankName: "Kaspi",
        iban: "KZ123456789012345678",
        bik: "CASPKZKA",
        defaultVatMode: "percent",
        defaultVatRate: 12,
        defaultCatalogTruId: "1",
        esfIntegrationEnabled: true,
      }),
    });

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase8 клиент", phone: "+77015550081" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase8 ЭСФ syncInvoice",
        contactId,
        items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase8 Buyer",
        legalName: "ТОО Phase8 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 10",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });
    const contract = await json(`/api/v1/deals/${dealId}/contracts`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.notEqual(contract.body.contract.status, "SIGNED");
    const avr = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "AVR" }),
    });
    avrId = avr.body.document.id;
    const validated = await json(`/api/v1/electronic-documents/${avrId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    const sentAvr = await json(`/api/v1/electronic-documents/${avrId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sentAvr.response.status, 200, JSON.stringify(sentAvr.body));
    const esf = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "ESF" }),
    });
    esfId = esf.body.document.id;
    const validatedEsf = await json(`/api/v1/electronic-documents/${esfId}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validatedEsf.response.status, 200, JSON.stringify(validatedEsf.body));
    assert.equal(validatedEsf.body.document.contractId,contract.body.contract.id);
    assert.notEqual(validatedEsf.body.document.source.contract.status,"SIGNED");
    assert.equal((await prisma.contract.findUniqueOrThrow({where:{id:contract.body.contract.id}})).signedAt,null);
  });

  after(() => {
    server?.close();
  });

  it("собирает InvoiceV2 и отправляет через mock даже с неподписанным договором", async () => {
    assert.equal(await prisma.invoice.count({where:{dealId}}),0,"Счёт на оплату отсутствует");
    const readiness = await json(`/api/v1/deals/${dealId}/esf-invoice-readiness`);
    assert.equal(readiness.body.ready,true);
    assert.match(readiness.body.warnings[0], /не подписан/);
    assert.equal(readiness.body.invoiceId,null);
    const stored = await prisma.electronicDocument.findUniqueOrThrow({where:{id:esfId}});
    assert.equal(stored.invoiceId,null);
    assert.equal((stored.sourceDataJson as any).invoice,null);
    const preview = await json(`/api/v1/electronic-documents/${esfId}/esf-preview`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.version, "InvoiceV2");
    assert.equal(preview.body.validation.valid, true, JSON.stringify(preview.body.validation));
    assert.match(preview.body.xml, /<v2:invoice /);
    assert.match(preview.body.xml, /<catalogTruId>1<\/catalogTruId>/);
    assert.match(preview.body.xml, /<truOriginCode>6<\/truOriginCode>/);
    assert.match(preview.body.xml, /<num>\d+<\/num>/);
    assert.deepEqual(preview.body.operations, ["createSession", "syncInvoice", "queryInvoiceById"]);
    assert.match(preview.body.envelopes.syncInvoice, /syncInvoiceRequest/);

    const sent = await json(`/api/v1/electronic-documents/${esfId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.provider, "mock");
    assert.equal(sent.body.document.status, "SENT");
    assert.equal(await prisma.invoice.count({where:{dealId}}),0,"ЭСФ отправляется без создания счёта на оплату");
    assert.ok(sent.body.externalId);
    assert.equal(sent.body.externalStatus, "CREATED");
    assert.equal(sent.body.document.externalSystem, "ESF_INVOICE");

    const again = await json(`/api/v1/electronic-documents/${esfId}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(again.response.status, 200);
    assert.equal(again.body.reused, true);
    assert.equal(again.body.externalId, sent.body.externalId);
  });

  it("обновляет official статус queryInvoiceById и ставит ACCEPTED на DELIVERED", async () => {
    const current = await json(`/api/v1/electronic-documents/${esfId}`);
    const invoiceId = current.body.document.externalId;
    mockSetInvoiceStatus(invoiceId, "DELIVERED");
    const refreshed = await json(`/api/v1/electronic-documents/${esfId}/esf-refresh`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.body));
    assert.equal(refreshed.body.operation, "queryInvoiceById");
    assert.equal(refreshed.body.externalStatus, "DELIVERED");
    assert.equal(refreshed.body.document.status, "ACCEPTED");
    assert.ok(refreshed.body.document.acceptedAt);
  });

  it("не отдаёт ЭСФ другого тенанта и не шлёт без АВР", async () => {
    const foreign = await json(`/api/v1/electronic-documents/${esfId}`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);

    const extraContact = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase8 extra", phone: "+77015550082" }),
    });
    const otherDeal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Phase8 без АВР",
        contactId: extraContact.body.client?.id || extraContact.body.id,
        items: [{ name: "Услуга", quantity: 1, unitPrice: 10000 }],
      }),
    });
    const extraDealId = otherDeal.body.deal.id;
    const extraCompany = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase8 Extra",
        legalName: "ТОО Phase8 Extra",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 11",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${extraDealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: extraCompany.body.id }),
    });
    await json(`/api/v1/deals/${extraDealId}/contracts`, { method: "POST", body: JSON.stringify({}) });
    const contract = await json(`/api/v1/deals/${extraDealId}/documents`);
    const contractId = contract.body.contracts[0].id;
    await prisma.contract.update({
      where: { id: contractId },
      data: { status: "SIGNED", signedAt: new Date() },
    });
    const esf = await json(`/api/v1/deals/${extraDealId}/electronic-documents`, {
      method: "POST",
      body: JSON.stringify({ type: "ESF" }),
    });
    const validated = await json(`/api/v1/electronic-documents/${esf.body.document.id}/validate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(validated.response.status, 200, JSON.stringify(validated.body));
    const blocked = await json(`/api/v1/electronic-documents/${esf.body.document.id}/esf-send`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(blocked.response.status, 422);
    assert.equal(blocked.body.code, "avr_not_sent");
  });
  async function freshEsf() {
    const original = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    const deal = await json("/api/v1/deals", { method: "POST", body: JSON.stringify({
      title: "ЭСФ: регрессия", contactId: original.contactId,
      items: [
        { name: "Услуга первая", quantity: 1, unitPrice: 10000 },
        { name: "Услуга вторая", quantity: 1, unitPrice: 20000 },
      ],
    }) });
    assert.equal(deal.response.status, 201, JSON.stringify(deal.body));
    await prisma.deal.update({ where: { id: deal.body.deal.id }, data: { companyId: original.companyId } });
    const created = await json(`/api/v1/deals/${deal.body.deal.id}/electronic-documents`, {
      method: "POST", body: JSON.stringify({ type: "ESF" }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    return { id: created.body.document.id as string, dealId: deal.body.deal.id as string, tenantId: original.tenantId };
  }

  const post = { method: "POST", body: "{}" };

  it("не считает локально подписанный или отклонённый АВР основанием готовности к отправке ЭСФ", async () => {
    const doc = await freshEsf();
    await json(`/api/v1/electronic-documents/${doc.id}/validate`, post);
    const avr = await json(`/api/v1/deals/${doc.dealId}/electronic-documents`, {
      method: "POST", body: JSON.stringify({ type: "AVR" }),
    });
    for (const data of [
      { externalSystem: "BASQAR", status: "ACCEPTED" as const },
      { externalSystem: "ESF_AWP", status: "REJECTED" as const },
    ]) {
      await prisma.electronicDocument.update({ where: { id: avr.body.document.id }, data: { ...data, externalId: "not-an-active-portal-act" } });
      const readiness = await json(`/api/v1/deals/${doc.dealId}/esf-invoice-readiness`);
      assert.equal(readiness.body.sendReady, false);
      assert.ok(readiness.body.missingFields.includes("avr.sent"));
      for (const endpoint of ["esf-send", "esf-send-signed"]) {
        const sent = await json(`/api/v1/electronic-documents/${doc.id}/${endpoint}`, endpoint === "esf-send" ? post : {
          method: "POST", body: JSON.stringify({ signature: Buffer.alloc(64, 7).toString("base64"), publicCertificate: pemFromCms(makeTestCms(Buffer.from("SIGN"))) }),
        });
        assert.equal(sent.response.status, 422, JSON.stringify(sent.body));
        assert.equal(sent.body.code, "avr_not_sent");
      }
    }
  });

  it("повторное создание возвращает принятый ЭСФ, даже если остался старый черновик", async () => {
    const accepted = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: esfId } });
    assert.equal(accepted.status, "ACCEPTED");
    await prisma.electronicDocument.create({ data: {
      tenantId: accepted.tenantId, dealId, type: "ESF", number: "999999", status: "DRAFT", amountWithoutVat: 1, vatAmount: 0, totalAmount: 1,
    } });
    const result = await json(`/api/v1/deals/${dealId}/electronic-documents`, {
      method: "POST", body: JSON.stringify({ type: "ESF" }),
    });
    assert.equal(result.body.document.id, esfId);
    assert.equal(result.body.reused, true);
  });

  it("не создаёт второй ЭСФ во время отправки и не меняет XML отправляемого документа", async () => {
    const doc = await freshEsf();
    await json(`/api/v1/electronic-documents/${doc.id}/validate`, post);
    await json(`/api/v1/electronic-documents/${doc.id}/esf-preview`, post);
    const sending = await prisma.electronicDocument.update({ where: { id: doc.id }, data: { status: "SENDING" } });
    const create = await json(`/api/v1/deals/${doc.dealId}/electronic-documents`, {
      method: "POST", body: JSON.stringify({ type: "ESF" }),
    });
    assert.equal(create.body.document.id, doc.id);
    const preview = await json(`/api/v1/electronic-documents/${doc.id}/esf-preview`, post);
    assert.equal(preview.response.status, 409);
    const stored = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.equal(stored.xmlStorageKey, sending.xmlStorageKey);
    assert.equal(stored.updatedAt.getTime(), sending.updatedAt.getTime());
  });

  it("повторная проверка сбрасывает XML, сохраняя байты предыдущей подписываемой версии", async () => {
    const doc = await freshEsf();
    await json(`/api/v1/electronic-documents/${doc.id}/validate`, post);
    const first = await json(`/api/v1/electronic-documents/${doc.id}/esf-preview`, post);
    const original = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.ok(original.xmlStorageKey);
    await prisma.dealItem.updateMany({ where: { dealId: doc.dealId }, data: { name: "Обновлённая услуга" } });
    const validation = await json(`/api/v1/electronic-documents/${doc.id}/validate`, post);
    assert.equal(validation.response.status, 200, JSON.stringify(validation.body));
    assert.equal((await prisma.electronicDocument.findUniqueOrThrow({ where: { id: doc.id } })).xmlStorageKey, null);
    const second = await json(`/api/v1/electronic-documents/${doc.id}/esf-preview`, post);
    assert.match(second.body.xml, /Обновлённая услуга/);
    const revised = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: doc.id } });
    assert.notEqual(revised.xmlStorageKey, original.xmlStorageKey);
    assert.equal(await readFile(resolveUploadPath(original.xmlStorageKey!), "utf8"), first.body.xml);
  });

  it("проверяет ТРУ у каждой позиции, а не только у первой заполненной", async () => {
    const doc = await freshEsf();
    const profile = await prisma.tenantLegalProfile.findUniqueOrThrow({ where: { tenantId: doc.tenantId } });
    try {
      await prisma.tenantLegalProfile.update({ where: { tenantId: doc.tenantId }, data: { defaultCatalogTruId: null } });
      const items = await prisma.dealItem.findMany({ where: { dealId: doc.dealId }, orderBy: { sortOrder: "asc" } });
      await prisma.dealItem.update({ where: { id: items[0].id }, data: { catalogTruId: "1" } });
      const readiness = await json(`/api/v1/deals/${doc.dealId}/esf-invoice-readiness`);
      assert.equal(readiness.body.ready, false);
      const validation = await json(`/api/v1/electronic-documents/${doc.id}/validate`, post);
      assert.equal(validation.response.status, 422);
      assert.match(validation.body.message, /ТРУ/);
      assert.match(validation.body.message, /2/);
      await prisma.dealItem.update({ where: { id: items[1].id }, data: { catalogTruId: "2" } });
      assert.equal((await json(`/api/v1/electronic-documents/${doc.id}/validate`, post)).response.status, 200);
    } finally {
      await prisma.tenantLegalProfile.update({ where: { tenantId: doc.tenantId }, data: { defaultCatalogTruId: profile.defaultCatalogTruId } });
    }
  });

  it("предпросмотр принятого ЭСФ не перезаписывает XML и служебные поля", async () => {
    const original = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: esfId } });
    const preview = await json(`/api/v1/electronic-documents/${esfId}/esf-preview`, post);
    assert.equal(preview.response.status, 200);
    const after = await prisma.electronicDocument.findUniqueOrThrow({ where: { id: esfId } });
    assert.equal(after.xmlStorageKey, original.xmlStorageKey);
    assert.equal(after.updatedAt.getTime(), original.updatedAt.getTime());
  });

  for (const type of ["AVR", "ESF"]) {
    it(`${type}: сохраняет номер принятого документа, даже если следующий запрос статуса оборвался`, async () => {
      const doc = await freshEsf();
      const avr = await json(`/api/v1/deals/${doc.dealId}/electronic-documents`, {
        method: "POST", body: JSON.stringify({ type: "AVR" }),
      });
      const id = type === "AVR" ? avr.body.document.id : doc.id;
      if (type === "ESF") await prisma.electronicDocument.update({ where: { id: avr.body.document.id }, data: {
        status: "SENT", externalSystem: "ESF_AWP", externalId: `awp-${doc.id}`,
      } });
      await json(`/api/v1/electronic-documents/${id}/validate`, post);
      const prepared = await json(`/api/v1/electronic-documents/${id}/esf-payload`, post);
      assert.equal(prepared.response.status, 200, JSON.stringify(prepared.body));
      await prisma.esfConnection.upsert({ where: { tenantId_environment: { tenantId: doc.tenantId, environment: "test" } },
        create: { tenantId: doc.tenantId, environment: "test", status: "CONNECTED", sessionId: "isolated-test-session" },
        update: { status: "CONNECTED", sessionId: "isolated-test-session" },
      });
      const originalFetch = globalThis.fetch;
      const previousEnv = { ...process.env };
      let uploads = 0;
      const remoteId = `registered-${type}-${doc.id}`;
      const intercepted = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).startsWith(base)) return originalFetch(url, init);
        assert.equal(new URL(String(url)).hostname, "test3.esf.kgd.gov.kz");
        const body = String(init?.body);
        if (body.includes("currentSessionStatusRequest")) return new Response("<Envelope><status>OK</status></Envelope>");
        if (body.includes("syncInvoiceRequest") || body.includes("awpUploadRequest")) {
          uploads++;
          return new Response(type === "ESF"
            ? `<Envelope><Body><syncInvoiceResponse><acceptedSet><standardResponse><id>${remoteId}</id></standardResponse></acceptedSet></syncInvoiceResponse></Body></Envelope>`
            : `<Envelope><Body><awpUploadResponse><acceptedList><awpUploadResult><awpId>${remoteId}</awpId></awpUploadResult></acceptedList></awpUploadResponse></Body></Envelope>`);
        }
        throw new Error("Simulated status connection failure after acceptance");
      });
      try {
        Object.assign(process.env, { ESF_ENV: "test", ESF_PROVIDER: "live", ESF_ALLOW_LIVE_SEND: "1", ESF_TLS_INSECURE: "0" });
        const raw = { signature: Buffer.alloc(64, 7).toString("base64"),
          publicCertificate: pemFromCms(makeTestCms(Buffer.from("SIGN"))), payloadSha256: prepared.body.payloadSha256 };
        const sent = await json(`/api/v1/electronic-documents/${id}/esf-send-signed`, { method: "POST", body: JSON.stringify(raw) });
        assert.equal(sent.response.status, 200, JSON.stringify(sent.body));
        const stored = await prisma.electronicDocument.findUniqueOrThrow({ where: { id } });
        assert.equal(stored.externalId, remoteId);
        assert.equal(stored.status, "SENT");
        const repeat = await json(`/api/v1/electronic-documents/${id}/esf-send-signed`, { method: "POST", body: JSON.stringify(raw) });
        assert.equal(repeat.response.status, 200, JSON.stringify(repeat.body));
        assert.equal(repeat.body.reused, true);
        await prisma.electronicDocument.update({ where: { id }, data: { status: "REJECTED" } });
        const rejected = await json(`/api/v1/electronic-documents/${id}/esf-send-signed`, { method: "POST", body: JSON.stringify(raw) });
        assert.equal(rejected.response.status, 200, JSON.stringify(rejected.body));
        assert.equal(rejected.body.reused, true);
        assert.equal(rejected.body.document.status, "REJECTED");
        assert.equal(uploads, 1);
        assert.equal(await prisma.outboxEvent.count({ where: { entityId: id, type: type === "ESF" ? "esf.sent" : "avr.sent" } }), 1);
      } finally {
        intercepted.mock.restore();
        for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
        Object.assign(process.env, previousEnv);
      }
    });
  }

});
