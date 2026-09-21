import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { encryptSecret } from "./lib/secretBox.ts";
import { setGreenApiFetchForTests } from "./services/greenApiWebhook.ts";

describe("Contact 360", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";

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
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@creolab.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    cookie = login.headers.get("set-cookie") || "";
    assert.ok(cookie);
  });

  after(() => {
    server?.close();
  });

  it("список клиентов отдаёт обогащённые строки", async () => {
    const response = await fetch(`${base}/api/v1/contacts`, { headers: { cookie } });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.length >= 1);
    const item = body.items[0];
    assert.ok(item.name);
    assert.ok("lifecycleLabel" in item);
    assert.ok("nextAction" in item || item.nextAction === null);
    assert.equal(typeof body.attention?.new, "number");
    assert.equal(typeof body.attention?.needsReply, "number");
  });

  it("цифра «Клиенты» в меню — новые клиенты, фильтр «нужен ответ» отдельно", async () => {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const fresh = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Новый клиент ${Date.now()}`,
        lifecycleStatus: "new",
        lastSeenAt: new Date(Date.now() - 86400_000 * 14),
      },
    });
    const veteran = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Уже в работе ${Date.now()}`,
        lifecycleStatus: "in_progress",
        lastSeenAt: new Date(),
      },
    });
    const waiting = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Ждёт ответа ${Date.now()}`,
        lifecycleStatus: "in_progress",
        lastInboundMessageAt: new Date(),
        lastOutboundMessageAt: new Date(Date.now() - 3600_000),
        lastSeenAt: new Date(Date.now() - 86400_000 * 7),
      },
    });
    const answered = await prisma.contact.create({
      data: {
        tenantId: tenant.id,
        name: `Уже ответили ${Date.now()}`,
        lifecycleStatus: "active",
        lastInboundMessageAt: new Date(Date.now() - 3600_000),
        lastOutboundMessageAt: new Date(),
        lastSeenAt: new Date(),
      },
    });

    const badgesRes = await fetch(`${base}/api/v1/nav-badges`, { headers: { cookie } });
    const badges = (await badgesRes.json()) as { badges: Record<string, number>; hrefs: Record<string, string>; hints: Record<string, string> };
    const allRes = await fetch(`${base}/api/v1/contacts?filter=all&limit=100`, { headers: { cookie } });
    const all = (await allRes.json()) as {
      attention: { new: number; needsReply: number };
      items: Array<{ id: string; needsReply?: boolean; lifecycleStatus?: string }>;
    };
    const newRes = await fetch(`${base}/api/v1/contacts?filter=new`, { headers: { cookie } });
    const freshList = (await newRes.json()) as { total: number; items: Array<{ id: string; lifecycleStatus?: string }> };
    const replyRes = await fetch(`${base}/api/v1/contacts?filter=needs_reply`, { headers: { cookie } });
    const reply = (await replyRes.json()) as { total: number; items: Array<{ id: string; needsReply?: boolean }> };

    assert.equal(all.attention.new, badges.badges["/contacts"]);
    assert.equal(freshList.total, all.attention.new);
    assert.equal(badges.hrefs["/contacts"], "/contacts?filter=new");
    assert.match(badges.hints["/contacts"], /новый клиент|новых клиента|новых клиентов/);
    assert.ok(freshList.items.some((item) => item.id === fresh.id));
    assert.ok(!freshList.items.some((item) => item.id === veteran.id));
    assert.equal(freshList.items.every((item) => item.lifecycleStatus === "new"), true);

    assert.equal(reply.total, all.attention.needsReply);
    assert.ok(reply.items.some((item) => item.id === waiting.id));
    assert.ok(!reply.items.some((item) => item.id === answered.id));
    assert.equal(reply.items.every((item) => item.needsReply), true);

    const newFlags = all.items.map((item) => item.lifecycleStatus === "new");
    const firstNotNew = newFlags.indexOf(false);
    const lastNew = newFlags.lastIndexOf(true);
    if (firstNotNew !== -1 && lastNew !== -1) {
      assert.ok(lastNew < firstNotNew);
    }
    assert.equal(all.items[0]?.lifecycleStatus, "new");
    assert.ok(all.items.some((item) => item.id === fresh.id));
    assert.ok(all.items.some((item) => item.id === waiting.id));
  });

  it("поиск по цифрам телефона находит клиента", async () => {
    const response = await fetch(`${base}/api/v1/contacts?q=87010000001`, { headers: { cookie } });
    const body = await response.json();
    assert.ok(body.items.some((item: { phoneNormalized?: string }) => item.phoneNormalized === "77010000001"));
  });

  it("интерес из закрытой переписки виден без заявки в списке и карточке", async () => {
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: `Interest regression ${Date.now()}`, source: "manual" }),
    });
    assert.equal(created.status, 201);
    const { client } = await created.json();
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: client.id } });
    const conversation = await prisma.conversation.create({
      data: { tenantId: contact.tenantId, contactId: client.id, status: "closed", mode: "human" },
    });
    const evidence = await prisma.message.create({
      data: { tenantId: contact.tenantId, conversationId: conversation.id, direction: "inbound", senderKind: "client", text: "Нужна презентация для инвесторов", historical: true },
    });
    await prisma.message.create({
      data: { tenantId: contact.tenantId, conversationId: conversation.id, direction: "outbound", senderKind: "staff", text: "Также можем разработать сайт" },
    });
    const response = await fetch(`${base}/api/v1/contacts?q=${encodeURIComponent(client.name)}`, { headers: { cookie } });
    const { items } = await response.json();
    assert.equal(items.length, 1);
    assert.equal(items[0].interest, "Нужна презентация для инвесторов");
    assert.equal(items[0].interestSource, "conversation");
    assert.equal(items[0].interestMessageId, evidence.id);
    const overview = await fetch(`${base}/api/v1/contacts/${client.id}/overview`, { headers: { cookie } });
    assert.equal((await overview.json()).client.interest, items[0].interest);
    assert.equal(await prisma.inquiry.count({ where: { contactId: client.id } }), 0);
    await prisma.inquiry.create({
      data: { tenantId: contact.tenantId, contactId: client.id, source: "manual", subject: "Согласованный брендинг" },
    });
    const withInquiry = await fetch(`${base}/api/v1/contacts?q=${encodeURIComponent(client.name)}`, { headers: { cookie } });
    const updated = (await withInquiry.json()).items[0];
    assert.equal(updated.interest, "Согласованный брендинг");
    assert.equal(updated.interestSource, "inquiry");
    assert.equal(updated.interestMessageId, null);
  });

  it("создание клиента и overview отвечают на ключевые вопросы", async () => {
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        name: "Мария Клиент360",
        phone: "+7 701 555 00 77",
        source: "manual",
        comment: "Нужен сайт",
        companyName: "Creo Demo",
      }),
    });
    assert.equal(created.status, 201);
    const overview = await created.json();
    assert.equal(overview.client.name, "Мария Клиент360");
    assert.ok(overview.client.phone);
    assert.equal(overview.client.id.includes("+"), false);
    assert.ok(overview.control);
    assert.ok(Array.isArray(overview.timeline));
    assert.ok(overview.attribution.sourceType === "manual" || overview.client);

    const byId = await fetch(`${base}/api/v1/contacts/${overview.client.id}/overview`, { headers: { cookie } });
    assert.equal(byId.status, 200);
    const detail = await byId.json();
    assert.equal(detail.client.companyName, "Creo Demo");
    assert.ok(detail.notes.length >= 1);
  });

  it("телефон не является primary key — два разных UUID на один номер в разных tenant", async () => {
    const creolab = await fetch(`${base}/api/v1/contacts?q=77010000001`, { headers: { cookie } });
    const a = await creolab.json();
    const loginDemo = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "owner@demo-agency.example",
        password: process.env.SEED_PASSWORD,
        client: "web",
      }),
    });
    const demoCookie = loginDemo.headers.get("set-cookie") || "";
    const demo = await fetch(`${base}/api/v1/contacts?q=77010000001`, { headers: { cookie: demoCookie } });
    const b = await demo.json();
    if (a.items[0] && b.items[0]) {
      assert.notEqual(a.items[0].id, b.items[0].id);
    }
  });
  it("очищает реквизиты, сохраняя обязательные строковые статусы", async () => {
    const response = await fetch(`${base}/api/v1/contacts`, {
      method: "POST", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Проверка пустых полей", phone: "+77018889977" }),
    });
    const created = await response.json();
    assert.equal(response.status, 201);
    const updated = await fetch(`${base}/api/v1/contacts/${created.client.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "", language: "", lifecycleStatus: "new", leadTemperature: "unknown", city: null }),
    });
    const body = await updated.json();
    assert.equal(updated.status, 200, JSON.stringify(body));
    const row = await prisma.contact.findUniqueOrThrow({ where: { id: created.client.id } });
    assert.equal(row.name, null);
    assert.equal(row.city, null);
    assert.equal(row.language, "unknown");
    assert.equal(row.lifecycleStatus, "new");
    assert.equal(row.leadTemperature, "unknown");
  });

  async function login(email: string) {
    const response = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(response.status, 200, await response.text());
    return response.headers.get("set-cookie") || "";
  }

  async function createClient(session: string, name: string) {
    const phone = `+7701${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const response = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: session },
      body: JSON.stringify({ name, phone }),
    });
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    return body.client.id as string;
  }

  it("владелец удаляет клиента вместе с заявкой и диалогом", async () => {
    const id = await createClient(cookie, "Удаление владельцем");
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    await prisma.inquiry.create({
      data: { tenantId: tenant.id, source: "manual", contactId: id, phoneRaw: "+77010000000", phoneNormalized: "77010000000" },
    });
    await prisma.conversation.create({ data: { tenantId: tenant.id, contactId: id } });
    const deleted = await fetch(`${base}/api/v1/contacts/${id}`, { method: "DELETE", headers: { cookie } });
    assert.equal(deleted.status, 200, await deleted.text());
    assert.equal(await prisma.contact.findUnique({ where: { id } }), null);
    assert.equal(await prisma.inquiry.count({ where: { contactId: id } }), 0);
    assert.equal(await prisma.conversation.count({ where: { contactId: id } }), 0);
    const missing = await fetch(`${base}/api/v1/contacts/${id}`, { headers: { cookie } });
    assert.equal(missing.status, 404);
  });

  it("директор может удалить клиента, менеджер и руководитель продаж — нет", async () => {
    const managerSession = await login("manager@creolab.example");
    const leadSession = await login("sales@creolab.example");
    const ownerUser = await prisma.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } });
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const director = await prisma.user.create({
      data: {
        email: `director-del-${randomUUID()}@creolab.example`,
        passwordHash: ownerUser.passwordHash,
        name: "Директор удаления",
        memberships: { create: { tenantId: tenant.id, role: "director", active: true } },
      },
    });
    const directorSession = await login(director.email);

    const blockedId = await createClient(cookie, "Нельзя менеджеру");
    for (const session of [managerSession, leadSession]) {
      const denied = await fetch(`${base}/api/v1/contacts/${blockedId}`, { method: "DELETE", headers: { cookie: session } });
      const body = await denied.json();
      assert.equal(denied.status, 403, JSON.stringify(body));
    }
    assert.ok(await prisma.contact.findUnique({ where: { id: blockedId } }));

    const directorId = await createClient(directorSession, "Удаление директором");
    const removed = await fetch(`${base}/api/v1/contacts/${directorId}`, {
      method: "DELETE",
      headers: { cookie: directorSession },
    });
    assert.equal(removed.status, 200, await removed.text());
    assert.equal(await prisma.contact.findUnique({ where: { id: directorId } }), null);
  });

  it("чужая компания не видит удаление, выставленный счёт блокирует удаление", async () => {
    const id = await createClient(cookie, "Клиент со счётом");
    const deal = await fetch(`${base}/api/v1/deals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({
        title: "Сделка удаления",
        contactId: id,
        items: [{ name: "Услуга", quantity: 1, unitPrice: 100, vatRate: 0 }],
      }),
    });
    const dealBody = await deal.json();
    assert.equal(deal.status, 201, JSON.stringify(dealBody));
    const tenantId = (await prisma.deal.findUniqueOrThrow({ where: { id: dealBody.deal.id } })).tenantId;
    await prisma.invoice.create({
      data: {
        tenantId,
        dealId: dealBody.deal.id,
        number: `DEL-${randomUUID()}`,
        amountWithoutVat: 100,
        vatAmount: 0,
        totalAmount: 100,
        status: "ISSUED",
      },
    });

    const demoCookie = await login("owner@demo-agency.example");
    const foreign = await fetch(`${base}/api/v1/contacts/${id}`, { method: "DELETE", headers: { cookie: demoCookie } });
    assert.equal(foreign.status, 404);

    const blocked = await fetch(`${base}/api/v1/contacts/${id}`, { method: "DELETE", headers: { cookie } });
    const blockedBody = await blocked.json();
    assert.equal(blocked.status, 409, JSON.stringify(blockedBody));
    assert.equal(blockedBody.code, "contact_has_documents");
    assert.ok(await prisma.contact.findUnique({ where: { id } }));
  });

  it("Написать открывает существующий WhatsApp-диалог и не требует прошлой переписки", async () => {
    const id = await createClient(cookie, "Диалог уже есть");
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const conversation = await prisma.conversation.create({
      data: { tenantId: tenant.id, contactId: id, sellerLeadId: `lead-${randomUUID()}`, status: "open", mode: "ai" },
    });
    const opened = await fetch(`${base}/api/v1/contacts/${id}/whatsapp-chat`, { method: "POST", headers: { cookie } });
    const body = await opened.json();
    assert.equal(opened.status, 200, JSON.stringify(body));
    assert.equal(body.conversationId, conversation.id);
    assert.equal(body.created, false);
  });

  it("без телефона написать нельзя, незарегистрированный WhatsApp блокирует", async () => {
    const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const nameless = await prisma.contact.create({
      data: { tenantId: tenant.id, name: "Без телефона" },
    });
    const missing = await fetch(`${base}/api/v1/contacts/${nameless.id}/whatsapp-chat`, {
      method: "POST",
      headers: { cookie },
    });
    const missingBody = await missing.json();
    assert.equal(missing.status, 422, JSON.stringify(missingBody));
    assert.equal(missingBody.code, "no_phone");

    const id = await createClient(cookie, "Нет WhatsApp");
    const seller = await prisma.integration.findFirstOrThrow({ where: { tenantId: tenant.id, type: "whatsapp_seller" } });
    const previous = (seller.schemaJson || {}) as Record<string, unknown>;
    await prisma.integration.update({
      where: { id: seller.id },
      data: {
        schemaJson: {
          ...previous,
          instanceId: "110011",
          apiTokenEnc: encryptSecret("check-token"),
          greenApiHost: "green.test",
        },
      },
    });
    setGreenApiFetchForTests(async (url) => {
      assert.match(String(url), /checkWhatsapp/);
      return new Response(JSON.stringify({ existsWhatsapp: false }), { status: 200 });
    });
    try {
      const blocked = await fetch(`${base}/api/v1/contacts/${id}/whatsapp-chat`, { method: "POST", headers: { cookie } });
      const body = await blocked.json();
      assert.equal(blocked.status, 409, JSON.stringify(body));
      assert.equal(body.code, "WHATSAPP_NOT_REGISTERED");
    } finally {
      setGreenApiFetchForTests(null);
      await prisma.integration.update({ where: { id: seller.id }, data: { schemaJson: previous } });
    }
  });

  it("duplicate phone returns existing client instead of creating a second one", async () => {
    const phone = `+7701${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
    const first = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Первый дубликат", phone }),
    });
    const firstBody = await first.json();
    assert.equal(first.status, 201, JSON.stringify(firstBody));
    const dup = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Второй дубликат", phone }),
    });
    const dupBody = await dup.json();
    assert.equal(dup.status, 409, JSON.stringify(dupBody));
    assert.equal(dupBody.code, "duplicate_phone");
    assert.equal(dupBody.details?.duplicates?.[0]?.id, firstBody.client.id);
    const forced = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: "Принудительный дубликат", phone, forceCreate: true }),
    });
    const forcedBody = await forced.json();
    assert.equal(forced.status, 201, JSON.stringify(forcedBody));
    const merged = await fetch(`${base}/api/v1/contacts/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ keepId: firstBody.client.id, mergeId: forcedBody.client.id }),
    });
    const mergedBody = await merged.json();
    assert.equal(merged.status, 200, JSON.stringify(mergedBody));
    const source = await prisma.contact.findUniqueOrThrow({ where: { id: forcedBody.client.id } });
    assert.ok(source.archivedAt);
  });

  it("workspace search and contact import stay inside the tenant", async () => {
    const unique = `Поиск ${Date.now()}`;
    const created = await fetch(`${base}/api/v1/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ name: unique, phone: `+7701${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}` }),
    });
    assert.equal(created.status, 201, await created.text());
    const search = await fetch(`${base}/api/v1/search?q=${encodeURIComponent(unique)}`, { headers: { cookie } });
    const searchBody = await search.json();
    assert.equal(search.status, 200, JSON.stringify(searchBody));
    assert.ok((searchBody.items || []).some((item: { title: string; type: string }) => item.type === "contact" && item.title.includes("Поиск")));
    const csv = Buffer.from("Имя,Телефон\nИмпорт Аудит,+77015550123\n", "utf8").toString("base64");
    const imported = await fetch(`${base}/api/v1/contacts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ fileName: "clients.csv", contentBase64: csv }),
    });
    const importedBody = await imported.json();
    assert.equal(imported.status, 200, JSON.stringify(importedBody));
    assert.ok(importedBody.created >= 1 || importedBody.skipped >= 1);
    const ops = await fetch(`${base}/api/v1/workspace/ops`, { headers: { cookie } });
    assert.equal(ops.status, 200, await ops.text());
    const audit = await fetch(`${base}/api/v1/workspace/audit`, { headers: { cookie } });
    assert.equal(audit.status, 200, await audit.text());
    const managerSession = await login("manager@creolab.example");
    const forbidden = await fetch(`${base}/api/v1/workspace/audit`, { headers: { cookie: managerSession } });
    assert.equal(forbidden.status, 403);
    const exported = await fetch(`${base}/api/v1/contacts/export`, { headers: { cookie } });
    const exportedBody = await exported.json();
    assert.equal(exported.status, 200, JSON.stringify(exportedBody));
    assert.match(exportedBody.csv, /name,phone,email/);
  });

});
