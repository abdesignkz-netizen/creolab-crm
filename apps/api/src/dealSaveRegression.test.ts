import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createPrismaClient, Prisma, type PrismaClient } from "@creolab/db";
import { seedDatabase } from "../../../packages/db/src/seed.ts";
import { createApp } from "./app.ts";
import { ensureDealPipelineStages, updateDeal } from "./services/dealService.ts";
import { createTask, getTask, listTasks } from "./services/domainService.ts";
import type { AuthContext } from "./lib/types.ts";

describe("deal saves and legacy task authors", () => {
  let prisma: PrismaClient;
  let auth: AuthContext;
  let server: Server;
  let base: string;
  let cookie: string;
  let dealId: string;
  let companyId: string;
  const nextActionAt = new Date("2026-10-01T12:00:00.000Z");

  before(async () => {
    prisma = await createPrismaClient();
    await seedDatabase();
    const member = await prisma.membership.findFirstOrThrow({
      where: { role: "owner", tenant: { slug: "creolab" } }, include: { tenant: true, user: true },
    });
    auth = { user: member.user, activeMembership: member, memberships: [member], sessionId: "test", client: "web" } as AuthContext;
    await ensureDealPipelineStages(prisma, member.tenantId);
    const stage = await prisma.dealStage.findFirstOrThrow({ where: { tenantId: member.tenantId, systemKey: "new" } });
    const contact = await prisma.contact.create({ data: { tenantId: member.tenantId, name: "Регрессия сохранения" } });
    const company = await prisma.company.create({ data: { tenantId: member.tenantId, name: "Компания регрессии" } });
    companyId = company.id;
    const deal = await prisma.deal.create({ data: {
      tenantId: member.tenantId, contactId: contact.id, stageId: stage.id,
      title: "Сделка с суммой", offerAmountMinor: new Prisma.Decimal("500000"), nextActionAt,
    } });
    dealId = deal.id;
    server = createApp(prisma).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${base}/api/v1/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: member.user.email, password: process.env.SEED_PASSWORD, client: "web" }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get("set-cookie") || "";
  });

  after(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("PATCH saves every affected field and persists Decimal and dates in audit", async () => {
    const changes = [
      { companyId }, { title: "Изменённое название" },
      { expectedCloseAt: "2026-11-01T00:00:00.000Z" }, { paymentStatus: "INVOICED" },
      { nextActionAt: "2026-10-02T12:00:00.000Z" },
      { offerAmountMinor: 750000 }, { offerAmountMinor: 0 }, { offerAmountMinor: null },
      { title: "Сделка без суммы" },
    ];
    for (const change of changes) {
      const before = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
      const response = await fetch(`${base}/api/v1/deals/${dealId}`, {
        method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(change),
      });
      assert.equal(response.status, 200, await response.text());
      const saved = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
      assert.equal(saved.version, before.version + 1);
      for (const [key, expected] of Object.entries(change)) {
        const actual = saved[key as keyof typeof saved];
        assert.equal(actual instanceof Date ? actual.toISOString() : Prisma.Decimal.isDecimal(actual) ? Number(actual) : actual, expected);
      }
      const audit = await prisma.auditEvent.findFirstOrThrow({
        where: { entityId: dealId, action: "deal.update" }, orderBy: { createdAt: "desc" },
      });
      const payload = audit.changesJson as { before: { offerAmountMinor: string | null; nextActionAt: string | null } };
      assert.equal(payload.before.offerAmountMinor, before.offerAmountMinor?.toString() ?? null);
      assert.equal(payload.before.nextActionAt, before.nextActionAt?.toISOString() ?? null);
    }
  });

  it("rolls back the deal and version when audit storage fails", async () => {
    const before = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    const failingPrisma = prisma.$extends({ query: { auditEvent: { async create() {
      throw new Error("audit storage unavailable");
    } } } });
    await assert.rejects(
      updateDeal(failingPrisma as unknown as PrismaClient, auth, dealId, { title: "Не должно сохраниться" }),
      /audit storage unavailable/,
    );
    const after = await prisma.deal.findUniqueOrThrow({ where: { id: dealId } });
    assert.equal(after.title, before.title);
    assert.equal(after.version, before.version);
  });

  it("shows unknown legacy authors without borrowing the assignee's name", async () => {
    for (const snapshot of [{}, { createdByKind: "user", createdByMembershipId: "missing-member" }]) {
      const task = await prisma.task.create({ data: {
        tenantId: auth.activeMembership!.tenantId, title: "Старая задача", type: "other", source: "manual",
        ownerMembershipId: auth.activeMembership!.id, contextSnapshotJson: snapshot,
      } });
      assert.equal((await getTask(prisma, auth, task.id)).createdByLabel, "Не указан");
      const board = await listTasks(prisma, auth);
      assert.equal(board.find((row) => row.id === task.id)?.createdByLabel, "Не указан");
    }
    const fresh = await createTask(prisma, auth, { type: "other", title: "Новая задача" });
    assert.equal((await getTask(prisma, auth, fresh.id)).createdByLabel, auth.user.name || auth.user.email);
  });
});
