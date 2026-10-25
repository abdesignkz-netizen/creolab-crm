import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@creolab/db";
import { authForUserInTenant } from "./services/authService.ts";
import { getSituation, snoozeSituation } from "./services/situationService.ts";

describe("Situation reminders respect record access and personal scope", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let owner: Awaited<ReturnType<typeof authForUserInTenant>>, manager: typeof owner, other: typeof owner;
  const originalFetch = globalThis.fetch;
  const until = () => new Date(Date.now() + 3600_000).toISOString();
  const visible = async (auth: typeof owner, id: string) => (await getSituation(prisma, auth)).items.some(item => item.id === id);
  const task = (auth: typeof owner) => prisma.task.create({ data: {
    tenantId: auth.activeMembership!.tenantId, ownerMembershipId: auth.activeMembership!.id,
    title: "Snooze access " + randomUUID(), type: "manual", status: "open", dueAt: new Date(Date.now() - 3600_000),
  } });
  before(async () => {
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    const auth = async (email: string) => {
      const membership = await prisma.membership.findFirstOrThrow({ where: { user: { email } } });
      return authForUserInTenant(prisma, membership.userId, membership.tenantId, "situation-access-test");
    };
    owner = await auth("owner@creolab.example");
    manager = await auth("manager@creolab.example");
    other = await auth("owner@demo-agency.example");
    globalThis.fetch = async () => { throw new Error("External services disabled"); };
  });
  after(async () => { globalThis.fetch = originalFetch; await prisma.$disconnect(); });

  it("a manager cannot hide the owner's inaccessible task or create an audit event for it", async () => {
    const row = await task(owner), itemId = "task_overdue:" + row.id;
    assert.equal(await visible(owner, itemId), true);
    assert.equal(await visible(manager, itemId), false);
    await assert.rejects(snoozeSituation(prisma, manager, { itemId, until: until() }), { code: "not_found" });
    assert.equal(await visible(owner, itemId), true);
    assert.equal(await prisma.situationSnooze.count({ where: { tenantId: row.tenantId, itemId: { endsWith: row.id } } }), 0);
    assert.equal(await prisma.auditEvent.count({ where: { tenantId: row.tenantId, entityId: itemId } }), 0);
  });

  it("personal reminders are independent and never hide a manager's task from the owner", async () => {
    const row = await task(manager), itemId = "task_overdue:" + row.id;
    const result = await snoozeSituation(prisma, manager, { itemId, until: until(), reason: "Waiting for details" });
    assert.equal(result.itemId, itemId);
    assert.equal(result.scope, "personal");
    assert.equal(await visible(manager, itemId), false);
    assert.equal(await visible(owner, itemId), true);
    const snoozed = (await getSituation(prisma, manager, { includeSnoozed: true })).items.find(item => item.id === itemId);
    assert.ok(snoozed?.snoozedUntil);
    await snoozeSituation(prisma, owner, { itemId, until: until() });
    await snoozeSituation(prisma, manager, { itemId, until: until() });
    assert.equal(await prisma.situationSnooze.count({ where: { tenantId: row.tenantId, itemId: { endsWith: row.id } } }), 2);
    assert.equal(await visible(owner, itemId), false);
  });

  it("only company administrators can explicitly snooze for everyone, with audit", async () => {
    const row = await task(manager), itemId = "task_overdue:" + row.id;
    await assert.rejects(snoozeSituation(prisma, manager, { itemId, until: until(), scope: "company" }), { code: "forbidden" });
    await snoozeSituation(prisma, owner, { itemId, until: until(), scope: "company", reason: "Agreed follow-up" });
    assert.equal(await visible(owner, itemId), false);
    assert.equal(await visible(manager, itemId), false);
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { tenantId: row.tenantId, entityId: itemId, action: "situation.snoozed" } });
    assert.equal(audit.actorUserId, owner.user.id);
    assert.equal((audit.changesJson as any).scope, "company");
  });

  it("legacy reminders and forged company prefixes cannot hide another user's queue", async () => {
    const row = await task(manager), itemId = "task_overdue:" + row.id;
    await prisma.situationSnooze.create({ data: { tenantId: row.tenantId, itemId, until: new Date(until()), byUserId: manager.user.id } });
    assert.equal(await visible(manager, itemId), false);
    assert.equal(await visible(owner, itemId), true);
    await prisma.situationSnooze.create({ data: { tenantId: row.tenantId, itemId: "company:" + itemId, until: new Date(until()), byUserId: manager.user.id } });
    assert.equal(await visible(owner, itemId), true);
  });

  it("rejects other companies, nonexistent records and fabricated situation kinds", async () => {
    const foreign = await task(other);
    await assert.rejects(snoozeSituation(prisma, owner, { itemId: "task_overdue:" + foreign.id, until: until() }), { code: "not_found" });
    for (const kind of ["needs_phone", "inquiry_new", "inquiry_accepted", "inquiry_ai_blocked", "missing_next_action",
      "conversation_human", "conversation_paused", "conversation_attention", "task_overdue", "task_due_today",
      "task_unassigned_hot", "contact_needs_reply", "anything"]) {
      await assert.rejects(snoozeSituation(prisma, owner, { itemId: kind + ":" + randomUUID(), until: until() }), { code: "not_found" });
    }
  });

  it("rejects suspended membership and company even for a directly invoked service", async () => {
    const row = await task(owner), input = { itemId: "task_overdue:" + row.id, until: until() };
    await assert.rejects(snoozeSituation(prisma, { ...owner, activeMembership: { ...owner.activeMembership!, active: false } }, input), { code: "membership_suspended" });
    await assert.rejects(snoozeSituation(prisma, { ...owner, activeMembership: { ...owner.activeMembership!, tenant: { ...owner.activeMembership!.tenant, status: "suspended" } } }, input), { code: "tenant_suspended" });
  });
});
