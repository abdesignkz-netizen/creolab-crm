import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 1", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let contactId = "";

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

    const login = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    }, "");
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: "owner@demo-agency.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    }, "");
    otherCookie = demo.response.headers.get("set-cookie") || "";

    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Документный клиент", phone: "+77015550001" }),
    });
    contactId = created.body.client?.id || created.body.id;
    assert.ok(contactId);
  });

  after(() => {
    server?.close();
  });

  it("сохраняет НДС по умолчанию в настройках, не в settingsJson", async () => {
    const saved = await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        defaultVatMode: "percent",
        defaultVatRate: 12,
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.defaultVatMode, "percent");
    assert.equal(saved.body.defaultVatRate, 12);

    const tenant = await prisma.tenant.findFirst({
      where: { slug: "creolab" },
      select: { id: true, settingsJson: true },
    });
    const settings = (tenant?.settingsJson || {}) as Record<string, unknown>;
    assert.equal(settings.defaultVatMode, undefined);
    const profile = await prisma.tenantLegalProfile.findUnique({ where: { tenantId: tenant!.id } });
    assert.equal(profile?.defaultVatMode, "percent");
  });

  it("создаёт сделку без заявки и повторяет POST с тем же ключом", async () => {
    const payload = {
      title: "Корпоративный сайт",
      contactId,
      items: [{ name: "Разработка сайта", quantity: 1, unitPrice: 850000 }],
    };
    const first = await json("/api/v1/deals", {
      method: "POST",
      headers: { "Idempotency-Key": "deal-manual-1" },
      body: JSON.stringify(payload),
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.body.deal.inquiryId, null);
    assert.equal(first.body.deal.amountFromItems, true);
    assert.equal(first.body.deal.items.length, 1);
    assert.equal(first.body.deal.itemTotals.totalAmount, 952000);

    const second = await json("/api/v1/deals", {
      method: "POST",
      headers: { "Idempotency-Key": "deal-manual-1" },
      body: JSON.stringify(payload),
    });
    assert.equal(second.body.deal.id, first.body.deal.id);

    const count = await prisma.deal.count({
      where: { title: "Корпоративный сайт", inquiryId: null },
    });
    assert.equal(count, 1);
  });

  it("не отдаёт сделку другого тенанта и не создаёт второй черновик договора", async () => {
    const created = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: "Изоляция",
        contactId,
        items: [{ name: "Аудит", quantity: 1, unitPrice: 100000, vatRate: 0 }],
      }),
    });
    const dealId = created.body.deal.id;
    const foreign = await json(`/api/v1/deals/${dealId}`, {}, otherCookie);
    assert.equal(foreign.response.status, 404);

    const a = await json(`/api/v1/deals/${dealId}/contracts`, { method: "POST", body: JSON.stringify({}) });
    const b = await json(`/api/v1/deals/${dealId}/contracts`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(a.response.status, 201);
    assert.equal(b.body.contract.id, a.body.contract.id);
    assert.equal(b.body.reused, true);

    const invoice = await json(`/api/v1/deals/${dealId}/invoices`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(invoice.response.status, 201);
    assert.equal(invoice.body.invoice.items[0].name, "Аудит");
    assert.equal(invoice.body.invoice.items[0].dealItemId, created.body.deal.items[0].id);
  });

  it("отклоняет чужой BIN и не подставляет НДС, пока ставка не выбрана", async () => {
    const demo = await json("/api/v1/settings/legal-profile", {}, otherCookie);
    assert.equal(demo.body.defaultVatMode, null);

    const contact = await json(
      "/api/v1/contacts",
      { method: "POST", body: JSON.stringify({ name: "Demo client", phone: "+77016660002" }) },
      otherCookie,
    );
    const demoContactId = contact.body.client?.id || contact.body.id;
    const deal = await json(
      "/api/v1/deals",
      {
        method: "POST",
        body: JSON.stringify({
          title: "Без НДС-настройки",
          contactId: demoContactId,
          items: [{ name: "Услуга", quantity: 1, unitPrice: 1000 }],
        }),
      },
      otherCookie,
    );
    assert.equal(deal.response.status, 422);
    assert.equal(deal.body.code, "vat_default_unset");
  });
});
