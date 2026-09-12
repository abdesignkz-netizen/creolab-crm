import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, mock, test } from "node:test";
import type { Server } from "node:http";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { makeTestCms } from "./testCms.ts";
import { mockSetAwpStatus, mockSetInvoiceStatus, resetEsfMock } from "./integrations/esf/EsfMock.ts";
import { processOutbox } from "./services/backgroundJobs.ts";

// Run with scripts/test-api.mjs: it supplies a separate temporary database and storage.
// Only the external ESF service and signing certificates are synthetic. Business state
// is changed through HTTP, including both contract signatures (no forced SIGNED rows).
let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
let server: Server;
let base = "";
let cookie = "";
let otherCookie = "";
let inquiryId = "";
let contactId = "";
let companyId = "";
let dealId = "";
let contractId = "";
let invoiceId = "";
let avrId = "";
let esfId = "";
const expected = { amountWithoutVat: 250000, vatAmount: 40000, totalAmount: 290000 };

async function request(path: string, method = "GET", data?: unknown, status = 200, session = cookie, headers = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", cookie: session, ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const body = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
  return { body, response };
}
function totals(value: Record<string, unknown>) {
  for (const [key, amount] of Object.entries(expected)) assert.equal(value[key], amount, key);
}

before(async () => {
  assert.equal(process.env.CRM_USE_PGLITE, "1", "Use the isolated test runner");
  assert.ok(process.env.CRM_PGLITE_DIR);
  assert.ok(process.env.STORAGE_DIR);
  process.env.ESF_PROVIDER = "mock";
  process.env.ESF_ENV = "off";
  process.env.ESF_ALLOW_LIVE_SEND = "0";
  process.env.CRM_INLINE_AUTOMATION = "0";
  resetEsfMock();
  prisma = await createPrismaClient();
  const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
  await seedDatabase();
  server = createApp(prisma).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, base, "The full-cycle test must never send external requests");
    return realFetch(input, init);
  });
  for (const email of ["owner@creolab.example", "owner@demo-agency.example"]) {
    const login = await request("/api/v1/auth/login", "POST", {
      email, password: process.env.SEED_PASSWORD, client: "web",
    }, 200, "");
    const session = (login.response.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(session);
    if (email === "owner@creolab.example") cookie = session;
    else otherCookie = session;
  }
  await request("/api/v1/settings/legal-profile", "PATCH", {
    legalName: "ТОО CREOLAB", bin: "123456789013", legalAddress: "Тестовый адрес исполнителя",
    directorName: "Тестовый Директор", directorPosition: "Директор",
    bankName: "Тестовый банк", iban: "KZ86125KZT5004100100", bik: "KCJBKZKX",
    defaultVatMode: "percent", defaultVatRate: 16, defaultCatalogTruId: "1",
    contractSigningEnabled: true, esfIntegrationEnabled: true,
  });
});
after(async () => {
  mock.restoreAll();
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  await prisma?.$disconnect();
});

