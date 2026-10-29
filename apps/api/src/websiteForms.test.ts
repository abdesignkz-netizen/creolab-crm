import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test, mock } from "node:test";
import type { Server } from "node:http";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { invalidateRuntimeConfig } from "./services/runtimeSettings.ts";
import { processInquiryAutomationJob } from "./services/inquiryAutomationQueue.ts";

let db: Awaited<ReturnType<typeof createPrismaClient>>, server: Server, base = "", owner = "", foreign = "", employee = "";
let tenantId = "", employeeId = "", foreignMemberId = "", formId = "", key = "", integrationId = "";
async function request(session: string, path: string, method = "GET", body?: unknown, status = 200, extra = {}) {
  const response = await fetch(base + path, { method, headers: { cookie: session, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(data)}`);
  return { data, cookie: (response.headers.get("set-cookie") || "").split(";")[0] };
}
const path = "/api/v1/integrations/website-forms";
const input = () => ({ requestId: randomUUID(), name: "Консультация", allowedDomains: ["https://WWW.company.example/", "company.example"], assigneeMembershipId: employeeId });

before(async () => {
  process.env.CRM_INLINE_AUTOMATION = "0";
  db = await createPrismaClient(); await (await import("../../../packages/db/src/seed.ts")).seedDatabase();
  server = createApp(db).listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
  const originalFetch = globalThis.fetch;
  mock.method(globalThis, "fetch", (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    assert.equal(new URL(url instanceof Request ? url.url : String(url)).origin, base, "No external requests in website form tests");
    return originalFetch(url, options);
  });
  owner = (await request("", "/api/v1/auth/login", "POST", { email: "owner@creolab.example", password: process.env.SEED_PASSWORD })).cookie;
  foreign = (await request("", "/api/v1/auth/login", "POST", { email: "owner@demo-agency.example", password: process.env.SEED_PASSWORD })).cookie;
  const own = await db.membership.findFirstOrThrow({ where: { role: "owner", user: { email: "owner@creolab.example" } } }); tenantId = own.tenantId;
  const user = await db.user.create({ data: { email: "forms-manager@example.test", name: "Сотрудник формы", passwordHash: (await db.user.findUniqueOrThrow({ where: { id: own.userId } })).passwordHash } });
  employeeId = (await db.membership.create({ data: { tenantId, userId: user.id, role: "manager" } })).id;
  employee = (await request("", "/api/v1/auth/login", "POST", { email: user.email, password: process.env.SEED_PASSWORD })).cookie;
  foreignMemberId = (await db.membership.findFirstOrThrow({ where: { tenantId: { not: tenantId } } })).id;
});
after(async () => { mock.restoreAll(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); await db?.$disconnect(); });

test("owner creates once on concurrent retries; default handling is manual and audited", async () => {
  const before = await db.formDefinition.count({ where: { tenantId } }), body = input();
  const results = await Promise.all([request(owner, path, "POST", body, 201), request(owner, path, "POST", body, 201)]);
  assert.equal(results[0].data.id, results[1].data.id); formId = results[0].data.id;
  assert.equal(await db.formDefinition.count({ where: { tenantId } }), before + 1);
  const row = await db.formDefinition.findUniqueOrThrow({ where: { id: formId }, include: { integration: true } });
  key = row.publicKey; integrationId = row.integrationId;
  assert.match(key, /^frm_[a-f0-9]{32}$/); assert.deepEqual(row.allowedDomains, ["company.example"]);
  assert.equal(row.integration.automationMode, "MANUAL"); assert.equal(row.integration.testMode, false);
  assert.deepEqual(row.integration.assignmentJson, { kind: "member", membershipId: employeeId });
  assert.equal(await db.auditEvent.count({ where: { tenantId, entityId: integrationId, action: "integration.website_form_created" } }), 1);
  await request(owner, path, "POST", { ...body, name: "Другое имя" }, 409);
  const listed = (await request(owner, path)).data;
  assert.equal(listed.items.find((f: any) => f.id === formId).lastSubmission, null);
});

test("permissions, tenant isolation and strict validation protect form configuration", async () => {
  await request("", path, "GET", undefined, 401);
  await request(employee, path, "GET", undefined, 403);
  await request(employee, path, "POST", input(), 403);
  await request(employee, `${path}/${formId}`, "PATCH", { enabled: false }, 403);
  await request(foreign, `${path}/${formId}`, "PATCH", { name: "Wrong tenant" }, 404);
  const foreignList = (await request(foreign, path)).data;
  assert.ok(!foreignList.items.some((f: any) => f.id === formId));
  assert.ok(!foreignList.members.some((m: any) => m.id === employeeId));
  for (const bad of [[], ["*"], ["https://company.example/path"], ["https://user:pass@company.example"], ["javascript:alert(1)"], ["https://company.example?key=secret"], ["company..example"], ["-company.example"]]) {
    await request(owner, path, "POST", { ...input(), allowedDomains: bad }, 422);
  }
  await request(owner, path, "POST", { ...input(), tenantId: "other" }, 422);
  await request(owner, path, "POST", { ...input(), assigneeMembershipId: foreignMemberId }, 422);
  await db.membership.update({ where: { id: employeeId }, data: { active: false } });
  try { await request(owner, `${path}/${formId}`, "PATCH", { assigneeMembershipId: employeeId }, 422); }
  finally { await db.membership.update({ where: { id: employeeId }, data: { active: true } }); }
});

test("public submissions enforce origin, validate fields, deduplicate and reach the assigned employee without an AI send", async () => {
  const endpoint = `/public/forms/${key}/submissions`, body = { name: "Посетитель", phone: "+77015550177", message: "Уточнить услугу" };
  const preflight = await fetch(base + endpoint, { method: "OPTIONS", headers: { origin: "https://company.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-submission-id" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://company.example");
  assert.match(preflight.headers.get("access-control-allow-headers") || "", /x-submission-id/i);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const privatePreflight = await fetch(base + "/api/v1/integrations/website-forms", { method: "OPTIONS", headers: { origin: "https://company.example", "access-control-request-method": "POST" } });
  assert.equal(privatePreflight.headers.get("access-control-allow-origin"), null, "Public intake must not open the private API to other websites");
  await request("", endpoint, "POST", body, 403, { origin: "https://company.example.attacker.test" });
  await request("", endpoint, "POST", { ...body, phone: "abc" }, 422, { origin: "https://company.example" });
  const headers = { origin: "https://www.company.example", "x-submission-id": randomUUID() };
  const first = (await request("", endpoint, "POST", body, 202, headers)).data;
  const duplicate = (await request("", endpoint, "POST", body, 200, headers)).data;
  assert.equal(first.receipt, duplicate.receipt); assert.equal(duplicate.duplicate, true);
  const received = await db.inquiry.findMany({ where: { integrationId } }); assert.equal(received.length, 1);
  assert.equal(received[0].assigneeMembershipId, employeeId); assert.equal(received[0].test, false);
  await processInquiryAutomationJob(db, { tenantId, inquiryId: received[0].id });
  assert.equal(await db.message.count({ where: { tenantId, direction: "outbound", conversation: { contactId: received[0].contactId } } }), 0);
  const listed = (await request(owner, path)).data.items.find((f: any) => f.id === formId);
  assert.equal(listed.lastSubmission.id, received[0].id);
  await request(employee, `/api/v1/inquiries/${received[0].id}`);
});

test("pause and resume preserve the address and history; changes remain bound to the same company", async () => {
  await request(owner, `${path}/${formId}`, "PATCH", { enabled: false });
  await request("", `/public/forms/${key}/submissions`, "POST", { name: "Paused", phone: "+77015550178" }, 404);
  assert.equal(await db.inquiry.count({ where: { integrationId } }), 1);
  await request(owner, `${path}/${formId}`, "PATCH", { enabled: true, name: "Запрос цены", allowedDomains: ["new.example"], assigneeMembershipId: null });
  const row = await db.formDefinition.findUniqueOrThrow({ where: { id: formId }, include: { integration: true } });
  assert.equal(row.publicKey, key); assert.equal(row.name, "Запрос цены"); assert.equal(row.integration.automationMode, "MANUAL");
  await request("", `/public/forms/${key}/submissions`, "POST", { name: "Old", phone: "+77015550178" }, 403, { origin: "https://company.example" });
  const listed = (await request(owner, path)).data.items.find((f: any) => f.id === formId);
  assert.equal(listed.enabled, true); assert.ok(listed.lastSubmission);
});

test("existing test-mode controls still work and never relabel previously received inquiries", async () => {
  const listed = (await request(owner, path)).data.items.find((f: any) => f.id === formId);
  assert.equal(listed.integrationId, integrationId);
  const modePath = `/api/v1/integrations/${listed.integrationId}/test-mode`;
  await request(owner, modePath, "POST", { testMode: true });
  assert.equal((await request(owner, path)).data.items.find((f: any) => f.id === formId).testMode, true);
  await request("", `/public/forms/${key}/submissions`, "POST", { name: "Проверка установки", phone: "+77015550179" }, 202, { origin: "https://new.example", "x-submission-id": randomUUID() });
  const testInquiry = await db.inquiry.findFirstOrThrow({ where: { integrationId, test: true } });
  await request(owner, modePath, "POST", { testMode: false });
  assert.equal((await request(owner, path)).data.items.find((f: any) => f.id === formId).testMode, false);
  assert.equal((await db.inquiry.findUniqueOrThrow({ where: { id: testInquiry.id } })).test, true);
  assert.equal(await db.inquiry.count({ where: { integrationId, test: false } }), 1);
});

test("catalog selects the connected form and shows paused intake honestly", async () => {
  const otherForms = await db.formDefinition.findMany({ where: { tenantId, id: { not: formId } } });
  const empty = await db.integration.create({ data: { tenantId, type: "form", name: "AAA without form", status: "active", connectionStatus: "CONNECTED" } });
  try {
    await db.formDefinition.updateMany({ where: { tenantId, id: { not: formId } }, data: { active: false } });
    const catalog = () => request(owner, "/api/v1/integrations/catalog").then(r => r.data.leads.find((c: any) => c.catalogType === "WEBSITE_FORM"));
    const connected = await catalog();
    assert.equal(connected.connected, true); assert.equal(connected.integrationId, integrationId);
    assert.ok(connected.submitUrl.endsWith(`/public/forms/${key}/submissions`));
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: false });
    const paused = await catalog();
    assert.equal(paused.connected, false); assert.equal(paused.connectionStatus, "DISCONNECTED");
    assert.equal(paused.healthLabel, "Не подключено"); assert.equal(paused.submitUrl, null);
    const setup = (await request(owner, "/api/v1/integrations/setup")).data;
    assert.equal(setup.form.connected, false);
  } finally {
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: true });
    for (const form of otherForms) await db.formDefinition.update({ where: { id: form.id }, data: { active: form.active } });
    await db.integration.delete({ where: { id: empty.id } });
  }
});

test("service restriction blocks creating and receiving forms and cannot be enabled by the owner", async () => {
  const original = (await db.tenant.findUniqueOrThrow({ where: { id: tenantId } })).settingsJson;
  await db.tenant.update({ where: { id: tenantId }, data: { settingsJson: { ...(original as object), features: { forms: false } } } });
  invalidateRuntimeConfig(tenantId);
  try {
    const list = (await request(owner, path)).data;
    assert.equal(list.available, false); assert.equal(list.unavailableReason, "disabled");
    await request(owner, path, "POST", input(), 403);
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: true }, 403);
    await request("", `/public/forms/${key}/submissions`, "POST", { name: "Disabled", phone: "+77015550178" }, 403, { origin: "https://new.example" });
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: false });
  } finally { await db.tenant.update({ where: { id: tenantId }, data: { settingsJson: original! } }); invalidateRuntimeConfig(tenantId); }
});

test("expired plan keeps configuration readable and allows pausing but blocks new intake", async () => {
  await request(owner, `${path}/${formId}`, "PATCH", { enabled: true });
  const plan = await db.tenantPlan.findFirstOrThrow({ where: { tenantId }, orderBy: { startsAt: "desc" } });
  await db.tenantPlan.update({ where: { id: plan.id }, data: { status: "active", endsAt: new Date(Date.now() - 86400000) } });
  try {
    const list = (await request(owner, path)).data;
    assert.equal(list.available, false); assert.equal(list.unavailableReason, "plan");
    assert.ok(list.items.find((f: any) => f.id === formId).lastSubmission);
    assert.equal((await request(owner, "/api/v1/workspace/onboarding")).data.available.form, false);
    await request(owner, path, "POST", input(), 403);
    await request("", `/public/forms/${key}/submissions`, "POST", { name: "Expired", phone: "+77015550180" }, 403, { origin: "https://new.example" });
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: false });
    await request(owner, `${path}/${formId}`, "PATCH", { enabled: true }, 403);
  } finally { await db.tenantPlan.update({ where: { id: plan.id }, data: { status: plan.status, endsAt: plan.endsAt } }); }
});
