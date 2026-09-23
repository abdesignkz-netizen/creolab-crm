import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { activateSubscription } from "./services/subscriptionActivationService.ts";
import { presentAudit } from "./lib/auditPresentation.ts";

describe("company employee invitations and readable audit", () => {
  let db: Awaited<ReturnType<typeof createPrismaClient>>;
  let server: any;
  let url: string, owner: string, manager: string, tenantId: string, otherTenantId: string;
  const base = "/api/v1/settings/members/invitations";
  async function req(cookie: string, path: string, method = "GET", body?: unknown) {
    const r = await fetch(url + path, { method, headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, data: await r.json(), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
  }
  before(async () => {
    db = await createPrismaClient();
    await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
    server = createApp(db).listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    owner = (await req("", "/api/v1/auth/login", "POST", { email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" })).cookie;
    manager = (await req("", "/api/v1/auth/login", "POST", { email: "manager@creolab.example", password: process.env.SEED_PASSWORD, client: "web" })).cookie;
    tenantId = (await db.tenant.findUniqueOrThrow({ where: { slug: "creolab" } })).id;
    otherTenantId = (await db.tenant.findUniqueOrThrow({ where: { slug: "demo-agency" } })).id;
    // Three seeded employees plus one purchased seat.
    await activateSubscription(db, { tenantId, planCode: "CRM_START", addOns: [{ code: "ADDON_USER", qty: 1 }] });
  });
  after(async () => { await new Promise<void>(resolve => server.close(resolve)); });
  let first: any;
  it("counts purchased seats and reserves the last seat atomically", async () => {
    const before = await req(owner, "/api/v1/settings/members");
    assert.equal(before.status, 200); assert.equal(before.data.capacity.limit, 4); assert.equal(before.data.capacity.remaining, 1);
    const results = await Promise.all(["first", "second"].map(name => req(owner, base, "POST", { name, email: `${name}@invite.test`, role: "manager" })));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 422]);
    first = results.find(r => r.status === 201)!.data;
    const list = await req(owner, "/api/v1/settings/members");
    assert.equal(list.data.capacity.pending, 1); assert.equal(list.data.capacity.canInvite, false);
    assert.equal(JSON.stringify(list.data).includes("tokenHash"), false);
    assert.equal(JSON.stringify(list.data).includes("inviteUrl"), false);
  });
  it("enforces permissions, tenant isolation and rejects client-supplied limits", async () => {
    assert.equal((await req(manager, base, "POST", { name: "Wrong", email: "wrong@invite.test" })).status, 403);
    assert.equal((await req(owner, base, "POST", { name: "Spoof", email: "spoof@invite.test", tenantId: otherTenantId, skipEntitlementLimit: true })).status, 422);
    assert.equal((await req(owner, base, "POST", { name: "Admin", email: "admin@invite.test", role: "platform_admin" })).status, 422);
    const foreign = await db.invitation.create({ data: { tenantId: otherTenantId, email: "foreign@invite.test", role: "manager", tokenHash: "foreign-test-only", expiresAt: new Date(Date.now()+60000) } });
    assert.equal((await req(owner, `${base}/${foreign.id}/renew`, "POST")).status, 404);
    assert.equal((await req(owner, `${base}/${foreign.id}`, "DELETE")).status, 404);
  });
  it("rotates a reserved invitation at capacity, invalidates the old link and frees a revoked seat", async () => {
    const rotated = await req(owner, `${base}/${first.id}/renew`, "POST");
    assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
    assert.notEqual(rotated.data.inviteUrl, first.inviteUrl);
    const token = first.inviteUrl.split("/invite/")[1];
    assert.equal((await req("", `/api/v1/invitations/${token}/accept`, "POST", { password: "InvitePass1!" })).status, 404);
    assert.equal((await req(owner, `${base}/${first.id}`, "DELETE")).status, 200);
    assert.equal((await req(owner, "/api/v1/settings/members")).data.capacity.remaining, 1);
  });
  it("rechecks a changed tariff on acceptance and creates no orphan account", async () => {
    const invite = await req(owner, base, "POST", { name: "Тест", email: "downgrade@invite.test", role: "manager" });
    assert.equal(invite.status, 201);
    await activateSubscription(db, { tenantId, planCode: "CRM_START" });
    const token = invite.data.inviteUrl.split("/invite/")[1];
    const denied = await req("", `/api/v1/invitations/${token}/accept`, "POST", { password: "InvitePass1!" });
    assert.equal(denied.status, 422, JSON.stringify(denied.data));
    assert.equal(await db.user.count({ where: { email: "downgrade@invite.test" } }), 0);
    await activateSubscription(db, { tenantId, planCode: "CRM_START", addOns: [{ code: "ADDON_USER", qty: 1 }] });
    const accepted = await req("", `/api/v1/invitations/${token}/accept`, "POST", { password: "InvitePass1!" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
    assert.equal(accepted.data.tenantId, tenantId);
    const list = await req(owner, "/api/v1/settings/members");
    assert.equal(list.data.capacity.active, 4); assert.equal(list.data.capacity.pending, 0); assert.equal(list.data.capacity.canInvite, false);
  });
  it("blocks a second employee on Free", async () => {
    const tenant = await db.tenant.create({ data: { name: "Free seats", slug: "free-seats" } });
    const account = await db.user.findUniqueOrThrow({ where: { email: "owner@creolab.example" } });
    await db.membership.create({ data: { tenantId: tenant.id, userId: account.id, role: "owner" } });
    await activateSubscription(db, { tenantId: tenant.id, planCode: "BASQAR_FREE" });
    const { createTenantInvitation, getInvitationCapacity } = await import("./services/invitationService.ts");
    const cap = await getInvitationCapacity(db, tenant.id);
    assert.equal(cap.limit, 1); assert.equal(cap.canInvite, false);
    await assert.rejects(createTenantInvitation(db, { tenantId: tenant.id, name: "No seat", email: "free@invite.test", role: "manager" }), /Добавление сотрудников недоступно/);
  });
  it("returns Russian journal descriptions, searches them and isolates company events", async () => {
    for (const id of [tenantId, otherTenantId]) await db.auditEvent.create({ data: { tenantId: id, action: "payment.confirmed", entityType: "billing_payment", changesJson: { amountMinor: 69900, requestId: "internal-identifier" } } });
    const result = await req(owner, "/api/v1/workspace/audit?q=" + encodeURIComponent("Оплата подтверждена"));
    assert.equal(result.status, 200); assert.equal(result.data.total, 1);
    assert.equal(result.data.items[0].actionLabel, "Оплата подтверждена");
    assert.deepEqual(result.data.items[0].details, ["Сумма: 69 900 ₸"]);
    assert.equal((await req(manager, "/api/v1/workspace/audit")).status, 403);
  });
});

it("formats plans, dates, control results and changes without leaking technical values", () => {
  const plan = presentAudit({ action: "subscription.activated", entityType: "tenant_plan", changesJson: { planCode: "BUNDLE_FULL", startsAt: "2026-09-23T00:00:00Z", source: "platform_admin_payment", requestId: "uuid" } });
  assert.ok(plan.details.includes("Тариф: BasQar Full")); assert.ok(plan.details.includes("Начало действия: 23.09.2026"));
  assert.doesNotMatch(JSON.stringify(plan), /BUNDLE_FULL|requestId|platform_admin_payment/);
  const control = presentAudit({ action: "control.get_deals_stats", entityType: "control_command", changesJson: { error: null, params: { period: "yesterday" }, result: "ok", source: "WHATSAPP" } });
  assert.ok(control.details.includes("Период: Вчера")); assert.ok(control.details.includes("Результат: Выполнено"));
  assert.doesNotMatch(JSON.stringify(control), /get_deals_stats|params|WHATSAPP/);
  const unknown = presentAudit({ action: "future.code", entityType: "unknown", changesJson: { error: "SQL Exception internal", token: "secret", reason: "Error: secret" } });
  assert.doesNotMatch(JSON.stringify(unknown), /future.code|SQL|Exception|secret|unknown/);
  const edit = presentAudit({ action: "deal.update", entityType: "deal", changesJson: { before: { offerAmountMinor: 100 }, after: { offerAmountMinor: 250 } } });
  assert.ok(edit.details.includes("Сумма сделки: 100 ₸ → 250 ₸"));
});