test("CRM: public form → inquiry → deal → signed contract → invoice → AVR → ESF (mock)", async (t) => {
  let blocked = false;
  async function step(name: string, run: () => Promise<void>) {
    await t.test(name, { skip: blocked ? "Предыдущий этап не пройден" : false }, async () => {
      try { await run(); } catch (error) { blocked = true; throw error; }
    });
  }
  await step("форма создаёт одну заявку и контакт; повтор не дублирует заявку", async () => {
    const payload = { name: "Сквозной тест CRM", phone: "+7 701 999 88 77", message: "Нужен сайт и аудит" };
    const first = await request("/public/forms/frm_creolab_site_demo/submissions", "POST", payload, 202, "", { "x-submission-id": "crm-full-cycle" });
    const second = await request("/public/forms/frm_creolab_site_demo/submissions", "POST", payload, 200, "", { "x-submission-id": "crm-full-cycle" });
    assert.equal(second.body.receipt, first.body.receipt);
    const list = await request("/api/v1/inquiries?filter=all");
    const matches = list.body.items.filter((row: { contactName: string }) => row.contactName === payload.name);
    assert.equal(matches.length, 1);
    inquiryId = matches[0].id;
    const detail = await request(`/api/v1/inquiries/${inquiryId}`);
    contactId = detail.body.contactId;
    assert.ok(contactId);
    const lookup = await request("/api/v1/inquiries/lookup-contact", "POST", { phone: payload.phone });
    assert.equal(lookup.body.contact.id, contactId);
  });

  await step("взятие заявки в работу и повторная конвертация сохраняют одну сделку", async () => {
    const taken = await request(`/api/v1/inquiries/${inquiryId}/take`, "POST", {});
    assert.equal(taken.body.status, "in_progress");
    const converted = await request(`/api/v1/inquiries/${inquiryId}/convert-to-deal`, "POST", { title: "Сквозной тест: сайт и аудит" });
    dealId = converted.body.id;
    assert.equal(converted.body.contactId, contactId);
    assert.equal(converted.body.inquiryId, inquiryId);
    const repeated = await request(`/api/v1/inquiries/${inquiryId}/convert-to-deal`, "POST", {});
    assert.equal(repeated.body.id, dealId);
    const detail = await request(`/api/v1/inquiries/${inquiryId}`);
    assert.equal(detail.body.status, "converted");
    assert.equal(detail.body.dealId, dealId);
    assert.equal(await prisma.deal.count({ where: { inquiryId } }), 1);
  });

  await step("реквизиты и две позиции сделки: 250 000 + 40 000 НДС = 290 000 ₸", async () => {
    const company = await request("/api/v1/companies", "POST", {
      name: "ТОО Сквозной тест", legalName: "ТОО Сквозной тест", bin: "222222222220",
      legalAddress: "Тестовый адрес заказчика", forceCreate: true,
    }, 201);
    companyId = company.body.id;
    await request(`/api/v1/deals/${dealId}`, "PATCH", { companyId });
    for (const item of [
      { name: "Разработка сайта", quantity: 2, unitPrice: 100000 },
      { name: "Аудит", quantity: 1, unitPrice: 50000 },
    ]) await request(`/api/v1/deals/${dealId}/items`, "POST", { ...item, vatRate: 16 }, 201);
    const items = await request(`/api/v1/deals/${dealId}/items`);
    assert.equal(items.body.items.length, 2);
    totals(items.body.totals);
  });

  await step("до подписания договор блокирует выпуск счёта и валидацию АВР", async () => {
    const draft = await request(`/api/v1/deals/${dealId}/contracts`, "POST", {}, 201);
    contractId = draft.body.contract.id;
    totals(draft.body.contract);
    await request(`/api/v1/contracts/${contractId}/generate`, "POST", {});
    const invoice = await request(`/api/v1/deals/${dealId}/invoices`, "POST", {}, 201);
    invoiceId = invoice.body.invoice.id;
    const blocked = await request(`/api/v1/invoices/${invoiceId}/generate`, "POST", {}, 422);
    assert.ok(blocked.body.details.missingFields.includes("contract.signed"));
    const avr = await request(`/api/v1/deals/${dealId}/electronic-documents`, "POST", { type: "AVR", invoiceId }, 201);
    avrId = avr.body.document.id;
    const validation = await request(`/api/v1/electronic-documents/${avrId}/validate`, "POST", {}, 422);
    assert.ok(validation.body.details.missingFields.includes("contract.signed"));
  });

  await step("подписи исполнителя и заказчика проверяют один PDF и закрывают договор", async () => {
    const signing = await request(`/api/v1/contracts/${contractId}/send-for-sign`, "POST", {});
    assert.equal(signing.body.contract.status, "PENDING_SIGNATURE");
    const seller = signing.body.requests.find((r: { signerType: string }) => r.signerType === "SELLER");
    const buyer = signing.body.requests.find((r: { signerType: string }) => r.signerType === "BUYER");
    const token = buyer.signUrl.split("/sign/")[1];
    const early = await request(`/public/sign/${token}`, "GET", undefined, 200, "");
    assert.equal(early.body.canSign, false);
    const response = await fetch(`${base}/api/v1/contracts/${contractId}/pdf`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    const signedSeller = await request(`/api/v1/signature-requests/${seller.id}/sign`, "POST", {
      cmsBase64: makeTestCms(bytes, { iin: "123456789013", bin: "123456789013" }),
    });
    assert.equal(signedSeller.body.contract.status, "PARTIALLY_SIGNED");
    const signedBuyer = await request(`/public/sign/${token}/sign`, "POST", {
      cmsBase64: makeTestCms(bytes, { iin: "222222222220", bin: "222222222220" }),
    }, 200, "");
    assert.equal(signedBuyer.body.bothSigned, true);
    assert.equal(signedBuyer.body.contractStatus, "SIGNED");
    const state = await request(`/api/v1/contracts/${contractId}/signing`);
    const verificationId = state.body.verificationUrl.split("/verify/")[1];
    const verified = await request(`/public/verify/${verificationId}`, "GET", undefined, 200, "");
    assert.equal(verified.body.signers.length, 2);
    assert.equal(verified.body.documentHash, createHash("sha256").update(bytes).digest("hex"));
    const immutable = await request(`/api/v1/contracts/${contractId}/generate`, "POST", {}, 422);
    assert.equal(immutable.body.code, "contract_immutable");
  });

  await step("событие подписания не дублирует счёт; выпуск PDF устанавливает INVOICED", async () => {
    await processOutbox(prisma);
    await processOutbox(prisma);
    assert.equal(await prisma.invoice.count({ where: { dealId } }), 1);
    const draft = await request(`/api/v1/deals/${dealId}/invoices`, "POST", {}, 201);
    assert.equal(draft.body.invoice.id, invoiceId);
    assert.equal(draft.body.invoice.contractId, contractId);
    const issued = await request(`/api/v1/invoices/${invoiceId}/generate`, "POST", {});
    assert.equal(issued.body.invoice.status, "ISSUED");
    totals(issued.body.invoice);
    assert.equal(issued.body.invoice.items.length, 2);
    const pdf = await fetch(`${base}/api/v1/invoices/${invoiceId}/pdf`, { headers: { cookie } });
    assert.equal(pdf.status, 200);
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), "%PDF");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), issued.body.sha256);
    const again = await request(`/api/v1/invoices/${invoiceId}/generate`, "POST", {});
    assert.equal(again.body.reused, true);
    assert.equal(again.body.invoice.pdfFileId, issued.body.invoice.pdfFileId);
    const deal = await request(`/api/v1/deals/${dealId}`);
    assert.equal(deal.body.deal.paymentStatus, "INVOICED");
  });

  await step("ЭСФ без отправленного АВР блокируется", async () => {
    const draft = await request(`/api/v1/deals/${dealId}/electronic-documents`, "POST", { type: "ESF", invoiceId, contractId }, 201);
    esfId = draft.body.document.id;
    await request(`/api/v1/electronic-documents/${esfId}/validate`, "POST", {});
    const blocked = await request(`/api/v1/electronic-documents/${esfId}/esf-send`, "POST", {}, 422);
    assert.equal(blocked.body.code, "avr_not_sent");
  });

  await step("АВР: обновлённый договор, валидный XML, отправка и подтверждение mock", async () => {
    const refreshed = await request(`/api/v1/deals/${dealId}/electronic-documents`, "POST", { type: "AVR", invoiceId, contractId }, 201);
    assert.equal(refreshed.body.document.id, avrId);
    const valid = await request(`/api/v1/electronic-documents/${avrId}/validate`, "POST", {});
    assert.equal(valid.body.document.status, "VALIDATED");
    totals(valid.body.document);
    assert.equal(valid.body.document.contractId, contractId);
    assert.equal(valid.body.document.invoiceId, invoiceId);
    const preview = await request(`/api/v1/electronic-documents/${avrId}/esf-preview`, "POST", {});
    assert.equal(preview.body.validation.valid, true);
    assert.equal(preview.body.version, "AwpV1");
    const sent = await request(`/api/v1/electronic-documents/${avrId}/esf-send`, "POST", {});
    assert.equal(sent.body.provider, "mock");
    assert.equal(sent.body.document.status, "SENT");
    assert.ok(sent.body.externalId);
    const again = await request(`/api/v1/electronic-documents/${avrId}/esf-send`, "POST", {});
    assert.equal(again.body.reused, true);
    assert.equal(again.body.externalId, sent.body.externalId);
    mockSetAwpStatus(sent.body.externalId, "CONFIRMED");
    const accepted = await request(`/api/v1/electronic-documents/${avrId}/esf-refresh`, "POST", {});
    assert.equal(accepted.body.document.status, "ACCEPTED");
    assert.ok(accepted.body.document.acceptedAt);
    t.diagnostic(`AVR mock externalId: ${sent.body.externalId}`);
  });

  await step("ЭСФ: валидный InvoiceV2, отправка и доставка mock без дублей", async () => {
    const preview = await request(`/api/v1/electronic-documents/${esfId}/esf-preview`, "POST", {});
    assert.equal(preview.body.validation.valid, true);
    assert.equal(preview.body.version, "InvoiceV2");
    const sent = await request(`/api/v1/electronic-documents/${esfId}/esf-send`, "POST", {});
    assert.equal(sent.body.provider, "mock");
    assert.equal(sent.body.document.status, "SENT");
    assert.equal(sent.body.document.externalSystem, "ESF_INVOICE");
    totals(sent.body.document);
    assert.equal(sent.body.document.contractId, contractId);
    assert.equal(sent.body.document.invoiceId, invoiceId);
    const again = await request(`/api/v1/electronic-documents/${esfId}/esf-send`, "POST", {});
    assert.equal(again.body.reused, true);
    assert.equal(again.body.externalId, sent.body.externalId);
    mockSetInvoiceStatus(sent.body.externalId, "DELIVERED");
    const accepted = await request(`/api/v1/electronic-documents/${esfId}/esf-refresh`, "POST", {});
    assert.equal(accepted.body.document.status, "ACCEPTED");
    assert.ok(accepted.body.document.acceptedAt);
    t.diagnostic(`ESF mock externalId: ${sent.body.externalId}`);
  });

  await step("вся цепочка изолирована от другой организации и сохраняет связи", async () => {
    for (const path of [
      `/api/v1/inquiries/${inquiryId}`, `/api/v1/deals/${dealId}`,
      `/api/v1/contracts/${contractId}/signing`, `/api/v1/invoices/${invoiceId}`,
      `/api/v1/electronic-documents/${avrId}`, `/api/v1/electronic-documents/${esfId}`,
    ]) await request(path, "GET", undefined, 404, otherCookie);
    const documents = await prisma.electronicDocument.findMany({ where: { dealId } });
    assert.equal(documents.length, 2);
    for (const document of documents) {
      assert.equal(document.status, "ACCEPTED");
      assert.equal(document.companyId, companyId);
      assert.equal(document.contractId, contractId);
      assert.equal(document.invoiceId, invoiceId);
      assert.equal(document.errorCode, null);
    }
    t.diagnostic(`Synthetic chain: inquiry=${inquiryId}, deal=${dealId}, contract=${contractId}, invoice=${invoiceId}`);
  });
});
