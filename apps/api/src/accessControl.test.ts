import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { createStaffNotification } from "./services/notificationService.ts";

describe("role access and account settings", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: { close: (cb?: (err?: Error) => void) => void; address: () => { port: number } | string | null };
  let url = "";
  let ownerCookie = "";
  let managerCookie = "";
  let directorCookie = "";
  let demoCookie = "";
  let creolabId = "";
  let demoId = "";
  let ownerMembershipId = "";
  let managerMembershipId = "";
  let directorUserId = "";
  let extraManagerEmail = "";

  async function login(email: string) {
    const login = await fetch(`${url}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(login.status, 200, await login.text());
    let cookie = login.headers.getSetCookie?.()?.[0]?.split(";")[0] || "";
    if (!cookie) cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(cookie);
    return cookie;
  }

  async function req(
    cookie: string,
    path: string,
    init: { method?: string; body?: unknown; tenantId?: string } = {},
  ) {
    const headers: Record<string, string> = { cookie };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.tenantId) headers["x-tenant-id"] = init.tenantId;
    const response = await fetch(`${url}${path}`, {
      method: init.method || "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve()) as typeof server;
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    url = `http://127.0.0.1:${addr.port}`;

    const creolab = await prisma.tenant.findFirstOrThrow({ where: { slug: "creolab" } });
    const demo = await prisma.tenant.findFirstOrThrow({ where: { slug: "demo-agency" } });
    creolabId = creolab.id;
    demoId = demo.id;

    const ownerMem = await prisma.membership.findFirstOrThrow({
      where: { tenantId: creolabId, role: "owner" },
    });
    const managerMem = await prisma.membership.findFirstOrThrow({
      where: { tenantId: creolabId, role: "manager" },
    });
    ownerMembershipId = ownerMem.id;
    managerMembershipId = managerMem.id;

    const ownerUser = await prisma.user.findUniqueOrThrow({ where: { id: ownerMem.userId } });
    const director = await prisma.user.create({
      data: {
        email: `director-${randomUUID()}@creolab.example`,
        passwordHash: ownerUser.passwordHash,
        name: "Директор теста",
        memberships: { create: { tenantId: creolabId, role: "director", active: true } },
      },
    });
    directorUserId = director.id;

    extraManagerEmail = `manager-two-${randomUUID()}@creolab.example`;
    await prisma.user.create({
      data: {
        email: extraManagerEmail,
        passwordHash: ownerUser.passwordHash,
        name: "Второй менеджер",
        memberships: { create: { tenantId: creolabId, role: "manager", active: true } },
      },
    });

    const { ensureDealPipelineStages } = await import("./services/dealService.ts");
    await ensureDealPipelineStages(prisma, creolabId);

    ownerCookie = await login("owner@creolab.example");
    managerCookie = await login("manager@creolab.example");
    directorCookie = await login(director.email);
    demoCookie = await login("owner@demo-agency.example");
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    await prisma.$disconnect();
  });

  it("1. администратор и директор управляют только своей компанией", async () => {
    const created = await req(demoCookie, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Клиент другой компании",
        phone: "+7 701 222 33 44",
        subject: "Чужой тендер",
        message: "Не для CreoLab",
        sourceChannel: "manual",
      },
    });
    assert.equal(created.status, 201);
    const foreign = await req(ownerCookie, `/api/v1/inquiries/${created.data.id}`);
    assert.equal(foreign.status, 404);
    const directorForeign = await req(directorCookie, `/api/v1/inquiries/${created.data.id}`);
    assert.equal(directorForeign.status, 404);
    const ownMembers = await req(directorCookie, "/api/v1/settings/members");
    assert.equal(ownMembers.status, 200);
    const ownAi = await req(directorCookie, "/api/v1/settings/ai-automation");
    assert.equal(ownAi.status, 200);
  });

  it("2. менеджер видит очередь и принимает заявку", async () => {
    const created = await req(ownerCookie, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Очередь менеджера",
        phone: "+7 701 111 22 33",
        subject: "Сайт",
        message: "Нужен сайт",
        sourceChannel: "manual",
      },
    });
    assert.equal(created.status, 201);
    await prisma.inquiry.update({
      where: { id: created.data.id },
      data: { assigneeMembershipId: null, status: "new" },
    });
    const list = await req(managerCookie, "/api/v1/inquiries?filter=unassigned");
    assert.equal(list.status, 200);
    assert.ok(list.data.items.some((item: { id: string }) => item.id === created.data.id));
    const take = await req(managerCookie, `/api/v1/inquiries/${created.data.id}/take`, { method: "POST" });
    assert.equal(take.status, 200);
    assert.equal(take.data.status, "in_progress");
    assert.equal(take.data.assigneeMembershipId, managerMembershipId);
  });

  it("3. два менеджера не принимают одну заявку одновременно", async () => {
    const created = await req(ownerCookie, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Гонка за заявку",
        phone: "+7 701 444 55 66",
        subject: "Аудит",
        message: "Нужен аудит",
        sourceChannel: "manual",
      },
    });
    assert.equal(created.status, 201);
    await prisma.inquiry.update({
      where: { id: created.data.id },
      data: { assigneeMembershipId: null, status: "new" },
    });
    const secondCookie = await login(extraManagerEmail);
    const [a, b] = await Promise.all([
      req(managerCookie, `/api/v1/inquiries/${created.data.id}/take`, { method: "POST" }),
      req(secondCookie, `/api/v1/inquiries/${created.data.id}/take`, { method: "POST" }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = a.status === 200 ? a.data : b.data;
    const loser = a.status === 409 ? a.data : b.data;
    assert.equal(loser.code, "already_taken");
    const inquiry = await prisma.inquiry.findUniqueOrThrow({ where: { id: created.data.id } });
    assert.ok(inquiry.assigneeMembershipId);
    assert.equal(inquiry.assigneeMembershipId, winner.assigneeMembershipId);
  });

  it("4. менеджер не читает чужие заявки, сделки, задачи и диалоги", async () => {
    const created = await req(ownerCookie, "/api/v1/inquiries", {
      method: "POST",
      body: {
        name: "Чужая заявка",
        phone: "+7 701 777 88 99",
        subject: "Презентация",
        message: "Нужна презентация",
        sourceChannel: "manual",
      },
    });
    await prisma.inquiry.update({
      where: { id: created.data.id },
      data: { assigneeMembershipId: ownerMembershipId, status: "in_progress" },
    });
    const inquiry = await req(managerCookie, `/api/v1/inquiries/${created.data.id}`);
    assert.equal(inquiry.status, 404);

    const contactId = created.data.contactId || created.data.contact?.id;
    assert.ok(contactId);
    const deal = await prisma.deal.create({
      data: {
        tenantId: creolabId,
        contactId,
        title: "Чужая сделка",
        assigneeMembershipId: ownerMembershipId,
        stageId: (await prisma.dealStage.findFirstOrThrow({ where: { tenantId: creolabId } })).id,
      },
    });
    const dealRes = await req(managerCookie, `/api/v1/deals/${deal.id}`);
    assert.equal(dealRes.status, 404);

    const task = await prisma.task.create({
      data: {
        tenantId: creolabId,
        type: "follow_up",
        title: "Чужая задача",
        ownerMembershipId: ownerMembershipId,
        status: "open",
      },
    });
    const taskRes = await req(managerCookie, `/api/v1/tasks/${task.id}`);
    assert.equal(taskRes.status, 404);
  });

  it("5. менеджер отмечает свои задачи и не создаёт чужие", async () => {
    const task = await prisma.task.create({
      data: {
        tenantId: creolabId,
        type: "follow_up",
        title: "Задача менеджера",
        ownerMembershipId: managerMembershipId,
        status: "open",
      },
    });
    const mine = await req(managerCookie, `/api/v1/tasks/${task.id}`);
    assert.equal(mine.status, 200);
    const done = await req(managerCookie, `/api/v1/tasks/${task.id}/complete`, { method: "POST" });
    assert.equal(done.status, 200);
    const create = await req(managerCookie, "/api/v1/tasks", {
      method: "POST",
      body: { type: "follow_up", title: "Нельзя создать" },
    });
    assert.equal(create.status, 403);
    const assign = await req(managerCookie, `/api/v1/tasks/${task.id}/assign`, {
      method: "POST",
      body: { membershipId: ownerMembershipId },
    });
    assert.equal(assign.status, 403);
  });

  it("6. менеджер добавляет клиентов и компании без закрытых связанных данных", async () => {
    const contact = await req(managerCookie, "/api/v1/contacts", {
      method: "POST",
      body: { name: "Клиент менеджера", phone: "+7 701 101 20 30", source: "manual" },
    });
    assert.equal(contact.status, 201);
    const contactId = contact.data.client?.id || contact.data.id;
    assert.ok(contactId);
    const patch = await req(managerCookie, `/api/v1/contacts/${contactId}`, {
      method: "PATCH",
      body: { name: "Попытка правки" },
    });
    assert.equal(patch.status, 403);
    const company = await req(managerCookie, "/api/v1/companies", {
      method: "POST",
      body: { name: `Компания менеджера ${Date.now()}` },
    });
    assert.equal(company.status, 201);
    const companyId = company.data.id || company.data.company?.id;
    const companyPatch = await req(managerCookie, `/api/v1/companies/${companyId}`, {
      method: "PATCH",
      body: { name: "Правка запрещена" },
    });
    assert.equal(companyPatch.status, 403);
  });

  it("7. документы, статистика, AI и интеграции закрыты для менеджера", async () => {
    const dealId = (
      await prisma.deal.create({
        data: {
          tenantId: creolabId,
          contactId: (await prisma.contact.findFirstOrThrow({ where: { tenantId: creolabId } })).id,
          title: "Документы недоступны менеджеру",
          assigneeMembershipId: managerMembershipId,
          stageId: (await prisma.dealStage.findFirstOrThrow({ where: { tenantId: creolabId } })).id,
        },
      })
    ).id;
    const closed = [
      "/api/v1/documents",
      "/api/v1/analytics/dashboard",
      "/api/v1/settings/ai-automation",
      "/api/v1/settings/legal-profile",
      "/api/v1/integrations/catalog",
      "/api/v1/settings/members",
      "/api/v1/situation/overview",
      "/api/v1/knowledge/current",
      "/api/v1/documents/avr/eligible-deals",
      `/api/v1/deals/${dealId}/documents`,
      `/api/v1/deals/${dealId}/avr-readiness`,
      `/api/v1/deals/${dealId}/contract-readiness`,
      `/api/v1/deals/${dealId}/invoice-readiness`,
    ];
    for (const path of closed) {
      const result = await req(managerCookie, path);
      assert.equal(result.status, 403, path);
      assert.ok(!JSON.stringify(result.data).includes("bin"));
    }
  });

  it("8. менеджер не меняет роль и запрещённые поля запросом", async () => {
    const role = await req(managerCookie, `/api/v1/workspace/members/${managerMembershipId}`, {
      method: "PATCH",
      body: { role: "owner", permissions: ["manage_documents"] },
    });
    assert.equal(role.status, 403);
    const deal = await prisma.deal.create({
      data: {
        tenantId: creolabId,
        contactId: (await prisma.contact.findFirstOrThrow({ where: { tenantId: creolabId } })).id,
        title: "Сделка менеджера",
        assigneeMembershipId: managerMembershipId,
        stageId: (await prisma.dealStage.findFirstOrThrow({ where: { tenantId: creolabId } })).id,
      },
    });
    const steal = await req(managerCookie, `/api/v1/deals/${deal.id}`, {
      method: "PATCH",
      body: { assigneeMembershipId: ownerMembershipId, paymentStatus: "PAID" },
    });
    assert.ok(steal.status === 200 || steal.status === 403);
    if (steal.status === 200) {
      assert.equal(steal.data.deal.assigneeMembershipId, managerMembershipId);
      assert.notEqual(steal.data.deal.paymentStatus, "PAID");
    }
  });

  it("9. смена роли действует на текущую сессию", async () => {
    const before = await req(managerCookie, "/api/v1/settings/members");
    assert.equal(before.status, 403);
    const promoted = await req(ownerCookie, `/api/v1/workspace/members/${managerMembershipId}`, {
      method: "PATCH",
      body: { role: "director" },
    });
    assert.equal(promoted.status, 200);
    const after = await req(managerCookie, "/api/v1/settings/members");
    assert.equal(after.status, 200);
    const restored = await req(ownerCookie, `/api/v1/workspace/members/${managerMembershipId}`, {
      method: "PATCH",
      body: { role: "manager" },
    });
    assert.equal(restored.status, 200);
    const again = await req(managerCookie, "/api/v1/settings/members");
    assert.equal(again.status, 403);
  });

  it("10. права и уведомления не переносятся между компаниями", async () => {
    await prisma.membership.upsert({
      where: {
        tenantId_userId: {
          tenantId: demoId,
          userId: (await prisma.membership.findUniqueOrThrow({ where: { id: managerMembershipId } })).userId,
        },
      },
      update: { role: "manager", active: true },
      create: {
        tenantId: demoId,
        userId: (await prisma.membership.findUniqueOrThrow({ where: { id: managerMembershipId } })).userId,
        role: "manager",
        active: true,
      },
    });
    await req(managerCookie, "/api/v1/me/notification-preferences", {
      method: "PATCH",
      tenantId: creolabId,
      body: { events: { tasks: false, new_inquiries: true } },
    });
    const creolabPrefs = await req(managerCookie, "/api/v1/me/notification-preferences", { tenantId: creolabId });
    const demoPrefs = await req(managerCookie, "/api/v1/me/notification-preferences", { tenantId: demoId });
    assert.equal(creolabPrefs.data.events.tasks, false);
    assert.notEqual(demoPrefs.data.events.tasks, false);
  });

  it("11. личные настройки сохраняются", async () => {
    const saved = await req(managerCookie, "/api/v1/me/profile", {
      method: "PATCH",
      body: { firstName: "Алия", lastName: "Тестова", city: "Алматы" },
    });
    assert.equal(saved.status, 200);
    const me = await req(managerCookie, "/api/v1/me");
    assert.equal(me.data.user.firstName, "Алия");
    assert.equal(me.data.user.city, "Алматы");
    const appearance = await req(managerCookie, "/api/v1/me/appearance", {
      method: "PATCH",
      body: { locale: "en", theme: "dark", timeFormat: "12", timezone: "Asia/Almaty" },
    });
    assert.equal(appearance.status, 200);
    const again = await req(managerCookie, "/api/v1/me");
    assert.equal(again.data.user.locale, "en");
    assert.equal(again.data.user.theme, "dark");
    await req(managerCookie, "/api/v1/me/appearance", {
      method: "PATCH",
      body: { locale: "ru", theme: "system", timeFormat: "24" },
    });
  });

  it("12. завершённые сессии перестают работать", async () => {
    const second = await login("manager@creolab.example");
    const revoke = await req(managerCookie, "/api/v1/me/sessions/revoke-others", { method: "POST", body: {} });
    assert.equal(revoke.status, 200);
    const dead = await req(second, "/api/v1/me");
    assert.equal(dead.status, 401);
    const alive = await req(managerCookie, "/api/v1/me");
    assert.equal(alive.status, 200);
  });

  it("13. настройки уведомлений влияют на доставку", async () => {
    await req(managerCookie, "/api/v1/me/notification-preferences", {
      method: "PATCH",
      body: { events: { new_inquiries: false } },
    });
    const before = await prisma.notification.count({ where: { recipientMembershipId: managerMembershipId } });
    const skipped = await createStaffNotification(prisma, {
      tenantId: creolabId,
      membershipId: managerMembershipId,
      type: "inquiry.created",
      entityType: "inquiry",
      entityId: randomUUID(),
      title: "Новая заявка",
      body: "Доступна в очереди",
    });
    assert.equal(skipped, null);
    const afterSkip = await prisma.notification.count({ where: { recipientMembershipId: managerMembershipId } });
    assert.equal(afterSkip, before);
    await req(managerCookie, "/api/v1/me/notification-preferences", {
      method: "PATCH",
      body: { events: { new_inquiries: true } },
    });
    const created = await createStaffNotification(prisma, {
      tenantId: creolabId,
      membershipId: managerMembershipId,
      type: "inquiry.created",
      entityType: "inquiry",
      entityId: randomUUID(),
      title: "Новая заявка",
      body: "Доступна в очереди",
    });
    assert.ok(created);
  });

  it("14. привязка без подтверждения не считается подключенной", async () => {
    const catalog = await req(ownerCookie, "/api/v1/integrations/catalog");
    assert.equal(catalog.status, 200);
    const telegram = catalog.data.notifications?.employeeTelegram;
    await prisma.telegramBinding.create({
      data: {
        userId: (await prisma.membership.findUniqueOrThrow({ where: { id: ownerMembershipId } })).userId,
        chatRef: "",
        pendingTokenHash: `pending-${randomUUID()}`,
        pendingExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const after = await req(ownerCookie, "/api/v1/integrations/catalog");
    assert.equal(after.data.notifications.employeeTelegram.connected, false);
    assert.equal(after.data.notifications.employeeTelegram.connectionStatus, "PENDING");
    assert.ok(telegram);
  });

  it("директор имеет полный доступ компании, менеджер — нет", async () => {
    const me = await req(directorCookie, "/api/v1/me");
    assert.equal(me.data.capabilities.companyAdmin, true);
    assert.equal(me.data.capabilities.documents, true);
    const mgr = await req(managerCookie, "/api/v1/me");
    assert.equal(mgr.data.capabilities.manager, true);
    assert.equal(mgr.data.capabilities.documents, false);
    assert.equal(mgr.data.user.platformAdmin, false);
    void directorUserId;
  });
});
