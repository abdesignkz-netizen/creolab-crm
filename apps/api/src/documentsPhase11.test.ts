import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";

describe("Documents phase 11 AI-команды", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";
  let dealId = "";
  let dealTitle = "Phase11 документы";

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
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANYMODEL_API_KEY;
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
        documentsEnabled: true,
      }),
    });
    const created = await json("/api/v1/contacts", {
      method: "POST",
      body: JSON.stringify({ name: "Phase11 клиент", phone: "+77015550093" }),
    });
    const contactId = created.body.client?.id || created.body.id;
    const deal = await json("/api/v1/deals", {
      method: "POST",
      body: JSON.stringify({
        title: dealTitle,
        contactId,
        items: [{ name: "Сопровождение", quantity: 1, unitPrice: 150000 }],
      }),
    });
    dealId = deal.body.deal.id;
    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО Phase11 Buyer",
        legalName: "ТОО Phase11 Buyer",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Кабанбай 12",
        forceCreate: true,
      }),
    });
    await json(`/api/v1/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ companyId: company.body.id }),
    });
  });

  after(() => {
    server?.close();
  });

  it("парсит юридические команды и не ломает КП / WhatsApp договор", async () => {
    const contract = await json("/api/v1/tasks/parse-command", {
      method: "POST",
      body: JSON.stringify({ text: `Сформируй договор по сделке ${dealTitle}` }),
    });
    assert.equal(contract.response.status, 200, JSON.stringify(contract.body));
    assert.equal(contract.body.command.intent, "document_action");
    assert.equal(contract.body.command.documentAction, "generate_contract");
    assert.equal(contract.body.asCampaign, false);
    assert.ok(contract.body.document.deals.some((row: { id: string }) => row.id === dealId));

    const whatsapp = await json("/api/v1/tasks/parse-command", {
      method: "POST",
      body: JSON.stringify({ text: "Отправь договор Ивану" }),
    });
    assert.equal(whatsapp.body.command.taskType, "send_documents");
    assert.notEqual(whatsapp.body.command.intent, "document_action");

    const proposal = await json("/api/v1/tasks/parse-command", {
      method: "POST",
      body: JSON.stringify({ text: "Отправь КП вчерашним клиентам" }),
    });
    assert.equal(proposal.body.command.intent, "send_proposal");

    const esf = await json("/api/v1/tasks/parse-command", {
      method: "POST",
      body: JSON.stringify({ text: "Отправь ЭСФ в ИС ЭСФ" }),
    });
    assert.equal(esf.body.command.documentAction, "send_esf");
  });

  it("выполняет команду договора и не отдаёт чужому тенанту", async () => {
    const draft = await json("/api/v1/documents/from-command", {
      method: "POST",
      body: JSON.stringify({
        text: `Подготовь черновик договора по сделке ${dealTitle}`,
        action: "generate_contract",
        dealId,
      }),
    });
    assert.equal(draft.response.status, 200, JSON.stringify(draft.body));
    assert.equal(draft.body.prepareOnly, true);
    assert.equal(draft.body.result.contract?.status, "DRAFT");
    assert.equal(draft.body.result.contract?.generatedFileId, null);

    const created = await json("/api/v1/documents/from-command", {
      method: "POST",
      body: JSON.stringify({ text: `Сформируй договор по сделке ${dealTitle}`, dealId }),
    });
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    assert.equal(created.body.action, "generate_contract");
    assert.equal(created.body.prepareOnly, false);
    assert.equal(created.body.deal.id, dealId);
    assert.ok(created.body.result.contract?.id || created.body.result.contract);
    assert.ok(created.body.result.contract?.generatedFileId);

    const foreign = await json(
      "/api/v1/documents/from-command",
      {
        method: "POST",
        body: JSON.stringify({ text: `Сформируй договор по сделке ${dealTitle}`, dealId }),
      },
      otherCookie,
    );
    assert.equal(foreign.response.status, 422);
  });

  it("situation ask ведёт документную команду в /documents", async () => {
    const asked = await json("/api/v1/situation/ask", {
      method: "POST",
      body: JSON.stringify({ text: "Сформируй договор" }),
    });
    assert.equal(asked.response.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.command, true);
    assert.equal(asked.body.documentCommand, true);
    assert.ok(String(asked.body.links?.[0]?.href || "").startsWith("/documents?command="));

    const validate = await json("/api/v1/situation/ask", {
      method: "POST",
      body: JSON.stringify({ text: "Проверь АВР" }),
    });
    assert.equal(validate.body.documentCommand, true);
    assert.ok(String(validate.body.links?.[0]?.href || "").startsWith("/documents?command="));
  });
});
